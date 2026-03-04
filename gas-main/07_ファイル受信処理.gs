/**
 * ===================================================
 * 07_ファイル受信処理.gs
 * ===================================================
 *
 * 【機能概要】
 * - LINEからの要員登録を2段階で処理（テキスト一時保存 → ファイル紐付け）
 * - LINE APIでファイル取得 → Google Drive保存 → Notion登録
 * - 複数件の案件/要員を分割して登録
 * - イニシャルによるテキストとファイルの紐付け
 *
 * 【doPost 登録タイプ一覧】
 * - "案件を登録": 即時登録（従来通り）
 * - "要員を一時保存": テキストを一時保存、ファイル待機（イニシャル対応）
 * - "要員ファイルを追加": ファイル受信 → イニシャルで一時保存と紐付け → Notion登録
 * - "要員を登録": 即時登録（従来互換、ファイルなし）
 *
 * 【設定が必要なもの】
 * 1. setupLineFileConfig() を実行して LINE_CHANNEL_ACCESS_TOKEN を設定
 * 2. Google Driveにスキルシート保存フォルダを作成し、SKILLSHEET_FOLDER_ID を設定
 *
 * 【既存ファイルとの関係】
 * - 05_WebApp.gs の doPost を削除し、このファイルの doPost を使用
 * - 06_LINEマッピング.gs の関数はそのまま使用（getCompanyNameByUserId等）
 */

// ============================================================
// 設定
// ============================================================

// 一時保存のタイムアウト時間（ミリ秒）
const TEMP_SAVE_TIMEOUT_MS = 5 * 60 * 1000;  // 5分

// デバッグモード（trueで詳細通知を送信）
const DEBUG_MODE = false;

/**
 * デバッグ通知を送信（DEBUG_MODEがtrueの場合のみ）
 */
function sendDebugNotification(message) {
  if (!DEBUG_MODE) return;
  const adminUserId = getAdminLineUserId();
  if (adminUserId) {
    sendLineNotification(adminUserId, `🔧 ${message}`);
  }
}

/**
 * LINE ファイル受信設定を確認
 *
 * 以下のスクリプトプロパティが必要です:
 *   - LINE_CHANNEL_ACCESS_TOKEN: LINE Messaging API のアクセストークン
 *   - SKILLSHEET_FOLDER_ID: Google Drive のスキルシート保存先フォルダID
 *
 * 設定方法: GASエディタ → プロジェクトの設定 → スクリプトプロパティ
 */
function checkLineFileConfig() {
  const props = PropertiesService.getScriptProperties();

  const token = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");
  const folderId = props.getProperty("SKILLSHEET_FOLDER_ID");

  Logger.log("=== LINE ファイル受信設定 ===");
  Logger.log("- LINE_CHANNEL_ACCESS_TOKEN: " + (token ? "✅ 設定済み" : "❌ 未設定"));
  Logger.log("- SKILLSHEET_FOLDER_ID: " + (folderId ? "✅ 設定済み (" + folderId + ")" : "❌ 未設定"));

  if (!token || !folderId) {
    Logger.log("⚠️ 未設定の項目があります。スクリプトプロパティで設定してください。");
  }
}

/**
 * 現在の設定を確認
 */
function showLineFileConfig() {
  const props = PropertiesService.getScriptProperties();
  Logger.log("=== LINE ファイル設定 ===");
  Logger.log("LINE_CHANNEL_ACCESS_TOKEN: " + (props.getProperty("LINE_CHANNEL_ACCESS_TOKEN") ? "✅ 設定済み" : "❌ 未設定"));
  Logger.log("SKILLSHEET_FOLDER_ID: " + (props.getProperty("SKILLSHEET_FOLDER_ID") || "❌ 未設定"));
}

// ============================================================
// URL抽出・処理
// ============================================================

/**
 * テキストからスキルシートURL（Google Drive, Dropbox等）を抽出
 * @param {string} text - 検索対象のテキスト
 * @returns {Array} 抽出されたURL情報の配列 [{url, type, fileId?}, ...]
 */
function extractSkillSheetUrls(text) {
  if (!text) return [];

  const urls = [];

  // Google Drive パターン
  // - https://drive.google.com/file/d/{fileId}/view
  // - https://drive.google.com/open?id={fileId}
  // - https://docs.google.com/document/d/{fileId}/edit
  // - https://docs.google.com/spreadsheets/d/{fileId}/edit
  const drivePatterns = [
    /https?:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)\/[^\s]*/g,
    /https?:\/\/drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)[^\s]*/g,
    /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)\/[^\s]*/g,
    /https?:\/\/drive\.google\.com\/drive\/folders\/([a-zA-Z0-9_-]+)[^\s]*/g
  ];

  drivePatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      urls.push({
        url: match[0].replace(/[。、）\)」』】>]+$/, ''),  // 末尾の句読点等を除去
        type: "google_drive",
        fileId: match[1]
      });
    }
  });

  // Dropbox パターン
  // - https://www.dropbox.com/s/{id}/{filename}?dl=0
  // - https://www.dropbox.com/scl/fi/{id}/{filename}
  const dropboxPatterns = [
    /https?:\/\/(?:www\.)?dropbox\.com\/s\/[a-zA-Z0-9]+\/[^\s]+/g,
    /https?:\/\/(?:www\.)?dropbox\.com\/scl\/fi\/[a-zA-Z0-9]+\/[^\s]+/g
  ];

  dropboxPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      urls.push({
        url: match[0].replace(/[。、）\)」』】>]+$/, ''),
        type: "dropbox",
        fileId: null
      });
    }
  });

  // OneDrive / SharePoint パターン
  const onedrivePatterns = [
    /https?:\/\/[a-zA-Z0-9-]+\.sharepoint\.com\/[^\s]+/g,
    /https?:\/\/onedrive\.live\.com\/[^\s]+/g,
    /https?:\/\/1drv\.ms\/[^\s]+/g
  ];

  onedrivePatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      urls.push({
        url: match[0].replace(/[。、）\)」』】>]+$/, ''),
        type: "onedrive",
        fileId: null
      });
    }
  });

  // 重複除去
  const uniqueUrls = [];
  const seen = new Set();
  urls.forEach(item => {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      uniqueUrls.push(item);
    }
  });

  Logger.log("🔗 URL抽出結果: " + uniqueUrls.length + "件");
  uniqueUrls.forEach(u => Logger.log("  - " + u.type + ": " + u.url));

  return uniqueUrls;
}

/**
 * Google Drive URLからファイル情報を取得してNotion用形式に変換
 * ※権限は既についている前提
 * @param {string} fileId - Google DriveのファイルID
 * @returns {Object|null} {name, url} または null
 */
function getGoogleDriveFileInfo(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const directUrl = "https://drive.google.com/uc?export=download&id=" + fileId;

    Logger.log("✅ Driveファイル情報取得: " + file.getName());

    return {
      name: file.getName(),
      url: directUrl
    };
  } catch (error) {
    Logger.log("⚠️ Driveファイル取得エラー（権限不足の可能性）: " + error);
    return null;
  }
}

/**
 * 抽出したURLをNotion登録用ファイル形式に変換
 * @param {Array} urlInfos - extractSkillSheetUrls()の戻り値
 * @returns {Array} Notion用ファイル配列 [{name, type, external: {url}}, ...]
 */
