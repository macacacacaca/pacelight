'use strict';

// 不開 VS Code，直接跑一次真實查詢，印出狀態列文字、token 與 API 費用、讀屏文字。
// 用法：npm run smoke

const { readCredentials, fetchUsage } = require('../src/usage');
const { renderView, formatTokens, formatUsd } = require('../src/format');
const { TokenLedger } = require('../src/tokens');

(async () => {
  const cred = await readCredentials();
  const usage = await fetchUsage(cred.accessToken);
  const now = Date.now();
  const ledger = new TokenLedger();
  await ledger.update(now);
  const win = (w, len) => (w && w.resetsAt != null && w.resetsAt > now ? ledger.summarize(w.resetsAt - len, now) : null);
  const tokens = { five_hour: win(usage.fiveHour, 5 * 3600e3), seven_day: win(usage.sevenDay, 7 * 864e5) };
  const view = renderView({
    snapshot: { usage, fetchedAt: now, plan: cred.subscriptionType },
    error: null,
    format: '',
    warn: 80,
    err: 95,
    theme: 'dark',
    now,
    tokens,
  });
  console.log(`Status bar : ${view.text}`);
  for (const [name, t] of Object.entries(tokens)) {
    if (t) console.log(`${name.padEnd(11)}: ${formatTokens(t.total)} tokens (${formatTokens(t.cacheRead)} cache reads) ≈ ${formatUsd(t.cost)} at API prices`);
  }
  console.log(`Screen rdr : ${view.ariaLabel}`);
})().catch((e) => {
  console.error(`Failed (${e.code ?? 'unknown'}): ${e.message}`);
  process.exitCode = 1;
});
