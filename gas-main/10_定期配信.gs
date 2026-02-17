/**
 * ===================================================
 * 10_定期配信.gs
 * ===================================================
 *
 * 【機能概要】
 * - Claude Code /broadcast コマンドからの配信指示を受け付け
 * - 案件サマリーをパートナーに個別LINE送信
 * - 要員サマリー + スキルシートファイルをパートナーに送信
 * - 自社フィルタリング（案件元/要員元企業を配信先から除外）
 *
 * 【エンドポイント】
 * doPost の "broadcast" アクションとして 07_ファイル受信処理.gs に追加
 * または本ファイル内の関数を doPost から呼び出す
 *
 * 【依存】
 * - 08_LINE通知.gs: sendLineNotification(userId, message)
 * - 06_LINEマッピング.gs: getCompanyNameByUserId(), LINE_USER_MAPPING
 * - NOTION_API_KEY, CASE_DB_ID, STAFF_DB_ID（スクリプトプロパティ or グローバル定数）
 */

// ============================================================
// 配信トークン（簡易認証）
// ============================================================

/**
 * 配信API用トークンを設定（初回のみ実行）
 */
function setupBroadcastToken() {
  const props = PropertiesService.getScriptProperties();
  // ランダムトークン生成
  const token = Utilities.getUuid();
  props.setProperty("BROADCAST_API_TOKEN", token);
  Logger.log("✅ 配信APIトークンを設定しました: " + token);
  Logger.log("⚠️ このトークンをbroadcast-skill側の設定に保存してください");
}

/**
 * 配信APIトークンを取得
 */
function getBroadcastToken() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty("BROADCAST_API_TOKEN");
}

// ============================================================
// メイン配信処理
// ============================================================

/**
 * 配信APIエンドポイント（doPostから呼び出し）
 *
 * @param {Object} payload - 配信指示
 *   {
 *     action: "broadcast",
 *     token: "認証トークン",
 *     cases: ["page_id_1", "page_id_2"],   // 配信する案件のNotionページID
 *     staff: ["page_id_3"],                 // 配信する要員のNotionページID
 *     test_mode: false                      // trueの場合は管理者のみに送信
 *   }
 * @returns {Object} 配信結果
 */
