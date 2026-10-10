'use strict';

// 上傳 GitHub、發布 .vsix 之前跑一次：確認要公開的東西裡沒有個人資訊或權杖。
// 用法：npm run check:privacy（有問題時結束碼為 1）
//
// 檢查：
// 1. 會被提交的檔案：用 git 自己的忽略規則決定清單（還不是 repo 時借一個暫存的 .git 來算）
// 2. 已經是 repo 時：暫存區、整個 git 歷史（含 commit 訊息）、tag
// 3. 專案裡的 .vsix（解開後逐檔檢查）
// 4. git 實際會寫進 commit 的作者身分
//
// 要找的帳號名稱、家目錄、電腦名稱、全名都在執行時從這台電腦讀出來，不寫在這個檔案裡。
// 輸出只說「哪裡有什麼類型的資訊」，不印出內容本身，可以放心貼出來。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic)$/i;

/** 執行指令並回傳輸出；失敗（指令不存在、非零結束）回傳 null */
function run(/** @type {string} */ cmd, /** @type {string[]} */ args, cwd = ROOT) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}
const git = (/** @type {string[]} */ args) => run('git', args);

/** @type {string[]} */
const problems = [];
/** @type {string[]} */
const notes = [];

if (git(['--version']) == null) {
  console.log('✖ 找不到 git，無法判斷哪些檔案會被提交');
  process.exit(1);
}

// ── 這台電腦上會認出你的字串 ──

const gitName = git(['config', 'user.name'])?.trim() || '';
const gitEmail = git(['config', 'user.email'])?.trim() || '';
/** @type {{ label: string, value: string }[]} */
const markers = [
  { label: '家目錄', value: os.homedir() },
  { label: '帳號名稱', value: os.userInfo().username },
  { label: '電腦名稱', value: os.hostname().replace(/\.local$/i, '') },
];
if (process.platform === 'darwin') {
  for (const key of ['ComputerName', 'LocalHostName']) {
    markers.push({ label: '電腦名稱', value: run('scutil', ['--get', key])?.trim() || '' });
  }
  // 自己在 git 設成公開名字的就不算
  const fullName = run('id', ['-F'])?.trim() || '';
  if (fullName !== gitName) markers.push({ label: '全名', value: fullName });
}
// 空白、連字號、底線、句點的寫法不同也要認得（「A B」「A-B」「AB」、不斷行空白）
const loose = (/** @type {string} */ s) =>
  s.split(/[\s ._-]+/).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('[\\s\\u00a0._-]*');
const personal = [...new Map(markers.filter((m) => m.value.length >= 3).map((m) => [loose(m.value).toLowerCase(), m])).values()]
  .map((m) => ({ label: m.label, re: new RegExp(loose(m.value), 'i') }));

/** @type {{ label: string, re: RegExp, allow?: (s: string) => boolean }[]} */
const PATTERNS = [
  // 測試用的假權杖都帶 CANARY
  { label: 'Anthropic 權杖', re: /sk-ant-[\w-]{20,}/g, allow: (s) => s.includes('CANARY') },
  { label: 'OpenAI 權杖', re: /\bsk-proj-[\w-]{20,}/g },
  { label: 'JWT', re: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g },
  { label: 'GitHub 權杖', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\w{50,})/g },
  { label: 'npm 權杖', re: /\bnpm_[A-Za-z0-9]{36}\b|_authToken=["']?[\w-]{16,}/g },
  { label: 'AWS 金鑰', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API 金鑰', re: /\bAIza[\w-]{35}\b/g },
  { label: 'Slack 權杖', re: /\bxox[abposr]-[\w-]{10,}/g },
  { label: '私鑰', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    label: 'email',
    re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\b/g,
    allow: (s) => /@(?:users\.noreply\.github\.com|example\.(?:com|org)|anthropic\.com|github\.com)$/i.test(s) || /@\d+x\./.test(s),
  },
];

/** @param {string} where @param {string} text */
function scanText(where, text) {
  const at = (/** @type {number} */ i) => `${where}:${text.slice(0, i).split('\n').length}`;
  for (const m of personal) {
    const hit = m.re.exec(text);
    if (hit) problems.push(`${at(hit.index)}  含有你的${m.label}`);
  }
  for (const p of PATTERNS) {
    for (const hit of text.matchAll(p.re)) {
      if (!p.allow?.(hit[0])) problems.push(`${at(hit.index ?? 0)}  像是${p.label}`);
    }
  }
}

/** 檢查一個檔案；symlink 檢查的是它指向的路徑（git 提交的就是這段文字） */
function scanFile(/** @type {string} */ abs, /** @type {string} */ where) {
  scanText(`${where}（檔名）`, where);
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return scanText(`${where}（連結）`, fs.readlinkSync(abs));
  if (!st.isFile()) return;
  if (st.size > MAX_BYTES) return problems.push(`${where}  超過 5MB 沒有檢查，請確認是否真的要公開`);
  const buf = fs.readFileSync(abs);
  if (!buf.includes(0)) return scanText(where, buf.toString('utf8'));
  // 二進位檔：用兩種方式解碼，至少認得出裡面的 ASCII 與 UTF-16 字串
  scanText(where, buf.toString('latin1'));
  scanText(where, buf.toString('utf16le'));
  if (IMAGE.test(where)) notes.push(`${where}  圖片的畫面內容請自己看過`);
}

/** 走訪資料夾裡的每個檔案（不跟著 symlink 走） */
function walk(/** @type {string} */ dir, /** @type {string} */ prefix, /** @type {(abs: string, rel: string) => void} */ fn) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = `${prefix}${ent.name}`;
    if (ent.isDirectory()) walk(abs, `${rel}/`, fn);
    else fn(abs, rel);
  }
}

