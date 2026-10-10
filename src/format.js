// @ts-check
'use strict';

// 畫面：狀態列文字、滑鼠提示裡的 SVG 用量卡片、讀屏文字。純函式，不依賴 vscode。
// 文字都在 src/i18n.js，這裡只負責邏輯與排版。
//
// 設計參考（研究時都查證過獎項）：
// - Flighty（2023 Apple 設計獎・互動）：像機場看板，一行一個區間；平常安靜，出狀況時版面才改變。
// - Gentler Streak（2024 Apple 設計獎・社會影響）、Copilot Money（2024 決選）：
//   比較「用量」和「時間過了多少」的步調線；文字溫和、不嚇人。
// - Apple HIG Gauges／Charts：固定 0–100 刻度、先用一句話講重點、不只靠顏色表達狀態。
// - 配色：偏暖的中性色，強調色（陶土橘）只用在「超前的用量」。

const { localeFor } = require('./i18n');

/** @typedef {import('./usage').Usage} Usage */
/** @typedef {import('./usage').UsageWindow} UsageWindow */
/** @typedef {import('./i18n').Locale} Locale */
/** @typedef {import('./tokens').Summary} TokenSummary */
/** @typedef {{ five_hour: TokenSummary | null, seven_day: TokenSummary | null }} TokenWindows */
/** @typedef {'dark' | 'light' | 'hc-dark' | 'hc-light'} Theme */
/** @typedef {'normal' | 'warning' | 'error'} Level */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PLAN_NAMES = /** @type {Record<string, string>} */ ({ pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' });

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const clamp = (/** @type {number} */ x, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));

/**
 * 狀態列自訂格式用的短倒數：42m、2h10m、5d4h（不分語言）。
 * @param {number | null} resetsAt
 * @param {number} now
 */
function shortCountdown(resetsAt, now) {
  if (resetsAt == null) return '?';
  const mins = Math.max(0, Math.ceil((resetsAt - now) / MINUTE));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${pad(mins % 60)}m`;
  return `${Math.floor(hours / 24)}d${hours % 24}h`;
}

/** 3.9M、48.2K、850 */
function formatTokens(/** @type {number} */ n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

/** $4.90、$153.27；一百美元以上取整數：$1,234 */
function formatUsd(/** @type {number} */ usd) {
  if (usd >= 100) return `$${Math.round(usd).toLocaleString('en-US')}`;
  return `$${usd.toFixed(2)}`;
}

/* ───────────── 數字、等級與步調 ───────────── */

/**
 * 顯示用的整數百分比。無條件捨去，避免 79.6% 顯示成 80% 卻沒變色、99.6% 被說成「已用完」；
 * 顏色門檻也一律用這個數字判斷，畫面上看到的和顏色永遠一致。
 * @param {number} percent
 */
const shown = (percent) => Math.floor(percent + 1e-9);

/** @param {number} percent @param {number} warn @param {number} err @returns {Level} */
function levelOf(percent, warn, err) {
  const p = shown(percent);
  if (p >= err) return 'error';
  if (p >= warn) return 'warning';
  return 'normal';
}

const RANK = { normal: 0, warning: 1, error: 2 };

/**
 * 區間的即時狀態。
 * - 過了重置時間的舊數字當作 0%（新區間剛開始）。
 * - 「偏快」只有一條規則：照目前速度會在重置前用完，而且會被擋住至少一成的區間長度。
 *   區間剛開始（時間過不到一成）樣本太少，改看用量是否比時間多 15 個百分點。
 * @param {UsageWindow | null} w
 * @param {number} lengthMs
 * @param {number} now
 */
function windowState(w, lengthMs, now) {
  if (!w) return null;
  const reset = w.resetsAt != null && w.resetsAt <= now;
  const percent = reset ? 0 : w.percent;
  const resetsAt = reset ? null : w.resetsAt;
  const elapsed = resetsAt == null ? null : clamp(1 - (resetsAt - now) / lengthMs);
  const notStarted = !reset && resetsAt == null && shown(percent) === 0;

  let runOutAt = null;
  let ahead = false;
  if (elapsed != null && resetsAt != null && percent > 0 && percent < 100) {
    const over = percent - elapsed * 100;
    if (elapsed >= 0.1) {
      const at = now + (100 - percent) * ((elapsed * lengthMs) / percent);
      const lockout = (resetsAt - at) / lengthMs;
      if (lockout >= 0.1 && over >= 5) {
        ahead = true;
        runOutAt = at;
      }
    } else {
      ahead = over >= 15;
    }
  }
  return { percent, resetsAt, elapsed, ahead, runOutAt, reset, notStarted };
}

/**
 * @typedef {{ key: string, short: string, label: string, noun: string, name: string, lengthMs: number, extra: boolean }} WindowDef
 * @typedef {{ def: WindowDef, s: NonNullable<ReturnType<typeof windowState>> }} Row
 */

/**
 * 全部區間（含 Max 方案的「僅 Opus／僅 Sonnet」）。沒資料、或額外區間還沒開始用的不列出。
 * @param {Usage} usage
 * @param {number} now
 * @param {Locale} L
 * @returns {Row[]}
 */
function rowsOf(usage, now, L) {
  const hasExtras = usage.extras.length > 0;
  /** @type {{ def: WindowDef, w: UsageWindow | null }[]} */
  const defs = [
    {
      def: { key: 'five_hour', short: '5h', label: L.label.five_hour, noun: L.noun.five_hour, name: L.name.five_hour, lengthMs: 5 * HOUR, extra: false },
      w: usage.fiveHour,
    },
    {
      def: {
        key: 'seven_day', short: '7d', label: hasExtras ? L.label.seven_day_all : L.label.seven_day,
        noun: L.noun.seven_day, name: L.name.seven_day, lengthMs: 7 * DAY, extra: false,
      },
      w: usage.sevenDay,
    },
  ];
  for (const e of usage.extras) {
    // 舊版快取的 label 是「7 天 Sonnet」，新版是「Sonnet」，兩種都接受
    const model = e.label.replace(/^7 天\s*/, '');
    if (e.window.resetsAt == null && shown(e.window.percent) === 0) continue;
    defs.push({
      def: {
        key: e.key ?? model, short: `7d ${model}`, label: L.label.extra(model), noun: L.noun.extra(model),
        name: L.name.extra(model), lengthMs: 7 * DAY, extra: true,
      },
      w: e.window,
    });
  }
  /** @type {Row[]} */
  const rows = [];
  for (const { def, w } of defs) {
    const s = windowState(w, def.lengthMs, now);
    if (s) rows.push({ def, s });
  }
  return rows;
}

/**
 * 最需要注意的那一列：等級高的優先；都快用完時取比較晚重置的（那才是真正要等的時間）。
 * @param {Row[]} rows
 * @param {number} warn
 * @param {number} err
 */
function bindingRow(rows, warn, err) {
  return [...rows].sort((a, b) => {
    const ra = RANK[levelOf(a.s.percent, warn, err)];
    const rb = RANK[levelOf(b.s.percent, warn, err)];
    if (ra !== rb) return rb - ra;
    if (ra === 2) return (b.s.resetsAt ?? 0) - (a.s.resetsAt ?? 0);
    return b.s.percent - a.s.percent;
  })[0];
}

/**
 * @param {Usage} usage
 * @param {number} warn
 * @param {number} err
 * @param {number} [now]
 */
function usageLevel(usage, warn, err, now = Date.now()) {
  const top = bindingRow(rowsOf(usage, now, localeFor('en')), warn, err);
  return top ? levelOf(top.s.percent, warn, err) : 'normal';
}

/** Things 3 式小圓餅（只給自訂格式用；預設版面不用，因為 ◔◑◕ 和 ○● 會落到不同字型） */
function pie(/** @type {number} */ percent) {
  const p = shown(percent);
  if (p >= 88) return '●';
  if (p >= 63) return '◕';
  if (p >= 38) return '◑';
  if (p >= 13) return '◔';
  return '○';
}

/* ───────────── 狀態列 ───────────── */

/**
 * 自訂格式：{five_hour} {five_hour_pie} {five_hour_reset} {five_hour_pace}
 * {five_hour_tokens} {five_hour_cost}，seven_day 同理。
 * @param {string} template
 * @param {Usage} usage
 * @param {number} now
 * @param {Locale} [L]
 * @param {TokenWindows | null} [tokens]
 */
function renderText(template, usage, now, L = localeFor('en'), tokens = null) {
  /** @type {Record<string, string>} */
  const values = {};
  const rows = rowsOf(usage, now, L);
  for (const key of ['five_hour', 'seven_day']) {
    const s = rows.find((r) => r.def.key === key)?.s;
    values[key] = s ? String(shown(s.percent)) : '?';
    values[`${key}_pie`] = s ? pie(s.percent) : '○';
    values[`${key}_reset`] = shortCountdown(s?.resetsAt ?? null, now);
    values[`${key}_pace`] = s?.ahead ? L.pace : '';
    const t = tokens?.[/** @type {'five_hour' | 'seven_day'} */ (key)];
    values[`${key}_tokens`] = t ? formatTokens(t.total) : '—';
    values[`${key}_cost`] = t ? formatUsd(t.cost) : '—';
  }
  return template.replace(/\{(\w+)\}/g, (m, key) => values[key] ?? m);
}

/**
 * 預設版面：平常「5h 13% · 7d 54% over pace」；有一項接近上限時，
 * 像 Flighty 一樣只留最需要注意的那一項，並講何時重置。
 * @param {Row[]} rows
 * @param {number} warn
 * @param {number} err
 * @param {number} now
 * @param {Locale} L
 */
function defaultText(rows, warn, err, now, L) {
  const top = bindingRow(rows, warn, err);
  if (top && levelOf(top.s.percent, warn, err) !== 'normal') {
    const p = shown(top.s.percent);
    const icon = levelOf(top.s.percent, warn, err) === 'error' ? '$(error)' : '$(warning)';
    const when = top.s.resetsAt == null ? '' : ` · ${L.resetPhrase(top.s.resetsAt, now)}`;
    return `${icon} ${top.def.short} ${p >= 100 ? L.usedUp : `${p}%`}${when}`;
  }
  const main = rows.filter((r) => !r.def.extra);
  if (!main.length) return L.unknownTotal;
  return main.map(({ def, s }) => `${def.short} ${shown(s.percent)}%${s.ahead ? ` ${L.pace}` : ''}`).join(' · ');
}

/* ───────────── 一句話摘要（先回答「撐得到重置嗎？」） ───────────── */

/**
 * @param {Row[]} rows
 * @param {number} warn
 * @param {number} err
 * @param {number} now
 * @param {Locale} L
 * @returns {{ main: string, tip: string | null }}
 */
function headline(rows, warn, err, now, L) {
  const H = L.headline;
  const alerts = rows.filter((r) => levelOf(r.s.percent, warn, err) !== 'normal');
  if (alerts.length) {
    const top = /** @type {Row} */ (bindingRow(alerts, warn, err));
    const p = shown(top.s.percent);
    const errors = alerts.filter((r) => levelOf(r.s.percent, warn, err) === 'error');
    const reset = top.s.resetsAt;
    if (errors.length >= 2 && reset != null) {
      const allOut = errors.every((r) => shown(r.s.percent) >= 100);
      return { main: H.bothOut(L.joinNames(errors.map((r) => r.def.name)), allOut, L.clock(reset, now)), tip: null };
    }
    if (p >= 100) {
      const others = top.def.extra && rows.every((r) => r === top || shown(r.s.percent) < 100);
      return { main: H.usedUp(top.def.noun, reset == null ? null : L.resetPhrase(reset, now), others), tip: null };
    }
    if (top.s.runOutAt != null && reset != null) {
      return { main: H.runOutAlert(top.def.noun, L.approxClock(top.s.runOutAt, now), L.clock(reset, now)), tip: null };
    }
    if (reset != null) return { main: H.lasts(top.def.noun, p, L.clock(reset, now)), tip: null };
    return { main: H.justPct(top.def.noun, p), tip: null };
  }

  // 會在重置前用完的：挑被擋住最久的那個
  const racing = rows
    .filter((r) => r.s.runOutAt != null && r.s.resetsAt != null)
    .sort((a, b) => (b.s.resetsAt ?? 0) - (b.s.runOutAt ?? 0) - ((a.s.resetsAt ?? 0) - (a.s.runOutAt ?? 0)))[0];
  if (racing && racing.s.runOutAt != null && racing.s.resetsAt != null) {
    const main = H.racing(racing.def.noun, L.approxClock(racing.s.runOutAt, now), L.duration(racing.s.resetsAt - racing.s.runOutAt));
    let tip = null;
    const daysLeft = (racing.s.resetsAt - now) / DAY;
    if (racing.def.lengthMs >= DAY && daysLeft >= 1) {
      tip = H.tip(L.clock(racing.s.resetsAt, now), Math.floor((100 - racing.s.percent) / daysLeft));
    }
    return { main, tip };
  }
  // 區間剛開始就用很多（樣本太少，不估用完時間，只講事實）
  const spike = rows.find((r) => r.s.ahead && r.s.elapsed != null);
  if (spike && spike.s.elapsed != null) {
    const spent = L.duration(Math.floor((spike.s.elapsed * spike.def.lengthMs) / MINUTE) * MINUTE);
    return { main: H.spike(spike.def.noun, spent, shown(spike.s.percent)), tip: null };
  }
  const top = Math.max(0, ...rows.map((r) => r.s.percent));
  return { main: top < 50 ? H.calmLow : H.calmOn, tip: null };
}

/* ───────────── 卡片配色 ───────────── */

/**
 * SVG 放在 <img> 裡讀不到 VS Code 的主題變數，所以依主題種類各給一組顏色。
 * 中性色偏暖（石板灰／米白）；陶土橘只用在「超前的用量」；
 * 警告是琥珀、錯誤是紅，和陶土橘拉開色相。小字對比度都在 4.5:1 以上。
 */
const PALETTES = {
  dark: {
    text: '#F0EEE6', secondary: '#B0AEA5', tertiary: '#9C9B94',
    track: '#33332F', fill: '#E8E6DC', accent: '#D97757', warning: '#F0AC54', error: '#FF5A5F', pace: '#F0EEE6',
  },
  light: {
    text: '#141413', secondary: '#5E5D59', tertiary: '#6E6D68',
    track: '#E8E6DC', fill: '#3D3D3A', accent: '#B5532F', warning: '#9A5200', error: '#CD2B31', pace: '#141413',
  },
  'hc-dark': {
    text: '#FFFFFF', secondary: '#FFFFFF', tertiary: '#E0E0E0',
    track: '#4A4A4A', fill: '#FFFFFF', accent: '#FFB38A', warning: '#FFD370', error: '#F48771', pace: '#FFFFFF',
  },
  'hc-light': {
    text: '#000000', secondary: '#000000', tertiary: '#292929',
    track: '#C8C8C8', fill: '#000000', accent: '#A03D18', warning: '#895503', error: '#B5200D', pace: '#000000',
  },
};

/** @param {string} s */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ───────────── SVG 卡片 ───────────── */

const CARD_W = 360;
const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang TC', 'Microsoft JhengHei', 'Segoe UI', system-ui, sans-serif";
const ROW_H = 66;

/**
 * 粗估文字寬度（SVG 不會自動換行，得自己算）。寧可估寬一點：估窄了字會被切掉。
 * @param {string} s
 * @param {number} size
 * @param {boolean} [bold] 粗體大約寬 8%
 */
function textWidth(s, size, bold = false) {
  let w = 0;
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp >= 0x2e80) w += size;
    else if (ch === ' ') w += size * 0.3;
    else if (/[0-9]/.test(ch)) w += size * 0.63;
    else if (/[A-Z]/.test(ch)) w += size * 0.72;
    else if (/[iljtf.,:;'!|()]/.test(ch)) w += size * 0.32;
    else if (/[mw—]/.test(ch)) w += size * 0.9;
    else w += size * 0.58;
  }
  return bold ? w * 1.08 : w;
}

/**
 * 換行：中文在標點後面斷，英文在空白斷；單段太長才硬切。
 * @param {string} text
 * @param {number} size
 * @param {number} maxW
 * @param {boolean} [bold]
 */
function wrap(text, size, maxW, bold = false) {
  const pieces = text.split(/(?<=[，。；：])|(?<= )/);
  const lines = [];
  let line = '';
  for (const piece of pieces) {
    if (textWidth((line + piece).trimEnd(), size, bold) <= maxW) {
      line += piece;
      continue;
    }
    if (line) lines.push(line.trimEnd());
    line = '';
    for (const ch of piece) {
      if (textWidth(line + ch, size, bold) > maxW) {
        lines.push(line);
        line = '';
      }
      line += ch;
    }
  }
  if (line) lines.push(line.trimEnd());
  return lines;
}

/**
 * 一列：標籤和大百分比同一條基線；長條（步調線）；重置時間與狀態。
 * @param {Row} row
 * @param {number} y
 * @param {typeof PALETTES.dark} c
 * @param {{ warn: number, err: number, now: number, hideTag: boolean, L: Locale }} o
 */
function windowRow({ def, s }, y, c, o) {
  const { L } = o;
  const p = shown(s.percent);
  const level = levelOf(s.percent, o.warn, o.err);
  const levelColor = level === 'error' ? c.error : level === 'warning' ? c.warning : null;
  const usedW = clamp(s.percent / 100) * CARD_W;
  const paceX = s.elapsed == null ? null : clamp(s.elapsed * CARD_W, 3, CARD_W - 3);
  const barY = y + 26;
  const out = [];

  out.push(
    `<text x="0" y="${y + 16}" font-size="13" font-weight="500" fill="${c.secondary}">${esc(def.label)}</text>`,
    `<text x="${CARD_W}" y="${y + 16}" text-anchor="end" font-size="22" font-weight="600" fill="${levelColor ?? c.text}" style="font-variant-numeric: tabular-nums">${p}<tspan font-size="13" font-weight="500" fill="${c.secondary}" dx="1">%</tspan></text>`
  );

  // 長條：軌道 → 已用（實心；超過步調線的部分用陶土橘斜紋）→ 步調線
  out.push(`<rect x="0" y="${barY}" width="${CARD_W}" height="8" rx="4" fill="${c.track}"/>`);
  if (usedW > 0) {
    const clip = `clip-${def.key}`;
    out.push(`<clipPath id="${clip}"><rect x="0" y="${barY}" width="${Math.max(usedW, 8)}" height="8" rx="4"/></clipPath>`, `<g clip-path="url(#${clip})">`);
    out.push(`<rect x="0" y="${barY}" width="${CARD_W}" height="8" fill="${levelColor ?? c.fill}"/>`);
    if (!levelColor && s.ahead && paceX != null) {
      const hatch = `hatch-${def.key}`;
      out.push(
        `<pattern id="${hatch}" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${c.track}"/><rect width="2.5" height="4" fill="${c.accent}"/></pattern>`,
        `<rect x="${paceX}" y="${barY}" width="${CARD_W}" height="8" fill="url(#${hatch})"/>`
      );
    }
    out.push('</g>');
  }
  if (paceX != null) {
    // 步調線：時間過到哪裡。先在長條上挖一道縫，線才不會和實心部分融在一起。
    out.push(
      `<rect x="${paceX - 3}" y="${barY}" width="6" height="8" fill="${c.track}"/>`,
      `<rect x="${paceX - 1}" y="${barY - 4}" width="2" height="16" rx="1" fill="${c.pace}"/>`,
      `<circle cx="${paceX}" cy="${barY - 5}" r="2.5" fill="${c.pace}"/>`
    );
  }

  // 重置時間（一天內講還有多久，超過一天講時刻）與狀態
  const infoY = barY + 24;
  let info;
  if (s.notStarted) info = L.info.notStarted;
  else if (s.reset) info = L.info.reset;
  else if (s.resetsAt == null) info = L.info.unknown;
  else if (s.resetsAt - o.now < DAY) info = L.info.soon(L.duration(s.resetsAt - o.now), L.clock(s.resetsAt, o.now));
  else info = L.info.later(L.clock(s.resetsAt, o.now), L.duration(s.resetsAt - o.now));
  out.push(`<text x="0" y="${infoY}" font-size="12" fill="${c.tertiary}">${esc(info)}</text>`);

  let tag = '';
  let tagColor = c.secondary;
  if (p >= 100) [tag, tagColor] = [L.tag.usedUp, c.error];
  else if (level === 'error') [tag, tagColor] = [L.tag.error, c.error];
  else if (level === 'warning') [tag, tagColor] = [L.tag.warning, c.warning];
  else if (s.notStarted) tag = L.tag.notStarted;
  else if (s.ahead && s.elapsed != null) {
    tagColor = c.accent;
    tag = L.tag.ahead(Math.round(s.elapsed * 100));
    if (textWidth(info, 12) + textWidth(tag, 12) + 16 > CARD_W) tag = L.tag.aheadShort;
  }
  if (tag && !o.hideTag) {
    const weight = tagColor === c.secondary ? 400 : 600;
    out.push(`<text x="${CARD_W}" y="${infoY}" text-anchor="end" font-size="12" font-weight="${weight}" fill="${tagColor}">${esc(tag)}</text>`);
  }
  return out.join('');
}

