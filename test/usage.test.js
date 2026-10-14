'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseUsage, fetchUsage, fetchProfile, parseProfile, readCredentials, parseRetryAfter, UsageError } = require('../src/usage');

// 測試一律用假的 fetchImpl；萬一哪個測試漏了，也不能真的連上 api.anthropic.com
globalThis.fetch = async () => { throw new Error('tests must not hit the network'); };

// 照回應的格式編的範例資料（resets_at 帶微秒，和真的回應一樣）
const SAMPLE = {
  five_hour: { utilization: 9.0, resets_at: '2026-01-15T03:00:00.123456+00:00' },
  seven_day: { utilization: 53.0, resets_at: '2026-01-20T00:00:00.654321+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: 'session', percent: 9, resets_at: '2026-01-15T03:00:00.123456+00:00' },
    { kind: 'weekly_all', percent: 53, resets_at: '2026-01-20T00:00:00.654321+00:00' },
  ],
};

/** limits[] 裡模型專屬的週額度（新版回應的寫法） */
const scoped = (/** @type {any} */ scope, percent = 58, extra = {}) => ({
  kind: 'weekly_scoped', group: 'weekly', percent, severity: 'normal', resets_at: '2026-01-20T00:00:00.654321+00:00', scope, is_active: true, ...extra,
});
const FABLE = scoped({ model: { id: null, display_name: 'Fable' }, surface: null });

test('parseUsage 讀出 5 小時與 7 天', () => {
  const u = parseUsage(SAMPLE);
  assert.equal(u.fiveHour?.percent, 9);
  assert.equal(u.sevenDay?.percent, 53);
  assert.equal(u.fiveHour?.resetsAt, Date.UTC(2026, 0, 15, 3, 0, 0, 123));
  assert.deepEqual(u.extras, []);
});

test('parseUsage 在 five_hour 缺席時改用 limits[]', () => {
  const u = parseUsage({ limits: SAMPLE.limits });
  assert.equal(u.fiveHour?.percent, 9);
  assert.equal(u.sevenDay?.percent, 53);
});

test('parseUsage 帶出 Max 方案的額外區間', () => {
  const u = parseUsage({ ...SAMPLE, seven_day_sonnet: { utilization: 12.5, resets_at: null } });
  assert.deepEqual(u.extras, [{ key: 'seven_day_sonnet', label: 'Sonnet', window: { percent: 12.5, resetsAt: null } }]);
});

test('parseUsage 拒絕沒有用量的回應', () => {
  assert.throws(() => parseUsage({}), (e) => e instanceof UsageError && e.code === 'bad-response');
  assert.throws(() => parseUsage(null), (e) => e instanceof UsageError && e.code === 'bad-response');
  assert.throws(() => parseUsage({ five_hour: { utilization: 'x' } }), /No 5-hour or 7-day data/);
});

test('parseUsage 從 limits[] 讀出模型專屬的週額度（僅 Fable）', () => {
  const u = parseUsage({ ...SAMPLE, limits: [...SAMPLE.limits, FABLE] });
  assert.deepEqual(u.extras, [{ key: 'weekly_scoped_fable', label: 'Fable', window: { percent: 58, resetsAt: Date.UTC(2026, 0, 20, 0, 0, 0, 654) } }]);
  assert.equal(u.sevenDay?.percent, 53); // weekly_all 不受影響
});

test('parseUsage 略過沒有名稱或沒有數字的 weekly_scoped', () => {
  const limits = [
    ...SAMPLE.limits,
    scoped(null),
    scoped({ model: null, surface: null }),
    scoped({ model: { id: 'x', display_name: null }, surface: null }),
    scoped({ model: { display_name: '   ' }, surface: null }),
    scoped({ model: { display_name: 'Ghost' } }, 'n/a'),
    null,
    'junk',
  ];
  assert.deepEqual(parseUsage({ ...SAMPLE, limits }).extras, []);
});

test('parseUsage 的 weekly_scoped 不和 seven_day_sonnet 重複，順序是頂層欄位在前', () => {
  const body = {
    ...SAMPLE,
    seven_day_sonnet: { utilization: 12.5, resets_at: null },
    limits: [...SAMPLE.limits, scoped({ model: { display_name: 'sonnet' } }, 40), FABLE, scoped({ model: { display_name: 'FABLE' } }, 99)],
  };
  assert.deepEqual(parseUsage(body).extras.map((e) => [e.key, e.label, e.window.percent]), [
    ['seven_day_sonnet', 'Sonnet', 12.5],
    ['weekly_scoped_fable', 'Fable', 58],
  ]);
});

