'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../src/format');
const { LOCALES } = require('../src/i18n');

const zh = LOCALES['zh-TW'];
const en = LOCALES.en;

const NOW = new Date(2026, 9, 8, 13, 35).getTime(); // 當地時間 10/8（週四）13:35
const H = 3_600_000;
const M = 60_000;
const D = 24 * H;

const usage = (five, fiveIn, seven, sevenIn, extras = []) => ({
  fiveHour: { percent: five, resetsAt: NOW + fiveIn },
  sevenDay: { percent: seven, resetsAt: NOW + sevenIn },
  extras,
});
const TODAY = usage(13, 3 * H + 5 * M, 54, 5 * D + 8 * H + 25 * M); // 平常的一天：5 小時從容、7 天偏快
const sonnet = (percent, resetsIn) => ({ key: 'seven_day_sonnet', label: 'Sonnet', window: { percent, resetsAt: resetsIn == null ? null : NOW + resetsIn } });
// 新版回應 limits[] 裡的模型專屬週額度（parseUsage 產生的 key 是 weekly_scoped_<名稱>）
const fable = (percent, resetsIn) => ({ key: 'weekly_scoped_fable', label: 'Fable', window: { percent, resetsAt: resetsIn == null ? null : NOW + resetsIn } });
const count = (/** @type {string} */ s, /** @type {string} */ sub) => s.split(sub).length - 1;

/** @param {any} u @param {any} [error] */
const view = (u, error = null, extra = {}) =>
  f.renderView({ snapshot: u && { usage: u, fetchedAt: NOW - M, plan: 'pro' }, error, format: '', warn: 80, err: 95, theme: 'dark', now: NOW, lang: 'zh-TW', ...extra });