/** 標題與方案標籤（有資料、沒資料的卡片共用） */
function header(/** @type {typeof PALETTES.dark} */ c, /** @type {Locale} */ L, /** @type {string | null} */ plan) {
  const out = [`<text x="0" y="17" font-size="14" font-weight="600" fill="${c.text}">${esc(L.title)}</text>`];
  const planName = plan ? PLAN_NAMES[plan] ?? plan : null;
  if (planName) {
    const x = Math.ceil(textWidth(L.title, 14, true)) + 6.5;
    const w = Math.ceil(textWidth(planName, 11)) + 12;
    out.push(
      `<rect x="${x}" y="4.5" width="${w}" height="16" rx="8" fill="none" stroke="${c.tertiary}" stroke-width="1"/>`,
      `<text x="${x + w / 2}" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="${c.secondary}">${esc(planName)}</text>`
    );
  }
  return out.join('');
}

/**
 * Token 與 API 費用表：這台電腦的 Claude Code 在 5 小時、7 天區間各用了多少。
 * @param {TokenWindows} tokens
 * @param {number} y 起始位置
 * @param {typeof PALETTES.dark} c
 * @param {Locale} L
 * @returns {{ svg: string, height: number }}
 */
function tokenTable(tokens, y, c, L) {
  const T = L.tokens;
  const col1 = 262;
  const col2 = CARD_W;
  const cell = (/** @type {TokenSummary | null} */ s, /** @type {(s: TokenSummary) => string} */ f) => (s ? f(s) : '—');
  const { five_hour: a, seven_day: b } = tokens;
  const out = [];
  let yy = y + 16;
  out.push(
    `<text x="0" y="${yy}" font-size="12" font-weight="600" fill="${c.secondary}">${esc(T.heading)}</text>`,
    `<text x="${col1}" y="${yy}" text-anchor="end" font-size="12" fill="${c.tertiary}">${esc(L.label.five_hour)}</text>`,
    `<text x="${col2}" y="${yy}" text-anchor="end" font-size="12" fill="${c.tertiary}">${esc(L.label.seven_day)}</text>`
  );
  /** @type {[string, (s: TokenSummary) => string, number, string, number][]} */
  const rows = [
    [T.total, (s) => formatTokens(s.total), 13, c.text, 500],
    [T.cacheRead, (s) => formatTokens(s.cacheRead), 12, c.tertiary, 400],
    [T.cost, (s) => formatUsd(s.cost), 13, c.text, 600],
  ];
  for (const [label, f, size, color, weight] of rows) {
    yy += size === 13 ? 21 : 18;
    const style = 'style="font-variant-numeric: tabular-nums"';
    out.push(
      `<text x="${size === 13 ? 0 : 10}" y="${yy}" font-size="${size}" font-weight="${weight === 600 ? 600 : 400}" fill="${color}">${esc(label)}</text>`,
      `<text x="${col1}" y="${yy}" text-anchor="end" font-size="${size}" font-weight="${weight}" fill="${color}" ${style}>${esc(cell(a, f))}</text>`,
      `<text x="${col2}" y="${yy}" text-anchor="end" font-size="${size}" font-weight="${weight}" fill="${color}" ${style}>${esc(cell(b, f))}</text>`
    );
  }
  const top = b?.topModel ?? a?.topModel ?? null;
  const unpriced = (a?.unpricedTokens ?? 0) + (b?.unpricedTokens ?? 0) > 0;
  yy += 19;
  out.push(`<text x="0" y="${yy}" font-size="11" fill="${c.tertiary}">${esc(T.note(top) + (unpriced ? ` · ${T.unpriced}` : ''))}</text>`);
  return { svg: out.join(''), height: yy - y + 4 };
}

