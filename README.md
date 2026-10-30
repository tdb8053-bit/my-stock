# GitHub Pages 資產總管

這是 Apps Script HTML 版以外的 GitHub Pages 套件。上傳本資料夾內的全部檔案到既有 GitHub repository 啟用 Pages；不要只替換 `index.html`，也不要上傳 placeholder 以外的憑證。

## 目前狀態

- `index.html` 是 GitHub Pages 專用介面；它透過 OAuth 和 Apps Script API 讀取私密試算表並記錄交易。
- Apps Script API 原始碼在 `../apps-script/pwa-api/`，需要先由您建立並部署 owner-only API executable。
- `config.example.js` 目前只有 placeholder。GitHub Pages 要能使用前，您必須以實際 OAuth Web Client ID 和 API executable deployment ID 更新這份公開設定；兩者屬公開識別資料，不能放入 client secret 或 access token。
- 本機套件完成不代表 Google Cloud、OAuth、Apps Script API 或 GitHub Pages 已部署。

## 您需要在 Google 帳戶完成的設定

1. 依 `../apps-script/pwa-api/README.md` 建立獨立 API Apps Script 專案、Script Property，並檢查必要工作表。
2. 將 API 專案和 OAuth 用戶端關聯到同一個標準 Google Cloud 專案並啟用 Apps Script API。
3. 建立 OAuth Web Client，將最終 GitHub Pages 網域加入「已授權的 JavaScript 來源」；同意畫面先限制您的擁有者帳戶。
4. 檢查 Apps Script 專案 Overview 顯示的完整 OAuth scopes，確認符合 `config.example.js`，再建立 `MYSELF` API executable deployment。
5. 把實際 OAuth Client ID 與 API deployment ID 填入 `config.example.js`。不要把 client secret、token、Sheet ID 或帳務資料放入本資料夾。
6. 確認 repository 可見內容只含程式和公開圖示，再把本資料夾全部檔案上傳到 repository 根目錄並啟用 GitHub Pages。

Apps Script API 執行要求 API 專案與 OAuth 用戶端共用標準 Cloud 專案、啟用 Apps Script API，且 access token 涵蓋 API 專案全部 scopes。請先檢視 Google 授權頁列出的權限；不要略過未驗證應用程式或權限警告。

## 使用與資料安全

- 開啟 GitHub Pages 後按「登入」，以擁有新版資產總管試算表的 Google 帳戶授權。登出或頁面重載後須重新登入；access token 只留在頁面記憶體。
- API deployment 必須限制為 `MYSELF`。試算表保持私密，前端不使用公開 GViz 查詢。
- Service worker 只快取靜態頁面、公開設定、程式和圖示；不快取 OAuth、Apps Script API 回應或金融資料。
- 交易需先確認，之後只寫入試算表，不會送出券商委託。遇到結果待核對提示時，先檢查交易記錄，不要重複送出。
- 新版 `index.html` 不會改動或取代 `apps-script/Index.html` Apps Script 網頁版。