const head = (/** @type {any} */ u, L = zh) => f.headline(f.rowsOf(u, NOW, L), 80, 95, NOW, L);
const svgOf = (/** @type {string} */ tooltip) => {
  const m = tooltip.match(/data:image\/svg\+xml;base64,([^"]+)/);
  assert.ok(m, 'tooltip 應該有 SVG 圖');
  return Buffer.from(m[1], 'base64').toString('utf8');
};

test('狀態列平常顯示兩項，用得偏快的標「偏快」', () => {
  const v = view(TODAY);
  assert.equal(v.text, '5h 13% · 7d 54% 偏快');
  assert.equal(v.level, 'normal');
  assert.match(v.ariaLabel, /^Claude 用量：5 小時 13%；7 天 54%，偏快。照目前速度/);
});

test('接近上限時只留最需要注意的那一項與重置時間', () => {
  assert.equal(view(usage(86, 42 * M, 60, 3 * D)).text, '$(warning) 5h 86% · 42 分鐘後重置');
  const err = view(usage(30, 2 * H, 97, 28 * H));
  assert.equal(err.text, '$(error) 7d 97% · 週五 17:35 重置');
  assert.equal(err.level, 'error');
  assert.equal(view(usage(100, 30 * M, 50, 2 * D)).text, '$(error) 5h 已用完 · 30 分鐘後重置');
});

test('兩項都用完時講比較晚的重置（那才是真正要等的時間）', () => {
  const u = usage(100, 1 * H, 100, 2 * D + 3 * H);
  assert.equal(view(u).text, '$(error) 7d 已用完 · 週六 16:35 重置');
  assert.equal(head(u).main, '5 小時和 7 天額度都已用完，要等到週六 16:35 才會完全恢復。');
});

test('Max 方案的「僅 Sonnet」也會觸發狀態列與摘要', () => {
  const u = usage(20, 3 * H, 40, 4 * D, [sonnet(98, 4 * D)]);
  const v = view(u);
  assert.equal(v.text, '$(error) 7d Sonnet 98% · 週一 13:35 重置');
  assert.equal(v.level, 'error');
  assert.match(v.ariaLabel, /7 天・所有模型 40%；7 天・僅 Sonnet 98%，快用完了/);
  // 還沒開始用的額外區間不列出
  assert.equal(f.rowsOf(usage(20, 3 * H, 40, 4 * D, [sonnet(0, null)]), NOW, zh).length, 2);
});

test('「僅 Fable」一切正常時不進狀態列，快用完時才會', () => {
  const calm = view(usage(13, 3 * H + 5 * M, 54, 5 * D + 8 * H + 25 * M, [fable(58, 5 * D + 8 * H + 25 * M)]));
  assert.equal(calm.text, '5h 13% · 7d 54% 偏快');
  assert.equal(calm.level, 'normal');
  assert.match(calm.ariaLabel, /7 天・僅 Fable 58%/);
  const out = view(usage(20, 3 * H, 40, 4 * D, [fable(98, 4 * D)]));
  assert.equal(out.text, '$(error) 7d Fable 98% · 週一 13:35 重置');
  assert.equal(out.level, 'error');
  assert.match(svgOf(out.tooltip), />快用完了</);
});

test('顯示的數字和顏色一致（無條件捨去）', () => {
  const v = view(usage(79.6, 4 * H, 10, 6 * D));
  assert.match(v.text, /^5h 79%/);
  assert.equal(v.level, 'normal');
  assert.equal(view(usage(99.6, 1 * H, 10, 6 * D)).text, '$(error) 5h 99% · 1 小時後重置');
});

test('過了重置時間的舊數字當作 0%', () => {
  const s = f.windowState({ percent: 97, resetsAt: NOW - 1 }, 5 * H, NOW);
  assert.equal(s?.percent, 0);
  assert.equal(s?.reset, true);
  const v = view(usage(97, -1 * M, 20, 3 * D));
  assert.equal(v.level, 'normal');
  assert.equal(v.text, '5h 0% · 7d 20%');
});

test('「偏快」只有一條規則：照目前速度會在重置前用完', () => {
  // TODAY 的 7 天：54% 用了 40 小時 → 約 34 小時後用完，遠早於重置
  const s = f.windowState({ percent: 54, resetsAt: NOW + 5 * D + 8 * H }, 7 * D, NOW);
  assert.equal(s?.ahead, true);
  assert.ok(s?.runOutAt && Math.abs(s.runOutAt - (NOW + (46 * 40 * H) / 54)) < 1000);
  // 稍微超前但重置前幾乎撐得到：不算偏快，也不給用完時間
  const close = f.windowState({ percent: 45, resetsAt: NOW + 4 * D }, 7 * D, NOW);
  assert.equal(close?.ahead, false);
  assert.equal(close?.runOutAt, null);
  // 區間剛開始（時間過不到一成）：看是否比時間多 15 個百分點，不估用完時間
  const spike = f.windowState({ percent: 25, resetsAt: NOW + 4 * H + 45 * M }, 5 * H, NOW);
  assert.equal(spike?.ahead, true);
  assert.equal(spike?.runOutAt, null);
});

test('一句話摘要先回答「撐得到重置嗎？」', () => {
  assert.deepEqual(head(TODAY), {
    main: '照目前速度，7 天額度明天（週五）23:00 左右就會用完，比重置早 3 天 22 小時。',
    tip: '想撐到週二 22:00 重置，每天用 8% 以內。',
  });
  assert.equal(head(usage(8, 4 * H, 12, 6 * D)).main, '目前用得不多，各項額度都夠用到重置。');
  assert.equal(head(usage(86, 42 * M, 60, 3 * D)).main, '5 小時額度已用 86%，照目前速度撐得到 14:17 重置。');
  assert.equal(head(usage(30, 2 * H, 97, 28 * H)).main, '照目前速度，7 天額度今天 18:00 左右就會用完，要等到週五 17:35 才重置。');
  assert.equal(head(usage(100, 30 * M, 50, 2 * D)).main, '5 小時額度已用完，30 分鐘後重置。');
  assert.equal(head(usage(25, 4 * H + 45 * M, 10, 6 * D)).main, '5 小時額度開頭 15 分鐘就用了 25%，用得偏快。');
});

test('兩項都會提早用完時，講被擋最久的那項', () => {
  const u = usage(45, 3 * H, 54, 5 * D + 8 * H);
  assert.match(head(u).main, /^照目前速度，7 天額度/);
});

test('時間用語', () => {
  assert.equal(zh.clock(NOW + 3 * H, NOW), '16:35');
  assert.equal(zh.clock(NOW + 11 * H, NOW), '週五 00:35');
  assert.equal(zh.clock(NOW + 6 * D, NOW), '週三 13:35');
  assert.equal(zh.clock(NOW + 7 * D, NOW), '10/15 13:35'); // 下週同一天不寫「週四」，免得誤會成今天
  assert.equal(zh.duration(41 * M), '41 分鐘');
  assert.equal(zh.duration(2 * H), '2 小時');
  assert.equal(zh.duration(3 * H + 5 * M), '3 小時 5 分鐘');
  assert.equal(zh.duration(5 * D + 8 * H), '5 天 8 小時');
  assert.equal(zh.duration(2 * D), '2 天');
  assert.equal(zh.resetPhrase(NOW + 42 * M, NOW), '42 分鐘後重置');
  assert.equal(zh.resetPhrase(NOW + 28 * H, NOW), '週五 17:35 重置');
  assert.equal(zh.approxClock(NOW + 4 * H + 20 * M, NOW), '今天 18:00 左右');
  assert.equal(zh.approxClock(NOW + 33 * H + 30 * M, NOW), '明天（週五）23:00 左右');
  assert.equal(zh.approxClock(NOW + 47 * M, NOW), '今天 14:20 左右');
  assert.equal(f.shortCountdown(NOW + 2 * H + 10 * M, NOW), '2h10m');
});

test('摘要太長時在標點後換行', () => {
  const lines = f.wrap('照目前速度，7 天額度明天（週五）23:00 左右就會用完，比重置早 3 天 22 小時。', 13, 360);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /，$/);
});

test('自訂格式的代號', () => {
  assert.equal(f.renderText('$(pulse) 5h {five_hour}% · 7d {seven_day}%', TODAY, NOW), '$(pulse) 5h 13% · 7d 54%');
  assert.equal(f.renderText('{five_hour_pie}{seven_day_pie} {seven_day_pace} {five_hour_reset}', TODAY, NOW, zh), '◔◑ 偏快 3h05m');
  assert.equal(f.renderText('{nope}', TODAY, NOW), '{nope}');
  assert.equal(view(TODAY, null, { format: '{five_hour}|{seven_day}' }).text, '13|54');
});

test('卡片：摘要在最上面、兩列、步調圖例', () => {
  const svg = svgOf(view(TODAY).tooltip);
  assert.ok(svg.indexOf('照目前速度') < svg.indexOf('>5 小時<'), '摘要要在各列前面');
  assert.match(svg, />Pro</);
  assert.match(svg, />剛剛更新<|1 分鐘前更新/);
  assert.match(svg, /3 小時 5 分鐘後重置 · 16:40/);
  assert.match(svg, /週二 22:00 重置 · 還有 5 天 8 小時/);
  assert.match(svg, /偏快，時間才過 24%/);
  assert.match(svg, /時間過到這裡/);
  assert.match(svg, /超前的用量/);
  assert.match(svg, /<pattern id="hatch-seven_day"/);
  assert.doesNotMatch(svg, /步調從容/);
});

test('卡片：還沒開始計時的區間', () => {
  const svg = svgOf(view({ fiveHour: { percent: 0, resetsAt: null }, sevenDay: { percent: 20, resetsAt: NOW + 5 * D }, extras: [] }).tooltip);
  assert.match(svg, /還沒開始計時，下次送出訊息起算/);
  assert.match(svg, />未開始</);
});

const card = (/** @type {any} */ usage, /** @type {object} */ extra = {}) =>
  f.renderCard({ usage, plan: 'max', fetchedAt: NOW, stale: false, theme: 'dark', warn: 80, err: 95, now: NOW, lang: 'zh-TW', ...extra });

test('卡片：Max 方案多一條精簡列（列高 40，圖例前多留 10），標籤說清楚「所有模型」與「僅 Sonnet」', () => {
  const one = card(TODAY);
  const two = card({ ...TODAY, extras: [sonnet(41, 28 * H)] });
  assert.equal(two.height - one.height, 50);
  assert.match(two.svg, /7 天・所有模型/);
  assert.match(two.svg, /7 天・僅 Sonnet/);
  assert.match(two.svg, />41<tspan/);
  // 精簡列沒有重置時間那一行（和 7 天列同一個重置時間）
  assert.equal(count(two.svg, '重置'), count(one.svg, '重置'));
  assert.doesNotMatch(two.svg, /週五 17:35/);
  assert.match(two.svg, /clip-seven_day_sonnet/);
});

test('卡片：limits[] 來的「僅 Fable」精簡列', () => {
  const svg = card({ ...TODAY, extras: [fable(58, 5 * D)] }).svg;
  assert.match(svg, /7 天・僅 Fable/);
  assert.match(svg, /7 天・所有模型/);
  assert.match(svg, />58<tspan/);
  assert.match(svg, /<clipPath id="clip-weekly_scoped_fable">/);
  assert.match(svg, /<pattern id="hatch-weekly_scoped_fable"/); // 58% 比時間快，有斜紋
  assert.match(svg, />偏快</); // 精簡列一律用短版標籤
  assert.match(svg, />偏快，時間才過 24%</); // 主列照舊
  // 精簡列的字比主列小
  assert.match(svg, /font-size="12" font-weight="500" fill="#B0AEA5">7 天・僅 Fable</);
  assert.match(svg, /font-size="16" font-weight="600"[^>]*>58<tspan font-size="11"/);
  // 資料過時時精簡列也一起淡出：Fable 列要在淡出群組裡面，而群組一路包到卡片結尾（沒有 token 表時）
  const stale = card({ ...TODAY, extras: [fable(58, 5 * D)] }, { stale: true }).svg;
  const group = stale.indexOf('<g opacity="0.45">');
  assert.ok(group >= 0 && stale.indexOf('7 天・僅 Fable') > group);
  assert.ok(stale.endsWith('</g></svg>'));
});

test('卡片：精簡列在最後一列、週額度剛重置時，步調線不會碰到圖例的標記', () => {
  // 剛重置：時間過不到 1%，步調線貼在最左邊（x=3），正好和圖例的小圓點（cx=3）同一條垂直線
  const svg = card(usage(20, 3 * H, 1, 7 * D - 10 * M, [fable(1, 7 * D - 10 * M)])).svg;
  const lines = [...svg.matchAll(/<rect x="2" y="(\d+(?:\.\d+)?)" width="2" height="16"/g)].map((m) => Number(m[1]) + 16);
  const legend = [...svg.matchAll(/<circle cx="3" cy="(\d+(?:\.\d+)?)" r="2\.5"/g)].map((m) => Number(m[1]) - 2.5);
  assert.ok(lines.length >= 1 && legend.length >= 1, '應該有貼在左邊的步調線和圖例的圓點');
  const lastLineBottom = Math.max(...lines);
  const legendTop = Math.max(...legend);
  assert.ok(legendTop - lastLineBottom >= 5, `圖例的圓點（${legendTop}）要在最後一條步調線（${lastLineBottom}）下面至少 5px`);
});

test('卡片：精簡列快用完時有「快用完了」標籤，7 天本身快用完時精簡列不標', () => {
  const svg = card(usage(20, 3 * H, 40, 4 * D, [fable(98, 4 * D)])).svg;
  assert.match(svg, />快用完了</);
  assert.match(svg, />98<tspan/);
  // 7 天額度本身 97%：主列標「快用完了」，精簡列不再重複
  const both = card(usage(20, 3 * H, 97, 4 * D, [fable(60, 4 * D)])).svg;
  assert.equal(count(both, '>快用完了<'), 1);
  assert.doesNotMatch(both, />偏快</); // Fable 60% 本來是「偏快」，7 天快用完時連這個也不標
});

test('卡片：方案標籤帶等級（Max 5x）', () => {
  assert.match(card(TODAY, { plan: 'max', tier: 'default_claude_max_5x' }).svg, />Max 5x</);
  assert.match(card(TODAY, { plan: 'max', tier: 'default_claude_max_20x' }).svg, />Max 20x</);
  const plain = card(TODAY, { plan: 'max', tier: null }).svg;
  assert.match(plain, />Max</);
  assert.doesNotMatch(plain, />Max \d+x</);
  assert.match(card(TODAY, { plan: 'max' }).svg, />Max</);
  assert.match(card(TODAY, { plan: 'pro', tier: 'default_claude_pro' }).svg, />Pro</);
  assert.match(card(TODAY, { plan: 'team', tier: 'enterprise' }).svg, />Team</);
  assert.match(card(TODAY, { plan: 'ultra<', tier: 'default_claude_ultra_7x' }).svg, />ultra&lt; 7x</);
  assert.doesNotMatch(card(TODAY, { plan: null, tier: 'default_claude_max_5x' }).svg, /5x/);
  // renderView 把快照裡的 tier 傳給卡片；舊快取沒有 tier 也行
  const v = f.renderView({ snapshot: { usage: TODAY, fetchedAt: NOW - M, plan: 'max', tier: 'default_claude_max_5x' }, error: null, format: '', warn: 80, err: 95, theme: 'dark', now: NOW });
  assert.match(svgOf(v.tooltip), />Max 5x</);
  assert.match(svgOf(view(TODAY).tooltip), />Pro</);
});

test('卡片：每種主題都畫得出來，文字有跳脫', () => {
  for (const theme of ['dark', 'light', 'hc-dark', 'hc-light']) {
    const card = f.renderCard({ usage: TODAY, plan: '<b>&', fetchedAt: NOW, stale: true, theme: /** @type {any} */ (theme), warn: 80, err: 95, now: NOW, lang: 'zh-TW' });
    assert.match(card.svg, /^<svg /);
    assert.match(card.svg, /&lt;b&gt;&amp;/);
    assert.match(card.svg, /13:35 的資料/);
    assert.match(card.svg, /<g opacity="0.45">/);
  }
});

test('提示內容：圖片、指令連結，長度遠低於 VS Code 的 10 萬字上限', () => {
  const v = view(TODAY);
  assert.match(v.tooltip, /<img src="data:image\/svg\+xml;base64,/);
  assert.match(v.tooltip, /command:pacelight\.refresh/);
  assert.match(v.tooltip, /command:workbench\.action\.openSettings/);
  assert.ok(v.tooltip.length < 20_000);
});

test('更新失敗：狀態列加圖示（警示狀態也看得出來），提示先講原因', () => {
  const v = view(TODAY, { code: 'network', message: 'x' });
  assert.equal(v.text, '$(debug-disconnect) 5h 13% · 7d 54% 偏快');
  assert.match(v.tooltip, /^\$\(debug-disconnect\) 連不上 Claude 伺服器/);
  assert.match(v.tooltip, /command:pacelight\.showLog/);
  assert.match(v.ariaLabel, /資料停在 13:34/);
  const warn = view(usage(86, 42 * M, 60, 3 * D), { code: 'http', message: 'Server returned HTTP 500', detail: 'HTTP 500' });
  assert.equal(warn.text, '$(warning) 5h 86% · 42 分鐘後重置 $(history)');
  assert.match(warn.tooltip, /伺服器回應 HTTP 500，稍後會自動再試。/);
});

test('沒有資料時的狀態', () => {
  assert.equal(view(null).text, '$(sync~spin)');
  const noLogin = view(null, { code: 'no-login', message: 'x' });
  assert.equal(noLogin.text, '$(account) 未登入訂閱');
  assert.match(noLogin.tooltip, /\/login/);
  assert.match(noLogin.tooltip, /重新檢查/);
  assert.equal(view(null, { code: 'expired', message: 'x' }).text, '$(key) 登入待更新');
  assert.equal(view(null, { code: 'http', message: 'Server returned HTTP 500', detail: 'HTTP 500' }).text, '$(warning) 用量無法取得');
});

/* ───────────── English（預設語言） ───────────── */

const viewEn = (/** @type {any} */ u, error = null) =>
  f.renderView({ snapshot: u && { usage: u, fetchedAt: NOW - M, plan: 'pro' }, error, format: '', warn: 80, err: 95, theme: 'dark', now: NOW });

test('English: status bar text', () => {
  assert.equal(viewEn(TODAY).text, '5h 13% · 7d 54% over pace');
  assert.equal(viewEn(usage(86, 42 * M, 60, 3 * D)).text, '$(warning) 5h 86% · resets in 42m');
  assert.equal(viewEn(usage(30, 2 * H, 97, 28 * H)).text, '$(error) 7d 97% · resets Fri 5:35 PM');
  assert.equal(viewEn(usage(100, 30 * M, 50, 2 * D)).text, '$(error) 5h used up · resets in 30m');
  assert.equal(viewEn(usage(20, 3 * H, 40, 4 * D, [sonnet(98, 4 * D)])).text, '$(error) 7d Sonnet 98% · resets Mon 1:35 PM');
});

test('English: headlines', () => {
  assert.deepEqual(head(TODAY, en), {
    main: 'At this pace, the 7-day limit runs out tomorrow (Fri) around 11 PM, 3d 22h before it resets.',
    tip: 'To last until Tue 10:00 PM, keep it under 8% a day.',
  });
  assert.equal(head(usage(8, 4 * H, 12, 6 * D), en).main, 'Light usage so far — every limit lasts until its reset.');
  assert.equal(head(usage(86, 42 * M, 60, 3 * D), en).main, '5-hour limit at 86% — at this pace it lasts until the 2:17 PM reset.');
  assert.equal(head(usage(30, 2 * H, 97, 28 * H), en).main, 'At this pace, the 7-day limit runs out today around 6 PM — it resets Fri 5:35 PM.');
  assert.equal(head(usage(100, 1 * H, 100, 2 * D + 3 * H), en).main, '5-hour and 7-day limits are used up. Full access returns Sat 4:35 PM.');
  assert.equal(head(usage(25, 4 * H + 45 * M, 10, 6 * D), en).main, '25% of the 5-hour limit used in the first 15m — over pace.');
});

test('English: time formats', () => {
  assert.equal(en.clock(NOW + 3 * H, NOW), '4:35 PM');
  assert.equal(en.clock(NOW + 11 * H, NOW), 'Fri 12:35 AM');
  assert.equal(en.clock(NOW + 7 * D, NOW), 'Oct 15, 1:35 PM');
  assert.equal(en.duration(41 * M), '41m');
  assert.equal(en.duration(3 * H + 5 * M), '3h 5m');
  assert.equal(en.duration(5 * D + 8 * H), '5d 8h');
  assert.equal(en.approxClock(NOW + 4 * H + 20 * M, NOW), 'today around 6 PM');
  assert.equal(en.approxClock(NOW + 47 * M, NOW), 'today around 2:20 PM');
});

test('English: card, aria label and errors', () => {
  const v = viewEn(TODAY);
  const svg = svgOf(v.tooltip);
  assert.match(svg, />Claude Usage</);
  assert.match(svg, />5 hours</);
  assert.match(svg, /Resets in 3h 5m · 4:40 PM/);
  assert.match(svg, /Resets Tue 10:00 PM · in 5d 8h/);
  assert.match(svg, /Over pace · time at 24%/);
  assert.match(svg, />Time elapsed</);
  assert.match(svg, />Usage over pace</);
  assert.match(v.ariaLabel, /^Claude usage: 5 hours 13%; 7 days 54%, over pace\. At this pace/);
  assert.match(v.tooltip, /\[\$\(refresh\) Refresh\]/);
  const stale = viewEn(TODAY, { code: 'network', message: "Can't reach server (ENOTFOUND)", detail: 'ENOTFOUND' });
  assert.equal(stale.text, '$(debug-disconnect) 5h 13% · 7d 54% over pace');
  assert.match(stale.tooltip, /^\$\(debug-disconnect\) Can't reach Claude's servers/);
  assert.match(svgOf(stale.tooltip), /Data from 1:34 PM/);
  assert.equal(viewEn(null, { code: 'no-login', message: 'x' }).text, '$(account) No subscription login');
  assert.equal(viewEn(null, { code: 'expired', message: 'x' }).text, '$(key) Login needs refresh');
});

test('English: long headline wraps at spaces', () => {
  const lines = f.wrap('At this pace, the 7-day limit runs out tomorrow (Fri) around 11 PM, 3d 22h before it resets.', 13, 360);
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => !l.endsWith(' ')));
});

/* ───────────── Token 與 API 費用 ───────────── */

const summary = (total, cacheRead, cost) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead, total, cost, unpricedTokens: 0, requests: 1, topModel: 'Opus 5.5', topModelShare: 1 });
const TOKENS = { five_hour: summary(3.9e6, 3.4e6, 4.9), seven_day: summary(267.4e6, 254.6e6, 153.27) };