function convertUrlsToNotionFiles(urlInfos) {
  const notionFiles = [];

  urlInfos.forEach((info, index) => {
    if (info.type === "google_drive" && info.fileId) {
      // Google Driveの場合はファイル名を取得
      const fileInfo = getGoogleDriveFileInfo(info.fileId);
      if (fileInfo) {
        notionFiles.push({
          name: fileInfo.name,
          type: "external",
          external: { url: fileInfo.url }
        });
      } else {
        // 取得失敗時は元URLをそのまま使用
        notionFiles.push({
          name: `スキルシート_${index + 1}`,
          type: "external",
          external: { url: info.url }
        });
      }
    } else {
      // Dropbox, OneDrive等はURLをそのまま使用
      // Dropboxの場合、dl=0 を dl=1 に変更すると直接ダウンロード
      let finalUrl = info.url;
      if (info.type === "dropbox") {
        finalUrl = info.url.replace(/dl=0/, 'dl=1');
      }

      notionFiles.push({
        name: `スキルシート_${info.type}_${index + 1}`,
        type: "external",
        external: { url: finalUrl }
      });
    }
  });

  Logger.log("📎 Notion用ファイル変換: " + notionFiles.length + "件");
  return notionFiles;
}

/**
 * テキストからURLを除去（原文保存用）
 * @param {string} text - 元のテキスト
 * @param {Array} urlInfos - 抽出されたURL情報
 * @returns {string} URL除去後のテキスト
 */
function removeUrlsFromText(text, urlInfos) {
  let result = text;
  urlInfos.forEach(info => {
    result = result.replace(info.url, '').replace(/\s+/g, ' ').trim();
  });
  return result;
}

// ============================================================
// イニシャル処理
// ============================================================

/**
 * イニシャルを正規化（大文字化、記号除去）
 * @param {string} initial - 元のイニシャル
 * @returns {string} 正規化されたイニシャル
 */
function normalizeInitial(initial) {
  if (!initial) return "";
  // 大文字化、ドット・スペース・アンダースコア・ハイフン除去
  return initial.toUpperCase().replace(/[\.\s_\-]/g, "");
}

/**
 * ファイル名からイニシャルを抽出
 * @param {string} fileName - ファイル名
 * @returns {string} 抽出されたイニシャル（正規化済み）
 *
 * 対応パターン例:
 * - 括弧内: "0103_業務経歴書(KH鶴見駅).xlsx" → "KH"
 * - 括弧内: "業務経歴書(IN東篤宮駅)_202603.xlsx" → "IN"
 * - 先頭: "YY_スキルシート.xlsx" → "YY"
 * - 先頭: "Y.K_経歴書.pdf" → "YK"
 * - 末尾: "スキルシート_Y.K.pdf" → "YK"
 * - 末尾: "経歴書_YY.xlsx" → "YY"
 */
function extractInitialFromFileName(fileName) {
  if (!fileName) return "";

  // 拡張子を除去
  const baseName = fileName.replace(/\.[^/.]+$/, "");

  Logger.log("📄 イニシャル抽出: ファイル名=" + fileName + ", ベース名=" + baseName);

  // パターン0: 括弧内の先頭にイニシャルがあるケース（最優先）
  // "0103_業務経歴書(KH鶴見駅)" → "KH"
  // "業務経歴書(IN東篤宮駅)_202603" → "IN"
  const parenMatch = baseName.match(/[（\(]([A-Za-z]{2})/);
  if (parenMatch) {
    const result = normalizeInitial(parenMatch[1]);
    Logger.log("📄 → 括弧内パターンでマッチ: " + result);
    return result;
  }

  // パターン1: 先頭にイニシャルがあるケース
  // "YY_スキルシート", "Y.K_経歴書", "YY様" など
  const headPatterns = [
    /^([A-Za-z][\.\s_\-]?[A-Za-z])[\s_\-様氏]/,   // YY_ Y.K_ YY様 (2文字)
    /^([A-Za-z])[\s_\-様氏]/                       // Y_ Y様 (1文字)
  ];

  for (const pattern of headPatterns) {
    const match = baseName.match(pattern);
    if (match) {
      const result = normalizeInitial(match[1]);
      Logger.log("📄 → 先頭パターンでマッチ: " + result);
      return result;
    }
  }

  // パターン2: 末尾にイニシャルがあるケース
  // "スキルシート_Y.K", "経歴書_YY", "履歴書_Y_K" など
  const tailPatterns = [
    /[\s_\-]([A-Za-z][\.\s_\-]?[A-Za-z])$/,        // _YK _Y.K _Y_K (2文字)
    /[\s_\-]([A-Za-z])$/                            // _Y (1文字)
  ];

  for (const pattern of tailPatterns) {
    const match = baseName.match(pattern);
    if (match) {
      const result = normalizeInitial(match[1]);
      Logger.log("📄 → 末尾パターンでマッチ: " + result);
      return result;
    }
  }

  // パターン3: 先頭がアルファベットで始まる場合（フォールバック）
  // "YKスキルシート" など区切りなしのケース
  const fallbackMatch = baseName.match(/^([A-Za-z]{2})/);
  if (fallbackMatch) {
    const result = normalizeInitial(fallbackMatch[1]);
    Logger.log("📄 → フォールバックパターンでマッチ: " + result);
    return result;
  }

  Logger.log("📄 → イニシャル抽出失敗");
  return "";
}

// ============================================================
// 一時保存管理（双方向対応版）
// テキストとファイル、どちらが先に来ても紐付け可能
// ============================================================

/**
 * 要員テキストデータを一時保存
 * ファイルが先に来ていれば紐付けて即時登録
 * @param {string} userId - LINE UserID
 * @param {string} initial - 要員のイニシャル
 * @param {Object} data - 保存するデータ {原文, 企業名, 担当者}
 * @returns {Object} {matched: boolean, pageId: string|null}
 */
function saveTempStaffData(userId, initial, data) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial) || "UNKNOWN";

  // ========================================
  // Step 1: ファイル一時保存をチェック（双方向対応）
  // ========================================
  const pendingFile = getTempFileDataByInitial(userId, normalizedInitial);

  if (pendingFile) {
    // ファイルが先に来ていた → 紐付けて即時Notion登録
    Logger.log("🔗 ファイル一時保存と紐付け: " + normalizedInitial);
    sendDebugNotification(`🔗 テキスト受信→ファイル発見\n${normalizedInitial}`);

    const formData = {
      "原文": data["原文"],
      "企業名": data["企業名"],
      "担当者": data["担当者"],
      "files": pendingFile.files
    };

    const pageId = createStaffPageFromApiWithFiles(formData);

    if (pageId) {
      sendDebugNotification(`✅ 紐付け登録成功\n${normalizedInitial}`);
      return { matched: true, pageId: pageId };
    } else {
      sendDebugNotification(`❌ 紐付け登録失敗\n${normalizedInitial}`);
      return { matched: true, pageId: null };
    }
  }

  // ========================================
  // Step 2: ファイルがない → テキストを一時保存（従来通り）
  // ========================================
  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempData = JSON.parse(tempDataJson);

  if (!tempData[userId]) {
    tempData[userId] = {};
  }

  tempData[userId][normalizedInitial] = {
    ...data,
    timestamp: new Date().getTime()
  };

  props.setProperty("TEMP_STAFF_DATA", JSON.stringify(tempData));

  Logger.log("📝 テキスト一時保存完了: " + userId + " / " + normalizedInitial);
  Logger.log(JSON.stringify(tempData[userId][normalizedInitial], null, 2));

  // タイムアウト用トリガーを設定（5分後）
  setTimeoutTrigger(userId);

  return { matched: false, pageId: null };
}

