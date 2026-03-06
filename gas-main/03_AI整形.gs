/**
 * 03_AI整形.gs
 *
 * 【機能概要】
 * Notion DBに登録された案件・要員の原文をAIで構造化データに整形
 *
 * 【処理フロー】
 * 1. 原文テキストの有効性判定（要員情報 or 通常会話の分類）
 * 2. AI API（Gemini/Claude）で原文を構造化データに変換
 * 3. 整形結果をNotionページのプロパティに書き戻し
 * 4. 整形完了後にマッチング処理をスケジュール
 *
 * 【使用AI】
 * - Gemini 2.5 Flash: 案件・要員の整形（高速・低コスト）
 * - プロンプトはスプレッドシートで管理
 *
 * 【依存】
 * - 04_マッチング.gs: scheduleMatching()（整形完了後に呼び出し）
 */

/**
 * 要員情報として有効かどうかを判定
 * @param {string} rawText - 原文
 * @returns {boolean} - 要員情報として有効ならtrue
 */
function isValidStaffInfo(rawText) {
  if (!rawText || rawText.trim() === "") {
    Logger.log("⚠️ 要員判定: 空のテキスト");
    return false;
  }

  // スキルシート添付のみの場合は有効（ファイルで判断するため）
  if (rawText === "（スキルシート添付）") {
    return true;
  }

  // 要員情報に含まれるべきキーワード（いずれか1つ以上）
  const staffKeywords = [
    // スキル関連
    "java", "python", "javascript", "typescript", "react", "vue", "angular",
    "php", "ruby", "go", "rust", "c#", "c++", "swift", "kotlin",
    "aws", "azure", "gcp", "docker", "kubernetes",
    "sql", "mysql", "postgresql", "oracle", "mongodb",
    "spring", "rails", "laravel", "django", "node",
    // 経験・スキル表現
    "経験", "年", "スキル", "得意", "実務",
    // 単価関連
    "単価", "万", "希望",
    // 稼働関連
    "稼働", "即日", "可能", "開始", "〜", "から",
    // イニシャル・属性
    "様", "氏", "歳", "男", "女", "最寄", "駅"
  ];

  // 通常会話・業務連絡のパターン（これに該当する場合は除外）
  const conversationPatterns = [
    /出払[っいうえお]/,           // 「出払って」「出払い」など
    /いません/,
    /しまいました/,
    /ありがとう/,
    /よろしく/,
    /お疲れ/,
    /了解/,
    /承知/,
    /確認しま/,
    /連絡しま/,
    /お伝え/,
    /ご連絡/,
    /お願い/,
    /すみません/,
    /申し訳/,
    /^[^\n]{0,50}$(?![\s\S]*[0-9]+[万円])/,  // 短文で単価情報なし
  ];

  const lowerText = rawText.toLowerCase();

  // 会話パターンに該当するか確認
  for (const pattern of conversationPatterns) {
    if (pattern.test(rawText)) {
      Logger.log("⚠️ 要員判定: 通常会話パターンに該当 - " + pattern.toString());
      return false;
    }
  }

  // 要員キーワードを含むか確認
  let keywordCount = 0;
  const matchedKeywords = [];
  for (const keyword of staffKeywords) {
    if (lowerText.includes(keyword.toLowerCase())) {
      keywordCount++;
      matchedKeywords.push(keyword);
    }
  }

  // 2つ以上のキーワードがあれば要員情報と判定
  if (keywordCount >= 2) {
    Logger.log("✅ 要員判定: 有効（キーワード: " + matchedKeywords.join(", ") + "）");
    return true;
  }

  Logger.log("⚠️ 要員判定: キーワード不足（" + keywordCount + "個: " + matchedKeywords.join(", ") + "）");
  return false;
}

/**
 * スプレッドシートからプロンプトを取得
 * @param {string} type - "case" または "staff"
 */
function getPrompt(type) {
  const sheet = SpreadsheetApp.openById(PROMPT_SHEET_ID).getSheets()[0];
  if (type === "case") {
    return sheet.getRange("B1").getValue();
  } else if (type === "staff") {
    return sheet.getRange("B2").getValue();
  }
  return null;
}

/**
 * Gemini Flashを使って原文を整形（コスト削減版）
 * @param {string} rawText - 原文
 * @param {string} type - "case" または "staff"
 * @param {string} [companyName] - 案件元企業名（商流の企業名を「上位」に置換するため）
 * @returns {object|null} - 整形結果のJSONオブジェクト、失敗時はnull
 */