/**
 * @param {{ usage: Usage, plan: string | null, fetchedAt: number, stale: boolean, theme: Theme, warn: number, err: number, now: number, lang?: string, tokens?: TokenWindows | null }} o
 * @returns {{ svg: string, width: number, height: number }}
 */
function renderCard(o) {
  const L = localeFor(o.lang);
  const c = PALETTES[o.theme] ?? PALETTES.dark;
  const rows = rowsOf(o.usage, o.now, L);
  const out = [header(c, L, o.plan)];

  const updated = o.stale ? L.dataFrom(L.clock(o.fetchedAt, o.now)) : L.updated(o.fetchedAt, o.now);
  out.push(`<text x="${CARD_W}" y="17" text-anchor="end" font-size="12" fill="${o.stale ? c.warning : c.tertiary}">${esc(updated)}</text>`);

  // 一句話摘要放最上面（HIG：先講重點）
  const head = o.stale ? { main: L.staleHeadline(L.clock(o.fetchedAt, o.now)), tip: null } : headline(rows, o.warn, o.err, o.now, L);
  const top = bindingRow(rows, o.warn, o.err);
  const topLevel = top ? levelOf(top.s.percent, o.warn, o.err) : 'normal';
  const headColor = o.stale ? c.text : topLevel === 'error' ? c.error : topLevel === 'warning' ? c.warning : c.text;
  let y = 42;
  const headWeight = topLevel === 'normal' || o.stale ? 500 : 600;
  for (const line of wrap(head.main, 13, CARD_W, headWeight === 600)) {
    out.push(`<text x="0" y="${y}" font-size="13" font-weight="${headWeight}" fill="${headColor}">${esc(line)}</text>`);
    y += 19;
  }
  if (head.tip) {
    for (const line of wrap(head.tip, 12, CARD_W)) {
      out.push(`<text x="0" y="${y}" font-size="12" fill="${c.secondary}">${esc(line)}</text>`);
      y += 18;
    }
  }
  y += 4;

  // 各列（資料過時時整體淡出，只留標題列清楚）
  const sevenDayError = rows.some((r) => r.def.key === 'seven_day' && levelOf(r.s.percent, o.warn, o.err) === 'error');
  const body = [];
  rows.forEach((row, i) => {
    body.push(windowRow(row, y + i * ROW_H, c, { warn: o.warn, err: o.err, now: o.now, L, hideTag: row.def.extra && sevenDayError }));
  });
  y += rows.length * ROW_H;

  // 圖例：第一次看到直線的人也知道它是什麼
  const anyPace = rows.some((r) => r.s.elapsed != null);
  const anyAhead = rows.some((r) => r.s.ahead && levelOf(r.s.percent, o.warn, o.err) === 'normal');
  if (anyPace) {
    const ly = y + 6;
    body.push(
      `<rect x="2" y="${ly - 9}" width="2" height="11" rx="1" fill="${c.pace}"/>`,
      `<circle cx="3" cy="${ly - 10}" r="2.5" fill="${c.pace}"/>`,
      `<text x="10" y="${ly}" font-size="12" fill="${c.tertiary}">${esc(L.legend.pace)}</text>`
    );
    if (anyAhead) {
      const x = Math.ceil(10 + textWidth(L.legend.pace, 12) + 14);
      body.push(
        `<pattern id="hatch-legend" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="${c.track}"/><rect width="2.5" height="4" fill="${c.accent}"/></pattern>`,
        `<rect x="${x}" y="${ly - 8}" width="16" height="8" rx="4" fill="url(#hatch-legend)"/>`,
        `<text x="${x + 22}" y="${ly}" font-size="12" fill="${c.tertiary}">${esc(L.legend.ahead)}</text>`
      );
    }
    y += 12;
  }
  out.push(o.stale ? `<g opacity="0.45">${body.join('')}</g>` : body.join(''));

  // Token 與 API 費用（本機記錄，不受連線狀態影響，所以不淡出）
  if (o.tokens && (o.tokens.five_hour || o.tokens.seven_day)) {
    const table = tokenTable(o.tokens, y + 8, c, L);
    out.push(`<rect x="0" y="${y + 6}" width="${CARD_W}" height="1" fill="${c.track}"/>`, table.svg);
    y += 8 + table.height;
  }

  const height = Math.ceil(y + 4);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}" viewBox="0 0 ${CARD_W} ${height}" font-family="${esc(FONT)}">` +
    out.join('') +
    '</svg>';
  return { svg, width: CARD_W, height };
}

