'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TokenLedger, parseLine, entryCost, priceFor, modelName, summarize } = require('../src/tokens');

/** 一行 Claude Code 記錄（格式照實際的 .jsonl） */
const line = ({ id = 'msg_1', req = 'req_1', model = 'claude-opus-5-5', t = '2026-10-08T05:00:00.000Z', input = 2, output = 100, write5m = 0, write1h = 1000, read = 5000, speed = 'standard', web = 0 } = {}) =>
  JSON.stringify({
    type: 'assistant',
    requestId: req,
    timestamp: t,
    message: {
      id,
      model,
      content: [{ type: 'text', text: 'hi "usage" in text should not confuse the filter' }],
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: write5m + write1h,
        cache_read_input_tokens: read,
        cache_creation: { ephemeral_5m_input_tokens: write5m, ephemeral_1h_input_tokens: write1h },
        server_tool_use: { web_search_requests: web, web_fetch_requests: 0 },
        speed,
      },
    },
  });

test('parseLine 只取回覆行的 usage', () => {
  const hit = parseLine(line());
  assert.equal(hit?.key, 'msg_1:req_1');
  assert.deepEqual(
    { ...hit?.entry, t: undefined },
    { t: undefined, model: 'claude-opus-5-5', input: 2, output: 100, write5m: 0, write1h: 1000, cacheRead: 5000, webSearch: 0, fast: false, us: false }
  );
  assert.equal(parseLine(JSON.stringify({ type: 'user', message: { content: 'x' } })), null);
  assert.equal(parseLine('{not json "usage" "assistant"'), null);
  assert.equal(parseLine(line({ model: '<synthetic>' })), null);
  // 舊記錄沒有 cache_creation 細項：整筆當 5 分鐘寫入
  const old = JSON.parse(line());
  delete old.message.usage.cache_creation;
  assert.equal(parseLine(JSON.stringify(old))?.entry.write5m, 1000);
});

test('計價：照官方牌價', () => {
  const e = parseLine(line({ input: 1e6, output: 1e6, write5m: 1e6, write1h: 1e6, read: 1e6 }))?.entry;
  assert.ok(e);
  // Opus 5.5：輸入 4、輸出 20、5 分鐘寫入 5、1 小時寫入 8、快取讀取 0.2
  assert.equal(entryCost(e).toFixed(2), (4 + 20 + 5 + 8 + 0.2).toFixed(2));
  // 快速模式：輸入 8、輸出 40，快取倍率疊在快速模式輸入價上（讀取 0.05 倍 → 0.4）
  assert.equal(entryCost({ ...e, fast: true }).toFixed(2), (8 + 40 + 10 + 16 + 0.4).toFixed(2));
  // 網路搜尋每次 $0.01；美國境內推論 1.1 倍
  assert.equal(entryCost({ ...e, input: 0, output: 0, write5m: 0, write1h: 0, cacheRead: 0, webSearch: 3 }).toFixed(2), '0.03');
  assert.equal(entryCost({ ...e, us: true }).toFixed(3), ((4 + 20 + 5 + 8 + 0.2) * 1.1).toFixed(3));
  // Haiku 5.5 提示超過 10 萬 token 改用較高價格
  const short = { ...e, model: 'claude-haiku-5-5', input: 50_000, output: 0, write5m: 0, write1h: 0, cacheRead: 0 };
  assert.equal(entryCost(short).toFixed(4), (0.05 * 0.1).toFixed(4));
  assert.equal(entryCost({ ...short, input: 200_000 }).toFixed(4), (0.2 * 0.5).toFixed(4));
  // 沒有牌價的模型
  assert.equal(entryCost({ ...e, model: 'claude-3-7-sonnet-20250219' }), null);
});

test('模型比對與名稱', () => {
  assert.equal(priceFor('claude-opus-4-8-20260101')?.prefix, 'claude-opus-4-8');
  assert.equal(priceFor('claude-opus-4-20250514')?.prefix, 'claude-opus-4');
  assert.equal(priceFor('claude-sonnet-5')?.cacheRead, 0.2);
  assert.equal(priceFor('claude-sonnet-5-5')?.cacheRead, 0.1);
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-3-5-haiku-20241022'), 'Haiku 3.5');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('claude-opus-4-20250514'), 'Opus 4');
});

test('summarize 依時間區間加總', () => {
  const t = Date.parse('2026-10-08T05:00:00Z');
  const a = /** @type {any} */ (parseLine(line({ id: 'a' }))).entry;
  const b = { ...a, t: t - 10 * 3_600_000, model: 'claude-3-7-sonnet' };
  const s = summarize([a, b], t - 3_600_000, t + 1);
  assert.equal(s.requests, 1);
  assert.equal(s.total, 2 + 100 + 1000 + 5000);
  assert.equal(s.topModel, 'Opus 5.5');
  const all = summarize([a, b], 0, t + 1);
  assert.equal(all.unpricedTokens, 6102);
});

test('TokenLedger：去重、取最終值、增量讀取半行、子資料夾', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pacelight-tokens-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = path.join(root, 'proj', 'sess.jsonl');
  const sub = path.join(root, 'proj', 'sess', 'subagents', 'agent-1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  const now = Date.parse('2026-10-08T06:00:00Z');

  // 同一則回覆三行：串流中途的 output 較小，最後一行是最終值
  fs.writeFileSync(session, [line({ output: 10 }), line({ output: 100 }), line({ output: 100 })].join('\n') + '\n');
  fs.writeFileSync(sub, line({ id: 'sub', model: 'claude-haiku-5-5', input: 10, output: 20, write1h: 0, read: 0 }) + '\n');

  const ledger = new TokenLedger({ root });
  await ledger.update(now);
  assert.equal(ledger.entries.size, 2);
  assert.equal(ledger.entries.get('msg_1:req_1')?.output, 100);

  // 再寫入半行：還不算；補完才算
  const next = line({ id: 'msg_2', output: 7 });
  fs.appendFileSync(session, next.slice(0, 40));
  assert.ok((await ledger.update(now)) > 0);
  assert.equal(ledger.entries.size, 2);
  fs.appendFileSync(session, next.slice(40) + '\n');
  await ledger.update(now);
  assert.equal(ledger.entries.size, 3);
  assert.equal(await ledger.update(now), 0, '沒有新內容時不讀');

  // 超過保留期限的會被清掉
  await ledger.update(now + 9 * 24 * 3_600_000);
  assert.equal(ledger.entries.size, 0);
});
