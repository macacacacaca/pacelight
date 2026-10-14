'use strict';

// 產生一頁 HTML，模擬 VS Code 2026 Dark／Light 的狀態列與滑鼠提示，用來看設計效果。
// 用法：npm run preview [-- 輸出路徑 [en|zh-TW]]，再用瀏覽器打開。

const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');
const { renderView } = require('../src/format');

const NOW = new Date(2026, 9, 8, 13, 35).getTime();
const LANG = process.argv[3] || 'en';
const H = 3_600_000;
const M = 60_000;
const D = 24 * H;

const THEMES = {
  dark: {
    bar: '#191A1B', barFg: '#8C8C8C', barBorder: '#2A2B2C', hoverBg: '#202122', hoverBorder: '#2A2B2C',
    fg: '#BFBFBF', link: '#48A0C7', editor: '#121314', warnBg: '#7A6400', errBg: '#C72E0F', dim: '#555555', hr: '#2A2B2C',
  },
  'hc-dark': {
    bar: '#000000', barFg: '#FFFFFF', barBorder: '#6FC3DF', hoverBg: '#0C141F', hoverBorder: '#6FC3DF',
    fg: '#FFFFFF', link: '#21A6FF', editor: '#000000', warnBg: '#7A6400', errBg: '#C72E0F', dim: '#A5A5A5', hr: '#6FC3DF',
  },
  light: {
    bar: '#FAFAFD', barFg: '#606060', barBorder: '#F0F1F2', hoverBg: '#FAFAFD', hoverBorder: '#E4E5E6',
    fg: '#202020', link: '#0069CC', editor: '#FFFFFF', warnBg: '#7A6400', errBg: '#C72E0F', dim: '#BBBBBB', hr: '#E4E5E6',
  },
};

const usage = (five, fiveIn, seven, sevenIn, extras = []) => ({
  fiveHour: { percent: five, resetsAt: NOW + fiveIn },
  sevenDay: { percent: seven, resetsAt: NOW + sevenIn },
  extras,
});
const snap = (u, plan = 'pro', tier = null) => ({ usage: u, fetchedAt: NOW - 1 * M, plan, tier });
const scoped = (key, label, percent, resetsIn) => ({ key, label, window: { percent, resetsAt: NOW + resetsIn } });
const summary = (total, cacheRead, cost) => ({ input: 0, output: 0, cacheWrite: 0, cacheRead, total, cost, unpricedTokens: 0, requests: 1, topModel: 'Opus 5.5', topModelShare: 1 });
const TOKENS = { five_hour: summary(3.9e6, 3.4e6, 4.9), seven_day: summary(267.4e6, 254.6e6, 153.27) };

const SCENARIOS = [
  { title: '平常', theme: 'dark', snapshot: snap(usage(13, 3 * H + 5 * M, 54, 5 * 24 * H + 8 * H + 25 * M)), tokens: TOKENS },
  { title: '兩項都從容', theme: 'dark', snapshot: snap(usage(8, 4 * H, 12, 6 * 24 * H)) },
  { title: '5 小時接近上限', theme: 'dark', snapshot: snap(usage(86, 42 * M, 60, 3 * 24 * H)) },
  { title: '7 天快用完（Max 方案）', theme: 'dark', snapshot: snap(usage(30, 2 * H, 97, 1 * D + 4 * H, [scoped('seven_day_sonnet', 'Sonnet', 41, 1 * D + 4 * H)]), 'max', 'default_claude_max_20x') },
  { title: 'Max 5x・僅 Fable 58%', theme: 'dark', snapshot: snap(usage(18, 2 * H, 29, 6 * D + 8 * H, [scoped('weekly_scoped_fable', 'Fable', 58, 6 * D + 8 * H)]), 'max', 'default_claude_max_5x') },
  { title: 'Max 5x・僅 Fable 快用完', theme: 'dark', snapshot: snap(usage(20, 3 * H, 40, 4 * D, [scoped('weekly_scoped_fable', 'Fable', 98, 4 * D)]), 'max', 'default_claude_max_5x') },
  { title: '更新失敗（顯示舊資料）', theme: 'dark', snapshot: snap(usage(13, 3 * H, 54, 5 * 24 * H)), error: { code: 'network', message: '連不上伺服器（ENOTFOUND）' } },
  { title: '淺色主題', theme: 'light', snapshot: snap(usage(13, 3 * H + 5 * M, 54, 5 * 24 * H + 8 * H + 25 * M)), tokens: TOKENS },
  { title: '淺色主題・接近上限', theme: 'light', snapshot: snap(usage(91, 25 * M, 70, 2 * 24 * H)) },
  { title: '兩項都用完', theme: 'dark', snapshot: snap(usage(100, 1 * H, 100, 2 * 24 * H + 3 * H)) },
  { title: '僅 Sonnet 快用完（Max）', theme: 'dark', snapshot: snap(usage(20, 3 * H, 40, 4 * D, [scoped('seven_day_sonnet', 'Sonnet', 98, 4 * D)]), 'max', 'default_claude_max_20x') },
  { title: '接近上限時連不上', theme: 'dark', snapshot: snap(usage(86, 42 * M, 60, 3 * 24 * H)), error: { code: 'network', message: 'x' } },
  { title: '沒有訂閱登入', theme: 'dark', snapshot: null, error: { code: 'no-login', message: 'x' } },
  { title: '高對比主題', theme: 'hc-dark', snapshot: snap(usage(13, 3 * H + 5 * M, 54, 5 * 24 * H + 8 * H + 25 * M)) },
];