function executeBroadcastFromApi(payload) {
  Logger.log("=== 配信処理開始 ===");

  // 認証チェック
  const expectedToken = getBroadcastToken();
  if (!expectedToken || payload.token !== expectedToken) {
    Logger.log("❌ 認証エラー");
    return { success: false, message: "認証エラー: トークンが不正です" };
  }

  const caseIds = payload.cases || [];
  const staffIds = payload.staff || [];
  const testMode = payload.test_mode || false;

  if (caseIds.length === 0 && staffIds.length === 0) {
    return { success: false, message: "配信対象が指定されていません" };
  }

  // パートナー一覧取得
  const partners = getAllMappedPartners();
  if (partners.length === 0) {
    return { success: false, message: "登録済みパートナーがいません" };
  }

  Logger.log("配信対象: 案件" + caseIds.length + "件, 要員" + staffIds.length + "件");
  Logger.log("パートナー数: " + partners.length);
  Logger.log("テストモード: " + testMode);

  const results = {
    success: true,
    cases_sent: 0,
    staff_sent: 0,
    total_messages: 0,
    skipped_own: 0,
    errors: [],
    details: [],
    debug: {
      target_partners_count: 0,
      admin_user_id: "",
    }
  };

  // テストモードの場合は管理者のみに送信
  const adminUserId = getAdminLineUserId();
  const targetPartners = testMode
    ? partners.filter(p => p.userId === adminUserId)
    : partners;

  // デバッグ情報
  results.debug.target_partners_count = targetPartners.length;
  results.debug.admin_user_id = adminUserId ? (adminUserId.substring(0, 10) + "...") : "未設定";
  results.debug.test_mode = testMode;
  results.debug.all_partners_count = partners.length;
  if (testMode && targetPartners.length === 0) {
    results.debug.warning = "テストモードで管理者が見つかりません。adminUserIdがパートナー一覧に含まれていない可能性があります。";
    results.debug.partner_userids_preview = partners.map(p => p.userId.substring(0, 10) + "...").slice(0, 5);
  }

  // ========================================
  // 案件配信（1件ずつ個別送信）
  // ========================================
  for (const caseId of caseIds) {
    const caseData = fetchCaseForBroadcast(caseId);
    if (!caseData) {
      results.errors.push({ type: "case", id: caseId, error: "データ取得失敗" });
      continue;
    }

    for (const partner of targetPartners) {
      // 自社フィルタリング
      if (isOwnData(partner.companyName, caseData.sourceCompany)) {
        results.skipped_own++;
        Logger.log("⏭️ 自社除外: " + partner.companyName + " ← " + caseData.sourceCompany);
        continue;
      }

      // 挨拶文 + サマリー全文を送信
      const caseMessage = "弊社注力情報になります！\n"
        + "マッチしそうな要員さまがいらっしゃいましたらご紹介ください！\n"
        + "*************************\n"
        + caseData.summary + "\n"
        + "*************************";
      const caseSendResult = sendLineNotificationWithDetail(partner.userId, caseMessage);
      if (caseSendResult.success) {
        results.cases_sent++;
        results.total_messages++;
      } else {
        results.errors.push({
          type: "case",
          id: caseId,
          partner: partner.companyName,
          error: caseSendResult.error,
          status_code: caseSendResult.statusCode,
          message_length: caseMessage.length
        });
      }

      // API制限対策: 少し待機
      Utilities.sleep(100);
    }

    results.details.push({
      type: "case",
      id: caseId,
      title: caseData.title,
      sent_to: results.cases_sent
    });
  }

  // ========================================
  // 要員配信（サマリー + スキルシートファイル）
  // ========================================
  for (const staffId of staffIds) {
    const staffData = fetchStaffForBroadcast(staffId);
    if (!staffData) {
      results.errors.push({ type: "staff", id: staffId, error: "データ取得失敗" });
      continue;
    }

    let staffSentCount = 0;

    for (const partner of targetPartners) {
      // 自社フィルタリング
      if (isOwnData(partner.companyName, staffData.sourceCompany)) {
        results.skipped_own++;
        Logger.log("⏭️ 自社除外: " + partner.companyName + " ← " + staffData.sourceCompany);
        continue;
      }

      // 1通目: 挨拶文 + サマリー全文を送信
      const staffMessage = "弊社注力情報になります！\n"
        + "マッチしそうな案件がございましたらご紹介ください！\n"
        + "※弊社商流抜けも可能です\n"
        + "*************************\n"
        + staffData.summary + "\n"
        + "*************************";
      const staffSendResult = sendLineNotificationWithDetail(partner.userId, staffMessage);
      if (staffSendResult.success) {
        results.staff_sent++;
        results.total_messages++;
      } else {
        results.errors.push({
          type: "staff",
          id: staffId,
          partner: partner.companyName,
          error: staffSendResult.error,
          status_code: staffSendResult.statusCode,
          message_length: staffMessage.length
        });
      }

      // 2通目: スキルシートファイル送信
      if (staffData.skillSheetUrl) {
        Utilities.sleep(200); // 連続送信を避ける
        const sentFile = sendSkillSheetFile(partner.userId, staffData.skillSheetUrl, staffData.skillSheetName);
        if (sentFile) {
          results.total_messages++;
        } else {
          // ファイル送信失敗時はURLをテキストで送信
          const fallbackMsg = "スキルシート: " + staffData.skillSheetUrl;
          sendLineNotification(partner.userId, fallbackMsg);
          results.total_messages++;
        }
      }

      staffSentCount++;
      Utilities.sleep(100);
    }

    results.details.push({
      type: "staff",
      id: staffId,
      title: staffData.title,
      has_skill_sheet: !!staffData.skillSheetUrl,
      sent_to: staffSentCount
    });
  }

  Logger.log("=== 配信処理完了 ===");
  Logger.log("案件送信: " + results.cases_sent + "通");
  Logger.log("要員送信: " + results.staff_sent + "通");
  Logger.log("合計: " + results.total_messages + "通");
  Logger.log("自社除外: " + results.skipped_own + "件");

  return results;
}

// ============================================================
// Notionデータ取得
// ============================================================