// ── 1. 會被提交的檔案 ──

const isRepo = path.resolve(git(['rev-parse', '--show-toplevel'])?.trim() || '/nonexistent') === path.resolve(ROOT);
let tracked;
if (isRepo) {
  tracked = (git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']) || '').split('\0').filter(Boolean);
} else {
  // 借一個暫存的 .git 來算，規則（含全域忽略設定）和真的 git add 完全一樣，專案裡不會多出 .git
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-check-'));
  try {
    git(['init', '-q', tmp]);
    const out = git(['--git-dir', path.join(tmp, '.git'), '--work-tree', ROOT, 'ls-files', '-z', '--others', '--exclude-standard']);
    tracked = (out || '').split('\0').filter(Boolean);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
for (const rel of tracked) {
  scanFile(path.join(ROOT, rel), rel);
  if (/(^|\/)(\.claude|\.DS_Store|node_modules)(\/|$)/.test(rel) || /\.(vsix|log)$/.test(rel)) {
    problems.push(`${rel}  不該提交的本機檔案（請加進 .gitignore）`);
  }
}

// ── 2. 暫存區、歷史、tag ──

if (isRepo) {
  scanText('暫存區（git diff --cached）', git(['diff', '--cached']) || '');
  scanText('git 歷史（git log --all -p）', git(['log', '--all', '-p', '--format=%an <%ae>%n%cn <%ce>%n%B']) || '');
  scanText('tag（git for-each-ref refs/tags）', git(['for-each-ref', '--format=%(taggername) %(taggeremail)%0a%(contents)', 'refs/tags']) || '');
}

// ── 3. .vsix 打包檔 ──

const vsixes = fs.readdirSync(ROOT).filter((f) => f.endsWith('.vsix'));
for (const vsix of vsixes) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-check-vsix-'));
  try {
    if (run('unzip', ['-q', '-o', path.join(ROOT, vsix), '-d', tmp]) == null) {
      problems.push(`${vsix}  解不開（找不到 unzip？），沒有檢查`);
      continue;
    }
    walk(tmp, '', (abs, rel) => {
      if (/^extension\/(\.claude|\.github|\.vscode|test|scripts|node_modules)\//.test(rel)) {
        problems.push(`${vsix} → ${rel}  不該打包進擴充功能（請加進 .vscodeignore）`);
      }
      scanFile(abs, `${vsix} → ${rel}`);
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 4. git 作者身分：看 git 實際會寫進 commit 的內容 ──

if (!gitName || !gitEmail) {
  problems.push('git 的 user.name、user.email 要兩個都設定，沒設的那個 git 會自動用帳號全名或「帳號@電腦名稱」補上：\n' +
    '      git config --global user.name "<公開的名字>"\n' +
    '      git config --global user.email "<ID>+<帳號>@users.noreply.github.com"');
}
for (const kind of ['AUTHOR', 'COMMITTER']) {
  const ident = git(['var', `GIT_${kind}_IDENT`])?.replace(/\s+\d+ [+-]\d{4}\s*$/, '') || '';
  const leaked = [...new Set(personal.filter((m) => m.re.test(ident)).map((m) => m.label))];
  if (/\.local>$/i.test(ident) && !leaked.includes('電腦名稱')) leaked.push('電腦名稱');
  if (leaked.length) problems.push(`commit 的${kind === 'AUTHOR' ? '作者' : '提交者'}身分會帶出你的${leaked.join('、')}`);
}
if (gitEmail && !/@users\.noreply\.github\.com$/i.test(gitEmail)) {
  problems.push('git 的 email 不是 GitHub 的 noreply 地址，會公開在每個 commit 上');
}
const offset = -new Date().getTimezoneOffset();
if (offset !== 0) {
  const hhmm = `${offset > 0 ? '+' : '-'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  notes.push(`每個 commit 都會記錄時區（${hhmm}）；不想公開的話用 TZ=UTC git commit`);
}

// ── 結果 ──

console.log(`檢查了 ${tracked.length} 個要提交的檔案、${vsixes.length} 個 .vsix${isRepo ? '、git 歷史' : '（還不是 git repo）'}`);
if (notes.length) {
  console.log('\n請自己確認：');
  for (const n of notes) console.log(`  • ${n}`);
}
if (problems.length) {
  console.log(`\n發現 ${problems.length} 個問題：`);
  for (const p of problems) console.log(`  ✖ ${p}`);
  process.exitCode = 1;
} else {
  console.log('\n✔ 沒有找到個人資訊或權杖');
}
