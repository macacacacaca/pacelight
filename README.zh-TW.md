<p align="center">
  <img src="docs/icon.png" width="112" height="112" alt="Pacelight 圖示：沿著跑道移動的配速燈">
</p>

<h1 align="center">Pacelight 配速燈</h1>

<p align="center">
  <b>撐得到重置嗎？</b><br>
  把 Claude 訂閱的 5 小時與 7 天用量，和時間放在一起比，顯示在 VS Code 狀態列。
</p>

<p align="center">
  <a href="#安裝">安裝</a> ·
  <a href="#特色">特色</a> ·
  <a href="#隱私">隱私</a> ·
  <a href="#設定">設定</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/usage-card.png" width="460" alt="滑鼠移到狀態列上的用量卡片：5 小時 29%、7 天 81%，預估 7 天額度何時用完，以及這台電腦 Claude Code 的 token 數與 API 費用">
</p>

<p align="center"><sub>非官方社群專案，與 Anthropic 無關，也未經其認可或贊助。</sub></p>

## 一眼看懂

Pacelight 待在狀態列「✻ Claude Code」旁邊，平常不打擾，需要注意時才變。下表是繁中介面（`pacelight.language` 設為 `zh-TW`）的樣子；預設的英文介面把「偏快」顯示為「over pace」。

| 狀態列 | 顏色 | 意思 |
|:--|:--|:--|
| `5h 8% · 7d 12%` | — | 都在步調內。大部分時間你只會看到這樣。 |
| `5h 13% · 7d 54% 偏快` | — | 照目前速度，7 天額度會在重置前用完。 |
| `5h 86% · 42 分鐘後重置` | 警告色 | 有一項到了 80%。只留這一項，並講何時重置。 |
| `7d 97% · 週五 17:35 重置` | 錯誤色 | 有一項到了 95% 或已用完（`5h 已用完 · 30 分鐘後重置`）。 |
| `5h 13% · 7d 54% 偏快` 前面多一個時鐘或斷線圖示 | — | 數字不是最新的：連不上伺服器，或登入需要更新。滑鼠移上去看原因。 |

## 特色

- **平常很安靜。** 只有兩個數字。只有某項額度需要注意時，狀態列才會改變。
- **看步調，不只看百分比。** 單看 54% 沒什麼意義。Pacelight 把每個區間的用量和「時間過了多少」相比，照目前速度會提早用完時就告訴你。
- **直接給答案。** 滑鼠移上去，第一句就回答你真正想知道的事：「照目前速度，7 天額度明天（週五）23:00 左右就會用完，比重置早 3 天 22 小時。」接著告訴你怎麼撐過去：「想撐到週二 22:00 重置，每天用 8% 以內。」
- **步調一看就懂。** 每個區間一條長條，直線標出時間過到哪裡；超過直線的斜紋，就是用得比時間快的部分。
- **換算成 API 費用。** 這台電腦的 Claude Code 在每個區間用了多少 token，照 Anthropic API 牌價要花多少錢。
- **方案裡的每項額度。** Max 方案「僅 Sonnet」「僅 Fable」這類單一模型的每週額度，會以精簡列列在卡片 7 天額度的下面，並一樣觸發警告色；伺服器回應裡舊的單一模型欄位和新的 `limits[]` 清單都會讀。
- **不浪費請求。** 預設每 2 分鐘查一次，所有 VS Code 視窗共用同一份結果，出錯時自動放慢；方案名稱最多每小時查一次。
- **不靠顏色也看得懂。** 狀態都有文字說明，狀態列和卡片也都有讀屏文字。
- **英文與繁體中文介面。**

點一下狀態列項目，就會立即更新。

## 安裝

需要 VS Code 1.90 以上，並已用 Claude 訂閱（Pro、Max 等）登入 Claude Code；API 金鑰登入沒有方案用量。

