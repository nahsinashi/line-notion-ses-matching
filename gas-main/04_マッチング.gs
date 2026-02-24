// ============================================================
// 遅延マッチング処理（タイムアウト対策）
// ============================================================

/**
 * マッチング処理を遅延実行するためのトリガーを設定
 * @param {string} pageId - 登録されたページID
 * @param {string} type - "staff" または "case"
 */
function scheduleMatching(pageId, type) {
  const props = PropertiesService.getScriptProperties();

  // 遅延マッチングキューに追加
  const queueJson = props.getProperty("MATCHING_QUEUE") || "[]";
  const queue = JSON.parse(queueJson);

  queue.push({
    pageId: pageId,
    type: type,
    timestamp: new Date().getTime()
  });

  props.setProperty("MATCHING_QUEUE", JSON.stringify(queue));
  Logger.log("📋 マッチングキューに追加: " + type + " / " + pageId);

  // 既存のトリガーがなければ作成（1分後に実行）
  const existingTriggers = ScriptApp.getProjectTriggers();
  const hasMatchingTrigger = existingTriggers.some(t =>
    t.getHandlerFunction() === "processMatchingQueue"
  );

  if (!hasMatchingTrigger) {
    ScriptApp.newTrigger("processMatchingQueue")
      .timeBased()
      .after(60 * 1000)  // 1分後
      .create();
    Logger.log("⏰ マッチングトリガー設定（1分後）");
  }
}

/**
 * マッチングキューを処理（トリガーから呼び出し）
 */
function processMatchingQueue() {
  const props = PropertiesService.getScriptProperties();
  const queueJson = props.getProperty("MATCHING_QUEUE") || "[]";
  const queue = JSON.parse(queueJson);

  Logger.log("=== マッチングキュー処理開始 ===");
  Logger.log("キュー件数: " + queue.length);

  if (queue.length === 0) {
    Logger.log("処理するキューがありません");
    cleanupMatchingTriggers();
    return;
  }

  // 1件ずつ処理
  const item = queue.shift();
  props.setProperty("MATCHING_QUEUE", JSON.stringify(queue));

  Logger.log("処理中: " + item.type + " / " + item.pageId);

  try {
    if (item.type === "staff") {
      // 要員 → 案件マッチング
      const staffData = getPageData(item.pageId, "staff");
      matchStaffWithCases(item.pageId, staffData);
    } else if (item.type === "case") {
      // 案件 → 要員マッチング
      const caseData = getPageData(item.pageId, "case");
      matchCaseWithStaff(item.pageId, caseData);
    }

    Logger.log("✅ マッチング処理完了: " + item.pageId);

  } catch (error) {
    Logger.log("❌ マッチング処理エラー: " + error);

    // エラー通知
    const adminUserId = getAdminLineUserId();
    if (adminUserId) {
      sendLineNotification(adminUserId,
        `❌ マッチング処理エラー\n${item.type}: ${item.pageId}\n${error.toString().substring(0, 100)}`
      );
    }
  }

  // キューに残りがあれば次のトリガーを設定
  if (queue.length > 0) {
    ScriptApp.newTrigger("processMatchingQueue")
      .timeBased()
      .after(30 * 1000)  // 30秒後
      .create();
    Logger.log("⏰ 次のマッチングトリガー設定（30秒後）残り: " + queue.length + "件");
  } else {
    cleanupMatchingTriggers();
  }
}

/**
 * マッチング用トリガーを削除
 */
function cleanupMatchingTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "processMatchingQueue") {
      ScriptApp.deleteTrigger(trigger);
      Logger.log("🗑️ マッチングトリガー削除");
    }
  });
}

/**
 * マッチングキューをクリア（デバッグ用）
 */
function clearMatchingQueue() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("MATCHING_QUEUE", "[]");
  cleanupMatchingTriggers();
  Logger.log("🗑️ マッチングキューをクリアしました");
}

/**
 * 現在のマッチングキューを確認（デバッグ用）
 */
function showMatchingQueue() {
  const props = PropertiesService.getScriptProperties();
  const queueJson = props.getProperty("MATCHING_QUEUE") || "[]";
  Logger.log("=== マッチングキュー ===");
  Logger.log(queueJson);
}

// ============================================================
// 同一情報元チェック
// ============================================================