/**
 * 沒有資料時只畫標題與一條空軌道，和有資料時的卡片同一個樣子。
 * @param {Theme} theme
 * @param {Locale} L
 */
function renderEmptyCard(theme, L) {
  const c = PALETTES[theme] ?? PALETTES.dark;
  const height = 40;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${height}" viewBox="0 0 ${CARD_W} ${height}" font-family="${esc(FONT)}">` +
    header(c, L, null) +
    `<rect x="0" y="30" width="${CARD_W}" height="8" rx="4" fill="${c.track}"/>` +
    '</svg>';
  return { svg, width: CARD_W, height };
}

/** @param {{ svg: string, width: number, height: number }} card @param {string} alt */
const imgTag = (card, alt) =>
  `<img src="data:image/svg+xml;base64,${Buffer.from(card.svg).toString('base64')}" width="${card.width}" height="${card.height}" alt="${esc(alt)}">`;

/* ───────────── 組合 ───────────── */

/**
 * @param {{ code: string, message: string, detail?: string }} error
 * @param {Locale} L
 */
function errorNotice(error, L) {
  switch (error.code) {
    case 'network': return L.errors.network;
    case 'expired': return L.errors.expired;
    case 'unauthorized': return L.errors.unauthorized;
    case 'rate-limited': return L.errors.rateLimited;
    case 'http': return L.errors.http(error.detail ?? 'an error');
    case 'bad-response': return L.errors.badResponse;
    default: return L.errors.unknown(error.message);
  }
}