1. 到[最新版本](https://github.com/macacacacaca/pacelight/releases/latest)下載 `pacelight-<版本>.vsix`。
2. 在 VS Code 的命令面板執行「Extensions: Install from VSIX…」選這個檔案；或在終端機執行 `code --install-extension pacelight-<版本>.vsix`。

在 macOS 上實測過。Linux、Windows 依 Claude Code 文件裡這兩個平台的登入檔位置實作，還沒實測。想自己從原始碼打包，見[開發](#開發)。

## 隱私

| | Pacelight 的做法 |
|:--|:--|
| **收集的資料** | 沒有。沒有遙測，沒有分析。 |
| **網路** | 兩個請求，都只連 `api.anthropic.com`：用量 `GET https://api.anthropic.com/api/oauth/usage`（預設每 2 分鐘），方案名稱 `GET https://api.anthropic.com/api/oauth/profile`（最多每小時一次，手動更新時也會查）。不連其他地方。 |
| **你的登入權杖** | 從 Claude Code 自己的儲存位置讀取，只送往 `api.anthropic.com`；不寫進記錄或磁碟，也不會刷新。 |
| **你的對話記錄** | 只在記憶體裡留下 token 數、模型名稱和時間；對話內容不會被儲存或送出。 |
| **存在磁碟上的** | 擴充功能儲存區裡的 `last-usage.json`：百分比、重置時間、方案名稱與等級（例如 Max 5x）、用量與方案的查詢時間。不存 email、名字。 |

送出的 User-Agent 是本工具自己的名稱（`pacelight/<版本>`），不冒充 Claude Code。

### 條款與風險

Anthropic 的 [Claude Code 法遵文件](https://code.claude.com/docs/en/legal-and-compliance)把訂閱登入限定在「Claude Code 與 Anthropic 自家應用的一般使用」，並寫明開發者不得收集、儲存或轉手 Claude.ai 的登入憑證或工作階段權杖（session token）。
Pacelight 只在你自己的電腦上讀權杖、只查你自己的用量、不儲存也不轉送，但這種用法沒有得到 Anthropic 明確允許，仍可能不符合條款，Anthropic 也可能隨時封鎖這個端點。

**使用 Pacelight 的風險（包括帳號受限）由你自行承擔。** 介意的話，請改用 Claude Code 內建的 `/usage` 查看用量。

## 設定

| 設定 | 預設 | 說明 |
|:--|:--|:--|
| `pacelight.language` | `en` | 介面語言：`en` 英文、`zh-TW` 繁體中文 |
| `pacelight.showTokens` | `true` | 卡片上顯示 token 與 API 費用 |
| `pacelight.format` | （空白） | 自訂狀態列文字；空白就用預設版面。見下方。 |
| `pacelight.refreshIntervalSeconds` | `120` | 查詢間隔，單位秒（最少 30） |
| `pacelight.warningThreshold` | `80` | 任一項達到這個百分比就變警告色 |
| `pacelight.errorThreshold` | `95` | 任一項達到這個百分比就變錯誤色 |

<details>
<summary><b>自訂狀態列文字</b></summary>

<br>

| 代號 | 範例 | |
|:--|:--|:--|
| `{five_hour}` | `13` | 百分比，只有數字，`%` 要自己加 |
| `{five_hour_pie}` | `◔` | 圓餅符號：○◔◑◕● |
| `{five_hour_reset}` | `2h10m` | 距離重置還有多久 |
| `{five_hour_pace}` | `偏快` | 只有用得比時間快時才出現，否則是空的（英文介面是 `over pace`） |
| `{five_hour_tokens}` | `3.9M` | 區間內用掉的 token |
| `{five_hour_cost}` | `$4.90` | 照 API 牌價換算的費用 |

`seven_day` 也有同樣的代號。`$(pulse)` 這類 codicon 圖示也能用。

- 同時看 5 小時的倒數：`"pacelight.format": "5h {five_hour}% ({five_hour_reset}) · 7d {seven_day}%"`
- 在狀態列直接看 7 天換算的 API 費用：`"pacelight.format": "5h {five_hour}% · 7d {seven_day}% · {seven_day_cost}"`

自訂格式會取代預設版面（包括接近上限時的顯示），但警告色、錯誤色照樣生效。關掉 `pacelight.showTokens` 時，`{…_tokens}`、`{…_cost}` 會顯示「—」。

</details>

不想看了：在狀態列按右鍵，取消勾選「Pacelight」。

## 運作方式

<details>
<summary><b>數字從哪裡來</b></summary>

<br>

1. 從 macOS 鑰匙圈的「Claude Code-credentials」（其他平台是 `~/.claude/.credentials.json`）讀 Claude Code 的訂閱登入權杖。
2. 用它呼叫 `GET https://api.anthropic.com/api/oauth/usage`，取出 `five_hour.utilization`、`seven_day.utilization`，以及單一模型的每週額度（`seven_day_opus`、`seven_day_sonnet`，或 `limits[]` 裡 `weekly_scoped` 的項目）。
3. 卡片上的方案標籤來自 `GET https://api.anthropic.com/api/oauth/profile`，只留 `organization.organization_type`（Pro、Max…）和 `rate_limit_tier`（5x、20x），最多每小時查一次，手動更新時也會查。Claude Code 鑰匙圈裡雖然也有 `subscriptionType`，但它只在登入時寫入、升級方案後不會更新，所以只在 profile 查不到方案、又沒有先前查到的結果時當備援。

- 只讀權杖，不會自己刷新（刷新會輪替 refresh token，可能讓 Claude Code 被登出）。權杖過期時，狀態列會把數字標成不是最新的，卡片上會說明原因；等 Claude Code 下次送出訊息就會自動刷新。
- 這兩個端點都沒有公開文件，日後可能改變。用量端點改了的話，狀態列會把數字標成不是最新的，卡片上會顯示警告；profile 端點改了，卡片只會沿用上次的方案標籤。資料解析在 [src/usage.js](src/usage.js)。
- 只有 Pro、Max 等訂閱登入才有這份資料；API 金鑰登入會顯示「未登入訂閱」（英文介面是「No subscription login」）。

</details>

<details>
<summary><b>Token 與費用怎麼算</b></summary>

<br>

- 來源是 Claude Code 存在這台電腦的對話記錄 `~/.claude/projects/**/*.jsonl`：每則回覆都記了輸入、輸出、快取寫入、快取讀取的 token 數。
- 同一則回覆會因為每個內容區塊各寫一行而重複出現，用 `message.id` + `requestId` 去重；子代理（`subagents/`）的記錄也算在內。
- 費用照 [Anthropic API 牌價](https://platform.claude.com/docs/en/about-claude/pricing)（2026-10-08）：快取寫入 5 分鐘 1.25 倍、1 小時 2 倍輸入價，快取讀取依模型而定（Opus 5.5 是 $0.20/MTok）；也算進快速模式、Haiku 5.5 長提示、指定美國境內推論的 1.1 倍，網路搜尋每次 $0.01。價目表在 [src/tokens.js](src/tokens.js) 的 `PRICES`，牌價變了改那裡。
- 只算這台電腦的 Claude Code；claude.ai 網頁、手機、其他電腦的用量不在記錄裡，所以和方案用量百分比不會完全對得上。
- 第一次掃描最近 8 天的記錄（幾百 MB）不到一秒，之後只讀新增的部分。

</details>

<details>
<summary><b>為什麼不用 Claude Code 的 <code>statusLine</code></b></summary>

<br>

`statusLine` 指令只有終端機版 `claude` 會執行並顯示結果；VS Code 裡的 Claude Code 面板不會跑它。
所以 Pacelight 做成 VS Code 擴充功能，直接讀和 `statusLine` 的 `rate_limits`、`/usage` 同一份資料。

</details>

## 設計

版面參考 Flighty（2023 Apple 設計獎）的機場看板、Gentler Streak（2024 Apple 設計獎）的步調線與溫和用語，以及 Apple HIG 的儀表準則：固定 0–100 刻度、先用一句話講重點、不只靠顏色表達狀態。

名字取自田徑場的配速燈：沿著跑道以目標配速移動的燈號，讓選手一眼看出自己比目標快還是慢。

## 開發

```sh
npm install            # 只裝開發工具：型別定義，以及 npm run preview 用的 marked、codicons；執行時沒有相依套件
npm test               # 單元測試，含假的 vscode 模組
npm run smoke          # 不開 VS Code，用你的 Claude Code 登入實際查一次並印出結果
npm run preview        # 產生 preview.html，模擬深色、淺色、高對比主題下的狀態列與卡片（中文版：npm run preview -- preview.html zh-TW）
npm run check:privacy  # push 或發布前跑：檢查要公開的檔案、git 歷史、.vsix 裡有沒有個人資訊或權杖
```

- 在 VS Code 開這個資料夾按 F5，會開一個「擴充功能開發主機」視窗來試。
- 想把自己打包的版本裝到平常用的 VS Code：執行 `npm run package`，再執行 `code --install-extension pacelight-0.1.1.vsix`，最後執行「Developer: Reload Window」。macOS 找不到 `code` 指令的話，先在命令面板執行「Shell Command: Install 'code' command in PATH」。

| 檔案 | 內容 |
|:--|:--|
| [extension.js](extension.js) | 狀態列項目、定時查詢、快取、指令 |
| [src/usage.js](src/usage.js) | 讀登入權杖、呼叫 API、解析回應（不依賴 vscode） |
| [src/format.js](src/format.js) | 狀態列文字、SVG 用量卡片、一句話摘要、讀屏文字（純函式） |
| [src/i18n.js](src/i18n.js) | 畫面上所有文字（英文、繁中），包括時間格式與句型 |
| [src/tokens.js](src/tokens.js) | 讀本機對話記錄統計 token、API 牌價與費用換算（不依賴 vscode） |
| [scripts/privacy-check.js](scripts/privacy-check.js) | 發布前的個資掃描 |

## 授權

[MIT](LICENSE)

<sub>Pacelight 是非官方社群專案，與 Anthropic 無關，也未經其認可或贊助。Claude、Claude Code 是 Anthropic, PBC 的商標。</sub>