// ============================================================
// ファイル一時保存管理（双方向対応用）
// ============================================================

/**
 * ファイルデータを一時保存
 * テキストが先に来ていれば紐付けて即時登録
 * @param {string} userId - LINE UserID
 * @param {string} initial - ファイルから抽出したイニシャル
 * @param {Object} fileData - ファイル情報 {files, 企業名, 担当者}
 * @returns {Object} {matched: boolean, pageId: string|null, tempData: Object|null}
 */
function saveTempFileData(userId, initial, fileData) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial) || "UNKNOWN";

  // ========================================
  // Step 1: テキスト一時保存をチェック
  // ========================================
  const pendingText = getTempStaffDataByInitial(userId, normalizedInitial);

  if (pendingText) {
    // テキストが先に来ていた → 紐付けて即時Notion登録
    Logger.log("🔗 テキスト一時保存と紐付け: " + normalizedInitial);
    sendDebugNotification(`🔗 ファイル受信→テキスト発見\n${normalizedInitial}`);

    return {
      matched: true,
      pageId: null,  // 呼び出し元で登録処理
      tempData: pendingText
    };
  }

  // ========================================
  // Step 2: テキストがない → ファイルを一時保存
  // ========================================
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  const tempFileData = JSON.parse(tempFileJson);

  if (!tempFileData[userId]) {
    tempFileData[userId] = {};
  }

  tempFileData[userId][normalizedInitial] = {
    ...fileData,
    timestamp: new Date().getTime()
  };

  props.setProperty("TEMP_FILE_DATA", JSON.stringify(tempFileData));

  Logger.log("📁 ファイル一時保存完了: " + userId + " / " + normalizedInitial);
  sendDebugNotification(`📁 ファイル一時保存\n${normalizedInitial}\nテキスト待機中...`);

  // ファイル用のタイムアウトトリガーも設定
  setTimeoutTrigger(userId);

  return { matched: false, pageId: null, tempData: null };
}

/**
 * ファイル一時保存データをイニシャルで取得して削除
 * @param {string} userId - LINE UserID
 * @param {string} initial - イニシャル
 * @returns {Object|null} 保存されていたファイルデータ、なければnull
 */
function getTempFileDataByInitial(userId, initial) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial);

  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  const tempFileData = JSON.parse(tempFileJson);

  if (!tempFileData[userId]) {
    return null;
  }

  const data = tempFileData[userId][normalizedInitial] || null;

  if (data) {
    // 取得したらデータを削除
    delete tempFileData[userId][normalizedInitial];

    if (Object.keys(tempFileData[userId]).length === 0) {
      delete tempFileData[userId];
    }

    props.setProperty("TEMP_FILE_DATA", JSON.stringify(tempFileData));
    Logger.log("📤 ファイル一時保存データを取得・削除: " + userId + " / " + normalizedInitial);
  }

  return data;
}

/**
 * ファイル一時保存データを確認（削除せず）
 */
function peekTempFileData(userId, initial) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial);
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  const tempFileData = JSON.parse(tempFileJson);

  if (!tempFileData[userId]) return null;
  return tempFileData[userId][normalizedInitial] || null;
}

/**
 * ファイル一時保存データを全て削除（リセット用）
 */
function clearAllTempFileData() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("TEMP_FILE_DATA", "{}");
  Logger.log("🗑️ ファイル一時保存データを全て削除しました");
}

/**
 * 現在のファイル一時保存データを全て表示（デバッグ用）
 */
function showAllTempFileData() {
  const props = PropertiesService.getScriptProperties();
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  Logger.log("=== 現在のファイル一時保存データ ===");
  Logger.log(tempFileJson);
}

// ============================================================
// テキスト一時保存管理（従来機能）
// ============================================================

/**
 * 一時保存データをイニシャルで取得して削除
 * @param {string} userId - LINE UserID
 * @param {string} initial - 要員のイニシャル
 * @returns {Object|null} 保存されていたデータ、なければnull
 */
function getTempStaffDataByInitial(userId, initial) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial);

  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempData = JSON.parse(tempDataJson);

  if (!tempData[userId]) {
    Logger.log("⚠️ 一時保存なし（userId不一致）: " + userId);
    return null;
  }

  const data = tempData[userId][normalizedInitial] || null;

  if (data) {
    // 取得したらデータを削除
    delete tempData[userId][normalizedInitial];

    // userIdの配下が空になったら削除
    if (Object.keys(tempData[userId]).length === 0) {
      delete tempData[userId];
      deleteTimeoutTrigger(userId);
    }

    props.setProperty("TEMP_STAFF_DATA", JSON.stringify(tempData));
    Logger.log("📤 一時保存データを取得・削除: " + userId + " / " + normalizedInitial);
  } else {
    Logger.log("⚠️ 一時保存なし（イニシャル不一致）: " + userId + " / " + normalizedInitial);
  }

  return data;
}

/**
 * 一時保存データを確認（削除せず）
 */
function peekTempStaffData(userId, initial) {
  const props = PropertiesService.getScriptProperties();
  const normalizedInitial = normalizeInitial(initial);
  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempData = JSON.parse(tempDataJson);

  if (!tempData[userId]) return null;
  return tempData[userId][normalizedInitial] || null;
}

/**
 * 現在の一時保存データを全て表示（デバッグ用）
 * 双方向対応：テキストとファイルの両方を表示
 */
function showAllTempData() {
  const props = PropertiesService.getScriptProperties();
  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  Logger.log("=== 現在のテキスト一時保存データ ===");
  Logger.log(tempDataJson);
  Logger.log("=== 現在のファイル一時保存データ ===");
  Logger.log(tempFileJson);
}

/**
 * 一時保存データを全て削除（リセット用）
 * 双方向対応：テキストとファイルの両方を削除
 */
function clearAllTempData() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("TEMP_STAFF_DATA", "{}");
  props.setProperty("TEMP_FILE_DATA", "{}");
  Logger.log("🗑️ テキスト・ファイル一時保存データを全て削除しました");
}

// ============================================================
// タイムアウト処理
// ============================================================

/**
 * タイムアウト用トリガーを設定
 */
function setTimeoutTrigger(userId) {
  // 既存のトリガーがあれば削除
  deleteTimeoutTrigger(userId);

  // 5分後に実行するトリガーを作成
  const trigger = ScriptApp.newTrigger("processTimeoutStaffData")
    .timeBased()
    .after(TEMP_SAVE_TIMEOUT_MS)
    .create();

  // トリガーIDとuserIdの紐付けを保存
  const props = PropertiesService.getScriptProperties();
  const triggersJson = props.getProperty("TIMEOUT_TRIGGERS") || "{}";
  const triggers = JSON.parse(triggersJson);
  triggers[userId] = trigger.getUniqueId();
  props.setProperty("TIMEOUT_TRIGGERS", JSON.stringify(triggers));

  Logger.log("⏰ タイムアウトトリガー設定: " + userId + " (5分後)");
}

/**
 * タイムアウト用トリガーを削除
 */