/**
 * 案件元企業と要員元企業が同一かを判定
 * 表記揺れを考慮し、空白・株式会社等を除去して比較
 * @param {string} source1 - 案件元企業名
 * @param {string} source2 - 要員元企業名
 * @returns {boolean} 同一情報元の場合true
 */
function isSameSource(source1, source2) {
  if (!source1 || !source2) return false;

  const normalize = (name) => name
    .replace(/[\s　]/g, "")               // 空白除去
    .replace(/株式会社|（株）|\(株\)/g, "") // 株式会社表記除去
    .replace(/合同会社/g, "")              // 合同会社表記除去
    .toLowerCase();

  return normalize(source1) === normalize(source2);
}

// ============================================================
// マッチング処理本体
// ============================================================

/**
 * 要員登録時：対象案件とマッチング
 * @param {string} staffPageId - 登録された要員のページID
 * @param {object} staffData - 整形済みの要員データ
 */
function matchStaffWithCases(staffPageId, staffData) {
  Logger.log("=== マッチング開始（要員 → 案件）===");
  
  // 対象ステータスの案件を取得
  const cases = getActiveItems(CASE_DB_ID, "case");
  Logger.log("対象案件数: " + cases.length);
  
  if (cases.length === 0) {
    Logger.log("⚠️ マッチング対象の案件がありません");
    return;
  }
  
  // 要員のスキルシート取得
  const fileId = getSkillSheetFileId(staffPageId);
  const skillSheetDoc = fileId ? getSkillSheetForAI(fileId) : null;
  
  // 各案件とマッチング判定
  cases.forEach(caseItem => {
    // 同一情報元チェック：案件元企業と要員元企業が同じならスキップ
    if (isSameSource(caseItem.data.元企業, staffData.元企業)) {
      Logger.log("⏭️ 同一情報元スキップ: " + caseItem.data.元企業);
      return;
    }

    const matchResult = executeMatching(caseItem, staffData, skillSheetDoc);

    if (matchResult && matchResult.score >= 60) {
      // 提案DBに候補として登録
      createMatchCandidate(caseItem.id, staffPageId, matchResult);
    }
  });

  Logger.log("=== マッチング完了 ===");
}

/**
 * 案件登録時：対象要員とマッチング
 * @param {string} casePageId - 登録された案件のページID
 * @param {object} caseData - 整形済みの案件データ
 */
function matchCaseWithStaff(casePageId, caseData) {
  Logger.log("=== マッチング開始（案件 → 要員）===");

  // 対象ステータスの要員を取得
  const staffList = getActiveItems(STAFF_DB_ID, "staff");
  Logger.log("対象要員数: " + staffList.length);

  if (staffList.length === 0) {
    Logger.log("⚠️ マッチング対象の要員がいません");
    return;
  }

  // 各要員とマッチング判定
  staffList.forEach(staff => {
    // 同一情報元チェック：案件元企業と要員元企業が同じならスキップ
    if (isSameSource(caseData.元企業, staff.data.元企業)) {
      Logger.log("⏭️ 同一情報元スキップ: " + staff.data.元企業);
      return;
    }

    // 要員のスキルシート取得
    const fileId = getSkillSheetFileId(staff.id);
    const skillSheetDoc = fileId ? getSkillSheetForAI(fileId) : null;

    const matchResult = executeMatching(caseData, staff.data, skillSheetDoc);

    if (matchResult && matchResult.score >= 60) {
      createMatchCandidate(casePageId, staff.id, matchResult);
    }
  });
  
  Logger.log("=== マッチング完了 ===");
}

/**
 * 対象ステータス（営業中）のアイテムを取得
 * @param {string} databaseId - データベースID
 * @param {string} type - "case" または "staff"
 */
function getActiveItems(databaseId, type) {
  const url = `https://api.notion.com/v1/databases/${databaseId}/query`;
  
  const payload = {
    filter: {
      property: "ステータス", select: { equals: "営業中" }
    },
    page_size: 100
  };
  
  const options = {
    method: "post",
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
    const result = JSON.parse(response.getContentText());
    
    return result.results.map(page => ({
      id: page.id,
      data: extractItemData(page, type)
    }));
    
  } catch (error) {
    Logger.log("❌ データ取得エラー: " + error);
    return [];
  }
}

/**
 * Notionページからマッチングに必要なデータを抽出
 */