/**
 * 案件の配信用データを取得
 * @param {string} pageId - NotionページID
 * @returns {Object|null} {title, summary, sourceCompany}
 */
function fetchCaseForBroadcast(pageId) {
  const url = "https://api.notion.com/v1/pages/" + pageId.replace(/-/g, "");

  const options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + NOTION_API_KEY,
      "Notion-Version": "2022-06-28"
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log("❌ 案件取得エラー: " + response.getResponseCode());
      return null;
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    const title = props["入力不要"]?.title?.[0]?.plain_text || "(無題)";
    const summary = props["サマリー"]?.rich_text?.[0]?.plain_text || "";
    const sourceCompany = props["案件元企業"]?.rich_text?.[0]?.plain_text || "";

    if (!summary) {
      Logger.log("⚠️ サマリーが空です: " + title);
      return null;
    }

    return {
      title: title,
      summary: summary,
      sourceCompany: sourceCompany
    };

  } catch (error) {
    Logger.log("❌ 案件取得例外: " + error);
    return null;
  }
}

/**
 * 要員の配信用データを取得
 * @param {string} pageId - NotionページID
 * @returns {Object|null} {title, summary, sourceCompany, skillSheetUrl, skillSheetName}
 */
function fetchStaffForBroadcast(pageId) {
  const url = "https://api.notion.com/v1/pages/" + pageId.replace(/-/g, "");

  const options = {
    method: "get",
    headers: {
      "Authorization": "Bearer " + NOTION_API_KEY,
      "Notion-Version": "2022-06-28"
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log("❌ 要員取得エラー: " + response.getResponseCode());
      return null;
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    const title = props["要員名"]?.title?.[0]?.plain_text || "(無名)";
    const summary = props["サマリー"]?.rich_text?.[0]?.plain_text || "";
    const sourceCompany = props["要員元企業"]?.rich_text?.[0]?.plain_text || "";

    // スキルシートURL取得
    let skillSheetUrl = null;
    let skillSheetName = null;
    const files = props["スキルシート"]?.files || [];
    if (files.length > 0) {
      const firstFile = files[0];
      skillSheetName = firstFile.name || "スキルシート";
      if (firstFile.type === "external") {
        skillSheetUrl = firstFile.external?.url;
      } else if (firstFile.type === "file") {
        skillSheetUrl = firstFile.file?.url;
      }
    }

    if (!summary) {
      Logger.log("⚠️ サマリーが空です: " + title);
      return null;
    }

    return {
      title: title,
      summary: summary,
      sourceCompany: sourceCompany,
      skillSheetUrl: skillSheetUrl,
      skillSheetName: skillSheetName
    };

  } catch (error) {
    Logger.log("❌ 要員取得例外: " + error);
    return null;
  }
}

// ============================================================
// スキルシートファイル送信（Flex Messageカード方式）
// ============================================================

/**
 * スキルシートファイルをFlex MessageカードとしてLINEで送信
 *
 * LINE Messaging APIにはファイルメッセージ型が無いため、
 * Flex Messageでファイル名・形式・サイズ＋ダウンロードボタン付きカードを送信。
 * LINE内蔵ブラウザで開くためアプリ内で完結する。
 *
 * @param {string} userId - 送信先LINE UserID
 * @param {string} fileUrl - ファイルURL（Google Drive等）
 * @param {string} fileName - ファイル名
 * @returns {boolean} 送信成功かどうか
 */
function sendSkillSheetFile(userId, fileUrl, fileName) {
  if (!fileUrl) return false;

  // Google DriveファイルIDを抽出
  const driveFileId = extractDriveFileId(fileUrl);

  if (driveFileId) {
    return sendDriveFileAsFlexCard(userId, driveFileId, fileName);
  } else {
    // 外部URLの場合: Flex Messageカードで送信
    return sendFlexFileCard(userId, fileUrl, fileName || "スキルシート", "", "");
  }
}

/**
 * Google DriveファイルURLからファイルIDを抽出
 * @param {string} url - Google Drive URL
 * @returns {string|null} ファイルID
 */
function extractDriveFileId(url) {
  if (!url) return null;

  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}

/**
 * Google DriveファイルをFlex Messageカードで送信
 *
 * @param {string} userId - 送信先LINE UserID
 * @param {string} fileId - Google DriveファイルID
 * @param {string} fileName - ファイル名（フォールバック用）
 * @returns {boolean} 送信成功かどうか
 */
function sendDriveFileAsFlexCard(userId, fileId, fileName) {
  try {
    const file = DriveApp.getFileById(fileId);

    // 共有設定を確認・変更
    const access = file.getSharingAccess();
    if (access !== DriveApp.Access.ANYONE && access !== DriveApp.Access.ANYONE_WITH_LINK) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    const downloadUrl = "https://drive.google.com/uc?export=download&id=" + fileId;
    const actualFileName = file.getName() || fileName || "スキルシート";

    // ファイル情報を取得
    const fileSize = file.getSize();
    const fileSizeStr = formatFileSize(fileSize);
    const fileExt = getFileExtension(actualFileName);

    return sendFlexFileCard(userId, downloadUrl, actualFileName, fileExt, fileSizeStr);

  } catch (error) {
    Logger.log("⚠️ Driveファイル情報取得エラー: " + error);
    // フォールバック: 最低限の情報でカード送信
    const downloadUrl = "https://drive.google.com/uc?export=download&id=" + fileId;
    return sendFlexFileCard(userId, downloadUrl, fileName || "スキルシート", "", "");
  }
}

/**
 * Flex Messageファイルカードを送信
 *
 * @param {string} userId - 送信先LINE UserID
 * @param {string} downloadUrl - ダウンロードURL
 * @param {string} fileName - ファイル名
 * @param {string} fileExt - ファイル拡張子（例: "PDF"）
 * @param {string} fileSize - ファイルサイズ文字列（例: "1.05 MB"）
 * @returns {boolean} 送信成功かどうか
 */
function sendFlexFileCard(userId, downloadUrl, fileName, fileExt, fileSize) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  if (!accessToken || !userId) {
    Logger.log("❌ アクセストークンまたはUserIDが未設定");
    return false;
  }

  // ファイル情報テキスト（拡張子・サイズがあれば表示）
  const infoTexts = [];
  if (fileExt) infoTexts.push("形式: " + fileExt);
  if (fileSize) infoTexts.push("サイズ: " + fileSize);
  const infoStr = infoTexts.length > 0 ? infoTexts.join("  |  ") : "";

  // Flex Message組み立て
  const bodyContents = [
    {
      type: "text",
      text: fileName,
      size: "sm",
      wrap: true,
      color: "#333333"
    }
  ];

  if (infoStr) {
    bodyContents.push({
      type: "text",
      text: infoStr,
      size: "xs",
      color: "#888888",
      margin: "sm"
    });
  }

  const flexMessage = {
    type: "flex",
    altText: "📎 スキルシート: " + fileName,
    contents: {
      type: "bubble",
      size: "kilo",
      header: {
        type: "box",
        layout: "horizontal",
        contents: [
          {
            type: "text",
            text: "📎",
            size: "xl",
            flex: 0
          },
          {
            type: "text",
            text: "スキルシート",
            weight: "bold",
            size: "md",
            margin: "sm",
            color: "#333333"
          }
        ],
        paddingBottom: "sm"
      },
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
        paddingTop: "sm"
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "button",
            action: {
              type: "uri",
              label: "ダウンロード",
              uri: downloadUrl
            },
            style: "primary",
            color: "#4CAF50"
          }
        ]
      }
    }
  };

  // LINE Push APIで送信
  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: userId,
    messages: [flexMessage]
  };

  const options = {
    method: "post",
    headers: {
      "Authorization": "Bearer " + accessToken,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode === 200) {
      Logger.log("✅ Flex Messageスキルシート送信成功: " + fileName);
      return true;
    } else {
      Logger.log("❌ Flex Message送信エラー: " + responseCode);
      Logger.log(response.getContentText());
      // フォールバック: テキストで送信
      const fallbackMsg = "📎 " + fileName + "\n" + downloadUrl;
      return sendLineNotification(userId, fallbackMsg);
    }
  } catch (error) {
    Logger.log("❌ Flex Message送信例外: " + error);
    const fallbackMsg = "📎 " + fileName + "\n" + downloadUrl;
    return sendLineNotification(userId, fallbackMsg);
  }
}

