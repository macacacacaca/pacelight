// @ts-check
'use strict';

// 畫面上所有文字。每種語言一份，連時間格式、句型都在這裡，format.js 只負責排版。
// 設定 pacelight.language 選語言（預設英文）。

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

/** 兩個時間差幾個日曆天 */
const dayDiff = (/** @type {number} */ ms, /** @type {number} */ now) =>
  Math.round((new Date(ms).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);

/** 估計時間的取整：三小時內取十分鐘，再遠取整點 */
const roundEstimate = (/** @type {number} */ ms, /** @type {number} */ now) => {
  const step = ms - now < 3 * HOUR ? 10 * MINUTE : HOUR;
  return Math.round(ms / step) * step;
};

/* ───────────── English ───────────── */

const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 4:40 PM；dropZero 時整點寫成 6 PM */
function time12(/** @type {Date} */ d, dropZero = false) {
  const h = d.getHours();
  const m = d.getMinutes();
  const ap = h < 12 ? 'AM' : 'PM';
  return dropZero && m === 0 ? `${h % 12 || 12} ${ap}` : `${h % 12 || 12}:${pad(m)} ${ap}`;
}

const en = {
  /** 42m、2h、3h 5m、5d 8h */
  duration(/** @type {number} */ ms) {
    const mins = Math.max(1, Math.ceil(ms / MINUTE));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return mins % 60 ? `${hours}h ${mins % 60}m` : `${hours}h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
  },
  /** 4:40 PM、Fri 5:35 PM、Oct 15, 1:35 PM（下週同一天不寫星期，免得和今天混淆） */
  clock(/** @type {number} */ ms, /** @type {number} */ now) {
    const d = new Date(ms);
    const diff = dayDiff(ms, now);
    if (diff === 0) return time12(d);
    if (diff > 0 && diff < 7) return `${DOW_EN[d.getDay()]} ${time12(d)}`;
    return `${MON_EN[d.getMonth()]} ${d.getDate()}, ${time12(d)}`;
  },
  /** today around 6 PM、tomorrow (Fri) around 11 PM */
  approxClock(/** @type {number} */ ms, /** @type {number} */ now) {
    const t = roundEstimate(ms, now);
    const d = new Date(t);
    const time = time12(d, true);
    const diff = dayDiff(t, now);
    if (diff === 0) return `today around ${time}`;
    if (diff === 1) return `tomorrow (${DOW_EN[d.getDay()]}) around ${time}`;
    if (diff > 1 && diff < 7) return `${DOW_EN[d.getDay()]} around ${time}`;
    return `${MON_EN[d.getMonth()]} ${d.getDate()} around ${time}`;
  },
  /** resets in 42m；超過一天：resets Fri 5:35 PM */
  resetPhrase(/** @type {number} */ resetsAt, /** @type {number} */ now) {
    return resetsAt - now < DAY ? `resets in ${en.duration(resetsAt - now)}` : `resets ${en.clock(resetsAt, now)}`;
  },

  pace: 'over pace',
  usedUp: 'used up',
  unknownTotal: 'Claude usage ?',

  title: 'Claude Usage',
  updated(/** @type {number} */ fetchedAt, /** @type {number} */ now) {
    const mins = Math.floor((now - fetchedAt) / MINUTE);
    if (mins < 1) return 'Updated just now';
    if (mins < 60) return `Updated ${mins}m ago`;
    return `Updated ${en.clock(fetchedAt, now)}`;
  },
  dataFrom: (/** @type {string} */ at) => `Data from ${at}`,
  staleHeadline: (/** @type {string} */ at) => `Showing data from ${at} — numbers may have changed.`,

  label: { five_hour: '5 hours', seven_day: '7 days', seven_day_all: '7 days · all models', extra: (/** @type {string} */ m) => `7 days · ${m} only` },
  noun: { five_hour: '5-hour limit', seven_day: '7-day limit', extra: (/** @type {string} */ m) => `7-day ${m} limit` },
  name: { five_hour: '5-hour', seven_day: '7-day', extra: (/** @type {string} */ m) => `7-day ${m}` },
  joinNames: (/** @type {string[]} */ names) => names.join(' and '),

  info: {
    notStarted: 'Starts with your next message',
    reset: 'Reset',
    unknown: 'Reset time unknown',
    soon: (/** @type {string} */ dur, /** @type {string} */ at) => `Resets in ${dur} · ${at}`,
    later: (/** @type {string} */ at, /** @type {string} */ dur) => `Resets ${at} · in ${dur}`,
  },
  tag: {
    usedUp: 'Used up',
    error: 'Almost out',
    warning: 'Near limit',
    notStarted: 'Not started',
    ahead: (/** @type {number} */ pct) => `Over pace · time at ${pct}%`,
    aheadShort: 'Over pace',
  },
  spokenTag: { usedUp: 'used up', error: 'almost out', warning: 'near limit', ahead: 'over pace' },
  legend: { pace: 'Time elapsed', ahead: 'Usage over pace' },
  tokens: {
    heading: 'Claude Code on this computer',
    total: 'Tokens',
    cacheRead: 'of which cache reads',
    cost: 'API cost (est.)',
    note: (/** @type {string | null} */ model) => (model ? `At API list prices · mostly ${model}` : 'At API list prices'),
    unpriced: 'some models have no list price',
    spoken: (/** @type {string} */ five, /** @type {string} */ seven) =>
      `API-equivalent cost on this computer: ${five} in the 5-hour window, ${seven} in the 7-day window.`,
  },

  headline: {
    bothOut: (/** @type {string} */ names, /** @type {boolean} */ allOut, /** @type {string} */ at) =>
      `${names} limits are ${allOut ? 'used up' : 'almost used up'}. Full access returns ${at}.`,
    usedUp: (/** @type {string} */ noun, /** @type {string | null} */ reset, /** @type {boolean} */ others) =>
      `${noun} used up${reset ? ` — ${reset}` : ''}${others ? '. Other models still available' : ''}.`,
    runOutAlert: (/** @type {string} */ noun, /** @type {string} */ approx, /** @type {string} */ at) =>
      `At this pace, the ${noun} runs out ${approx} — it resets ${at}.`,
    lasts: (/** @type {string} */ noun, /** @type {number} */ p, /** @type {string} */ at) =>
      `${noun} at ${p}% — at this pace it lasts until the ${at} reset.`,
    justPct: (/** @type {string} */ noun, /** @type {number} */ p) => `${noun} at ${p}%.`,
    racing: (/** @type {string} */ noun, /** @type {string} */ approx, /** @type {string} */ early) =>
      `At this pace, the ${noun} runs out ${approx}, ${early} before it resets.`,
    tip: (/** @type {string} */ at, /** @type {number} */ perDay) => `To last until ${at}, keep it under ${perDay}% a day.`,
    spike: (/** @type {string} */ noun, /** @type {string} */ spent, /** @type {number} */ p) =>
      `${p}% of the ${noun} used in the first ${spent} — over pace.`,
    calmLow: 'Light usage so far — every limit lasts until its reset.',
    calmOn: 'On pace — every limit lasts until its reset.',
  },

  errors: {
    network: "$(debug-disconnect) Can't reach Claude's servers. It will update once the connection is back.",
    expired: '$(key) Login token expired. Claude Code refreshes it the next time it sends a message, then this recovers.',
    unauthorized: '$(key) Login token rejected. Claude Code refreshes it the next time it sends a message, then this recovers.',
    rateLimited: '$(watch) Too many requests — paused for now, it will retry automatically.',
    http: (/** @type {string} */ detail) => `$(warning) The server returned ${detail}. It will retry automatically.`,
    badResponse: '$(warning) The usage endpoint sent something unexpected. It will retry automatically.',
    unknown: (/** @type {string} */ msg) => `$(warning) ${msg}. It will retry automatically.`,
  },
  noLogin: {
    status: '$(account) No subscription login',
    found: '$(account) No Claude subscription login found (not logged in yet, or Claude Code is using an API key).',
    howTo:
      'To show usage: run `claude` in a terminal, type `/login`, and pick your subscription account (Pro / Max). ' +
      "Don't need this? Right-click the status bar and uncheck “Pacelight”.",
    aria: 'Claude usage: no subscription login found',
  },
  expiredStatus: '$(key) Login needs refresh',
  unavailableStatus: '$(warning) Usage unavailable',
  loading: 'Loading Claude usage…',
  actions: { refresh: 'Refresh', recheck: 'Check again', settings: 'Settings', log: 'Show Log', web: 'claude.ai usage', settingsTitle: 'Pacelight settings' },
  spoken: {
    prefix: 'Claude usage: ',
    row: (/** @type {string} */ label, /** @type {number} */ p, /** @type {string} */ tag, /** @type {string} */ when) =>
      `${label} ${p}%${tag ? `, ${tag}` : ''}${when ? `, ${when}` : ''}`,
    join: '; ',
    end: '. ',
    sep: ' ',
    staleNote: (/** @type {string} */ at) => `Data from ${at}; it will update automatically once it recovers.`,
  },
};

/* ───────────── 繁體中文 ───────────── */

const DOW_ZH = ['日', '一', '二', '三', '四', '五', '六'];

/** 中文夾英數時前後空一格：「要等到 14:17 才重置」「要等到週五 17:35 才重置」 */
const mid = (/** @type {string} */ s) => `${/^[\x21-\x7e]/.test(s) ? ' ' : ''}${s}${/[\x21-\x7e]$/.test(s) ? ' ' : ''}`;

/** @type {typeof en} */
const zhTW = {
  /** 42 分鐘、2 小時、3 小時 5 分鐘、5 天 8 小時 */
  duration(ms) {
    const mins = Math.max(1, Math.ceil(ms / MINUTE));
    if (mins < 60) return `${mins} 分鐘`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return mins % 60 ? `${hours} 小時 ${mins % 60} 分鐘` : `${hours} 小時`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days} 天 ${hours % 24} 小時` : `${days} 天`;
  },
  /** 16:40、週五 17:35、10/15 13:35 */
  clock(ms, now) {
    const d = new Date(ms);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const diff = dayDiff(ms, now);
    if (diff === 0) return time;
    if (diff > 0 && diff < 7) return `週${DOW_ZH[d.getDay()]} ${time}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
  },
  /** 今天 18:00 左右、明天（週五）23:00 左右 */
  approxClock(ms, now) {
    const t = roundEstimate(ms, now);
    const d = new Date(t);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const diff = dayDiff(t, now);
    if (diff === 0) return `今天 ${time} 左右`;
    if (diff === 1) return `明天（週${DOW_ZH[d.getDay()]}）${time} 左右`;
    if (diff > 1 && diff < 7) return `週${DOW_ZH[d.getDay()]} ${time} 左右`;
    return `${d.getMonth() + 1}/${d.getDate()} ${time} 左右`;
  },
  /** 42 分鐘後重置；超過一天：週五 17:35 重置 */
  resetPhrase(resetsAt, now) {
    return resetsAt - now < DAY ? `${zhTW.duration(resetsAt - now)}後重置` : `${zhTW.clock(resetsAt, now)} 重置`;
  },

  pace: '偏快',
  usedUp: '已用完',
  unknownTotal: 'Claude 用量 ?',

  title: 'Claude 用量',
  updated(fetchedAt, now) {
    const mins = Math.floor((now - fetchedAt) / MINUTE);
    if (mins < 1) return '剛剛更新';
    if (mins < 60) return `${mins} 分鐘前更新`;
    return `${zhTW.clock(fetchedAt, now)} 更新`;
  },
  dataFrom: (at) => `${at} 的資料`,
  staleHeadline: (at) => `以下是 ${at} 的資料，數字可能已經變了。`,

  label: { five_hour: '5 小時', seven_day: '7 天', seven_day_all: '7 天・所有模型', extra: (m) => `7 天・僅 ${m}` },
  noun: { five_hour: '5 小時額度', seven_day: '7 天額度', extra: (m) => `7 天 ${m} 額度` },
  name: { five_hour: '5 小時', seven_day: '7 天', extra: (m) => `7 天 ${m}` },
  joinNames: (names) => names.join('和').replace(/和(?=\d)/g, '和 '),

  info: {
    notStarted: '還沒開始計時，下次送出訊息起算',
    reset: '已重置',
    unknown: '重置時間不明',
    soon: (dur, at) => `${dur}後重置 · ${at}`,
    later: (at, dur) => `${at} 重置 · 還有 ${dur}`,
  },
  tag: {
    usedUp: '已用完',
    error: '快用完了',
    warning: '接近上限',
    notStarted: '未開始',
    ahead: (pct) => `偏快，時間才過 ${pct}%`,
    aheadShort: '偏快',
  },
  spokenTag: { usedUp: '已用完', error: '快用完了', warning: '接近上限', ahead: '偏快' },
  legend: { pace: '時間過到這裡', ahead: '超前的用量' },
  tokens: {
    heading: '這台電腦的 Claude Code',
    total: 'Token 數',
    cacheRead: '其中快取讀取',
    cost: '換算 API 費用',
    note: (model) => (model ? `依 API 牌價估算 · 主要是 ${model}` : '依 API 牌價估算'),
    unpriced: '部分模型沒有牌價',
    spoken: (five, seven) => `這台電腦換算 API 費用：5 小時 ${five}，7 天 ${seven}。`,
  },

  headline: {
    bothOut: (names, allOut, at) => `${names}額度${allOut ? '都已用完' : '都快用完了'}，要等到${mid(at)}才會完全恢復。`,
    usedUp: (noun, reset, others) => `${noun}已用完${reset ? `，${reset}` : ''}${others ? '，其他模型還能用' : ''}。`,
    runOutAlert: (noun, approx, at) => `照目前速度，${noun}${approx}就會用完，要等到${mid(at)}才重置。`,
    lasts: (noun, p, at) => `${noun}已用 ${p}%，照目前速度撐得到${mid(at)}重置。`,
    justPct: (noun, p) => `${noun}已用 ${p}%。`,
    racing: (noun, approx, early) => `照目前速度，${noun}${approx}就會用完，比重置早 ${early}。`,
    tip: (at, perDay) => `想撐到${mid(at)}重置，每天用 ${perDay}% 以內。`,
    spike: (noun, spent, p) => `${noun}開頭 ${spent}就用了 ${p}%，用得偏快。`,
    calmLow: '目前用得不多，各項額度都夠用到重置。',
    calmOn: '照目前步調，各項額度都夠用到重置。',
  },

  errors: {
    network: '$(debug-disconnect) 連不上 Claude 伺服器，恢復連線後會自動更新。',
    expired: '$(key) 登入權杖已過期。Claude Code 下次送出訊息時會自動更新，之後這裡就會恢復。',
    unauthorized: '$(key) 登入權杖被拒。Claude Code 下次送出訊息時會自動更新，之後這裡就會恢復。',
    rateLimited: '$(watch) 查詢太頻繁，被伺服器暫時擋下，稍後會自動再試。',
    http: (detail) => `$(warning) 伺服器回應 ${detail}，稍後會自動再試。`,
    badResponse: '$(warning) 用量回應的格式不對，稍後會自動再試。',
    unknown: (msg) => `$(warning) ${msg}。稍後會自動再試。`,
  },
  noLogin: {
    status: '$(account) 未登入訂閱',
    found: '$(account) 找不到 Claude 訂閱帳號的登入（可能還沒登入，或 Claude Code 用的是 API 金鑰）。',
    howTo: '要顯示用量：在終端機執行 `claude`，輸入 `/login`，選訂閱帳號（Pro／Max）那一項。用不到的話，可以在狀態列按右鍵，取消勾選「Pacelight」。',
    aria: 'Claude 用量：找不到訂閱帳號的登入',
  },
  expiredStatus: '$(key) 登入待更新',
  unavailableStatus: '$(warning) 用量無法取得',
  loading: '正在讀取 Claude 用量…',
  actions: { refresh: '立即更新', recheck: '重新檢查', settings: '設定', log: '顯示記錄', web: 'claude.ai 用量', settingsTitle: 'Pacelight 設定' },
  spoken: {
    prefix: 'Claude 用量：',
    row: (label, p, tag, when) => `${label} ${p}%${tag ? `，${tag}` : ''}${when ? `，${when}` : ''}`,
    join: '；',
    end: '。',
    sep: '',
    staleNote: (at) => `資料停在 ${at}，恢復後會自動更新。`,
  },
};

/** @typedef {typeof en} Locale */
/** @typedef {'en' | 'zh-TW'} Lang */

const LOCALES = /** @type {Record<Lang, Locale>} */ ({ en, 'zh-TW': zhTW });

/** @param {string | undefined} lang @returns {Locale} */
const localeFor = (lang) => LOCALES[/** @type {Lang} */ (lang)] ?? en;

module.exports = { LOCALES, localeFor };