const icons = (s) => s.replace(/\$\(([a-z0-9-]+)(~spin)?\)/g, (_, name) => `<span class="codicon codicon-${name}"></span>`);

function scenarioHtml(sc) {
  const t = THEMES[sc.theme];
  const view = renderView({
    snapshot: sc.snapshot,
    error: sc.error ?? null,
    format: '',
    warn: 80,
    err: 95,
    theme: sc.theme,
    now: NOW,
    lang: LANG,
    tokens: sc.tokens ?? null,
  });
  const itemBg = view.level === 'error' ? t.errBg : view.level === 'warning' ? t.warnBg : 'transparent';
  const itemFg = view.level !== 'normal' ? '#FFFFFF' : t.barFg;
  const tooltip = marked.parse(icons(view.tooltip));
  return `
  <section style="background:${t.editor}">
    <h2 style="color:${t.fg}">${sc.title}</h2>
    <div class="hover" style="background:${t.hoverBg};border-color:${t.hoverBorder};color:${t.fg};--link:${t.link};--hr:${t.hr}">${tooltip}</div>
    <div class="bar" style="background:${t.bar};border-top-color:${t.barBorder};color:${t.barFg}">
      <span class="item"><span class="codicon codicon-bell"></span></span>
      <span class="item" style="background:${itemBg};color:${itemFg}">${icons(view.text)}</span>
      <span class="item">✻ Claude Code</span>
      <span class="item">UTF-8</span>
    </div>
    <p class="aria" style="color:${t.barFg}">Screen reader: ${view.ariaLabel}</p>
  </section>`;
}

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'preview.html'));
// 圖示字型直接內嵌，頁面放到哪裡都能開，檔案裡也不會有 /Users/<帳號> 這種本機路徑
const codicons = path.join(__dirname, '..', 'node_modules', '@vscode', 'codicons', 'dist');
const codiconCss = fs.readFileSync(path.join(codicons, 'codicon.css'), 'utf8')
  .replace(/url\("\.\/codicon\.ttf[^"]*"\)/, `url("data:font/ttf;base64,${fs.readFileSync(path.join(codicons, 'codicon.ttf')).toString('base64')}")`);
const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<style>${codiconCss}</style>
<style>
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: grid; grid-template-columns: repeat(2, 470px); }
  section { padding: 16px 20px 12px; display: flex; flex-direction: column; align-items: flex-end; min-height: 380px; justify-content: flex-end; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 auto; align-self: flex-start; opacity: .8; }
  .hover { border: 1px solid; border-radius: 6px; padding: 4px 8px; font-size: 13px; line-height: 1.4; max-width: 500px; margin-bottom: 6px; box-shadow: 0 4px 16px rgba(0,0,0,.36); }
  .hover p { margin: 8px 0; }
  .hover img { display: block; }
  .hover hr { border: 0; border-top: 1px solid var(--hr); margin: 4px -8px; }
  .hover a { color: var(--link); text-decoration: none; }
  .hover .codicon { font-size: 14px; vertical-align: text-bottom; }
  .bar { width: 100%; height: 22px; border-top: 1px solid; display: flex; justify-content: flex-end; font-size: 12px; }
  .bar .item { display: flex; align-items: center; gap: 3px; padding: 0 5px; white-space: pre; }
  .bar .codicon { font-size: 14px; }
  .aria { font-size: 11px; align-self: flex-start; margin: 6px 0 0; }
</style></head><body>${SCENARIOS.map(scenarioHtml).join('')}</body></html>`;

fs.writeFileSync(out, html);
console.log(out);
