/** * フォーム送信時に実行 */
function onFormSubmit(e) {
  // eがundefinedの場合(手動実行時)はエラーメッセージを表示
  if (!e || !e.response) {
    Logger.log("エラー: この関数はフォーム送信トリガーから実行される必要があります");
    Logger.log("手動テストする場合は testFormSubmit() を使用してください");
    return;
  }

  const itemResponses = e.response.getItemResponses();
  const formData = {};

  itemResponses.forEach(itemResponse => {
    const title = itemResponse.getItem().getTitle();
    const response = itemResponse.getResponse();
    formData[title] = response;
  });

  Logger.log("受信したフォームデータ:");
  Logger.log(JSON.stringify(formData, null, 2));

  const registrationType = formData["登録タイプ"];

  if (registrationType === "案件を登録") {
    createCasePage(formData);
  } else if (registrationType === "要員を登録") {
    createStaffPage(formData);
  } else if (registrationType === "提案を登録") {
    createProposalPage(formData);
  } else if (registrationType === "提案ステータスを変更") {
    updateProposalStatus(formData);
  } else if (registrationType === "案件ステータスを変更") {
    updateCaseStatus(formData);
  } else if (registrationType === "要員ステータスを変更") {
    updateStaffStatus(formData);
  }

  // 最後に選択肢を更新(次の人のために)
  updateFormChoices();
}