function extractItemData(page, type) {
  const props = page.properties;
  
  if (type === "case") {
    return {
      案件名: props["入力不要"]?.title?.[0]?.plain_text || "",
      サマリー: props["サマリー"]?.rich_text?.[0]?.plain_text || "",
      スキル要件: props["スキル要件"]?.multi_select?.map(s => s.name) || [],
      スキル詳細: props["スキル詳細"]?.rich_text?.[0]?.plain_text || "",
      営業単価: props["営業単価"]?.number || null,
      原文単価: props["原文単価"]?.number || null,
      元企業: props["案件元企業"]?.rich_text?.[0]?.plain_text || ""
    };
  } else {
    return {
      要員名: props["要員名"]?.title?.[0]?.plain_text || "",
      サマリー: props["サマリー"]?.rich_text?.[0]?.plain_text || "",
      スキル概要: props["スキル概要"]?.multi_select?.map(s => s.name) || [],
      スキル詳細: props["スキル詳細"]?.rich_text?.[0]?.plain_text || "",
      営業単価: props["営業単価"]?.number || null,
      希望単価: props["希望単価"]?.number || null,
      元企業: props["要員元企業"]?.rich_text?.[0]?.plain_text || ""
    };
  }
}

/**
 * Gemini APIでマッチング判定を実行（ハイブリッド構成）
 * - PDF有り: Gemini 2.0 Pro（高精度）
 * - PDF無し: Gemini 2.0 Flash（高速・低コスト）
 */
function executeMatching(caseData, staffData, skillSheetDoc) {
  const prompt = getMatchingPrompt();

  // プロンプトに変数を埋め込み
  const filledPrompt = prompt
    .replace("{{JOB_TEXT}}", JSON.stringify(caseData, null, 2))
    .replace("{{CANDIDATE_INTRO}}", JSON.stringify(staffData, null, 2))
    .replace("{{SKILL_SHEET}}", skillSheetDoc ? "（PDFファイルを添付）" : "（スキルシートなし）");

  try {
    let responseText;

    if (skillSheetDoc) {
      // PDF有り → Gemini 2.5 Pro（高精度PDF解析）
      Logger.log("📄 スキルシート有り → Gemini 2.5 Pro使用");
      responseText = callGeminiProForMatching(filledPrompt, skillSheetDoc);
    } else {
      // PDF無し → Gemini Flash（高速・低コスト）
      Logger.log("📝 スキルシート無し → Gemini Flash使用");
      responseText = callGeminiFlashForMatching(filledPrompt);
    }

    if (!responseText) {
      Logger.log("❌ マッチングAPI エラー: レスポンスなし");
      return null;
    }

    // スコアと判定を抽出
    return parseMatchingResult(responseText);

  } catch (error) {
    Logger.log("❌ マッチング例外: " + error);
    return null;
  }
}

/**
 * Gemini 2.5 Pro でマッチング（PDF対応）
 */
function callGeminiProForMatching(prompt, pdfDoc) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + GEMINI_API_KEY;

  const parts = [];

  // PDFを添付
  if (pdfDoc && pdfDoc.source && pdfDoc.source.data) {
    parts.push({
      inline_data: {
        mime_type: 'application/pdf',
        data: pdfDoc.source.data
      }
    });
  }

  parts.push({ text: prompt });

  const payload = {
    contents: [{ parts: parts }],
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

  if (response.getResponseCode() !== 200) {
    Logger.log("❌ Gemini 2.5 Pro API エラー: " + response.getResponseCode());
    Logger.log(response.getContentText());
    return null;
  }

  const result = JSON.parse(response.getContentText());

  if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
    return result.candidates[0].content.parts[0].text;
  }

  return null;
}

/**
 * Gemini Flash でマッチング（テキストのみ）
 */
function callGeminiFlashForMatching(prompt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 2000,
      temperature: 0.1
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'POST',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    Logger.log("❌ Gemini Flash API エラー: " + response.getResponseCode());
    Logger.log(response.getContentText());
    return null;
  }

  const result = JSON.parse(response.getContentText());

  if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
    return result.candidates[0].content.parts[0].text;
  }

  return null;
}

/**
 * マッチング結果をパース
 */