test('parseUsage 的 weekly_scoped key 只含安全字元（會當 SVG 的 id）', () => {
  const u = parseUsage({ ...SAMPLE, limits: [...SAMPLE.limits, scoped({ model: { display_name: 'Opus 4.1' } }), scoped({ model: { display_name: '<Fable>&"x"' } })] });
  assert.deepEqual(u.extras.map((e) => e.key), ['weekly_scoped_opus_4_1', 'weekly_scoped__fable___x_']);
  assert.equal(u.extras[0].label, 'Opus 4.1');
  for (const e of u.extras) assert.match(e.key, /^[a-z0-9_]+$/);
});

test('parseUsage 的 weekly_scoped 也接受 surface 型的 scope', () => {
  const u = parseUsage({ ...SAMPLE, limits: [...SAMPLE.limits, scoped({ model: null, surface: { id: 'cc', display_name: 'Claude Code' } }, 30)] });
  assert.deepEqual(u.extras, [{ key: 'weekly_scoped_claude_code', label: 'Claude Code', window: { percent: 30, resetsAt: Date.UTC(2026, 0, 20, 0, 0, 0, 654) } }]);
});

/* ───────────── profile 端點：方案名稱 ───────────── */

// 照 profile 回應的格式編的範例資料（個資欄位放了會被認出來的值）
const PROFILE = {
  account: { uuid: 'acct-uuid-0000', full_name: 'Some One', display_name: 'Someone', email: 'someone@example.com', has_claude_max: true, has_claude_pro: false, created_at: '2025-01-01T00:00:00Z' },
  organization: { uuid: 'org-uuid-0000', name: "Some One's Organization", organization_type: 'claude_max', billing_type: 'stripe_subscription', rate_limit_tier: 'default_claude_max_5x', seat_tier: null, has_extra_usage_enabled: false, subscription_status: 'active' },
  application: { uuid: 'app-uuid', name: 'Claude Code', slug: 'claude-code' },
  enabled_plugins: [],
};
const profileOf = (/** @type {string | null} */ type, tier = null, account = {}) => ({ account, organization: { organization_type: type, rate_limit_tier: tier } });

test('parseProfile 讀出方案與等級', () => {
  assert.deepEqual(parseProfile(PROFILE), { plan: 'max', tier: 'default_claude_max_5x' });
  assert.deepEqual(parseProfile(profileOf('claude_pro', 'default_claude_pro')), { plan: 'pro', tier: 'default_claude_pro' });
  assert.deepEqual(parseProfile(profileOf('claude_max', 'default_claude_max_20x')), { plan: 'max', tier: 'default_claude_max_20x' });
  assert.deepEqual(parseProfile(profileOf('claude_team')), { plan: 'team', tier: null });
  assert.deepEqual(parseProfile(profileOf('claude_enterprise', 'enterprise')), { plan: 'enterprise', tier: 'enterprise' });
  // 沒看過的 organization_type：去掉 claude_ 前綴直接當 key
  assert.deepEqual(parseProfile(profileOf('claude_foo')), { plan: 'foo', tier: null });
  assert.deepEqual(parseProfile(profileOf('Claude_Ultra')), { plan: 'ultra', tier: null });
});

test('parseProfile 沒有 organization_type 時看 has_claude_* 旗標', () => {
  assert.deepEqual(parseProfile({ account: { has_claude_max: true, has_claude_pro: true } }), { plan: 'max', tier: null });
  assert.deepEqual(parseProfile({ account: { has_claude_max: false, has_claude_pro: true } }), { plan: 'pro', tier: null });
  assert.deepEqual(parseProfile(profileOf(null, 'default_claude_pro', { has_claude_pro: true })), { plan: 'pro', tier: 'default_claude_pro' });
  assert.deepEqual(parseProfile({ account: { has_claude_max: 'yes' } }), { plan: null, tier: null }); // 不是 true 就不算
  assert.deepEqual(parseProfile({ organization: { organization_type: 42, rate_limit_tier: 7 } }), { plan: null, tier: null });
  assert.deepEqual(parseProfile({}), { plan: null, tier: null });
  assert.deepEqual(parseProfile({ account: null, organization: null }), { plan: null, tier: null });
  assert.throws(() => parseProfile(null), (e) => e instanceof UsageError && e.code === 'bad-response');
  assert.throws(() => parseProfile('max'), (e) => e instanceof UsageError && e.code === 'bad-response');
  assert.throws(() => parseProfile([]), (e) => e instanceof UsageError && e.code === 'bad-response');
});

