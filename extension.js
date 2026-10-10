// @ts-check
'use strict';

// VS Code 這一側：狀態列項目、排程查詢、共用快取、指令與設定。
// 資料怎麼拿在 src/usage.js，畫面怎麼畫在 src/format.js。

const vscode = require('vscode');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readCredentials, fetchUsage, UsageError } = require('./src/usage');
const { renderView } = require('./src/format');
const { TokenLedger } = require('./src/tokens');

const MIN_INTERVAL_S = 30;
const MAX_INTERVAL_S = 86_400;
const MAX_BACKOFF_MS = 15 * 60_000;
const EXPIRED_RETRY_MS = 60_000; // 權杖過期只讀鑰匙圈，不連網，可以看勤一點
const RENDER_TICK_MS = 30_000; // 只重畫倒數時間，不連網
const MAX_TIMEOUT_MS = 2_147_483_647;
const LEDGER_MIN_GAP_MS = 20_000; // 切換視窗時常常觸發更新，對話記錄不用掃那麼勤
const HOUR_MS = 3_600_000;

/** @typedef {import('./src/usage').Usage} Usage */
/** @typedef {{ usage: Usage, fetchedAt: number, plan: string | null }} Snapshot */

/**
 * 預期外的錯誤（多半是檔案系統錯誤）訊息裡常有絕對路徑。這些訊息會寫進記錄、顯示在卡片上，
 * 使用者回報問題時會貼出來，所以把家目錄換成 ~，不帶出帳號名稱。
 * @param {unknown} e
 */