/**
 * ファイルサイズを人間が読みやすい形式に変換
 * @param {number} bytes - バイト数
 * @returns {string} フォーマット済みサイズ（例: "1.05 MB"）
 */
function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(2) + " MB";
}

/**
 * ファイル名から拡張子を取得（大文字）
 * @param {string} fileName - ファイル名
 * @returns {string} 拡張子（例: "PDF", "XLSX"）
 */
function getFileExtension(fileName) {
  if (!fileName) return "";
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toUpperCase() : "";
}

// ============================================================
// パートナー管理
// ============================================================

/**
 * 全マッピング済みパートナーを取得
 * @returns {Array} [{userId, companyName}, ...]
 */
function getAllMappedPartners() {
  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty("LINE_USER_MAPPING") || "{}";

  try {
    const mapping = JSON.parse(mappingJson);
    const partners = [];

    for (const userId in mapping) {
      partners.push({
        userId: userId,
        companyName: mapping[userId]
      });
    }

    return partners;
  } catch (e) {
    Logger.log("❌ パートナーマッピング読み込みエラー: " + e);
    return [];
  }
}

// ============================================================
// 自社フィルタリング
// ============================================================

/**
 * 自社データかどうかを判定
 * パートナー企業名と情報元企業名を双方向部分一致でチェック
 *
 * @param {string} partnerCompanyName - パートナー企業名
 * @param {string} sourceCompany - 案件元/要員元企業名
 * @returns {boolean} 自社データの場合true（配信対象外）
 */