test('數字格式', () => {
  assert.equal(f.formatTokens(850), '850');
  assert.equal(f.formatTokens(48_200), '48.2K');
  assert.equal(f.formatTokens(3.9e6), '3.9M');
  assert.equal(f.formatTokens(1.2e9), '1.2B');
  assert.equal(f.formatUsd(4.9), '$4.90');
  assert.equal(f.formatUsd(153.27), '$153');
  assert.equal(f.formatUsd(1234.5), '$1,235');
});

test('卡片：token 與 API 費用表（英文、中文）', () => {
  const en = f.renderView({ snapshot: { usage: TODAY, fetchedAt: NOW, plan: 'pro' }, error: null, format: '', warn: 80, err: 95, theme: 'dark', now: NOW, tokens: TOKENS });
  const svg = svgOf(en.tooltip);
  assert.match(svg, />Claude Code on this computer</);
  assert.match(svg, />3\.9M</);
  assert.match(svg, />267\.4M</);
  assert.match(svg, />\$4\.90</);
  assert.match(svg, />\$153</);
  assert.match(svg, /At API list prices · mostly Opus 5\.5/);
  assert.match(en.ariaLabel, /API-equivalent cost on this computer: \$4\.90 in the 5-hour window, \$153 in the 7-day window\./);
  const zhSvg = svgOf(view(TODAY, null, { tokens: TOKENS }).tooltip);
  assert.match(zhSvg, />這台電腦的 Claude Code</);
  assert.match(zhSvg, />換算 API 費用</);
  // 沒有 token 資料時不畫表
  assert.doesNotMatch(svgOf(view(TODAY).tooltip), /Claude Code/);
  // 5 小時區間沒資料時顯示 —
  assert.match(svgOf(view(TODAY, null, { tokens: { five_hour: null, seven_day: TOKENS.seven_day } }).tooltip), />—</);
});

test('自訂格式的 token 與費用代號', () => {
  assert.equal(f.renderText('{seven_day_cost} · {five_hour_tokens}', TODAY, NOW, en, TOKENS), '$153 · 3.9M');
  assert.equal(f.renderText('{five_hour_cost}', TODAY, NOW, en, null), '—');
});
