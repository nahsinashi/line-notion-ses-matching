/**
 * 01_Webhook.gs — LINE Webhook受信 → Notion Inbox登録
 *
 * やること:
 *   1. LINE webhookイベントを受信
 *   2. テキスト/ファイルを取得
 *   3. Notion Inbox DBに原文を書き込む
 *
 * やらないこと:
 *   - AI分類・整形（Claude Codeが担当）
 *   - マッチング（Claude Codeが担当）
 *   - LINE通知
 */

// =========================================================
// Webhook エントリポイント
// =========================================================

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // action=send の場合は送信処理に振り分け
    if (body.action === "send") {
      const result = handleSendRequest(body);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // LINE webhook イベント処理
    const events = body.events || [];
    const results = [];
    for (const event of events) {
      const result = processEvent(event);
      if (result) results.push(result);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", processed: results.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log("doPost error: " + error.message);
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: error.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// =========================================================
// イベント処理
// =========================================================

function processEvent(event) {
  if (event.type !== "message") return null;

  const userId = event.source.userId;
  const message = event.message;

  // 再送チェック（5分キャッシュ）
  const cache = CacheService.getScriptCache();
  const cacheKey = "msg_" + message.id;
  if (cache.get(cacheKey)) return null;
  cache.put(cacheKey, "1", 300);

  if (message.type === "text") {
    return processTextMessage(message.text, userId);
  } else if (message.type === "file" || message.type === "image") {
    logToSheet("event_received", { type: message.type, messageId: message.id, fileName: message.fileName, userId: userId });
    return processFileMessage(message, userId);
  }

  logToSheet("event_skipped", { type: message.type, messageType: message.type, userId: userId });
  return null;
}

// =========================================================
// テキストメッセージ → Inbox
// =========================================================

function processTextMessage(text, userId) {
  const pageId = createInboxEntry(text, "LINE", userId);
  Logger.log(`Inbox登録 (テキスト): ${pageId}`);
  return { type: "text", pageId: pageId };
}

// =========================================================
// ファイルメッセージ → Drive保存 → Inbox
// =========================================================

function processFileMessage(message, userId) {
  // ファイル名の決定
  let fileName = "file";
  if (message.type === "file" && message.fileName) {
    fileName = message.fileName;
  } else if (message.type === "image") {
    fileName = "image_" + message.id + ".jpg";
  }

  // LINE APIからファイル取得 → Drive保存
  let fileUrl = null;
  try {
    logToSheet("file_download_start", { messageId: message.id, fileName: fileName });
    const blob = getLineFileContent(message.id);
    if (blob) {
      logToSheet("file_download_ok", { messageId: message.id, blobSize: blob.getBytes().length, contentType: blob.getContentType() });
      const fileInfo = saveFileToDrive(blob, fileName);
      fileUrl = fileInfo.url;
      logToSheet("file_save_ok", { messageId: message.id, fileUrl: fileUrl });
    } else {
      logToSheet("file_download_fail", { messageId: message.id, fileName: fileName, reason: "blob=null" });
    }
  } catch (error) {
    logToSheet("file_save_error", { messageId: message.id, fileName: fileName, error: error.message });
  }

  // ファイル取得の成否にかかわらず、Inboxには必ず登録する
  const rawText = fileUrl
    ? "（ファイル添付）" + fileName
    : "（ファイル添付・取得失敗）" + fileName;
  const pageId = createInboxEntry(rawText, "LINE", userId, fileUrl);
  Logger.log(`Inbox登録 (ファイル): ${pageId} / ${fileName} / URL: ${fileUrl || "なし"}`);
  return { type: "file", pageId: pageId, fileName: fileName };
}

// =========================================================
// LINE API: ファイルコンテンツ取得
// =========================================================

function getLineFileContent(messageId) {
  try {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { "Authorization": `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` },
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code === 200) {
      return response.getBlob();
    }
    logToSheet("line_api_error", { messageId: messageId, statusCode: code, body: response.getContentText().substring(0, 500) });
    return null;
  } catch (error) {
    logToSheet("line_api_exception", { messageId: messageId, error: error.message });
    return null;
  }
}

// =========================================================
// Google Drive: ファイル保存
// =========================================================

function saveFileToDrive(blob, fileName) {
  const folder = DriveApp.getFolderById(SKILLSHEET_FOLDER_ID);

  // タイムスタンプ付きファイル名
  const timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmmss");
  const ext = fileName.includes(".") ? fileName.substring(fileName.lastIndexOf(".")) : "";
  const baseName = fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName;
  const newFileName = `${baseName}_${timestamp}${ext}`;

  blob.setName(newFileName);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const downloadUrl = "https://drive.google.com/uc?export=download&id=" + file.getId();

  return {
    fileId: file.getId(),
    fileName: newFileName,
    url: downloadUrl
  };
}

// =========================================================
// Notion: Inbox DBにエントリ作成
// =========================================================

function createInboxEntry(rawText, source, userId, fileUrl) {
  const title = `${source}: ${userId || "不明"}`;

  const properties = {
    "タイトル": { title: [{ text: { content: title } }] },
    "原文": { rich_text: [{ text: { content: rawText.substring(0, 2000) } }] },
    "入力経路": { select: { name: source } },
    "userId": { rich_text: [{ text: { content: userId || "" } }] },
    "ステータス": { select: { name: "未処理" } }
  };

  // 添付ファイルがある場合
  if (fileUrl) {
    properties["添付ファイル"] = {
      files: [{ name: "スキルシート", type: "external", external: { url: fileUrl } }]
    };
  }

  // 原文全文をページ本文（blocks）にも書き込む（2000文字制限の回避）
  const children = textToBlocks(rawText);

  const payload = {
    parent: { database_id: INBOX_DB_ID },
    properties: properties,
    children: children
  };

  const response = UrlFetchApp.fetch(`${NOTION_API_URL}/pages`, {
    method: "post",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const result = JSON.parse(response.getContentText());

  if (response.getResponseCode() >= 400) {
    Logger.log("Notion API Error: " + response.getContentText());
    return null;
  }

  return result.id;
}

// =========================================================
// テキスト → Notionブロック変換（原文全文保存用）
// =========================================================

/**
 * テキストをNotionのparagraphブロック配列に変換
 * rich_textの2000文字制限を考慮して分割する
 * @param {string} text - 原文テキスト
 * @returns {Array} Notionブロック配列（最大100ブロック）
 */
function textToBlocks(text) {
  const blocks = [];
  const lines = text.split("\n");

  for (const line of lines) {
    if (line.length <= 2000) {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line || " " } }]
        }
      });
    } else {
      // 2000文字超の行は分割
      for (let i = 0; i < line.length; i += 2000) {
        blocks.push({
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: line.substring(i, i + 2000) } }]
          }
        });
      }
    }
  }

  return blocks.slice(0, 100);
}
