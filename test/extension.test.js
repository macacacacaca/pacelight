'use strict';

// 用假的 vscode 模組跑 activate()，檢查狀態列在各種情況下的樣子。

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** @type {string[]} 測試建立的暫存資料夾，全部跑完後刪掉 */
const tmpDirs = [];
const mkTmp = (/** @type {string} */ prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};
test.after(() => tmpDirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

// 讓 token 統計讀一個空資料夾，不要掃到真的對話記錄
process.env.CLAUDE_CONFIG_DIR = mkTmp('pacelight-config-');

// 測試一律用假的 fetchImpl；萬一哪個 stub 漏了，也不能真的連上 api.anthropic.com
globalThis.fetch = async () => { throw new Error('tests must not hit the network'); };

function makeVscode(settings = {}) {
  const commands = new Map();
  const items = [];
  /** @type {string[]} 寫進輸出頻道（記錄）的每一行 */
  const logs = [];
  const listeners = { config: [], window: [] };
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor(value, icons) { this.value = value; this.supportThemeIcons = icons; } },
    window: {
      createOutputChannel: () => ({ warn: (m) => logs.push(m), info: (m) => logs.push(m), show() {}, dispose() {} }),
      createStatusBarItem: (id, alignment, priority) => {
        const item = { id, alignment, priority, text: '', shown: false, show() { this.shown = true; }, dispose() {} };
        items.push(item);
        return item;
      },
      onDidChangeWindowState: (fn) => { listeners.window.push(fn); return { dispose() {} }; },
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      activeColorTheme: { kind: 2 },
      state: { focused: true, active: true },
    },
    workspace: {
      getConfiguration: () => ({ get: (k) => settings[k] }),
      onDidChangeConfiguration: (fn) => { listeners.config.push(fn); return { dispose() {} }; },
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    },
  };
  return { vscode, commands, items, logs, listeners };
}

/**
 * 載入一份全新的 extension.js，vscode 與 src/usage 都換成假的。
 * @param {{ settings?: object, creds?: () => Promise<any>, fetch?: (token: string) => Promise<any>, profile?: (token: string) => Promise<any>, seedCache?: object }} opts
 */
function load({ settings = {}, creds, fetch, profile, seedCache } = {}) {
  const fake = makeVscode(settings);
  const root = path.join(__dirname, '..');
  const realUsage = require('../src/usage');
  const stubUsage = {
    ...realUsage,
    readCredentials: creds ?? (async () => ({ accessToken: 't', expiresAt: Date.now() + 3600_000, subscriptionType: 'pro' })),
    fetchUsage: fetch ?? (async () => realUsage.parseUsage({ five_hour: { utilization: 9 }, seven_day: { utilization: 53 } })),
    fetchProfile: profile ?? (async () => ({ plan: 'pro', tier: 'default_claude_pro' })),
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(root) && !k.includes(`${path.sep}test${path.sep}`)) delete require.cache[k];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return fake.vscode;
    if (request === './src/usage' && parent && parent.filename === path.join(root, 'extension.js')) return stubUsage;
    return origLoad.call(this, request, parent, isMain);
  };
  try {
    const ext = require('../extension.js');
    const storage = mkTmp('pacelight-test-');
    if (seedCache) fs.writeFileSync(path.join(storage, 'last-usage.json'), JSON.stringify(seedCache));
    const context = { subscriptions: [], globalStorageUri: { fsPath: storage } };
    ext.activate(context);
    const dispose = () => context.subscriptions.forEach((d) => d.dispose());
    return { ...fake, context, storage, dispose, item: fake.items[0] };
  } finally {
    Module._load = origLoad;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));