function isOwnData(partnerCompanyName, sourceCompany) {
  if (!sourceCompany || !partnerCompanyName) return false;

  // 正規化（株式会社等を除去して比較）
  const normalize = (name) => {
    return name
      .replace(/株式会社|（株）|\(株\)|有限会社|合同会社/g, "")
      .replace(/\s+/g, "")
      .trim();
  };

  const normalizedPartner = normalize(partnerCompanyName);
  const normalizedSource = normalize(sourceCompany);

  if (!normalizedPartner || !normalizedSource) return false;

  // 双方向部分一致（表記ゆれ対応）
  return normalizedPartner.includes(normalizedSource)
      || normalizedSource.includes(normalizedPartner);
}

// ============================================================
// テスト用関数
// ============================================================

/**
 * 配信テスト（管理者のみに送信）
 */
function testBroadcast() {
  // テスト用: 実際のNotionページIDを指定
  const testPayload = {
    action: "broadcast",
    token: getBroadcastToken(),
    cases: [],   // テストする案件ページIDを入れる
    staff: [],   // テストする要員ページIDを入れる
    test_mode: true
  };

  Logger.log("⚠️ テスト用ページIDを設定してから実行してください");
  // const result = executeBroadcastFromApi(testPayload);
  // Logger.log(JSON.stringify(result, null, 2));
}

/**
 * 自社フィルタリングテスト
 */
function testIsOwnData() {
  Logger.log("=== 自社フィルタリングテスト ===");

  const tests = [
    { partner: "なっしー（テスト）", source: "クリア", expected: false },
    { partner: "株式会社クリア", source: "クリア", expected: true },
    { partner: "クリア", source: "株式会社クリア", expected: true },
    { partner: "POL", source: "POL", expected: true },
    { partner: "アジアンストリーム", source: "アジアンストリーム", expected: true },
    { partner: "テスト企業", source: "", expected: false },
    { partner: "テスト企業", source: null, expected: false },
  ];

  let passed = 0;
  tests.forEach(t => {
    const result = isOwnData(t.partner, t.source);
    const status = result === t.expected ? "✅" : "❌";
    if (result === t.expected) passed++;
    Logger.log(`${status} "${t.partner}" vs "${t.source}" → ${result} (期待: ${t.expected})`);
  });

  Logger.log(`\n結果: ${passed}/${tests.length} 成功`);
}

/**
 * 全パートナー確認
 */
function showAllPartners() {
  const partners = getAllMappedPartners();
  Logger.log("=== 登録済みパートナー ===");
  Logger.log("件数: " + partners.length);
  partners.forEach((p, i) => {
    Logger.log(`  [${i + 1}] ${p.companyName} (${p.userId.substring(0, 10)}...)`);
  });
}
