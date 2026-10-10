'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseUsage, fetchUsage, readCredentials, parseRetryAfter, UsageError } = require('../src/usage');

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

test('資安：每種失敗情況的錯誤都不帶權杖', async () => {
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
  for (const [name, fetchImpl] of Object.entries(cases)) {
    const err = await fetchUsage(CANARY, { fetchImpl }).then(() => null, (e) => e);
    assert.ok(err instanceof UsageError, `${name} 應該丟 UsageError`);
    assert.ok(!exposed(err).includes(CANARY), `${name} 的錯誤帶出了權杖`);
    assert.equal(err.cause, undefined, `${name} 不應該把原始錯誤掛在 cause 上`);
  }
});

test('資安：權杖只送往 https://api.anthropic.com', async () => {
  /** @type {string[]} */
  const urls = [];
  await fetchUsage(CANARY, {
    fetchImpl: async (url, init) => {
      urls.push(String(url));
      assert.equal(/** @type {any} */ (init).headers.Authorization, `Bearer ${CANARY}`);
      return new Response(JSON.stringify(SAMPLE), { status: 200 });
    },
  });
  assert.deepEqual(urls.map((u) => new URL(u).origin), ['https://api.anthropic.com']);
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