test('資安：parseProfile 只帶出方案與等級，不帶 email、名字、uuid', () => {
  const p = parseProfile({ ...PROFILE, token: 'sk-ant-oat01-CANARY-profile-1234567890' });
  assert.deepEqual(Object.keys(p).sort(), ['plan', 'tier']);
  const json = JSON.stringify(p);
  for (const s of ['someone@example.com', 'Some One', 'Someone', 'acct-uuid-0000', 'org-uuid-0000', 'CANARY', 'stripe']) {
    assert.ok(!json.includes(s), `parseProfile 帶出了「${s}」`);
  }
});

test('fetchProfile 打 profile 端點，標頭和 fetchUsage 相同', async () => {
  /** @type {any} */
  let seen;
  const p = await fetchProfile('tok', {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(PROFILE), { status: 200 });
    },
  });
  assert.deepEqual(p, { plan: 'max', tier: 'default_claude_max_5x' });
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/profile');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen.init.headers.Accept, 'application/json');
  assert.equal(seen.init.headers['User-Agent'], `pacelight/${require('../package.json').version}`);
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test('fetchProfile 的錯誤分類和 fetchUsage 一致', async () => {
  const code = async (/** @type {any} */ f) => fetchProfile('t', { fetchImpl: f }).then(() => 'ok', (e) => e.code);
  assert.equal(await code(fakeFetch(401, {})), 'unauthorized');
  assert.equal(await code(fakeFetch(403, {})), 'unauthorized');
  assert.equal(await code(fakeFetch(429, {})), 'rate-limited');
  assert.equal(await code(fakeFetch(500, {})), 'http');
  assert.equal(await code(fakeFetch(200, 'not json')), 'bad-response');
  assert.equal(await code(fakeFetch(200, null)), 'bad-response');
  assert.equal(await code(async () => { throw new TypeError('fetch failed'); }), 'network');
  const err = await fetchProfile('t', { fetchImpl: fakeFetch(429, {}, { 'retry-after': '90' }) }).catch((e) => e);
  assert.equal(err.retryAfterMs, 90_000);
});

/** @param {number} status @param {any} body @param {Record<string,string>} [headers] */
const fakeFetch = (status, body, headers = {}) => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

test('fetchUsage 成功時帶正確的標頭', async () => {
  /** @type {any} */
  let seen;
  const u = await fetchUsage('tok', {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    },
  });
  assert.equal(u.sevenDay?.percent, 53);
  assert.equal(seen.url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(seen.init.headers['User-Agent'], `pacelight/${require('../package.json').version}`);
});

test('fetchUsage 依狀態碼分類錯誤', async () => {
  const code = async (/** @type {any} */ f) => fetchUsage('t', { fetchImpl: f }).then(() => 'ok', (e) => e.code);
  assert.equal(await code(fakeFetch(401, {})), 'unauthorized');
  assert.equal(await code(fakeFetch(403, {})), 'unauthorized');
  assert.equal(await code(fakeFetch(429, {})), 'rate-limited');
  assert.equal(await code(fakeFetch(500, {})), 'http');
  assert.equal(await code(fakeFetch(200, 'not json')), 'bad-response');
  assert.equal(await code(async () => { throw new TypeError('fetch failed'); }), 'network');
});

test('fetchUsage 在 429 時帶出 Retry-After', async () => {
  const err = await fetchUsage('t', { fetchImpl: fakeFetch(429, {}, { 'retry-after': '90' }) }).catch((e) => e);
  assert.equal(err.retryAfterMs, 90_000);
});

test('parseRetryAfter 支援秒數與日期', () => {
  assert.equal(parseRetryAfter('30'), 30_000);
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter('garbage'), undefined);
  const now = Date.parse('2026-10-08T00:00:00Z');
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 00:01:00 GMT', now), 60_000);
});

// ── 資安：權杖不能出現在任何錯誤裡（錯誤訊息會寫進記錄、顯示在卡片上） ──

const CANARY = 'sk-ant-oat01-CANARY-do-not-leak-1234567890';