/** * 案件を新規登録 */
function createCasePage(formData) {
  const url = "https://api.notion.com/v1/pages";

  const payload = {
    parent: {
      database_id: CASE_DB_ID
    },
    properties: {
      "入力不要": {
        title: [
          {
            text: {
              content: " "
            }
          }
        ]
      },
      "案件元企業": {
        rich_text: [
          {
            text: {
              content: formData["企業名"] || ""
            }
          }
        ]
      },
      "原文": {
        rich_text: [
          {
            text: {
              content: formData["原文"] || ""
            }
          }
        ]
      },
      "ステータス": {
        select: {
          name: "未処理"
        }
      }
    }
  };

  if (formData["担当者"]) {
    payload.properties["担当"] = {
      select: {
        name: formData["担当者"]
      }
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
      Logger.log("✅ 案件DBに登録しました");
      Logger.log("ページID: " + result.id);

      const rawText = formData["原文"] || "";
      if (rawText) {
        const companyName = formData["企業名"] || "";
        const formatted = formatWithAI(rawText, "case", companyName);
        if (formatted) {
          updateCasePage(result.id, formatted);
          matchCaseWithStaff(result.id, formatted);
        } else {
          Logger.log("⚠️ 整形スキップ(AI API失敗)、未処理のまま");
        }
      }
    } else {
      Logger.log("❌ エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ エラー: " + error);
  }
}

/** * 要員を新規登録 */
function createStaffPage(formData) {
  const url = "https://api.notion.com/v1/pages";

  Logger.log("=== スキルシート デバッグ ===");
  Logger.log("スキルシート raw: " + formData["スキルシート"]);
  Logger.log("型: " + typeof formData["スキルシート"]);

  const payload = {
    parent: {
      database_id: STAFF_DB_ID
    },
    properties: {
      "要員名": {
        title: [
          {
            text: {
              content: " "
            }
          }
        ]
      },
      "要員元企業": {
        rich_text: [
          {
            text: {
              content: formData["企業名"] || ""
            }
          }
        ]
      },
      "原文": {
        rich_text: [
          {
            text: {
              content: formData["原文"] || ""
            }
          }
        ]
      },
      "ステータス": {
        select: {
          name: "未処理"
        }
      }
    }
  };

  if (formData["担当者"]) {
    payload.properties["担当"] = {
      select: {
        name: formData["担当者"]
      }
    };
  }

  if (formData["スキルシート"]) {
    let fileUrls = formData["スキルシート"];

    if (typeof fileUrls === "string") {
      fileUrls = fileUrls.split(",").map(s => s.trim());
    }

    const notionFiles = [];

    fileUrls.forEach(driveFileUrl => {
      Logger.log("処理中のURL: " + driveFileUrl);

      let fileId = null;

      const match1 = driveFileUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
      if (match1) fileId = match1[1];

      if (!fileId) {
        const match2 = driveFileUrl.match(/[?&]id=([a-zA-Z0-9_-]+)/);
        if (match2) fileId = match2[1];
      }

      if (!fileId && /^[a-zA-Z0-9_-]{20,}$/.test(driveFileUrl)) {
        fileId = driveFileUrl;
      }

      Logger.log("抽出されたファイルID: " + fileId);

      if (fileId) {
        const fileInfo = getDriveFileLink(fileId);
        if (fileInfo) {
          Logger.log("✅ ファイル情報取得成功: " + fileInfo.name);
          notionFiles.push({
            name: fileInfo.name,
            type: "external",
            external: { url: fileInfo.url }
          });
        }
      } else {
        Logger.log("⚠️ ファイルIDを抽出できませんでした");
      }
    });

    if (notionFiles.length > 0) {
      payload.properties["スキルシート"] = { files: notionFiles };
      Logger.log("Notionに送信するファイル数: " + notionFiles.length);
    }
  }

  Logger.log("=== 送信payload ===");
  Logger.log(JSON.stringify(payload, null, 2));

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
    const responseCode = response.getResponseCode();
    const result = JSON.parse(response.getContentText());

    if (responseCode === 200) {
      Logger.log("✅ 要員DBに登録しました");
      Logger.log("ページID: " + result.id);

      const rawText = formData["原文"] || "";
      if (rawText) {
        const companyName = formData["企業名"] || "";
        const formatted = formatWithAI(rawText, "staff", companyName);
        if (formatted) {
          updateStaffPage(result.id, formatted);
          matchStaffWithCases(result.id, formatted);
        } else {
          Logger.log("⚠️ 整形スキップ(AI API失敗)、未処理のまま");
        }
      }
    } else {
      Logger.log("❌ エラー: " + responseCode);
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ 例外エラー: " + error);
  }
}

/** * 提案を登録 */
function createProposalPage(formData) {
  const props = PropertiesService.getScriptProperties();
  const caseMapping = JSON.parse(props.getProperty("CASE_MAPPING") || "[]");
  const staffMapping = JSON.parse(props.getProperty("STAFF_MAPPING") || "[]");

  Logger.log("案件マッピング: " + caseMapping.length + "件");
  Logger.log("要員マッピング: " + staffMapping.length + "件");

  const selectedCaseLabel = normalizeLabel(formData["既存案件を選択"] || "");
  const selectedStaffLabel = normalizeLabel(formData["既存要員を選択"] || "");
  const caseId = caseMapping.find(opt => normalizeLabel(opt.label) === selectedCaseLabel)?.value;
  const staffId = staffMapping.find(opt => normalizeLabel(opt.label) === selectedStaffLabel)?.value;

  if (!caseId || !staffId) {
    Logger.log("❌ 案件または要員のIDが見つかりませんでした");
    Logger.log("選択された案件: " + formData["既存案件を選択"]);
    Logger.log("選択された要員: " + formData["既存要員を選択"]);
    return;
  }

  const url = "https://api.notion.com/v1/pages";

  const payload = {
    parent: {
      database_id: PROPOSAL_DB_ID
    },
    properties: {
      "提案名": {
        title: [
          {
            text: {
              content: " "
            }
          }
        ]
      },
      "案件DB": {
        relation: [
          { id: caseId }
        ]
      },
      "要員DB": {
        relation: [
          { id: staffId }
        ]
      },
      "ステータス": {
        select: {
          name: "候補"
        }
      },
      "提案日": {
        date: {
          start: Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy-MM-dd")
        }
      }
    }
  };

  if (formData["メモ"]) {
    payload.properties["メモ"] = {
      rich_text: [
        {
          text: {
            content: formData["メモ"]
          }
        }
      ]
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
      Logger.log("✅ 提案DBに登録しました");
      Logger.log("ページID: " + result.id);

      // ※フォーム提案登録のLINE通知は廃止（通知数節約）
    } else {
      Logger.log("❌ エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ エラー: " + error);
  }
}

/**
 * 提案のステータスを変更する
 */
function updateProposalStatus(formData) {
  const props = PropertiesService.getScriptProperties();
  const proposalMapping = JSON.parse(props.getProperty("PROPOSAL_MAPPING") || "[]");

  Logger.log("提案マッピング: " + proposalMapping.length + "件");
  Logger.log("選択された提案: " + formData["対象提案を選択"]);
  Logger.log("新しい提案ステータス: " + formData["新しい提案ステータス"]);

  const selectedProposalLabel = normalizeLabel(formData["対象提案を選択"] || "");
  const proposalId = proposalMapping.find(opt => normalizeLabel(opt.label) === selectedProposalLabel)?.value;

  if (!proposalId) {
    Logger.log("❌ 提案のIDが見つかりませんでした");
    Logger.log("選択された提案: " + formData["対象提案を選択"]);
    Logger.log("マッピング内ラベル一覧:");
    proposalMapping.forEach(opt => Logger.log("  " + JSON.stringify(opt.label)));
    return;
  }

  const pageId = proposalId.replace(/-/g, "");
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  // ★履歴記録用: 更新前のステータスを取得
  const oldStatus = getCurrentStatus(pageId, "ステータス");

  const payload = {
    properties: {
      "ステータス": {
        select: {
          name: formData["新しい提案ステータス"]
        }
      }
    }
  };

  if (formData["面談設定日"]) {
    payload.properties["面談設定日"] = {
      date: {
        start: formData["面談設定日"]
      }
    };
  }

  if (formData["メモ"]) {
    const currentPage = getNotionPage(pageId);
    let currentMemo = "";

    if (currentPage && currentPage.properties && currentPage.properties["メモ"]) {
      const memoProperty = currentPage.properties["メモ"];
      if (memoProperty.rich_text && memoProperty.rich_text.length > 0) {
        currentMemo = memoProperty.rich_text.map(rt => rt.plain_text).join("");
      }
    }

    const timestamp = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyy/MM/dd HH:mm");
    const newMemo = currentMemo
      ? `${currentMemo}\n\n[${timestamp}] ${formData["メモ"]}`
      : `[${timestamp}] ${formData["メモ"]}`;

    payload.properties["メモ"] = {
      rich_text: [
        {
          text: {
            content: newMemo
          }
        }
      ]
    };
  }

  const options = {
    method: "patch",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    Logger.log("=== 送信するペイロード ===");
    Logger.log(JSON.stringify(payload, null, 2));

    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log("✅ 提案DBのステータスを更新しました");
      Logger.log("ページID: " + result.id);
      Logger.log("新しい提案ステータス: " + formData["新しい提案ステータス"]);

      // ★履歴記録
      const recordName = formData["対象提案を選択"] || "";
      const newStatus = formData["新しい提案ステータス"];
      recordProposalStatusChange(pageId, oldStatus, newStatus, recordName);

      // ※フォーム提案ステータス変更のLINE通知は廃止（通知数節約）
    } else {
      Logger.log("❌ エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ エラー: " + error);
  }
}

/**
 * ラベル照合用：全角スペースを半角に正規化
 * Notionのタイトルに全角スペースが含まれている場合、
 * Googleフォーム経由で半角スペースに変換されることがあるため
 */
function normalizeLabel(str) {
  return str.replace(/\u3000/g, " ").trim();
}

/**
 * 案件のステータスを変更する
 */
function updateCaseStatus(formData) {
  const props = PropertiesService.getScriptProperties();
  const caseMapping = JSON.parse(props.getProperty("CASE_STATUS_MAPPING") || "[]");

  Logger.log("案件マッピング: " + caseMapping.length + "件");
  Logger.log("選択された案件: " + formData["対象案件を選択"]);
  Logger.log("新しい案件ステータス: " + formData["新しい案件ステータス"]);

  const selectedLabel = normalizeLabel(formData["対象案件を選択"] || "");
  const caseId = caseMapping.find(opt => normalizeLabel(opt.label) === selectedLabel)?.value;

  if (!caseId) {
    Logger.log("❌ 案件のIDが見つかりませんでした");
    Logger.log("選択された案件: " + formData["対象案件を選択"]);
    Logger.log("マッピング内ラベル一覧:");
    caseMapping.forEach(opt => Logger.log("  " + JSON.stringify(opt.label)));
    return;
  }

  const pageId = caseId.replace(/-/g, "");
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  // ★履歴記録用: 更新前のステータスを取得
  const oldStatus = getCurrentStatus(pageId, "ステータス");

  const payload = {
    properties: {
      "ステータス": {
        select: {
          name: formData["新しい案件ステータス"]
        }
      }
    }
  };

  const options = {
    method: "patch",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    Logger.log("=== 送信するペイロード ===");
    Logger.log(JSON.stringify(payload, null, 2));

    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log("✅ 案件DBのステータスを更新しました");
      Logger.log("ページID: " + result.id);
      Logger.log("新しい案件ステータス: " + formData["新しい案件ステータス"]);

      // ★履歴記録
      const recordName = formData["対象案件を選択"] || "";
      const newStatus = formData["新しい案件ステータス"];
      recordCaseStatusChange(pageId, oldStatus, newStatus, recordName);
    } else {
      Logger.log("❌ エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ エラー: " + error);
  }
}

/**
 * 要員のステータスを変更する
 */
function updateStaffStatus(formData) {
  const props = PropertiesService.getScriptProperties();
  const staffMapping = JSON.parse(props.getProperty("STAFF_STATUS_MAPPING") || "[]");

  Logger.log("要員マッピング: " + staffMapping.length + "件");
  Logger.log("選択された要員: " + formData["対象要員を選択"]);
  Logger.log("新しい要員ステータス: " + formData["新しい要員ステータス"]);

  const selectedStaffLabel = normalizeLabel(formData["対象要員を選択"] || "");
  const staffId = staffMapping.find(opt => normalizeLabel(opt.label) === selectedStaffLabel)?.value;

  if (!staffId) {
    Logger.log("❌ 要員のIDが見つかりませんでした");
    Logger.log("選択された要員: " + formData["対象要員を選択"]);
    Logger.log("マッピング内ラベル一覧:");
    staffMapping.forEach(opt => Logger.log("  " + JSON.stringify(opt.label)));
    return;
  }

  const pageId = staffId.replace(/-/g, "");
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  // ★履歴記録用: 更新前のステータスを取得
  const oldStatus = getCurrentStatus(pageId, "ステータス");

  const payload = {
    properties: {
      "ステータス": {
        select: {
          name: formData["新しい要員ステータス"]
        }
      }
    }
  };

  const options = {
    method: "patch",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    Logger.log("=== 送信するペイロード ===");
    Logger.log(JSON.stringify(payload, null, 2));

    const response = UrlFetchApp.fetch(url, options);
    const result = JSON.parse(response.getContentText());

    if (response.getResponseCode() === 200) {
      Logger.log("✅ 要員DBのステータスを更新しました");
      Logger.log("ページID: " + result.id);
      Logger.log("新しい要員ステータス: " + formData["新しい要員ステータス"]);

      // ★履歴記録
      const recordName = formData["対象要員を選択"] || "";
      const newStatus = formData["新しい要員ステータス"];
      recordStaffStatusChange(pageId, oldStatus, newStatus, recordName);
    } else {
      Logger.log("❌ エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
    }
  } catch (error) {
    Logger.log("❌ エラー: " + error);
  }
}

/**
 * Notionページを取得(メモの追記に使用)
 */
function getNotionPage(pageId) {
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  const options = {
    method: "get",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28"
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      return JSON.parse(response.getContentText());
    }
  } catch (error) {
    Logger.log("⚠️ ページ取得エラー: " + error);
  }

  return null;
}

/** * フォーム送信トリガーを設定 */
function setFormSubmitTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "onFormSubmit") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  const form = FormApp.openById(FORM_ID);
  ScriptApp.newTrigger("onFormSubmit")
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log("✅ フォーム送信トリガーを設定しました");
}