function deleteTimeoutTrigger(userId) {
  const props = PropertiesService.getScriptProperties();
  const triggersJson = props.getProperty("TIMEOUT_TRIGGERS") || "{}";
  const triggers = JSON.parse(triggersJson);

  const triggerId = triggers[userId];
  if (triggerId) {
    // トリガーを検索して削除
    const allTriggers = ScriptApp.getProjectTriggers();
    allTriggers.forEach(trigger => {
      if (trigger.getUniqueId() === triggerId) {
        ScriptApp.deleteTrigger(trigger);
        Logger.log("🗑️ タイムアウトトリガー削除: " + userId);
      }
    });

    // マッピングからも削除
    delete triggers[userId];
    props.setProperty("TIMEOUT_TRIGGERS", JSON.stringify(triggers));
  }
}

/**
 * タイムアウト処理（トリガーから自動呼び出し）
 * 一時保存されたまま5分経過したデータをNotion登録
 * 双方向対応：テキスト一時保存とファイル一時保存の両方を処理
 */
function processTimeoutStaffData() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date().getTime();
  let processedText = 0;
  let processedFile = 0;

  // ========================================
  // 1. テキスト一時保存のタイムアウト処理
  // ========================================
  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempData = JSON.parse(tempDataJson);

  Object.keys(tempData).forEach(userId => {
    const userInitials = tempData[userId];

    Object.keys(userInitials).forEach(initial => {
      const data = userInitials[initial];
      const elapsed = now - data.timestamp;

      if (elapsed >= TEMP_SAVE_TIMEOUT_MS) {
        Logger.log("=== ⏰ テキストタイムアウト処理: " + userId + " / " + initial + " ===");

        // Notionに登録（ファイルなし）
        const formData = {
          "企業名": data["企業名"],
          "担当者": data["担当者"],
          "原文": data["原文"],
          "files": []
        };

        const pageId = createStaffPageFromApiWithFiles(formData);

        if (pageId) {
          Logger.log("✅ テキストタイムアウト登録成功: " + pageId);
          sendDebugNotification(`⏰ テキストタイムアウト登録\n${initial}\n→ ✅`);
        } else {
          Logger.log("❌ テキストタイムアウト登録失敗");
          sendDebugNotification(`⏰ テキストタイムアウト登録\n${initial}\n→ ❌`);
        }

        delete tempData[userId][initial];
        processedText++;
      }
    });

    if (Object.keys(tempData[userId]).length === 0) {
      delete tempData[userId];
    }
  });

  if (processedText > 0) {
    props.setProperty("TEMP_STAFF_DATA", JSON.stringify(tempData));
    Logger.log("テキスト処理件数: " + processedText);
  }

  // ========================================
  // 2. ファイル一時保存のタイムアウト処理
  // ========================================
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  const tempFileData = JSON.parse(tempFileJson);

  Object.keys(tempFileData).forEach(userId => {
    const userInitials = tempFileData[userId];

    Object.keys(userInitials).forEach(initial => {
      const data = userInitials[initial];
      const elapsed = now - data.timestamp;

      if (elapsed >= TEMP_SAVE_TIMEOUT_MS) {
        Logger.log("=== ⏰ ファイルタイムアウト処理: " + userId + " / " + initial + " ===");

        // ファイルのみでNotion登録（テキストなし）
        const formData = {
          "企業名": data["企業名"],
          "担当者": data["担当者"],
          "原文": "（スキルシート添付）",
          "files": data.files || []
        };

        const pageId = createStaffPageFromApiWithFiles(formData);

        if (pageId) {
          Logger.log("✅ ファイルタイムアウト登録成功: " + pageId);
          sendDebugNotification(`⏰ ファイルタイムアウト登録\n${initial}\n→ ✅`);
        } else {
          Logger.log("❌ ファイルタイムアウト登録失敗");
          sendDebugNotification(`⏰ ファイルタイムアウト登録\n${initial}\n→ ❌`);
        }

        delete tempFileData[userId][initial];
        processedFile++;
      }
    });

    if (Object.keys(tempFileData[userId]).length === 0) {
      delete tempFileData[userId];
    }
  });

  if (processedFile > 0) {
    props.setProperty("TEMP_FILE_DATA", JSON.stringify(tempFileData));
    Logger.log("ファイル処理件数: " + processedFile);
  }

  // 不要なトリガーをクリーンアップ
  cleanupOrphanedTriggers();
}

/**
 * 孤立したタイムアウトトリガーを削除
 * 双方向対応：テキストとファイルの両方の一時保存を確認
 */
function cleanupOrphanedTriggers() {
  const props = PropertiesService.getScriptProperties();
  const triggersJson = props.getProperty("TIMEOUT_TRIGGERS") || "{}";
  const triggers = JSON.parse(triggersJson);
  const tempDataJson = props.getProperty("TEMP_STAFF_DATA") || "{}";
  const tempData = JSON.parse(tempDataJson);
  const tempFileJson = props.getProperty("TEMP_FILE_DATA") || "{}";
  const tempFileData = JSON.parse(tempFileJson);

  Object.keys(triggers).forEach(userId => {
    // テキストもファイルも一時保存がなければトリガー削除
    if (!tempData[userId] && !tempFileData[userId]) {
      deleteTimeoutTrigger(userId);
    }
  });
}

// ============================================================
// LINE ファイル取得
// ============================================================

/**
 * LINE APIからファイルコンテンツを取得
 * @param {string} messageId - LINEメッセージID
 * @returns {Blob|null} ファイルのBlob、失敗時はnull
 */
function getLineFileContent(messageId) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  if (!accessToken) {
    Logger.log("❌ LINE_CHANNEL_ACCESS_TOKEN が設定されていません");
    return null;
  }

  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;

  const options = {
    method: "get",
    headers: {
      "Authorization": `Bearer ${accessToken}`
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode === 200) {
      Logger.log("✅ LINE APIからファイル取得成功 (messageId: " + messageId + ")");
      return response.getBlob();
    } else {
      Logger.log("❌ LINE APIエラー: " + responseCode);
      Logger.log(response.getContentText());
      return null;
    }
  } catch (error) {
    Logger.log("❌ LINE API例外エラー: " + error);
    return null;
  }
}

// ============================================================
// Google Drive 保存
// ============================================================

/**
 * ファイルをGoogle Driveに保存し、共有リンクを返す
 * @param {Blob} fileBlob - ファイルのBlob
 * @param {string} fileName - ファイル名
 * @param {string} companyName - 企業名（サブフォルダ作成用）
 * @returns {Object|null} {fileId, fileName, url} または null
 */