function asUsageError(e) {
  if (e instanceof UsageError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new UsageError('unknown', message.split(os.homedir()).join('~'));
}

/** @param {any} v @returns {v is Snapshot} */
function isSnapshot(v) {
  return !!v && typeof v.fetchedAt === 'number' && !!v.usage && typeof v.usage === 'object' && Array.isArray(v.usage.extras);
}

/** 快照裡有任何區間已經過了重置時間，就不能再當成目前的數字。 */
function hasPassedReset(/** @type {Snapshot} */ snap, now = Date.now()) {
  const { fiveHour, sevenDay } = snap.usage;
  return [fiveHour, sevenDay].some((w) => w?.resetsAt != null && w.resetsAt <= now);
}

/** @returns {'dark' | 'light' | 'hc-dark' | 'hc-light'} */
function themeKind() {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light: return 'light';
    case vscode.ColorThemeKind.HighContrast: return 'hc-dark';
    case vscode.ColorThemeKind.HighContrastLight: return 'hc-light';
    default: return 'dark';
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const log = vscode.window.createOutputChannel('Pacelight', { log: true });
  const item = vscode.window.createStatusBarItem('pacelight.status', vscode.StatusBarAlignment.Right, 1);
  item.name = 'Pacelight';
  item.command = 'pacelight.refresh';
  item.text = '$(sync~spin)';
  item.show();

  // 本機對話記錄的 token 統計（只讀新增的部分）
  const ledger = new TokenLedger();
  let ledgerScannedAt = 0;

  // 多個 VS Code 視窗共用同一份結果，避免每個視窗各自打 API。
  const cacheFile = path.join(context.globalStorageUri.fsPath, 'last-usage.json');

  /** @type {Snapshot | null} */
  let last = null;
  /** @type {UsageError | null} */
  let lastError = null;
  /** @type {Promise<void> | null} */
  let inflight = null;
  let forceQueued = false;
  /** @type {NodeJS.Timeout | undefined} */
  let pollTimer;
  let lastAttemptAt = 0;
  let lastFailureAt = 0;
  let failures = 0;
  let backoffUntil = 0;
  let disposed = false;

  const warn = (/** @type {string} */ msg) => {
    if (!disposed) log.warn(msg);
  };

  function config() {
    const c = vscode.workspace.getConfiguration('pacelight');
    const secs = Number(c.get('refreshIntervalSeconds')) || 120;
    return {
      intervalMs: Math.min(MAX_INTERVAL_S, Math.max(MIN_INTERVAL_S, secs)) * 1000,
      format: String(c.get('format') || ''),
      warn: Number(c.get('warningThreshold') ?? 80),
      err: Number(c.get('errorThreshold') ?? 95),
      lang: String(c.get('language') || 'en'),
      showTokens: c.get('showTokens') !== false,
    };
  }

  /** @returns {Promise<Snapshot | null>} */
  async function readCache() {
    try {
      const v = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      return isSnapshot(v) ? v : null;
    } catch {
      return null;
    }
  }

  /** @param {Snapshot} snap */
  async function writeCache(snap) {
    try {
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      const tmp = `${cacheFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(snap));
      await fs.rename(tmp, cacheFile);
    } catch (e) {
      warn(`Failed to write cache: ${asUsageError(e).message}`);
    }
  }

  async function updateLedger() {
    if (!config().showTokens || Date.now() - ledgerScannedAt < LEDGER_MIN_GAP_MS) return;
    ledgerScannedAt = Date.now();
    try {
      await ledger.update();
    } catch (e) {
      warn(`Failed to read Claude Code transcripts: ${asUsageError(e).message}`);
    }
  }

  /** 目前 5 小時、7 天區間各自的 token 統計；區間還沒開始或已重置就是 null */
  function tokenWindows(/** @type {Usage} */ usage, /** @type {number} */ now) {
    const win = (/** @type {import('./src/usage').UsageWindow | null} */ w, /** @type {number} */ lengthMs) =>
      w && w.resetsAt != null && w.resetsAt > now ? ledger.summarize(w.resetsAt - lengthMs, now) : null;
    return { five_hour: win(usage.fiveHour, 5 * HOUR_MS), seven_day: win(usage.sevenDay, 7 * 24 * HOUR_MS) };
  }

  function render() {
    if (disposed) return;
    const c = config();
    const now = Date.now();
    const view = renderView({
      snapshot: last,
      error: lastError ? { code: lastError.code, message: lastError.message, detail: lastError.detail } : null,
      format: c.format,
      warn: c.warn,
      err: c.err,
      theme: themeKind(),
      now,
      lang: c.lang,
      tokens: c.showTokens && last ? tokenWindows(last.usage, now) : null,
    });
    item.text = view.text;
    item.backgroundColor =
      view.level === 'normal'
        ? undefined
        : new vscode.ThemeColor(view.level === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground');
    const tooltip = new vscode.MarkdownString(view.tooltip, true);
    tooltip.supportHtml = true;
    tooltip.isTrusted = { enabledCommands: ['pacelight.refresh', 'pacelight.showLog', 'workbench.action.openSettings'] };
    item.tooltip = tooltip;
    item.accessibilityInformation = { label: view.ariaLabel };
  }

  /**
   * 下一次查詢的時間：從「上次成功」和「上次嘗試」較晚的那個起算一個間隔，
   * 不早於退避時間，也不晚於下一個重置時間（重置後要盡快換成新數字）。
   * 最後加一點隨機錯開，讓先醒的視窗去查、其他視窗吃快取。
   */
  function schedule() {
    if (disposed) return;
    clearTimeout(pollTimer);
    const now = Date.now();
    const { intervalMs } = config();
    const fetchedAt = last && last.fetchedAt <= now ? last.fetchedAt : 0; // 時鐘倒退時當作過期
    let delay = Math.max(intervalMs - (now - Math.max(fetchedAt, lastAttemptAt)), backoffUntil - now);
    if (last && !lastError) {
      for (const w of [last.usage.fiveHour, last.usage.sevenDay]) {
        if (w?.resetsAt != null && w.resetsAt > now) delay = Math.min(delay, w.resetsAt - now + 3_000);
      }
    }
    delay = Math.min(MAX_TIMEOUT_MS, Math.max(5_000, delay) + Math.random() * 5_000);
    pollTimer = setTimeout(() => void refresh(false), delay);
  }

  /** @param {UsageError} e @param {number} intervalMs */
  function backoffFor(e, intervalMs) {
    switch (e.code) {
      case 'rate-limited':
        return e.retryAfterMs ?? Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
      case 'expired':
        return EXPIRED_RETRY_MS;
      case 'no-login':
        return intervalMs;
      default:
        return Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** (failures - 1));
    }
  }

  /** @param {boolean} force 手動更新時略過快取與退避 */
  async function refresh(force) {
    if (inflight) {
      // 查詢進行中又按了「立即更新」：等這次結束後再強制查一次。
      if (force) forceQueued = true;
      return inflight;
    }
    inflight = (async () => {
      const { intervalMs } = config();
      try {
        await updateLedger();
        if (!force) {
          const cached = await readCache();
          const now = Date.now();
          const age = cached ? now - cached.fetchedAt : -1;
          if (cached && age >= 0 && age < intervalMs * 0.9 && !hasPassedReset(cached, now)) {
            last = cached;
            // 只有比上次失敗更新的資料（例如另一個視窗剛查到）才代表問題解除了。
            if (cached.fetchedAt > lastFailureAt) {
              lastError = null;
              failures = 0;
              backoffUntil = 0;
            }
            return;
          }
          if (now < backoffUntil) return;
        }
        lastAttemptAt = Date.now();
        const cred = await readCredentials();
        if (cred.expiresAt != null && cred.expiresAt <= Date.now()) {
          throw new UsageError('expired', 'Login token expired');
        }
        const usage = await fetchUsage(cred.accessToken);
        if (disposed) return;
        last = { usage, fetchedAt: Date.now(), plan: cred.subscriptionType };
        lastError = null;
        failures = 0;
        backoffUntil = 0;
        await writeCache(last);
      } catch (e) {
        lastError = asUsageError(e);
        lastFailureAt = Date.now();
        failures++;
        backoffUntil = lastFailureAt + backoffFor(lastError, intervalMs);
        warn(`Refresh failed (${lastError.code}): ${lastError.message}`);
      } finally {
        render();
        schedule();
      }
    })().finally(() => {
      inflight = null;
      if (forceQueued && !disposed) {
        forceQueued = false;
        void refresh(true);
      }
    });
    return inflight;
  }

  const renderTimer = setInterval(render, RENDER_TICK_MS);
  let wasFocused = vscode.window.state.focused;

  context.subscriptions.push(
    item,
    log,
    {
      dispose: () => {
        disposed = true;
        clearTimeout(pollTimer);
        clearInterval(renderTimer);
      },
    },
    vscode.commands.registerCommand('pacelight.refresh', () => {
      // 點了馬上有反應：先換成轉圈，查完 render() 會換回來
      if (!disposed) item.text = `$(sync~spin) ${item.text.replace(/^\$\([^)]*\)\s*/, '')}`;
      return refresh(true);
    }),
    vscode.commands.registerCommand('pacelight.showLog', () => log.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pacelight')) {
        render();
        schedule();
      }
    }),
    vscode.window.onDidChangeActiveColorTheme(() => render()),
    // 回到這個視窗時順便看一下（快取還新鮮就不會連網）。
    // 這個事件在閒置／恢復操作時也會觸發，所以只看「從沒焦點變成有焦點」。
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused && !wasFocused) void refresh(false);
      wasFocused = s.focused;
    })
  );

  render();
  void refresh(false);
}

function deactivate() {}

module.exports = { activate, deactivate };