/** 把錯誤能被看到的地方全部攤開：訊息、細節、堆疊、cause、JSON */
const exposed = (/** @type {any} */ e) =>
  [String(e), e?.message, e?.detail, e?.stack, String(e?.cause ?? ''), e?.cause?.stack, JSON.stringify(e)].join('\n');

test('資安：每種失敗情況的錯誤都不帶權杖（usage 與 profile 端點）', async () => {
  const cases = {
    unauthorized: fakeFetch(401, { error: 'invalid token' }),
    'rate-limited': fakeFetch(429, {}, { 'retry-after': '5' }),
    http: fakeFetch(500, 'oops'),
    'bad-response': fakeFetch(200, 'not json'),
    // fetch 自己的錯誤可能把整個請求（含標頭）寫進訊息，要整個丟掉
    network: async (/** @type {any} */ _url, /** @type {any} */ init) => {
      throw new TypeError(`fetch failed: ${init.headers.Authorization}`, { cause: new Error(`header ${init.headers.Authorization}`) });
    },
    timeout: async () => { throw new DOMException(`aborted with ${CANARY}`, 'TimeoutError'); },
  };
  for (const [fnName, fn] of [['fetchUsage', fetchUsage], ['fetchProfile', fetchProfile]]) {
    for (const [name, fetchImpl] of Object.entries(cases)) {
      const err = await fn(CANARY, { fetchImpl }).then(() => null, (e) => e);
      assert.ok(err instanceof UsageError, `${fnName} ${name} 應該丟 UsageError`);
      assert.ok(!exposed(err).includes(CANARY), `${fnName} ${name} 的錯誤帶出了權杖`);
      assert.equal(err.cause, undefined, `${fnName} ${name} 不應該把原始錯誤掛在 cause 上`);
    }
  }
});

test('資安：權杖只送往 https://api.anthropic.com（usage 與 profile 端點）', async () => {
  /** @type {string[]} */
  const urls = [];
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    urls.push(String(url));
    assert.equal(init.headers.Authorization, `Bearer ${CANARY}`);
    return new Response(JSON.stringify(String(url).endsWith('/profile') ? PROFILE : SAMPLE), { status: 200 });
  };
  await fetchUsage(CANARY, { fetchImpl });
  await fetchProfile(CANARY, { fetchImpl });
  assert.deepEqual(urls.map((u) => new URL(u).origin), ['https://api.anthropic.com', 'https://api.anthropic.com']);
  assert.deepEqual(urls.map((u) => new URL(u).pathname), ['/api/oauth/usage', '/api/oauth/profile']);
});

test('資安：解析結果只有用量數字，不會把回應裡多的欄位帶出去', () => {
  const u = parseUsage({ ...SAMPLE, account: { email: 'someone@example.com' }, token: CANARY });
  assert.ok(!JSON.stringify(u).includes(CANARY));
  assert.ok(!JSON.stringify(u).includes('someone@example.com'));
});

test('資安：登入資料讀壞了，錯誤也不帶權杖', async () => {
  // 假裝不是 macOS，只讀暫存資料夾裡的 .credentials.json，不碰真的鑰匙圈和登入
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pacelight-creds-'));
  const saved = { platform: process.platform, secure: process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, config: process.env.CLAUDE_CONFIG_DIR };
  Object.defineProperty(process, 'platform', { value: 'linux' });
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    const file = path.join(dir, '.credentials.json');
    const broken = {
      // JSON.parse 的錯誤訊息會引用出錯位置附近約 10 個字，所以讓壞掉的地方剛好是權杖
      'JSON 壞掉': `${CANARY.replace('sk-ant-oat01-', '')} {"claudeAiOauth":`,
      '權杖帶換行': JSON.stringify({ claudeAiOauth: { accessToken: `${CANARY}\nX-Evil: 1` } }),
      '沒有權杖': JSON.stringify({ claudeAiOauth: { refreshToken: CANARY } }),
    };
    for (const [name, raw] of Object.entries(broken)) {
      fs.writeFileSync(file, raw);
      const err = await readCredentials().then(() => null, (e) => e);
      assert.equal(err?.code, 'no-login', name);
      assert.ok(!exposed(err).includes('CANARY'), `${name} 的錯誤帶出了權杖`);
    }
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: CANARY, expiresAt: 1, subscriptionType: 'pro' } }));
    assert.equal((await readCredentials()).accessToken, CANARY);
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    for (const [key, value] of [['CLAUDE_SECURESTORAGE_CONFIG_DIR', saved.secure], ['CLAUDE_CONFIG_DIR', saved.config]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