/** * Google Driveファイルの直接ダウンロードリンクを取得 */
function getDriveFileLink(driveFileId) {
  try {
    const file = DriveApp.getFileById(driveFileId);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    const directUrl = "https://drive.google.com/uc?export=download&id=" + driveFileId;

    // Googleフォーム経由アップロード時に付与される「 - 回答者名」を除去
    const rawName = file.getName();
    const cleanedName = cleanFormUploaderName(rawName);

    return {
      name: cleanedName,
      url: directUrl
    };
  } catch (error) {
    Logger.log("❌ ファイル取得エラー: " + error);
    return null;
  }
}

/**
 * Googleフォーム経由アップロード時にファイル名に付与される
 * 「 - 回答者名」を除去する
 * 例: "スキルシート_HH - リーデックス坂本原野.xlsx" → "スキルシート_HH.xlsx"
 * @param {string} fileName - 元のファイル名
 * @returns {string} クリーンなファイル名
 */
function cleanFormUploaderName(fileName) {
  if (!fileName) return fileName;

  // 拡張子を分離
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex === -1) {
    // 拡張子なしの場合：末尾の「 - 回答者名」を除去
    return fileName.replace(/ - [^-]+$/, "");
  }

  const baseName = fileName.substring(0, lastDotIndex);
  const ext = fileName.substring(lastDotIndex);

  // ベース名から末尾の「 - 回答者名」を除去
  const cleanedBase = baseName.replace(/ - [^-]+$/, "");

  return cleanedBase + ext;
}