function formatWithGemini(rawText, type, companyName) {
  const prompt = getPrompt(type);
  if (!prompt) {
    Logger.log("❌ プロンプト取得失敗: " + type);
    return null;
  }

  let fullPrompt = prompt + "\n\n【今日の日付】\n" + Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd");

  // 企業名がある場合、プロンプトに追加（案件：商流の企業名→上位、要員：所属の企業名変換用）
  if (companyName && type === "case") {
    fullPrompt += "\n\n【案件元企業】\n" + companyName;
  } else if (companyName && type === "staff") {
    fullPrompt += "\n\n【要員元企業】\n" + companyName;
  }

  fullPrompt += "\n\n【原文】\n" + rawText;

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

    const payload = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: {
        maxOutputTokens: 4000,
        temperature: 0.1
      }
    };

    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      Logger.log("❌ Gemini API エラー: " + responseCode);
      Logger.log(response.getContentText());
      sendErrorNotification("Gemini API", responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    if (!result.candidates || !result.candidates[0]?.content?.parts?.[0]?.text) {
      Logger.log("❌ Gemini API: 予期しないレスポンス構造");
      return null;
    }

    const content = result.candidates[0].content.parts[0].text;

    // デバッグ: Geminiの生レスポンスをログ出力
    Logger.log("📥 Gemini生レスポンス（先頭300文字）: " + content.substring(0, 300));
    Logger.log("📥 Gemini生レスポンス（末尾100文字）: " + content.substring(Math.max(0, content.length - 100)));

    // JSONを抽出
    let jsonStr = content.trim();

    // ```json または ``` で始まる場合、その部分を除去
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.substring(7);
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.substring(3);
    }

    // 末尾の ``` を除去
    if (jsonStr.endsWith("```")) {
      jsonStr = jsonStr.substring(0, jsonStr.length - 3);
    }

    jsonStr = jsonStr.trim();

    // JSONオブジェクトを抽出（最初の { から最後の } まで）
    const startIdx = jsonStr.indexOf("{");
    const endIdx = jsonStr.lastIndexOf("}");

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      jsonStr = jsonStr.substring(startIdx, endIdx + 1);
    }

    // JSONパース前にログ出力（デバッグ用）
    Logger.log("📋 抽出したJSON文字列（先頭200文字）: " + jsonStr.substring(0, 200));

    if (!jsonStr || jsonStr.length === 0) {
      Logger.log("❌ JSONの抽出に失敗しました");
      sendErrorNotification("Gemini API", "JSON抽出失敗", "生レスポンス: " + content.substring(0, 500));
      return null;
    }

    return JSON.parse(jsonStr);

  } catch (error) {
    Logger.log("❌ Gemini API 例外: " + error);
    sendErrorNotification("Gemini API", "例外", error.toString());
    return null;
  }
}

/**
 * AI整形処理のメイン関数
 * 現在はGemini Flashを使用
 * @param {string} rawText - 原文
 * @param {string} type - "case" または "staff"
 * @param {string} [companyName] - 案件元企業名（商流の企業名を「上位」に置換するため）
 * @returns {object|null} - 整形結果のJSONオブジェクト、失敗時はnull
 */
function formatWithAI(rawText, type, companyName) {
  return formatWithGemini(rawText, type, companyName);
}

/**
 * 後方互換性のためのエイリアス（非推奨）
 * @deprecated formatWithAI() を使用してください
 */
function formatWithClaude(rawText, type, companyName) {
  return formatWithAI(rawText, type, companyName);
}

/**
 * 案件ページを整形データで更新
 * @param {string} pageId - NotionページID
 * @param {object} data - 整形済みデータ
 */