const STALE_ICON = /** @type {Record<string, string>} */ ({ network: '$(debug-disconnect)' });

/** @param {Locale} L */
function actionLinks(L) {
  const A = L.actions;
  return {
    refresh: `[$(refresh) ${A.refresh}](command:pacelight.refresh "${A.refresh}")`,
    recheck: `[$(refresh) ${A.recheck}](command:pacelight.refresh "${A.recheck}")`,
    settings: `[$(gear) ${A.settings}](command:workbench.action.openSettings?%5B%22pacelight%22%5D "${A.settingsTitle}")`,
    log: `[$(output) ${A.log}](command:pacelight.showLog "${A.log}")`,
    web: `[$(link-external) ${A.web}](https://claude.ai/settings/usage)`,
  };
}
const actions = (/** @type {string[]} */ list) => list.join(' &nbsp;·&nbsp; ');

/**
 * 每一列講給讀屏聽的一句：「7 days 54%, over pace」「5 hours 86%, near limit, resets in 42m」。
 * @param {Row} row @param {number} warn @param {number} err @param {number} now @param {Locale} L
 */
function spokenRow({ def, s }, warn, err, now, L) {
  const p = shown(s.percent);
  const level = levelOf(s.percent, warn, err);
  const T = L.spokenTag;
  const tag = p >= 100 ? T.usedUp : level === 'error' ? T.error : level === 'warning' ? T.warning : s.ahead ? T.ahead : '';
  const when = level !== 'normal' && s.resetsAt != null ? L.resetPhrase(s.resetsAt, now) : '';
  return L.spoken.row(def.label, p, tag, when);
}

