/**
 * 00_Config.gs — gas-inbox 設定
 *
 * GASエディタ → プロジェクトの設定 → スクリプトプロパティで以下を登録:
 *   - LINE_CHANNEL_ACCESS_TOKEN  (LINEファイル取得に必要)
 *   - NOTION_API_KEY
 *   - INBOX_DB_ID               (Notion Inbox DBのID)
 *   - SKILLSHEET_FOLDER_ID      (Google Drive保存先フォルダID)
 */

const props = PropertiesService.getScriptProperties();

const LINE_CHANNEL_ACCESS_TOKEN = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
const NOTION_API_KEY = props.getProperty("NOTION_API_KEY");
const INBOX_DB_ID = props.getProperty("INBOX_DB_ID");
const SKILLSHEET_FOLDER_ID = props.getProperty("SKILLSHEET_FOLDER_ID");

const SKILLSHEET_LOG_SHEET_ID = props.getProperty("SKILLSHEET_LOG_SHEET_ID"); // デバッグ用（任意）

const NOTION_API_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * ファイル処理のデバッグログをスプレッドシートに書き出す
 * SKILLSHEET_LOG_SHEET_ID が未設定なら何もしない
 */
function logToSheet(stage, detail) {
  if (!SKILLSHEET_LOG_SHEET_ID) return;
  try {
    const ss = SpreadsheetApp.openById(SKILLSHEET_LOG_SHEET_ID);
    let sheet = ss.getSheetByName("file-log");
    if (!sheet) {
      sheet = ss.insertSheet("file-log");
      sheet.appendRow(["timestamp", "stage", "detail"]);
    }
    sheet.appendRow([new Date(), stage, JSON.stringify(detail).substring(0, 5000)]);
  } catch (e) {
    // ログ書き込み失敗は握り潰す（本体処理に影響させない）
  }
}

/**
 * 設定確認用（手動実行）
 */
function checkConfig() {
  const keys = [
    "LINE_CHANNEL_ACCESS_TOKEN",
    "NOTION_API_KEY",
    "INBOX_DB_ID",
    "SKILLSHEET_FOLDER_ID",
    "SKILLSHEET_LOG_SHEET_ID"
  ];
  keys.forEach(key => {
    const val = props.getProperty(key);
    Logger.log(`${key}: ${val ? "✅ SET" : "❌ MISSING"}`);
  });
}