function updateCasePage(pageId, data) {
  const url = "https://api.notion.com/v1/pages/" + pageId;

  const properties = {
    "ステータス": {
      select: { name: "営業中" }
    }
  };

  // 案件名
  if (data.案件名) {
    properties["入力不要"] = {
      title: [{ text: { content: data.案件名 } }]
    };
  }

  // サマリー
  if (data.サマリー) {
    properties["サマリー"] = {
      rich_text: [{ text: { content: data.サマリー.replace(/<br><br>/g, "\n").replace(/<br>/g, "\n") } }]
    };
  }

  // スキル要件（マルチセレクト）
  if (data.スキル要件 && data.スキル要件.length > 0) {
    properties["スキル要件"] = {
      multi_select: data.スキル要件.map(skill => ({ name: skill }))
    };
  }

  // スキル詳細
  if (data.スキル詳細) {
    properties["スキル詳細"] = {
      rich_text: [{ text: { content: data.スキル詳細 } }]
    };
  }

  // 営業単価
  if (data.営業単価 !== null && data.営業単価 !== undefined) {
    properties["営業単価"] = {
      number: data.営業単価
    };
  }
  // 原文単価
  if (data.原文単価 !== null && data.原文単価 !== undefined) {
    properties["原文単価"] = {
      number: data.原文単価
    };
  }

  // 案件開始
  if (data.案件開始) {
    properties["案件開始"] = {
      date: { start: data.案件開始 }
    };
  }

  // 勤務地
  if (data.勤務地) {
    properties["勤務地"] = {
      rich_text: [{ text: { content: data.勤務地 } }]
    };
  }

  // リモート
  if (data.リモート) {
    properties["リモート"] = {
      select: { name: data.リモート }
    };
  }

  // 募集人数
  if (data.募集人数 !== null && data.募集人数 !== undefined) {
    properties["募集人数"] = {
      number: data.募集人数
    };
  }

  const payload = { properties: properties };

  const options = {
    method: "patch",
    headers: {
      "Authorization": "Bearer " + NOTION_API_KEY,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      Logger.log("✅ 案件ページ更新完了: " + pageId);
      return true;
    } else {
      Logger.log("❌ 案件ページ更新エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log("❌ 案件ページ更新例外: " + error);
    return false;
  }
}

/**
 * 要員ページを整形データで更新
 * @param {string} pageId - NotionページID
 * @param {object} data - 整形済みデータ
 */
function updateStaffPage(pageId, data) {
  const url = "https://api.notion.com/v1/pages/" + pageId;

  const properties = {
    "ステータス": {
      select: { name: "営業中" }
    }
  };

  // 要員名
  if (data.要員名) {
    properties["要員名"] = {
      title: [{ text: { content: data.要員名 } }]
    };
  }

  // サマリー
  if (data.サマリー) {
    properties["サマリー"] = {
      rich_text: [{ text: { content: data.サマリー.replace(/<br><br>/g, "\n").replace(/<br>/g, "\n") } }]
    };
  }

  // スキル概要（マルチセレクト）
  if (data.スキル概要 && data.スキル概要.length > 0) {
    properties["スキル概要"] = {
      multi_select: data.スキル概要.map(skill => ({ name: skill }))
    };
  }

  // スキル詳細
  if (data.スキル詳細) {
    properties["スキル詳細"] = {
      rich_text: [{ text: { content: data.スキル詳細 } }]
    };
  }

  // 営業単価
  if (data.営業単価 !== null && data.営業単価 !== undefined) {
    properties["営業単価"] = {
      number: data.営業単価
    };
  }

  // 希望単価
  if (data.希望単価 !== null && data.希望単価 !== undefined) {
    properties["希望単価"] = {
      number: data.希望単価
    };
  }

  // 稼働開始
  if (data.稼働開始) {
    properties["稼働開始"] = {
      date: { start: data.稼働開始 }
    };
  }

  // 要員元企業
  if (data.要員元企業) {
    properties["要員元企業"] = {
      rich_text: [{ text: { content: data.要員元企業 } }]
    };
  }

  const payload = { properties: properties };

  const options = {
    method: "patch",
    headers: {
      "Authorization": "Bearer " + NOTION_API_KEY,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      Logger.log("✅ 要員ページ更新完了: " + pageId);
      return true;
    } else {
      Logger.log("❌ 要員ページ更新エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log("❌ 要員ページ更新例外: " + error);
    return false;
  }
}

/**
 * エラー通知（メール）
 */
function sendErrorNotification(source, code, detail) {
  const recipient = Session.getActiveUser().getEmail();
  const subject = "【SES自動整形】エラー発生: " + source;
  const body = "エラーコード: " + code + "\n\n詳細:\n" + detail;

  try {
    MailApp.sendEmail(recipient, subject, body);
    Logger.log("📧 エラー通知メール送信");
  } catch (e) {
    Logger.log("❌ メール送信失敗: " + e);
  }
}
/**
 * テスト用：案件整形の動作確認（Gemini Flash）
 */
function testCaseFormat() {
  const testRawText = `
【案件名】ECサイトリニューアル開発
【業務内容】既存ECサイトのフロントエンド刷新
【必須スキル】JavaScript 3年以上、React経験
【尚可スキル】TypeScript、Next.js
【単価】70万円
【期間】2025年2月〜長期
【場所】渋谷（週2出社）
【面談】1回
【商流】弊社→エンド
  `;

  Logger.log("=== 案件整形テスト開始（Gemini Flash）===");
  const result = formatWithGemini(testRawText, "case");
  Logger.log("整形結果:");
  Logger.log(JSON.stringify(result, null, 2));
}
/**
 * NotionページからスキルシートのファイルIDを取得
 * @param {string} pageId - NotionページID
 * @returns {string|null} - GoogleドライブのファイルID
 */
function getSkillSheetFileId(pageId) {
  const url = "https://api.notion.com/v1/pages/" + pageId;

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
    const page = JSON.parse(response.getContentText());

    const files = page.properties["スキルシート"]?.files;
    if (!files || files.length === 0) {
      Logger.log("⚠️ スキルシートが登録されていません");
      return null;
    }

    // external URLからファイルIDを抽出
    const fileUrl = files[0].external?.url || files[0].file?.url;
    if (!fileUrl) return null;

    // ファイルID抽出（既存ロジック流用）
    const match = fileUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/) ||
                  fileUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : null;

  } catch (error) {
    Logger.log("❌ スキルシート取得エラー: " + error);
    return null;
  }
}

/**
 * スキルシートをbase64で取得（AI API用）
 * @param {string} fileId - GoogleドライブのファイルID
 * @returns {object|null} - AI APIに渡す形式（PDFドキュメント）
 */
function getSkillSheetForAI(fileId) {
  try {
    const file = DriveApp.getFileById(fileId);
    const mimeType = file.getMimeType();
    let base64;

    if (mimeType === "application/pdf") {
      // PDFはそのまま
      base64 = Utilities.base64Encode(file.getBlob().getBytes());
    } else if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
      // Excel/スプレッドシート → PDF変換
      base64 = convertToPdfBase64(fileId, mimeType);
    } else {
      Logger.log("⚠️ 未対応のファイル形式: " + mimeType);
      return null;
    }

    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: base64
      }
    };

  } catch (error) {
    Logger.log("❌ ファイル読み込みエラー: " + error);
    return null;
  }
}