/** 卡片是 base64 的 SVG，要解開才看得到裡面的字 */
const cardSvg = (/** @type {any} */ h) =>
  [...String(h.item.tooltip?.value).matchAll(/base64,([^"]+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('\n');
const readCache = (/** @type {any} */ h) => JSON.parse(fs.readFileSync(path.join(h.storage, 'last-usage.json'), 'utf8'));
const USAGE_9_53 = { five_hour: { utilization: 9 }, seven_day: { utilization: 53 } };

test('啟動後顯示用量並寫入共用快取', async () => {
  const h = load();
  try {
    assert.equal(h.item.shown, true);
    assert.equal(h.item.alignment, 2);
    await settle();
    assert.equal(h.item.text, '5h 9% · 7d 53%');
    assert.equal(h.item.name, 'Pacelight');
    assert.equal(h.item.backgroundColor, undefined);
    assert.equal(h.item.color, undefined);
    assert.equal(h.item.tooltip.supportHtml, true);
    assert.deepEqual(h.item.tooltip.isTrusted, { enabledCommands: ['pacelight.refresh', 'pacelight.showLog', 'workbench.action.openSettings'] });
    assert.match(h.item.tooltip.value, /alt="Claude usage: 5 hours 9%; 7 days 53%\. /);
    assert.match(h.item.accessibilityInformation.label, /^Claude usage: 5 hours 9%; 7 days 53%\. /);
    const cache = JSON.parse(fs.readFileSync(path.join(h.storage, 'last-usage.json'), 'utf8'));
    assert.equal(cache.usage.sevenDay.percent, 53);
    assert.equal(cache.plan, 'pro');
  } finally {
    h.dispose();
  }
});

test('自訂格式與警告色', async () => {
  const h = load({
    settings: { format: '{five_hour}|{seven_day}', warningThreshold: 50, errorThreshold: 95 },
  });
  try {
    await settle();
    assert.equal(h.item.text, '9|53');
    assert.equal(h.item.backgroundColor.id, 'statusBarItem.warningBackground');
  } finally {
    h.dispose();
  }
});

test('沒有訂閱登入時顯示提示', async () => {
  const { UsageError } = require('../src/usage');
  const h = load({ creds: async () => { throw new UsageError('no-login', 'x'); } });
  try {
    await settle();
    assert.equal(h.item.text, '$(account) No subscription login');
  } finally {
    h.dispose();
  }
});

test('權杖過期時不連網', async () => {
  let fetched = false;
  const h = load({
    creds: async () => ({ accessToken: 't', expiresAt: Date.now() - 1, subscriptionType: 'pro' }),
    fetch: async () => { fetched = true; throw new Error('should not fetch'); },
  });
  try {
    await settle();
    assert.equal(fetched, false);
    assert.equal(h.item.text, '$(key) Login needs refresh');
    assert.match(h.item.tooltip.value, /refreshes it the next time/);
  } finally {
    h.dispose();
  }
});

test('更新失敗時保留舊資料並加上警告', async () => {
  const { UsageError, parseUsage } = require('../src/usage');
  let fail = false;
  const h = load({
    fetch: async () => {
      if (fail) throw new UsageError('network', '連不上伺服器：boom');
      return parseUsage({ five_hour: { utilization: 9 }, seven_day: { utilization: 53 } });
    },
  });
  try {
    await settle();
    fail = true;
    await h.commands.get('pacelight.refresh')();
    assert.equal(h.item.text, '$(debug-disconnect) 5h 9% · 7d 53%');
    assert.match(h.item.tooltip.value, /Can't reach Claude's servers/);
  } finally {
    h.dispose();
  }
});

test('429 之後切回視窗不會再連網', async () => {
  const { UsageError } = require('../src/usage');
  let calls = 0;
  const h = load({
    fetch: async () => { calls++; throw new UsageError('rate-limited', '查詢太頻繁', { retryAfterMs: 60_000 }); },
  });
  try {
    await settle();
    assert.equal(calls, 1);
    h.listeners.window.forEach((fn) => fn({ focused: true }));
    await settle();
    assert.equal(calls, 1);
  } finally {
    h.dispose();
  }
});

test('快取新鮮時，另一個視窗不連網', async () => {
  const { parseUsage } = require('../src/usage');
  let fetched = false;
  const h = load({
    seedCache: { usage: parseUsage({ five_hour: { utilization: 21 }, seven_day: { utilization: 64 } }), fetchedAt: Date.now() - 10_000, plan: 'max' },
    fetch: async () => { fetched = true; throw new Error('should use cache'); },
  });
  try {
    await settle();
    assert.equal(fetched, false);
    assert.equal(h.item.text, '5h 21% · 7d 64%');
  } finally {
    h.dispose();
  }
});

test('快取過期或損毀時會重新查詢', async () => {
  let calls = 0;
  const fetch = async () => { calls++; return require('../src/usage').parseUsage({ five_hour: { utilization: 1 }, seven_day: { utilization: 2 } }); };
  const stale = load({ seedCache: { usage: { fiveHour: null, sevenDay: null, extras: [] }, fetchedAt: Date.now() - 3600_000, plan: null }, fetch });
  const broken = load({ seedCache: { nope: true }, fetch });
  try {
    await settle();
    assert.equal(calls, 2);
    assert.equal(stale.item.text, '5h 1% · 7d 2%');
    assert.equal(broken.item.text, '5h 1% · 7d 2%');
  } finally {
    stale.dispose();
    broken.dispose();
  }
});

test('出錯後不會每幾秒重試（下一次排在一個間隔之後）', async () => {
  const { UsageError } = require('../src/usage');
  const realSetTimeout = global.setTimeout;
  const delays = [];
  // 只攔截排程用的長計時器；測試自己等待用的短計時器照常執行
  global.setTimeout = (fn, ms, ...args) => {
    if (ms <= 1000) return realSetTimeout(fn, ms, ...args);
    delays.push(ms);
    return realSetTimeout(() => {}, 0);
  };
  let h;
  try {
    h = load({ creds: async () => { throw new UsageError('http', '伺服器回應 HTTP 500'); } });
    await settle();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  try {
    const pollDelays = delays;
    assert.ok(pollDelays.length >= 1, '應該排了下一次查詢');
    assert.ok(pollDelays.every((d) => d >= 120_000), `出錯後的間隔太短：${pollDelays}`);
  } finally {
    h?.dispose();
  }
});

test('超大的查詢間隔不會讓計時器溢位', async () => {
  const realSetTimeout = global.setTimeout;
  const delays = [];
  // 只攔截排程用的長計時器；測試自己等待用的短計時器照常執行
  global.setTimeout = (fn, ms, ...args) => {
    if (ms <= 1000) return realSetTimeout(fn, ms, ...args);
    delays.push(ms);
    return realSetTimeout(() => {}, 0);
  };
  let h;
  try {
    h = load({ settings: { refreshIntervalSeconds: 9_999_999 } });
    await settle();
  } finally {
    global.setTimeout = realSetTimeout;
  }
  try {
    assert.ok(delays.length >= 1 && delays.every((d) => d <= 2_147_483_647));
  } finally {
    h?.dispose();
  }
});

test('只有「從沒焦點變成有焦點」才會更新', async () => {
  let reads = 0;
  const h = load({ creds: async () => { reads++; return { accessToken: 't', expiresAt: Date.now() + 3600_000, subscriptionType: 'pro' }; } });
  try {
    await settle();
    const after = reads;
    h.listeners.window.forEach((fn) => fn({ focused: true, active: false })); // 閒置
    h.listeners.window.forEach((fn) => fn({ focused: true, active: true })); // 恢復操作
    await settle();
    assert.equal(reads, after);
  } finally {
    h.dispose();
  }
});

test('查詢進行中按「立即更新」會在結束後再強制查一次', async () => {
  let calls = 0;
  /** @type {(v?: any) => void} */
  let release = () => {};
  const { parseUsage } = require('../src/usage');
  const h = load({
    fetch: () => { calls++; return new Promise((r) => { release = () => r(parseUsage({ five_hour: { utilization: 9 }, seven_day: { utilization: 53 } })); }); },
  });
  try {
    await settle();
    assert.equal(calls, 1);
    const p = h.commands.get('pacelight.refresh')();
    release();
    await p;
    await settle();
    release();
    await settle();
    assert.equal(calls, 2);
  } finally {
    h.dispose();
  }
});

test('語言設定切成繁中', async () => {
  const h = load({ settings: { language: 'zh-TW' } });
  try {
    await settle();
    assert.equal(h.item.text, '5h 9% · 7d 53%');
    assert.match(h.item.accessibilityInformation.label, /^Claude 用量：5 小時 9%；7 天 53%。/);
  } finally {
    h.dispose();
  }
});

/* ───────────── 方案名稱（profile 端點） ───────────── */

test('方案名稱以 profile 為準：憑證說 pro、profile 說 Max 5x', async () => {
  const h = load({ profile: async () => ({ plan: 'max', tier: 'default_claude_max_5x' }) });
  try {
    await settle();
    assert.equal(h.item.text, '5h 9% · 7d 53%');
    const cache = readCache(h);
    assert.equal(cache.plan, 'max');
    assert.equal(cache.tier, 'default_claude_max_5x');
    assert.equal(typeof cache.planFetchedAt, 'number');
    assert.match(cardSvg(h), />Max 5x</);
  } finally {
    h.dispose();
  }
});

test('profile 查不到時用量照常顯示，方案退回憑證的值', async () => {
  const { UsageError } = require('../src/usage');
  let usageCalls = 0;
  let profileCalls = 0;
  const h = load({
    fetch: async () => { usageCalls++; return require('../src/usage').parseUsage(USAGE_9_53); },
    profile: async () => { profileCalls++; throw new UsageError('http', 'Server returned HTTP 500', { detail: 'HTTP 500' }); },
  });
  try {
    await settle();
    assert.equal(profileCalls, 1);
    assert.equal(typeof readCache(h).planFetchedAt, 'number'); // 失敗也記時間，一小時內不再重試
    assert.equal(h.item.text, '5h 9% · 7d 53%'); // 沒有錯誤圖示
    assert.equal(h.item.backgroundColor, undefined);
    assert.doesNotMatch(h.item.tooltip.value, /HTTP 500/);
    assert.equal(readCache(h).plan, 'pro');
    assert.equal(readCache(h).tier, null);
    assert.match(h.logs.join('\n'), /Plan lookup failed \(http\): Server returned HTTP 500/);
    assert.doesNotMatch(h.logs.join('\n'), /Refresh failed/);
    assert.match(cardSvg(h), />Pro</);
    // 不算失敗，所以不退避：切回視窗（用量快取過期時）照常重查
    fs.writeFileSync(path.join(h.storage, 'last-usage.json'), JSON.stringify({ ...readCache(h), fetchedAt: Date.now() - 3600_000 }));
    h.listeners.window.forEach((fn) => fn({ focused: false }));
    h.listeners.window.forEach((fn) => fn({ focused: true }));
    await settle();
    assert.equal(usageCalls, 2);
    assert.equal(profileCalls, 1); // 一小時內不重試 profile
    await h.commands.get('pacelight.refresh')();
    assert.equal(profileCalls, 2); // 手動更新才會再試
  } finally {
    h.dispose();
  }
});

test('已經查到 Max 5x 之後 profile 失敗或讀不到方案，沿用上次的，不退回憑證的舊值', async () => {
  const { UsageError } = require('../src/usage');
  /** @type {() => Promise<any>} */
  let respond = async () => ({ plan: 'max', tier: 'default_claude_max_5x' });
  const h = load({ profile: () => respond() });
  try {
    await settle();
    assert.match(cardSvg(h), />Max 5x</);
    // 一小時後手動更新時 profile 暫時 500
    respond = async () => { throw new UsageError('http', 'Server returned HTTP 500', { detail: 'HTTP 500' }); };
    await h.commands.get('pacelight.refresh')();
    assert.equal(readCache(h).plan, 'max');
    assert.equal(readCache(h).tier, 'default_claude_max_5x');
    assert.match(cardSvg(h), />Max 5x</);
    // 回應格式變了：200 但解析不到方案
    respond = async () => ({ plan: null, tier: null });
    await h.commands.get('pacelight.refresh')();
    assert.equal(readCache(h).plan, 'max');
    assert.equal(readCache(h).tier, 'default_claude_max_5x');
    assert.match(cardSvg(h), />Max 5x</);
    assert.match(h.logs.join('\n'), /Plan lookup returned no plan/);
    assert.equal(h.item.text, '5h 9% · 7d 53%');
  } finally {
    h.dispose();
  }
});

test('方案名稱一小時內只查一次；手動更新一律重查', async () => {
  let usageCalls = 0;
  let profileCalls = 0;
  const h = load({
    fetch: async () => { usageCalls++; return require('../src/usage').parseUsage(USAGE_9_53); },
    profile: async () => { profileCalls++; return { plan: 'max', tier: 'default_claude_max_5x' }; },
  });
  try {
    await settle();
    assert.equal(usageCalls, 1);
    assert.equal(profileCalls, 1);
    const first = readCache(h);
    // 讓用量快取過期（方案查詢時間還新鮮），切回視窗會重查用量，但不會再查方案
    fs.writeFileSync(path.join(h.storage, 'last-usage.json'), JSON.stringify({ ...first, fetchedAt: Date.now() - 3600_000 }));
    h.listeners.window.forEach((fn) => fn({ focused: false }));
    h.listeners.window.forEach((fn) => fn({ focused: true }));
    await settle();
    assert.equal(usageCalls, 2);
    assert.equal(profileCalls, 1);
    assert.equal(readCache(h).plan, 'max');
    assert.equal(readCache(h).planFetchedAt, first.planFetchedAt);
    assert.match(cardSvg(h), />Max 5x</);
    // 手動更新
    await h.commands.get('pacelight.refresh')();
    assert.equal(usageCalls, 3);
    assert.equal(profileCalls, 2);
    assert.ok(readCache(h).planFetchedAt > first.planFetchedAt);
  } finally {
    h.dispose();
  }
});

test('快取裡的方案查詢時間還新鮮時，另一個視窗不查 profile，沿用快取的方案', async () => {
  const { parseUsage } = require('../src/usage');
  let profileCalls = 0;
  const planFetchedAt = Date.now() - 60_000;
  const fresh = load({
    seedCache: { usage: parseUsage({ five_hour: { utilization: 21 }, seven_day: { utilization: 64 } }), fetchedAt: Date.now() - 3600_000, plan: 'max', tier: 'default_claude_max_5x', planFetchedAt },
    profile: async () => { profileCalls++; return { plan: 'pro', tier: 'default_claude_pro' }; },
  });
  // 兩小時前查的就要重查
  const old = load({
    seedCache: { usage: parseUsage({ five_hour: { utilization: 21 }, seven_day: { utilization: 64 } }), fetchedAt: Date.now() - 3600_000, plan: 'max', tier: 'default_claude_max_5x', planFetchedAt: Date.now() - 2 * 3600_000 },
    profile: async () => ({ plan: 'pro', tier: 'default_claude_pro' }),
  });
  try {
    await settle();
    assert.equal(profileCalls, 0);
    assert.equal(fresh.item.text, '5h 9% · 7d 53%'); // 用量有重查
    assert.equal(readCache(fresh).plan, 'max');
    assert.equal(readCache(fresh).tier, 'default_claude_max_5x');
    assert.equal(readCache(fresh).planFetchedAt, planFetchedAt);
    assert.match(cardSvg(fresh), />Max 5x</);
    assert.equal(readCache(old).plan, 'pro');
    assert.match(cardSvg(old), />Pro</);
  } finally {
    fresh.dispose();
    old.dispose();
  }
});

test('舊版快取沒有 tier 與方案查詢時間也能照常讀', async () => {
  const { parseUsage } = require('../src/usage');
  let fetched = false;
  const h = load({
    seedCache: { usage: parseUsage({ five_hour: { utilization: 21 }, seven_day: { utilization: 64 } }), fetchedAt: Date.now() - 10_000, plan: 'max' },
    fetch: async () => { fetched = true; throw new Error('should use cache'); },
  });
  try {
    await settle();
    assert.equal(fetched, false);
    assert.equal(h.item.text, '5h 21% · 7d 64%');
    assert.match(cardSvg(h), />Max</);
    assert.doesNotMatch(cardSvg(h), />Max \d+x</);
  } finally {
    h.dispose();
  }
});

/* ───────────── 資安 ───────────── */

const CANARY = 'sk-ant-oat01-CANARY-do-not-leak-1234567890';
// 照 profile 端點的格式編的假回應，個資欄位都放了會被認出來的值
const PROFILE = {
  account: { uuid: 'acct-uuid-0000', full_name: 'Some One', display_name: 'Someone', email: 'someone@example.com', has_claude_max: true, has_claude_pro: false },
  organization: { uuid: 'org-uuid-0000', name: "Some One's Organization", organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x' },
};
const PII = ['someone@example.com', 'Some One', 'Someone', 'acct-uuid-0000', 'org-uuid-0000'];
const isProfile = (/** @type {any} */ url) => String(url).endsWith('/api/oauth/profile');

test('資安：權杖不會出現在記錄、快取或畫面上', async () => {
  const { fetchUsage: realFetch, fetchProfile: realProfile } = require('../src/usage');
  const ok = async (/** @type {any} */ url) => new Response(JSON.stringify(isProfile(url) ? PROFILE : USAGE_9_53), { status: 200 });
  /** @type {(url: any, init: any) => Promise<Response>} */
  let respond = ok;
  const h = load({
    creds: async () => ({ accessToken: CANARY, expiresAt: Date.now() + 3600_000, subscriptionType: 'pro' }),
    // 走真的 fetchUsage／fetchProfile，只把網路換掉
    fetch: (token) => realFetch(token, { fetchImpl: (url, init) => respond(url, init) }),
    profile: (token) => realProfile(token, { fetchImpl: (url, init) => respond(url, init) }),
  });
  const visible = () => [
    ...h.logs,
    h.item.text,
    h.item.tooltip?.value,
    cardSvg(h),
    h.item.accessibilityInformation?.label,
    fs.readdirSync(h.storage).map((f) => fs.readFileSync(path.join(h.storage, f), 'utf8')).join('\n'),
  ].join('\n');
  try {
    await settle();
    assert.equal(h.item.text, '5h 9% · 7d 53%');
    const cache = readCache(h);
    assert.deepEqual(Object.keys(cache).sort(), ['fetchedAt', 'plan', 'planFetchedAt', 'tier', 'usage']);
    assert.equal(cache.plan, 'max');
    assert.match(cardSvg(h), />Max 5x</);

    const failures = [
      async () => new Response('{}', { status: 401 }),
      async () => new Response('oops', { status: 500 }),
      async (/** @type {any} */ _url, /** @type {any} */ init) => { throw new TypeError(`fetch failed: ${init.headers.Authorization}`); },
      // 用量正常、只有 profile 失敗（fetch 自己的錯誤可能把標頭寫進訊息）
      async (/** @type {any} */ url, /** @type {any} */ init) => {
        if (isProfile(url)) throw new TypeError(`fetch failed: ${init.headers.Authorization}`, { cause: new Error(`header ${init.headers.Authorization}`) });
        return ok(url);
      },
      async (/** @type {any} */ url) => (isProfile(url) ? new Response(`{"error":"${CANARY}"}`, { status: 401 }) : ok(url)),
      async (/** @type {any} */ url) => (isProfile(url) ? new Response(`not json ${CANARY}`, { status: 200 }) : ok(url)),
    ];
    for (const fail of failures) {
      respond = fail;
      await h.commands.get('pacelight.refresh')();
    }
    const logs = h.logs.join('\n');
    assert.match(logs, /Refresh failed \(unauthorized\)[\s\S]*Refresh failed \(http\)[\s\S]*Refresh failed \(network\)/, '三次用量失敗都應該寫進記錄');
    assert.match(logs, /Plan lookup failed \(network\)[\s\S]*Plan lookup failed \(unauthorized\)[\s\S]*Plan lookup failed \(bad-response\)/, '三次 profile 失敗都應該寫進記錄');
    assert.equal(h.item.text, '5h 9% · 7d 53%'); // profile 失敗不算錯誤
    assert.ok(!visible().includes(CANARY), '權杖出現在記錄、快取或畫面上');
    for (const s of PII) assert.ok(!visible().includes(s), `個資「${s}」出現在記錄、快取或畫面上`);
  } finally {
    h.dispose();
  }
});

test('資安：profile 回應裡的 email、名字、uuid 不會寫進快取', async () => {
  const { fetchProfile: realProfile } = require('../src/usage');
  const h = load({
    profile: (token) => realProfile(token, { fetchImpl: async () => new Response(JSON.stringify(PROFILE), { status: 200 }) }),
  });
  try {
    await settle();
    const raw = fs.readFileSync(path.join(h.storage, 'last-usage.json'), 'utf8');
    for (const s of PII) assert.ok(!raw.includes(s), `快取裡出現了「${s}」`);
    assert.equal(JSON.parse(raw).plan, 'max');
    assert.equal(JSON.parse(raw).tier, 'default_claude_max_5x');
  } finally {
    h.dispose();
  }
});

test('資安：預期外錯誤的訊息裡，家目錄換成 ~', async () => {
  const home = os.homedir();
  const h = load({
    creds: async () => { throw new Error(`EACCES: permission denied, open '${path.join(home, '.claude', '.credentials.json')}'`); },
  });
  try {
    await settle();
    const shown = [...h.logs, h.item.tooltip?.value, h.item.accessibilityInformation?.label].join('\n');
    assert.match(shown, /permission denied, open '~/);
    assert.ok(!shown.includes(home), '記錄或卡片上出現了家目錄');
  } finally {
    h.dispose();
  }
});