function saveFileToDrive(fileBlob, fileName, companyName) {
  const props = PropertiesService.getScriptProperties();
  const folderId = props.getProperty("SKILLSHEET_FOLDER_ID");

  if (!folderId) {
    Logger.log("❌ SKILLSHEET_FOLDER_ID が設定されていません");
    return null;
  }

  try {
    // 親フォルダを取得
    const parentFolder = DriveApp.getFolderById(folderId);

    // 企業名でサブフォルダを作成（または既存を使用）
    let targetFolder = parentFolder;
    if (companyName && companyName !== "" && !companyName.startsWith("LINE:")) {
      // 企業名フォルダを探す
      const subFolders = parentFolder.getFoldersByName(companyName);
      if (subFolders.hasNext()) {
        targetFolder = subFolders.next();
        Logger.log("📁 既存フォルダを使用: " + companyName);
      } else {
        targetFolder = parentFolder.createFolder(companyName);
        Logger.log("📁 新規フォルダ作成: " + companyName);
      }
    }

    // ファイル名に日時を追加（重複防止）
    const timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd_HHmmss");
    const ext = fileName.includes(".") ? fileName.substring(fileName.lastIndexOf(".")) : "";
    const baseName = fileName.includes(".") ? fileName.substring(0, fileName.lastIndexOf(".")) : fileName;
    const newFileName = `${baseName}_${timestamp}${ext}`;

    // Blobにファイル名を設定
    fileBlob.setName(newFileName);

    // ファイルを保存
    const file = targetFolder.createFile(fileBlob);

    // リンクを持つ全員が閲覧可能に設定
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    // ダウンロードリンクを生成
    const downloadUrl = "https://drive.google.com/uc?export=download&id=" + file.getId();

    Logger.log("✅ Driveに保存成功: " + newFileName);
    Logger.log("🔗 URL: " + downloadUrl);

    return {
      fileId: file.getId(),
      fileName: newFileName,
      url: downloadUrl
    };

  } catch (error) {
    Logger.log("❌ Drive保存エラー: " + error);
    return null;
  }
}

// ============================================================
// LINEファイル処理
// ============================================================

/**
 * LINEから送信されたファイルを処理（単一ファイル用）
 * @param {Object} fileInfo - ファイル情報 {messageId, fileName, fileSize, type}
 * @param {string} companyName - 企業名
 * @returns {Array} Notion登録用のファイル情報配列
 */
function processLineFile(fileInfo, companyName) {
  if (!fileInfo || !fileInfo.messageId) {
    Logger.log("処理するファイル情報がありません");
    return [];
  }

  const savedFiles = [];

  Logger.log("=== 📄 ファイル処理中 ===");
  Logger.log("messageId: " + fileInfo.messageId);
  Logger.log("fileName: " + fileInfo.fileName);
  Logger.log("type: " + fileInfo.type);

  // LINE APIからファイル取得
  const fileBlob = getLineFileContent(fileInfo.messageId);

  if (fileBlob) {
    // Google Driveに保存
    const savedFile = saveFileToDrive(
      fileBlob,
      fileInfo.fileName || `file_${fileInfo.messageId}`,
      companyName
    );

    if (savedFile) {
      // Notion用のファイル形式
      savedFiles.push({
        name: savedFile.fileName,
        type: "external",
        external: { url: savedFile.url }
      });
    }
  }

  Logger.log(`=== ファイル処理完了: ${savedFiles.length} 件 ===`);
  return savedFiles;
}

/**
 * LINEから送信されたファイルを処理（複数ファイル用、従来互換）
 * @param {Array} files - ファイル情報の配列 [{messageId, fileName, fileSize, type}, ...]
 * @param {string} companyName - 企業名
 * @returns {Array} Notion登録用のファイル情報配列
 */
function processLineFiles(files, companyName) {
  if (!files || !Array.isArray(files) || files.length === 0) {
    Logger.log("処理するファイルがありません");
    return [];
  }

  const savedFiles = [];

  files.forEach((fileInfo, index) => {
    Logger.log(`=== 📄 ファイル ${index + 1}/${files.length} 処理中 ===`);
    const result = processLineFile(fileInfo, companyName);
    savedFiles.push(...result);
  });

  Logger.log(`=== ファイル処理完了: ${savedFiles.length}/${files.length} 成功 ===`);
  return savedFiles;
}

// ============================================================
// Notion登録（ファイル対応版）
// ============================================================

/**
 * API経由で要員を新規登録（ファイル対応版）
 * ※既存の createStaffPageFromApi を置き換え
 */
function createStaffPageFromApiWithFiles(formData) {
  const url = "https://api.notion.com/v1/pages";
  const rawText = formData["原文"] || "";

  // ファイルがある場合は処理
  let notionFiles = [];
  if (formData["files"] && Array.isArray(formData["files"]) && formData["files"].length > 0) {
    Logger.log("=== 📎 LINEファイル処理開始 ===");
    notionFiles = processLineFiles(formData["files"], formData["企業名"]);
    Logger.log("Notion登録用ファイル数: " + notionFiles.length);
  }

  // ========================================
  // 要員情報の有効性チェック（通常会話を除外）
  // ========================================
  // ファイルがない場合のみテキスト内容をチェック
  if (notionFiles.length === 0 && !isValidStaffInfo(rawText)) {
    Logger.log("⚠️ 要員登録スキップ: 通常会話または無効なデータ");
    Logger.log("原文: " + rawText.substring(0, 100));

    // デバッグ通知
    if (DEBUG_MODE) {
      const adminUserId = getAdminLineUserId();
      if (adminUserId) {
        sendLineNotification(adminUserId,
          `⚠️ 要員登録スキップ\n通常会話と判定されました\n\n原文: ${rawText.substring(0, 50)}...`
        );
      }
    }
    return null;
  }

  const payload = {
    parent: {
      database_id: STAFF_DB_ID
    },
    properties: {
      "要員名": {
        title: [{ text: { content: " " } }]
      },
      "要員元企業": {
        rich_text: [{ text: { content: formData["企業名"] || "" } }]
      },
      "原文": {
        rich_text: [{ text: { content: formData["原文"] || "" } }]
      },
      "ステータス": {
        select: { name: "未処理" }
      }
    }
  };

  if (formData["担当者"]) {
    payload.properties["担当"] = {
      select: { name: formData["担当者"] }
    };
  }

  // スキルシートファイルがあれば追加
  if (notionFiles.length > 0) {
    payload.properties["スキルシート"] = { files: notionFiles };
    Logger.log("📎 スキルシートプロパティを追加");
  }

  const options = {
    method: "post",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log("✅ [API] 要員DBに登録しました: " + result.id);
      Logger.log("📎 スキルシート数: " + notionFiles.length);

      // AI整形処理（Gemini Flash）
      const rawText = formData["原文"] || "";
      if (rawText && rawText !== "（スキルシート添付）") {
        try {
          const companyName = formData["企業名"] || "";
          const formatted = formatWithAI(rawText, "staff", companyName);
          if (formatted) {
            updateStaffPage(result.id, formatted);
            // マッチングは遅延実行（タイムアウト対策）
            scheduleMatching(result.id, "staff");
          } else {
            Logger.log("⚠️ 整形スキップ(AI API失敗)");
          }
        } catch (aiError) {
          Logger.log("⚠️ AI処理エラー: " + aiError);
        }
      }

      return result.id;
    } else {
      Logger.log("❌ [API] エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return null;
    }
  } catch (error) {
    Logger.log("❌ [API] 例外エラー: " + error);
    return null;
  }
}

/**
 * API経由で要員を新規登録（URL抽出ファイル対応版）
 * テキスト内から抽出したスキルシートURLを添付
 */