/**
 * 後方互換性のためのエイリアス（非推奨）
 * @deprecated getSkillSheetForAI() を使用してください
 */
function getSkillSheetForClaude(fileId) {
  return getSkillSheetForAI(fileId);
}

/**
 * Excel/スプレッドシートをPDFに変換してbase64で返す
 */
function convertToPdfBase64(fileId, mimeType) {
  const token = ScriptApp.getOAuthToken();
  let exportUrl;

  if (mimeType.includes("spreadsheet")) {
    // Googleスプレッドシート
    exportUrl = "https://docs.google.com/spreadsheets/d/" + fileId + "/export?format=pdf";
  } else {
    // Excel → 一度スプレッドシートとして開いてPDF化
    const file = DriveApp.getFileById(fileId);
    const blob = file.getBlob();
    const tempSheet = Drive.Files.insert(
      { title: "temp_convert", mimeType: "application/vnd.google-apps.spreadsheet" },
      blob
    );
    exportUrl = "https://docs.google.com/spreadsheets/d/" + tempSheet.id + "/export?format=pdf";

    // 変換後に一時ファイル削除
    Utilities.sleep(1000);
    DriveApp.getFileById(tempSheet.id).setTrashed(true);
  }

  const response = UrlFetchApp.fetch(exportUrl, {
    headers: { "Authorization": "Bearer " + token }
  });

  return Utilities.base64Encode(response.getBlob().getBytes());
}

/**
 * テスト用：スキルシート取得確認
 */
function testGetSkillSheet() {
  // 実際の要員ページIDを入れてテスト
  const testPageId = "2e7c01f8776981d78727ff6d314c76fc?";

  const fileId = getSkillSheetFileId(testPageId);
  Logger.log("ファイルID: " + fileId);

  if (fileId) {
    const doc = getSkillSheetForAI(fileId);
    Logger.log("取得成功: " + (doc ? "✅" : "❌"));
    Logger.log("データサイズ: " + (doc?.source?.data?.length || 0) + " bytes");
  }
}

/**
 * テスト用：要員整形の動作確認（Gemini Flash）
 */
function testStaffFormat() {
  const testRawText = `
K.S（男性 32歳）
最寄駅：渋谷駅（山手線）
スキル：Java 5年、Spring Boot、MySQL
希望単価：60万円
稼働可能：即日
希望条件：リモート希望
経験：金融系システムの開発経験あり
  `;

  Logger.log("=== 要員整形テスト開始（Gemini Flash）===");
  const result = formatWithGemini(testRawText, "staff");
  Logger.log("整形結果:");
  Logger.log(JSON.stringify(result, null, 2));
}