function parseMatchingResult(text) {
  const judgmentMatch = text.match(/【一次判定】(OK|要確認|見送り)（(\d+)点）/);
  
  if (!judgmentMatch) {
    // 見送りとして扱う（ログ表示のみ変更）
    Logger.log("→ 見送り（単価NGまたは60点未満）");
    return null;
  }
  
  return {
    judgment: judgmentMatch[1],
    score: parseInt(judgmentMatch[2]),
    detail: text
  };
}

/**
 * 提案DBにマッチング候補を登録
 */
function createMatchCandidate(caseId, staffId, matchResult) {
  const url = "https://api.notion.com/v1/pages";
  
  const payload = {
    parent: { database_id: PROPOSAL_DB_ID },
    properties: {
      "提案名": {
        title: [{ text: { content: `【自動】${matchResult.judgment}（${matchResult.score}点）` } }]
      },
      "案件DB": {
        relation: [{ id: caseId }]
      },
      "要員DB": {
        relation: [{ id: staffId }]
      },
      "ステータス": {
        select: { name: "候補" }
      },
      "提案日": {
        date: { start: Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd") }
      },
      "メモ": {
        rich_text: [{ text: { content: matchResult.detail.substring(0, 2000) } }]
      }
    }
  };
  
  const options = {
    method: "post",
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
      Logger.log("✅ 提案候補登録: " + matchResult.judgment + "（" + matchResult.score + "点）");

      // LINE通知
      const result = JSON.parse(response.getContentText());
      notifyProposalToAdmin(result.id, "候補", matchResult.detail);
    } else {
      Logger.log("❌ 提案登録エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ 提案登録例外: " + error);
  }
}

/**
 * マッチングプロンプトを取得（スプレッドシートから）
 */
function getMatchingPrompt() {
  const sheet = SpreadsheetApp.openById(PROMPT_SHEET_ID).getSheets()[0];
  return sheet.getRange("B3").getValue(); // B3にマッチングプロンプトを配置
}

/**
 * テスト用：手動で1組をマッチング
 */
function testMatching() {
  // ====== ここを書き換えてテスト ======
  const testCasePageId = "2edc01f8776981da9da1ca89acf4c4eb"; // 案件ページIDを入れる
  const testStaffPageId = "2e2c01f877698107ba95e1d9225d184b"; // 要員ページIDを入れる
  // ==================================
  
  if (!testCasePageId || !testStaffPageId) {
    Logger.log("❌ テスト用のページIDを設定してください");
    return;
  }
  
  Logger.log("=== マッチングテスト開始 ===");
  
  // 案件データ取得
  const caseData = getPageData(testCasePageId, "case");
  Logger.log("【案件】" + caseData.案件名);
  Logger.log(JSON.stringify(caseData, null, 2));
  
  // 要員データ取得
  const staffData = getPageData(testStaffPageId, "staff");
  Logger.log("【要員】" + staffData.要員名);
  Logger.log(JSON.stringify(staffData, null, 2));
  
  // スキルシート取得
  const fileId = getSkillSheetFileId(testStaffPageId);
  Logger.log("【スキルシート】" + (fileId ? "あり" : "なし"));
  
  const skillSheetDoc = fileId ? getSkillSheetForAI(fileId) : null;
  
  // マッチング実行
  Logger.log("--- AI API (Gemini) 呼び出し中... ---");
  const matchResult = executeMatching(caseData, staffData, skillSheetDoc);
  
  if (matchResult) {
    Logger.log("=== マッチング結果 ===");
    Logger.log("判定: " + matchResult.judgment);
    Logger.log("スコア: " + matchResult.score + "点");
    Logger.log("--- 詳細 ---");
    Logger.log(matchResult.detail);
    
    // 60点以上なら提案DB登録するか確認
    if (matchResult.score >= 60) {
      Logger.log("✅ 提案候補として登録可能（60点以上）");
      // 実際に登録したい場合は以下のコメントを外す
      createMatchCandidate(testCasePageId, testStaffPageId, matchResult);
    } else {
      Logger.log("⚠️ 見送り（60点未満）");
    }
  } else {
    Logger.log("❌ マッチング失敗");
  }
}

/**
 * NotionページからデータをJSON形式で取得
 */
function getPageData(pageId, type) {
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
    return extractItemData(page, type);
  } catch (error) {
    Logger.log("❌ ページ取得エラー: " + error);
    return {};
  }
}