function createStaffPageFromApiWithUrlFiles(formData) {
  const url = "https://api.notion.com/v1/pages";
  const rawText = formData["原文"] || "";

  // URL抽出済みのファイル情報を取得
  const notionFiles = formData["urlFiles"] || [];

  // ========================================
  // 要員情報の有効性チェック（通常会話を除外）
  // ========================================
  if (notionFiles.length === 0 && !isValidStaffInfo(rawText)) {
    Logger.log("⚠️ 要員登録スキップ: 通常会話または無効なデータ");
    Logger.log("原文: " + rawText.substring(0, 100));

    if (DEBUG_MODE) {
      const adminUserId = getAdminLineUserId();
      if (adminUserId) {
        sendLineNotification(adminUserId,
          `⚠️ 要員登録スキップ\n通常会話と判定されました\n\n原文: ${rawText.substring(0, 50)}...`
        );
      }
    }
    return null;
  }

  const payload = {
    parent: {
      database_id: STAFF_DB_ID
    },
    properties: {
      "要員名": {
        title: [{ text: { content: " " } }]
      },
      "要員元企業": {
        rich_text: [{ text: { content: formData["企業名"] || "" } }]
      },
      "原文": {
        rich_text: [{ text: { content: formData["原文"] || "" } }]
      },
      "ステータス": {
        select: { name: "未処理" }
      }
    }
  };

  if (formData["担当者"]) {
    payload.properties["担当"] = {
      select: { name: formData["担当者"] }
    };
  }

  // スキルシートURLファイルがあれば追加
  if (notionFiles.length > 0) {
    payload.properties["スキルシート"] = { files: notionFiles };
    Logger.log("📎 スキルシートURL追加: " + notionFiles.length + "件");
  }

  const options = {
    method: "post",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log("✅ [API] 要員DBに登録しました（URL版）: " + result.id);
      Logger.log("📎 スキルシートURL数: " + notionFiles.length);

      // AI整形処理（Gemini Flash）
      if (rawText) {
        try {
          const companyName = formData["企業名"] || "";
          const formatted = formatWithAI(rawText, "staff", companyName);
          if (formatted) {
            updateStaffPage(result.id, formatted);
            // マッチングは遅延実行（タイムアウト対策）
            scheduleMatching(result.id, "staff");
          } else {
            Logger.log("⚠️ 整形スキップ(AI API失敗)");
          }
        } catch (aiError) {
          Logger.log("⚠️ AI処理エラー: " + aiError);
        }
      }

      return result.id;
    } else {
      Logger.log("❌ [API] エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return null;
    }
  } catch (error) {
    Logger.log("❌ [API] 例外エラー: " + error);
    return null;
  }
}

// ============================================================
// doPost（メインエントリーポイント）
// ============================================================

/**
 * POSTリクエストを処理するエンドポイント
 * ※05_WebApp.gs の doPost を削除し、こちらを使用
 *
 * 【登録タイプ】
 * - "案件を登録": 即時登録（従来通り）
 * - "要員を一時保存": テキストを一時保存（Notion未登録、イニシャル対応）
 * - "要員ファイルを追加": ファイル受信 → イニシャルで一時保存と紐付け → Notion登録
 * - "要員URLを処理": テキスト内のスキルシートURL → 抽出してNotion登録
 * - "要員を登録": 即時登録（従来互換）
 */
