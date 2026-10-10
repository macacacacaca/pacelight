// @ts-check
'use strict';

// 從 Claude Code 存在本機的對話記錄（~/.claude/projects/**/*.jsonl）統計 token 用量，
// 並依 Anthropic API 牌價換算成「如果用 API 要花多少錢」。不依賴 vscode。
//
// - 只讀每則回覆的 usage 數字，不讀、不存對話內容。
// - 同一則回覆會因為每個內容區塊各寫一行而重複出現，用 message.id + requestId 去重；
//   串流途中的行數字較小，所以每個欄位取最大值（＝最終值）。
// - 只算這台電腦上的 Claude Code；claude.ai 網頁、其他電腦的用量不在記錄裡。

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

/**
 * API 牌價（美元／每百萬 token），2026-10-08 取自 https://platform.claude.com/docs/en/about-claude/pricing
 * 快取寫入：5 分鐘 1.25 倍、1 小時 2 倍輸入價；快取讀取依模型而定（另列）。
 * 依前綴比對，長的先比（claude-opus-4-8 要先於 claude-opus-4）。
 * @type {{ prefix: string, input: number, output: number, cacheRead: number, fast?: { input: number, output: number }, long?: { over: number, input: number, output: number, cacheRead: number } }[]}
 */
const PRICES = [
  { prefix: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { prefix: 'claude-fable-5', input: 10, output: 50, cacheRead: 1 },
  { prefix: 'claude-mythos-5', input: 10, output: 50, cacheRead: 1 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, fast: { input: 8, output: 40 } },
  { prefix: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  { prefix: 'claude-opus-4-8', input: 5, output: 25, cacheRead: 0.5, fast: { input: 10, output: 50 } },
  { prefix: 'claude-opus-4-7', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-5', input: 5, output: 25, cacheRead: 0.5 },
  { prefix: 'claude-opus-4-1', input: 15, output: 75, cacheRead: 1.5 },
  { prefix: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5 },
  { prefix: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.1 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3 },
  { prefix: 'claude-sonnet-4-5', input: 3, output: 15, cacheRead: 0.3 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3 },
  { prefix: 'claude-haiku-5-5', input: 0.1, output: 0.5, cacheRead: 0.01, long: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1 },
  { prefix: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08 },
].sort((a, b) => b.prefix.length - a.prefix.length);

const WEB_SEARCH_USD = 0.01; // 每次 $10 / 1,000
const US_GEO_MULTIPLIER = 1.1;

/** @param {string} model */
function priceFor(model) {
  return PRICES.find((p) => model.includes(p.prefix)) ?? null;
}

/** 顯示用的模型名稱：claude-opus-5-5 → Opus 5.5 */
function modelName(/** @type {string} */ model) {
  const m = model.match(/claude-(?:(\d)-(\d)-)?([a-z]+)(?:-(\d+))?(?:-(\d+))?/);
  if (!m) return model;
  const family = m[3].charAt(0).toUpperCase() + m[3].slice(1);
  const version = m[1] ? `${m[1]}.${m[2]}` : [m[4], m[5] && m[5].length <= 2 ? m[5] : null].filter(Boolean).join('.');
  return version ? `${family} ${version}` : family;
}

/**
 * @typedef {{ t: number, model: string, input: number, output: number, write5m: number, write1h: number, cacheRead: number, webSearch: number, fast: boolean, us: boolean }} Entry
 */

/** 一則回覆換算成美元；沒有牌價的模型回傳 null */
function entryCost(/** @type {Entry} */ e) {
  const p = priceFor(e.model);
  if (!p) return null;
  const prompt = e.input + e.write5m + e.write1h + e.cacheRead;
  let { input, output, cacheRead } = p;
  if (p.long && prompt > p.long.over) ({ input, output, cacheRead } = p.long);
  if (e.fast && p.fast) {
    // 快速模式另有價格，快取倍率疊在快速模式的輸入價上
    cacheRead = (cacheRead / input) * p.fast.input;
    ({ input, output } = p.fast);
  }
  const usd =
    (e.input * input + e.write5m * input * 1.25 + e.write1h * input * 2 + e.cacheRead * cacheRead + e.output * output) / 1e6 +
    e.webSearch * WEB_SEARCH_USD;
  return e.us ? usd * US_GEO_MULTIPLIER : usd;
}

/**
 * 從一行記錄取出 usage；不是有用量的回覆就回傳 null。
 * @param {string} line
 * @returns {{ key: string, entry: Entry } | null}
 */
function parseLine(line) {
  // 先用字串篩，只有回覆行才 JSON.parse（大部分行是工具結果，很長）
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const m = d?.message;
  const u = m?.usage;
  if (d.type !== 'assistant' || !u || typeof m.model !== 'string' || m.model.startsWith('<')) return null;
  const t = Date.parse(d.timestamp);
  if (!Number.isFinite(t)) return null;
  const n = (/** @type {any} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const created = n(u.cache_creation_input_tokens);
  const has1h = u.cache_creation && typeof u.cache_creation === 'object';
  const write1h = has1h ? n(u.cache_creation.ephemeral_1h_input_tokens) : 0;
  // 舊記錄沒有分 5 分鐘／1 小時，當作 5 分鐘
  const write5m = has1h ? n(u.cache_creation.ephemeral_5m_input_tokens) : created;
  return {
    key: `${m.id ?? d.uuid}:${d.requestId ?? ''}`,
    entry: {
      t,
      model: m.model,
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      write5m,
      write1h,
      cacheRead: n(u.cache_read_input_tokens),
      webSearch: n(u.server_tool_use?.web_search_requests),
      fast: u.speed === 'fast',
      us: u.inference_geo === 'us',
    },
  };
}

/**
 * @typedef {{
 *   input: number, output: number, cacheWrite: number, cacheRead: number, total: number,
 *   cost: number, unpricedTokens: number, requests: number, topModel: string | null, topModelShare: number,
 * }} Summary
 */

/**
 * 統計某段時間內的用量。
 * @param {Iterable<Entry>} entries
 * @param {number} from
 * @param {number} to
 * @returns {Summary}
 */
function summarize(entries, from, to) {
  const s = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0, unpricedTokens: 0, requests: 0, topModel: /** @type {string | null} */ (null), topModelShare: 0 };
  /** @type {Map<string, number>} */
  const byModel = new Map();
  for (const e of entries) {
    if (e.t < from || e.t > to) continue;
    const tokens = e.input + e.output + e.write5m + e.write1h + e.cacheRead;
    s.requests++;
    s.input += e.input;
    s.output += e.output;
    s.cacheWrite += e.write5m + e.write1h;
    s.cacheRead += e.cacheRead;
    s.total += tokens;
    const usd = entryCost(e);
    if (usd == null) s.unpricedTokens += tokens;
    else {
      s.cost += usd;
      byModel.set(e.model, (byModel.get(e.model) ?? 0) + usd);
    }
  }
  let best = 0;
  for (const [model, usd] of byModel) {
    if (usd > best) [best, s.topModel] = [usd, modelName(model)];
  }
  s.topModelShare = s.cost > 0 ? best / s.cost : 0;
  return s;
}

/** Claude Code 放對話記錄的資料夾 */
function projectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/** @param {string} dir @returns {AsyncGenerator<string>} */
async function* walk(dir) {
  let list;
  try {
    list = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

const CHUNK = 4 * 1024 * 1024;

/**
 * 增量讀取：記住每個檔案讀到哪裡，下次只讀新增的部分。
 */
class TokenLedger {
  /** @param {{ root?: string, retentionMs?: number }} [opts] */
  constructor({ root = projectsDir(), retentionMs = 8 * 24 * 3_600_000 } = {}) {
    this.root = root;
    this.retentionMs = retentionMs;
    /** @type {Map<string, { offset: number, rest: string }>} */
    this.files = new Map();
    /** @type {Map<string, Entry>} */
    this.entries = new Map();
  }

  /** @param {{ key: string, entry: Entry }} hit */
  upsert({ key, entry }) {
    const old = this.entries.get(key);
    if (!old) {
      this.entries.set(key, entry);
      return;
    }
    for (const k of /** @type {const} */ (['input', 'output', 'write5m', 'write1h', 'cacheRead', 'webSearch'])) {
      old[k] = Math.max(old[k], entry[k]);
    }
  }

  /** 掃描新的記錄；回傳讀了多少位元組 */
  async update(now = Date.now()) {
    const since = now - this.retentionMs;
    let readBytes = 0;
    for await (const file of walk(this.root)) {
      let st;
      try {
        st = await fs.stat(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < since) continue;
      let state = this.files.get(file);
      if (!state || st.size < state.offset) {
        // 新檔案，或檔案被改寫變短：從頭讀
        state = { offset: 0, rest: '' };
        this.files.set(file, state);
      }
      if (st.size === state.offset) continue;
      readBytes += await this.readFrom(file, state, st.size);
    }
    for (const [key, e] of this.entries) if (e.t < since) this.entries.delete(key);
    return readBytes;
  }

  /**
   * @param {string} file
   * @param {{ offset: number, rest: string }} state
   * @param {number} size
   */
  async readFrom(file, state, size) {
    let handle;
    try {
      handle = await fs.open(file, 'r');
    } catch {
      return 0;
    }
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(Math.min(CHUNK, size - state.offset));
    let read = 0;
    try {
      while (state.offset < size) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - state.offset), state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        read += bytesRead;
        const lines = (state.rest + decoder.write(buf.subarray(0, bytesRead))).split('\n');
        // 最後一段可能還沒寫完整，留到下次
        state.rest = lines.pop() ?? '';
        for (const line of lines) {
          const hit = parseLine(line);
          if (hit) this.upsert(hit);
        }
      }
    } finally {
      await handle.close();
    }
    return read;
  }

  /**
   * @param {number} from
   * @param {number} to
   */
  summarize(from, to) {
    return summarize(this.entries.values(), from, to);
  }
}

module.exports = { TokenLedger, summarize, parseLine, entryCost, priceFor, modelName, projectsDir, PRICES };