/**
 * @param {{
 *   snapshot: { usage: Usage, fetchedAt: number, plan: string | null } | null,
 *   error: { code: string, message: string, detail?: string } | null,
 *   format: string,
 *   warn: number,
 *   err: number,
 *   theme: Theme,
 *   now: number,
 *   lang?: string,
 *   tokens?: TokenWindows | null,
 * }} o
 * @returns {{ text: string, tooltip: string, level: Level, ariaLabel: string }}
 */
function renderView({ snapshot, error, format, warn, err, theme, now, lang, tokens = null }) {
  const L = localeFor(lang);
  const act = actionLinks(L);
  const notice = error ? errorNotice(error, L) : null;

  if (!snapshot) {
    if (!error) return { text: '$(sync~spin)', tooltip: L.loading, level: 'normal', ariaLabel: L.loading };
    const empty = imgTag(renderEmptyCard(theme, L), L.title);
    if (error.code === 'no-login') {
      const tooltip = [empty, '', L.noLogin.found, '', L.noLogin.howTo, '', '---', '', actions([act.recheck, act.web])].join('\n');
      return { text: L.noLogin.status, tooltip, level: 'normal', ariaLabel: L.noLogin.aria };
    }
    const text = error.code === 'expired' || error.code === 'unauthorized' ? L.expiredStatus : L.unavailableStatus;
    const tooltip = [empty, '', notice, '', '---', '', actions([act.refresh, act.log, act.web])].join('\n');
    return { text, tooltip, level: 'normal', ariaLabel: `${L.spoken.prefix}${(notice ?? '').replace(/\$\([^)]*\)\s*/g, '')}` };
  }

  const { usage } = snapshot;
  const rows = rowsOf(usage, now, L);
  const stale = !!error;
  const level = usageLevel(usage, warn, err, now);

  let text = format ? renderText(format, usage, now, L, tokens) : defaultText(rows, warn, err, now, L);
  if (error) {
    const icon = STALE_ICON[error.code] ?? '$(history)';
    text = level === 'normal' && !format ? `${icon} ${text}` : `${text} ${icon}`;
  }

  const card = renderCard({ usage, plan: snapshot.plan, fetchedAt: snapshot.fetchedAt, stale, theme, warn, err, now, lang, tokens });
  const head = headline(rows, warn, err, now, L);
  const spoken = `${L.spoken.prefix}${rows.map((r) => spokenRow(r, warn, err, now, L)).join(L.spoken.join)}${L.spoken.end}`;
  const costNote =
    tokens && (tokens.five_hour || tokens.seven_day)
      ? `${L.spoken.sep}${L.tokens.spoken(tokens.five_hour ? formatUsd(tokens.five_hour.cost) : '—', tokens.seven_day ? formatUsd(tokens.seven_day.cost) : '—')}`
      : '';
  const alt = `${spoken}${stale ? L.spoken.staleNote(L.clock(snapshot.fetchedAt, now)) : head.main + (head.tip ? `${L.spoken.sep}${head.tip}` : '')}${costNote}`.trim();

  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(imgTag(card, alt), '', '---', '', actions(stale ? [act.refresh, act.log, act.settings] : [act.refresh, act.settings, act.web]));

  return { text, tooltip: lines.join('\n'), level, ariaLabel: alt };
}

module.exports = {
  renderView,
  renderText,
  renderCard,
  headline,
  usageLevel,
  windowState,
  rowsOf,
  pie,
  shortCountdown,
  wrap,
  formatTokens,
  formatUsd,
};