function doPost(e) {
  try {
    const requestData = JSON.parse(e.postData.contents);

    Logger.log("=== 📨 doPost: リクエスト受信 ===");
    Logger.log(JSON.stringify(requestData, null, 2));

    // ========================================
    // 配信API（/broadcast からの呼び出し）
    // ========================================
    if (requestData["action"] === "broadcast") {
      const broadcastResult = executeBroadcastFromApi(requestData);
      return ContentService
        .createTextOutput(JSON.stringify(broadcastResult))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const registrationType = requestData["登録タイプ"];

    // デバッグ通知: ファイル追加時のみ
    if (registrationType === "要員ファイルを追加") {
      const files = requestData["files"] || [];
      sendDebugNotification(`既存GAS受信\nファイル数: ${files.length}`);
    }

    // UserIDから企業名を取得
    let companyName = requestData["企業名"] || "";
    const userId = requestData["userId"];

    if (userId) {
      const mappedName = getCompanyNameByUserId(userId);
      if (mappedName) {
        companyName = mappedName;
        Logger.log("🏢 マッピングから企業名取得: " + companyName);
      } else {
        Logger.log("⚠️ マッピング未登録: " + userId);
        companyName = "LINE:" + userId;

        // 管理者に未マッピングのUserIDを通知（マッピング登録用）
        const adminUserId = getAdminLineUserId();
        if (adminUserId) {
          sendLineNotification(adminUserId,
            `🆕 未登録パートナーからの送信\n\n` +
            `UserID:\n${userId}\n\n` +
            `登録タイプ: ${registrationType}\n` +
            `※GASエディタで addLineUserMapping("${userId}", "企業名") を実行してマッピングを追加してください`
          );
        }
      }
    }

    let result = { success: false, message: "不明な登録タイプです" };

    // ========================================
    // 案件登録（即時）
    // ========================================
    if (registrationType === "案件を登録") {
      const formData = {
        "登録タイプ": "案件を登録",
        "担当者": requestData["担当者"],
        "企業名": companyName,
        "原文": requestData["原文"]
      };

      const pageId = createCasePageFromApi(formData);

      if (pageId) {
        result = {
          success: true,
          message: "案件を登録しました",
          pageId: pageId,
          type: "case",
          companyName: companyName
        };
      } else {
        result = { success: false, message: "案件登録に失敗しました" };
      }
    }

    // ========================================
    // 要員テキスト → 一時保存（ファイル待機、イニシャル対応）
    // ※URLが含まれている場合は即時Notion登録
    // ========================================
    else if (registrationType === "要員を一時保存") {
      const rawText = requestData["原文"] || "";
      const initial = requestData["initial"] || "";

      // ========================================
      // URL検出: スキルシートURLがあれば即時登録
      // ========================================
      const extractedUrls = extractSkillSheetUrls(rawText);

      if (extractedUrls.length > 0) {
        // URLあり → ファイル待機せず即時Notion登録
        Logger.log("🔗 スキルシートURL検出: " + extractedUrls.length + "件 → 即時登録");
        sendDebugNotification(`URL検出\n${extractedUrls.length}件 → 即時登録`);

        // URLをNotion用ファイル形式に変換
        const notionFiles = convertUrlsToNotionFiles(extractedUrls);

        const formData = {
          "原文": rawText,
          "企業名": companyName,
          "担当者": requestData["担当者"] || "高梨",
          "urlFiles": notionFiles
        };

        const pageId = createStaffPageFromApiWithUrlFiles(formData);

        if (pageId) {
          sendDebugNotification(`URL登録完了\n→ ✅`);
          result = {
            success: true,
            message: `要員を登録しました（スキルシートURL: ${notionFiles.length}件）`,
            pageId: pageId,
            type: "staff_with_url",
            companyName: companyName,
            extractedUrls: extractedUrls.map(u => u.url)
          };
        } else {
          result = { success: false, message: "要員登録に失敗しました" };
        }

      } else {
        // URLなし → 双方向対応：ファイルが先に来ていればそちらと紐付け
        const tempData = {
          "原文": rawText,
          "企業名": companyName,
          "担当者": requestData["担当者"] || "高梨"
        };

        const saveResult = saveTempStaffData(userId, initial, tempData);

        if (saveResult.matched) {
          // ファイルが先に来ていた → 紐付けて登録完了
          result = {
            success: true,
            message: "要員を登録しました（ファイル先行で紐付け）",
            pageId: saveResult.pageId,
            type: "staff_matched_from_text",
            userId: userId,
            initial: normalizeInitial(initial) || "UNKNOWN",
            companyName: companyName
          };
        } else {
          // ファイルがまだ → 一時保存完了
          result = {
            success: true,
            message: "要員情報を一時保存しました（ファイル待機中）",
            type: "staff_pending",
            userId: userId,
            initial: normalizeInitial(initial) || "UNKNOWN",
            companyName: companyName
          };
        }
      }
    }

    // ========================================
    // 要員ファイル → 双方向対応でイニシャル紐付け
    // テキストが先に来ていれば紐付け、なければファイルを一時保存
    // ========================================
    else if (registrationType === "要員ファイルを追加") {
      const files = requestData["files"] || [];

      // ファイルごとに処理
      const results = [];

      for (const fileInfo of files) {
        // ファイル名からイニシャルを抽出
        const fileInitial = extractInitialFromFileName(fileInfo.fileName);
        Logger.log("📄 ファイル: " + fileInfo.fileName + " → イニシャル: " + fileInitial);

        // 双方向対応：テキスト一時保存をチェック
        const fileData = {
          files: [fileInfo],
          "企業名": companyName,
          "担当者": requestData["担当者"] || "高梨"
        };

        const saveResult = saveTempFileData(userId, fileInitial, fileData);

        let formData;
        let pageId = null;

        if (saveResult.matched && saveResult.tempData) {
          // テキストが先に来ていた → 紐付けてNotion登録
          Logger.log("🔗 テキスト一時保存と紐付け: " + fileInitial);
          formData = {
            "原文": saveResult.tempData["原文"],
            "企業名": saveResult.tempData["企業名"],
            "担当者": saveResult.tempData["担当者"],
            "files": [fileInfo]
          };
          pageId = createStaffPageFromApiWithFiles(formData);

          // デバッグ通知: 紐付け登録結果
          sendDebugNotification(`🔗 紐付け登録\n${fileInfo.fileName}\n→ ${pageId ? '✅' : '❌'}`);

        } else {
          // テキストがまだ → ファイルを一時保存済み（saveTempFileDataで保存された）
          Logger.log("📁 ファイル一時保存完了、テキスト待機: " + fileInitial);
          // pageId は null のまま（Notion登録はまだ）
        }

        results.push({
          fileName: fileInfo.fileName,
          initial: fileInitial,
          pageId: pageId,
          matched: saveResult.matched,
          pending: !saveResult.matched  // テキスト待機中フラグ
        });
      }

      // デバッグ通知: 処理完了サマリー
      const matchedCount = results.filter(r => r.matched).length;
      const pendingCount = results.filter(r => r.pending).length;
      const successCount = results.filter(r => r.pageId).length;

      let summaryMsg = `📊 ファイル処理完了\n`;
      summaryMsg += `紐付け登録: ${matchedCount}件\n`;
      summaryMsg += `テキスト待機: ${pendingCount}件`;
      sendDebugNotification(summaryMsg);

      result = {
        success: true,
        message: `ファイル${results.length}件処理（登録:${matchedCount}件, 待機:${pendingCount}件）`,
        type: "staff_files",
        companyName: companyName,
        details: results
      };
    }

    // ========================================
    // 要員URLを処理（テキスト内のスキルシートURL抽出）
    // ========================================
    else if (registrationType === "要員URLを処理") {
      const rawText = requestData["原文"] || "";

      // テキストからURL抽出
      const extractedUrls = extractSkillSheetUrls(rawText);

      if (extractedUrls.length > 0) {
        sendDebugNotification(`URL抽出\n${extractedUrls.length}件検出`);

        // URLをNotion用ファイル形式に変換
        const notionFiles = convertUrlsToNotionFiles(extractedUrls);

        // 原文からURLを除去（任意：そのまま残す場合はコメントアウト）
        // const cleanedText = removeUrlsFromText(rawText, extractedUrls);

        const formData = {
          "原文": rawText,  // URLはそのまま残す
          "企業名": companyName,
          "担当者": requestData["担当者"] || "高梨",
          "urlFiles": notionFiles  // files ではなく urlFiles として渡す
        };

        const pageId = createStaffPageFromApiWithUrlFiles(formData);

        sendDebugNotification(`URL登録\n→ ${pageId ? '✅' : '❌'}`);

        if (pageId) {
          result = {
            success: true,
            message: `要員を登録しました（スキルシートURL: ${notionFiles.length}件）`,
            pageId: pageId,
            type: "staff_with_url",
            companyName: companyName,
            extractedUrls: extractedUrls.map(u => u.url)
          };
        } else {
          result = { success: false, message: "要員登録に失敗しました" };
        }
      } else {
        // URLがない場合は通常の要員登録として処理
        Logger.log("⚠️ URLが検出されませんでした。通常登録にフォールバック");

        const formData = {
          "原文": rawText,
          "企業名": companyName,
          "担当者": requestData["担当者"] || "高梨",
          "files": []
        };

        const pageId = createStaffPageFromApiWithFiles(formData);

        if (pageId) {
          result = {
            success: true,
            message: "要員を登録しました（URLなし）",
            pageId: pageId,
            type: "staff",
            companyName: companyName
          };
        } else {
          result = { success: false, message: "要員登録に失敗しました" };
        }
      }
    }

    // ========================================
    // 要員登録（従来互換、即時登録）
    // ========================================
    else if (registrationType === "要員を登録") {
      const formData = {
        "原文": requestData["原文"],
        "企業名": companyName,
        "担当者": requestData["担当者"],
        "files": requestData["files"] || []
      };

      const pageId = createStaffPageFromApiWithFiles(formData);

      if (pageId) {
        result = {
          success: true,
          message: "要員を登録しました",
          pageId: pageId,
          type: "staff",
          companyName: companyName
        };
      } else {
        result = { success: false, message: "要員登録に失敗しました" };
      }
    }

    Logger.log("=== ✅ doPost: 処理結果 ===");
    Logger.log(JSON.stringify(result, null, 2));

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    Logger.log("❌ doPost エラー: " + error);

    // エラーは常に通知（DEBUG_MODE関係なく）
    const adminUserId = getAdminLineUserId();
    if (adminUserId) {
      sendLineNotification(adminUserId, `❌ 既存GASエラー\n${error.toString().substring(0, 200)}`);
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        message: "エラーが発生しました: " + error.toString()
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * GETリクエスト用（動作確認用）
 */
function doGet(e) {
  const result = {
    status: "ok",
    message: "GAS Web App is running (with file & initial support)",
    version: "3.1",
    timestamp: new Date().toISOString()
  };

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// テスト用関数
// ============================================================

/**
 * イニシャル抽出テスト
 * GASエディタで実行して結果を確認
 */
function testExtractInitial() {
  const testCases = [
    // 括弧内パターン（最優先）
    { file: "0103_業務経歴書(KH鶴見駅).xlsx", expected: "KH" },
    { file: "0106_業務経歴書(RK新小岩).pdf", expected: "RK" },
    { file: "業務経歴書(IN東篤宮駅)_202603.xlsx", expected: "IN" },
    { file: "0101_業務経歴書(SE三崎口).xlsx", expected: "SE" },
    { file: "0102_職務経歴(TY東神奈川).xlsx", expected: "TY" },
    { file: "0104_業務経歴書(TY大船駅).xlsx", expected: "TY" },
    // 先頭パターン
    { file: "YY_スキルシート.xlsx", expected: "YY" },
    { file: "Y.Y_経歴書.pdf", expected: "YY" },
    { file: "Y.K_経歴書.pdf", expected: "YK" },
    { file: "TK_2024.xlsx", expected: "TK" },
    { file: "T.K_skills.pdf", expected: "TK" },
    // 末尾パターン
    { file: "スキルシート_Y.K.pdf", expected: "YK" },
    { file: "スキルシート_YY.xlsx", expected: "YY" },
    { file: "経歴書_T.K.pdf", expected: "TK" },
    { file: "履歴書_YK.docx", expected: "YK" },
    // イニシャルなし
    { file: "スキルシート.xlsx", expected: "" },
    { file: "経歴書.pdf", expected: "" }
  ];

  Logger.log("=== イニシャル抽出テスト ===");
  let passed = 0;
  let failed = 0;

  testCases.forEach(tc => {
    const result = extractInitialFromFileName(tc.file);
    const status = result === tc.expected ? "✅" : "❌";
    if (result === tc.expected) {
      passed++;
    } else {
      failed++;
    }
    Logger.log(`${status} ${tc.file} → "${result}" (期待: "${tc.expected}")`);
  });

  Logger.log(`\n結果: ${passed}/${testCases.length} 成功, ${failed} 失敗`);
}

/**
 * 2段階登録フローのテスト（イニシャル対応版）
 */
function testTwoStepRegistrationWithInitial() {
  const testUserId = "Utest123456789";

  // 一時保存をクリア
  clearAllTempData();

  // Step 1: 複数要員テキストを一時保存
  Logger.log("=== Step 1: テキスト一時保存（複数） ===");

  const staff1 = {
    postData: {
      contents: JSON.stringify({
        "登録タイプ": "要員を一時保存",
        "担当者": "高梨",
        "userId": testUserId,
        "initial": "YY",
        "原文": "YY様 Java 5年経験\n希望単価：55万\n稼働：即日可"
      })
    }
  };
  doPost(staff1);

  const staff2 = {
    postData: {
      contents: JSON.stringify({
        "登録タイプ": "要員を一時保存",
        "担当者": "高梨",
        "userId": testUserId,
        "initial": "TK",
        "原文": "TK様 Go 3年経験\n希望単価：60万\n稼働：3月〜"
      })
    }
  };
  doPost(staff2);

  // 一時保存を確認
  Logger.log("\n=== 一時保存確認 ===");
  showAllTempData();

  // Step 2: ファイル追加（イニシャルで紐付け）
  Logger.log("\n=== Step 2: ファイル追加（イニシャル紐付け） ===");
  const fileAdd = {
    postData: {
      contents: JSON.stringify({
        "登録タイプ": "要員ファイルを追加",
        "担当者": "高梨",
        "userId": testUserId,
        "files": [
          { "messageId": "test1", "fileName": "Y.Y_スキルシート.xlsx", "fileSize": 1234, "type": "file" },
          { "messageId": "test2", "fileName": "TK_経歴書.pdf", "fileSize": 5678, "type": "file" }
        ]
      })
    }
  };
  // 注意: 実際のテストではmessageIdが有効でないとファイル取得失敗する
  // const result = doPost(fileAdd);
  // Logger.log("ファイル追加結果: " + result.getContent());

  // 一時保存が削除されているか確認
  Logger.log("\n=== 一時保存確認（処理後） ===");
  showAllTempData();
}

/**
 * Drive保存のテスト
 */
function testSaveToDrive() {
  const testBlob = Utilities.newBlob("テスト内容", "text/plain", "test.txt");
  const result = saveFileToDrive(testBlob, "test_file.txt", "テスト企業");

  if (result) {
    Logger.log("✅ テスト成功");
    Logger.log("URL: " + result.url);
  } else {
    Logger.log("❌ テスト失敗");
  }
}

/**
 * URL抽出テスト
 * GASエディタで実行して結果を確認
 */
function testExtractSkillSheetUrls() {
  Logger.log("=== URL抽出テスト ===\n");

  // テストケース1: 実際のLINEメッセージ例
  const testMessage1 = `いつもお世話になっております！

注力中のプロパーとなります！
上流案件ございましたらご紹介いただけたら嬉しいですｍｍ

━━━━━━━━━━━━━━━━━━
■ R.S（42歳／女性）
りんかい線 東雲駅
3月16日～／所属：自社プロパー
単価：120万
精算幅：140h〜180h（応相談）
IT経験：約23年
得意分野：金融業界／運用保守／DX推進（RPA・OCR）／PM・PMO／チームマネジメント
━━━━━━━━━━━━━━━━━━

【スキルシート】
https://docs.google.com/spreadsheets/d/1-8p87fdbwqXRY77GLAURkY_v439K5-M2ZkvJm_fM2bM/edit?usp=sharing

━━━━━━━━━━━━━━━━━━`;

  Logger.log("--- テスト1: Google スプレッドシート ---");
  const result1 = extractSkillSheetUrls(testMessage1);
  Logger.log("検出数: " + result1.length);
  result1.forEach((r, i) => {
    Logger.log(`  [${i + 1}] type=${r.type}, fileId=${r.fileId}`);
    Logger.log(`      url=${r.url}`);
  });

  // テストケース2: 複数URL
  const testMessage2 = `2名ご紹介します。

■ A.B様
スキルシート: https://drive.google.com/file/d/abc123xyz/view?usp=sharing

■ C.D様
スキルシート: https://docs.google.com/document/d/def456uvw/edit`;

  Logger.log("\n--- テスト2: 複数URL（Drive + Docs）---");
  const result2 = extractSkillSheetUrls(testMessage2);
  Logger.log("検出数: " + result2.length);
  result2.forEach((r, i) => {
    Logger.log(`  [${i + 1}] type=${r.type}, fileId=${r.fileId}`);
  });

  // テストケース3: Dropbox
  const testMessage3 = `スキルシートはこちらです。
https://www.dropbox.com/s/abc123/skillsheet.xlsx?dl=0

よろしくお願いします。`;

  Logger.log("\n--- テスト3: Dropbox ---");
  const result3 = extractSkillSheetUrls(testMessage3);
  Logger.log("検出数: " + result3.length);
  result3.forEach((r, i) => {
    Logger.log(`  [${i + 1}] type=${r.type}, url=${r.url}`);
  });

  // テストケース4: URLなし
  const testMessage4 = `YY様
Java 5年経験
希望単価55万`;

  Logger.log("\n--- テスト4: URLなし ---");
  const result4 = extractSkillSheetUrls(testMessage4);
  Logger.log("検出数: " + result4.length + " (期待値: 0)");

  Logger.log("\n=== テスト完了 ===");
}

/**
 * URL処理の統合テスト（doPost経由）
 * ※実際にNotionに登録するためテスト環境で実行
 */
function testUrlProcessingFlow() {
  Logger.log("=== URL処理フローテスト ===\n");

  const testRequest = {
    postData: {
      contents: JSON.stringify({
        "登録タイプ": "要員URLを処理",
        "担当者": "高梨",
        "userId": "Utest123456789",
        "原文": `いつもお世話になっております！

■ R.S（42歳／女性）
りんかい線 東雲駅
3月16日～／所属：自社プロパー
単価：120万
IT経験：約23年
得意分野：金融業界／運用保守／DX推進

【スキルシート】
https://docs.google.com/spreadsheets/d/1-8p87fdbwqXRY77GLAURkY_v439K5-M2ZkvJm_fM2bM/edit?usp=sharing`
      })
    }
  };

  // 注意: 実際にNotionに登録されます
  // const result = doPost(testRequest);
  // Logger.log("結果: " + result.getContent());

  Logger.log("⚠️ 実際のテストはコメントを解除して実行してください");
}
