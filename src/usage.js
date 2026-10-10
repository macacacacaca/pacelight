// @ts-check
'use strict';

// 讀取 Claude Code 的訂閱登入，向 /api/oauth/usage 查詢 5 小時 / 7 天用量。
// 這和 Claude Code 自己的 /usage、狀態列 rate_limits 是同一份資料。
// 這個檔案不依賴 vscode，可以直接用 node 測試。
//
// 注意：
// - 這個端點沒有公開文件，日後可能改變；解析時一律防禦性處理。
// - 只「讀」權杖，從不自己刷新。刷新會輪替 refresh token，可能讓 Claude Code 被登出；
//   權杖過期時等 Claude Code 自己刷新即可（送出任何訊息就會）。

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const USER_AGENT = `pacelight/${require('../package.json').version}`;

class UsageError extends Error {
  /**
   * @param {'no-login' | 'expired' | 'unauthorized' | 'rate-limited' | 'http' | 'network' | 'bad-response' | 'unknown'} code
   * @param {string} message 英文說明（會寫進記錄）
   * @param {{ retryAfterMs?: number, detail?: string }} [extra] detail：給畫面用的技術細節，例如 HTTP 500、ENOTFOUND
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'UsageError';
    this.code = code;
    this.retryAfterMs = extra.retryAfterMs;
    this.detail = extra.detail;
  }
}

/** Claude Code 用自訂設定資料夾時，登入資料存在另一個位置。 */
function customConfigDir() {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return secure !== undefined ? secure : process.env.CLAUDE_CONFIG_DIR;
}

/** 鑰匙圈項目的命名方式和 Claude Code 相同：自訂資料夾會加上路徑雜湊。 */
function keychainService() {
  const dir = customConfigDir();
  if (!dir) return KEYCHAIN_SERVICE;
  return `${KEYCHAIN_SERVICE}-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`;
}

/** @param {string[]} args @returns {Promise<string>} */
function security(args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(new Error('security command failed')) : resolve(stdout.trim())
    );
  });
}

/** @returns {Promise<string>} */
async function readKeychain() {
  const service = keychainService();
  let account = process.env.USER || os.userInfo().username;
  if (!/^[a-zA-Z0-9._-]+$/.test(account)) account = 'claude-code-user';
  try {
    return await security(['find-generic-password', '-a', account, '-w', '-s', service]);
  } catch (e) {
    // 預設資料夾的舊登入可能存在別的帳號名下；自訂資料夾則不退回，免得讀到另一個帳號。
    if (service !== KEYCHAIN_SERVICE) throw e;
    return security(['find-generic-password', '-w', '-s', service]);
  }
}

/**
 * macOS 從鑰匙圈讀，其他平台（或鑰匙圈讀不到時）讀 ~/.claude/.credentials.json。
 * @returns {Promise<{ accessToken: string, expiresAt: number | null, subscriptionType: string | null }>}
 */
async function readCredentials() {
  /** @type {string | null} */
  let raw = null;
  if (process.platform === 'darwin') {
    raw = await readKeychain().catch(() => null);
  }
  if (!raw) {
    const dir = customConfigDir() || path.join(os.homedir(), '.claude');
    raw = await fs.readFile(path.join(dir, '.credentials.json'), 'utf8').catch(() => null);
  }
  if (!raw) throw new UsageError('no-login', 'Claude Code login not found');

  let oauth;
  try {
    oauth = JSON.parse(raw).claudeAiOauth;
  } catch {
    throw new UsageError('no-login', 'Could not parse Claude Code credentials');
  }
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken) {
    throw new UsageError('no-login', 'No Claude subscription login (API key logins have no plan usage)');
  }
  // 權杖裡有換行之類的字元時，fetch 會把整個標頭值寫進錯誤訊息；先擋掉，免得權杖流進記錄。
  if (!/^[\x21-\x7e]+$/.test(oauth.accessToken)) {
    throw new UsageError('no-login', 'Malformed Claude Code login token');
  }
  return {
    accessToken: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  };
}

/**
 * Retry-After 可能是秒數或 HTTP 日期。
 * @param {string | null} value
 * @param {number} [now]
 * @returns {number | undefined}
 */
function parseRetryAfter(value, now = Date.now()) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/**
 * @typedef {{ percent: number, resetsAt: number | null }} UsageWindow
 * @typedef {{ fiveHour: UsageWindow | null, sevenDay: UsageWindow | null, extras: { key: string, label: string, window: UsageWindow }[] }} Usage
 */

/** @returns {UsageWindow | null} */
function toWindow(/** @type {any} */ w) {
  if (!w || typeof w !== 'object') return null;
  const pct = typeof w.utilization === 'number' ? w.utilization : w.percent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const at = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
  return { percent: pct, resetsAt: Number.isFinite(at) ? at : null };
}

// Max 方案另外有「只算某個模型」的 7 天額度
const EXTRA_WINDOWS = [
  ['seven_day_opus', 'Opus'],
  ['seven_day_sonnet', 'Sonnet'],
];

/**
 * @param {any} body
 * @returns {Usage}
 */
function parseUsage(body) {
  if (!body || typeof body !== 'object') {
    throw new UsageError('bad-response', 'Unexpected usage response');
  }
  // 新版回應另外附 limits[]；five_hour / seven_day 缺席時拿它來補。
  const limits = Array.isArray(body.limits) ? body.limits : [];
  const fromLimits = (/** @type {string} */ kind) => toWindow(limits.find((l) => l && l.kind === kind));

  const fiveHour = toWindow(body.five_hour) ?? fromLimits('session');
  const sevenDay = toWindow(body.seven_day) ?? fromLimits('weekly_all');
  if (!fiveHour && !sevenDay) {
    throw new UsageError('bad-response', 'No 5-hour or 7-day data in usage response');
  }
  const extras = [];
  for (const [key, label] of EXTRA_WINDOWS) {
    const w = toWindow(body[key]);
    if (w) extras.push({ key, label, window: w });
  }
  return { fiveHour, sevenDay, extras };
}

/**
 * @param {string} accessToken
 * @param {{ timeoutMs?: number, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Usage>}
 */
async function fetchUsage(accessToken, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 只留錯誤種類（例如 ENOTFOUND、TimeoutError），不帶原始訊息，避免任何標頭內容外流。
    const err = /** @type {any} */ (e);
    const kind = err?.cause?.code || err?.name || 'Error';
    throw new UsageError('network', `Can't reach server (${kind})`, { detail: kind });
  }
  if (res.status === 401 || res.status === 403) {
    throw new UsageError('unauthorized', `Login token rejected (HTTP ${res.status})`, { detail: `HTTP ${res.status}` });
  }
  if (res.status === 429) {
    throw new UsageError('rate-limited', 'Too many requests (HTTP 429)', {
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  if (!res.ok) throw new UsageError('http', `Server returned HTTP ${res.status}`, { detail: `HTTP ${res.status}` });

  let body;
  try {
    body = await res.json();
  } catch {
    throw new UsageError('bad-response', 'Usage response is not JSON');
  }
  return parseUsage(body);
}

module.exports = { UsageError, readCredentials, fetchUsage, parseUsage, parseRetryAfter };
