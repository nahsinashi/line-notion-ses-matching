/**
 * ===================================================
 * 05_WebApp.gs - Notion登録関数
 * ===================================================
 *
 * 【注意】
 * doPost / doGet は 07_ファイル受信処理.gs に移動しました。
 * このファイルには Notion登録関数のみ残しています。
 *
 * LINEマッピング関数は 06_LINEマッピング.gs にあります。
 */

// ============================================================
// Notion登録関数
// ============================================================

/**
 * API経由で案件を新規登録
 * @param {Object} formData - {登録タイプ, 担当者, 企業名, 原文}
 * @returns {string|null} ページID、失敗時はnull
 */
function createCasePageFromApi(formData) {
  const url = "https://api.notion.com/v1/pages";

  const payload = {
    parent: {
      database_id: CASE_DB_ID
    },
    properties: {
      "入力不要": {
        title: [{ text: { content: " " } }]
      },
      "案件元企業": {
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
      Logger.log("✅ [API] 案件DBに登録しました: " + result.id);

      // AI整形処理（Gemini Flash）
      const rawText = formData["原文"] || "";
      if (rawText) {
        try {
          const companyName = formData["企業名"] || "";
          const formatted = formatWithAI(rawText, "case", companyName);
          if (formatted) {
            updateCasePage(result.id, formatted);
            // マッチングは遅延実行（タイムアウト対策）
            scheduleMatching(result.id, "case");
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
 * API経由で要員を新規登録（ファイルなし版、従来互換用）
 * ※ファイル対応版は 07_ファイル受信処理.gs の createStaffPageFromApiWithFiles を使用
 */
function createStaffPageFromApi(formData) {
  const url = "https://api.notion.com/v1/pages";

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

      // AI整形処理（Gemini Flash）
      const rawText = formData["原文"] || "";
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
