/** * Notion APIでデータベースを検索（ページネーション対応） */
function queryNotionDatabase(databaseId) {
  const url = `https://api.notion.com/v1/databases/${databaseId}/query`;
  let allResults = [];
  let hasMore = true;
  let startCursor = null;

  while (hasMore) {
    const payload = {
      page_size: 100
    };

    if (startCursor) {
      payload.start_cursor = startCursor;
    }

    const options = {
      method: "post",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json"
      },
      payload: JSON.stringify(payload)
    };

    const response = UrlFetchApp.fetch(url, options);
    const data = JSON.parse(response.getContentText());

    allResults = allResults.concat(data.results);
    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }

  Logger.log(`DB ${databaseId.slice(-4)}: ${allResults.length}件取得`);
  return { results: allResults };
}

/** * データベースのスキーマを取得 */
function getDatabaseSchema(databaseId) {
  const url = `https://api.notion.com/v1/databases/${databaseId}`;
  
  const options = {
    method: "get",
    headers: {
      "Authorization": `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28"
    }
  };
  
  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

/** * 担当者の選択肢を取得 */
function getAssigneeOptions() {
  const schema = getDatabaseSchema(CASE_DB_ID);
  const assigneeProperty = schema.properties["担当"];
  
  if (assigneeProperty && assigneeProperty.select) {
    return assigneeProperty.select.options.map(opt => opt.name);
  }
  return [];
}

/**
 * ラベル用：全角スペースを半角に正規化
 */
function normalizeLabelText(str) {
  return str.replace(/\u3000/g, " ").trim();
}

/** * 案件DBから選択肢を生成（重複除去版） */
function getCaseOptions() {
  const data = queryNotionDatabase(CASE_DB_ID);
  const options = [];
  const seenLabels = new Set();

  data.results.forEach(page => {
    const title = normalizeLabelText(page.properties["入力不要"]?.title?.[0]?.plain_text || "無題");
    const company = normalizeLabelText(page.properties["案件元企業"]?.rich_text?.[0]?.plain_text || "");
    const status = page.properties["ステータス"]?.select?.name || "";

    if (status === "営業中") {
      let label = company ? `${title}（${company}）` : title;

      if (seenLabels.has(label)) {
        label = `${label} [${page.id.slice(-4)}]`;
      }
      seenLabels.add(label);

      options.push({
        label: label,
        value: page.id
      });
    }
  });

  return options;
}

/** * 要員DBから選択肢を生成（重複除去版） */
function getStaffOptions() {
  const data = queryNotionDatabase(STAFF_DB_ID);
  const options = [];
  const seenLabels = new Set();

  data.results.forEach(page => {
    const name = normalizeLabelText(page.properties["要員名"]?.title?.[0]?.plain_text || "無題");
    const company = normalizeLabelText(page.properties["要員元企業"]?.rich_text?.[0]?.plain_text || "");
    const status = page.properties["ステータス"]?.select?.name || "";

    if (status === "営業中") {
      let label = company ? `${name}（${company}）` : name;

      if (seenLabels.has(label)) {
        label = `${label} [${page.id.slice(-4)}]`;
      }
      seenLabels.add(label);

      options.push({
        label: label,
        value: page.id
      });
    }
  });

  return options;
}

/** * 提案DBから選択肢を生成 */
function getProposalOptions() {
  const data = queryNotionDatabase(PROPOSAL_DB_ID);
  const options = [];
  const seenLabels = new Set();

  const caseData = queryNotionDatabase(CASE_DB_ID);
  const staffData = queryNotionDatabase(STAFF_DB_ID);

  const allowedStatuses = ["候補", "提案中", "面談", "結果待ち"];

  Logger.log(`=== 提案DB デバッグ ===`);
  Logger.log(`提案DB総件数: ${data.results.length}件`);

  let skippedByStatus = 0;

  data.results.forEach(page => {
    const title = page.properties["提案名"]?.title?.[0]?.plain_text || "無題";
    const status = page.properties["ステータス"]?.select?.name || "";

    if (!allowedStatuses.includes(status)) {
      skippedByStatus++;
      return;
    }

    const caseRelation = page.properties["案件DB"]?.relation?.[0];
    const staffRelation = page.properties["要員DB"]?.relation?.[0];

    let caseName = "";
    let staffName = "";

    if (caseRelation) {
      const casePage = caseData.results.find(c => c.id === caseRelation.id);
      if (casePage) {
        caseName = normalizeLabelText(casePage.properties["入力不要"]?.title?.[0]?.plain_text || "不明");
      }
    }

    if (staffRelation) {
      const staffPage = staffData.results.find(s => s.id === staffRelation.id);
      if (staffPage) {
        staffName = normalizeLabelText(staffPage.properties["要員名"]?.title?.[0]?.plain_text || "不明");
      }
    }

    let label = `[案件:${caseName || "不明"} / 要員:${staffName || "不明"}] (${status})`;

    if (seenLabels.has(label)) {
      label = `${label} [${page.id.slice(-4)}]`;
    }
    seenLabels.add(label);

    options.push({
      label: label,
      value: page.id
    });
  });

  Logger.log(`ステータスでスキップ: ${skippedByStatus}件`);
  Logger.log(`最終的な提案オプション: ${options.length}件`);
  Logger.log(`=== 提案DB デバッグ終了 ===`);

  return options;
}

/** * 案件DBからステータス変更用の選択肢を生成（「終了」以外） */
function getCaseOptionsForStatusChange() {
  const data = queryNotionDatabase(CASE_DB_ID);
  const options = [];
  const seenLabels = new Set();

  data.results.forEach(page => {
    const title = normalizeLabelText(page.properties["入力不要"]?.title?.[0]?.plain_text || "無題");
    const company = normalizeLabelText(page.properties["案件元企業"]?.rich_text?.[0]?.plain_text || "");
    const status = page.properties["ステータス"]?.select?.name || "";

    if (status === "終了") return;

    let label = company ? `${title}（${company}）[${status}]` : `${title} [${status}]`;

    if (seenLabels.has(label)) {
      label = `${label} [${page.id.slice(-4)}]`;
    }
    seenLabels.add(label);

    options.push({
      label: label,
      value: page.id
    });
  });

  return options;
}

/** * 要員DBからステータス変更用の選択肢を生成（「終了」以外） */
function getStaffOptionsForStatusChange() {
  const data = queryNotionDatabase(STAFF_DB_ID);
  const options = [];
  const seenLabels = new Set();

  data.results.forEach(page => {
    const name = normalizeLabelText(page.properties["要員名"]?.title?.[0]?.plain_text || "無題");
    const company = normalizeLabelText(page.properties["要員元企業"]?.rich_text?.[0]?.plain_text || "");
    const status = page.properties["ステータス"]?.select?.name || "";

    if (status === "終了") return;

    let label = company ? `${name}（${company}）[${status}]` : `${name} [${status}]`;

    if (seenLabels.has(label)) {
      label = `${label} [${page.id.slice(-4)}]`;
    }
    seenLabels.add(label);

    options.push({
      label: label,
      value: page.id
    });
  });

  return options;
}

/** * フォームの選択肢を更新 */
function updateFormChoices() {
  try {
    const form = FormApp.openById(FORM_ID);
    const items = form.getItems();
    
    Logger.log("データ取得開始...");
    const assigneeOptions = getAssigneeOptions();
    Logger.log(`担当者オプション: ${assigneeOptions.length}件`);
    
    const caseOptions = getCaseOptions();
    Logger.log(`案件オプション: ${caseOptions.length}件`);
    
    const staffOptions = getStaffOptions();
    Logger.log(`要員オプション: ${staffOptions.length}件`);
    
    const proposalOptions = getProposalOptions();
    Logger.log(`提案オプション: ${proposalOptions.length}件`);
    
    // 担当者を更新
    if (assigneeOptions.length > 0) {
      updateDropdownByTitle(items, "担当者", assigneeOptions);
    }
    
    // 提案登録用：既存案件を選択を更新
    if (caseOptions.length > 0) {
      updateDropdownByTitle(items, "既存案件を選択", caseOptions.map(opt => opt.label));
      
      const props = PropertiesService.getScriptProperties();
      props.setProperty("CASE_MAPPING", JSON.stringify(caseOptions));
      Logger.log("✓ 案件マッピングを保存");
    } else {
      updateDropdownByTitle(items, "既存案件を選択", ["（現在、注力案件はありません）"]);
      Logger.log("⚠ 案件オプションが0件のためデフォルト値を設定");
    }
    
    // 提案登録用：既存要員を選択を更新
    if (staffOptions.length > 0) {
      updateDropdownByTitle(items, "既存要員を選択", staffOptions.map(opt => opt.label));
      
      const props = PropertiesService.getScriptProperties();
      props.setProperty("STAFF_MAPPING", JSON.stringify(staffOptions));
      Logger.log("✓ 要員マッピングを保存");
    } else {
      updateDropdownByTitle(items, "既存要員を選択", ["（現在、注力要員はありません）"]);
      Logger.log("⚠ 要員オプションが0件のためデフォルト値を設定");
    }
    
    // 提案ステータス変更用：対象提案を選択を更新
    if (proposalOptions.length > 0) {
      updateDropdownByTitle(items, "対象提案を選択", proposalOptions.map(opt => opt.label));
      
      const props = PropertiesService.getScriptProperties();
      props.setProperty("PROPOSAL_MAPPING", JSON.stringify(proposalOptions));
      Logger.log("✓ 提案マッピングを保存");
    } else {
      updateDropdownByTitle(items, "対象提案を選択", ["（現在、変更可能な提案はありません）"]);
      Logger.log("⚠ 提案オプションが0件のためデフォルト値を設定");
    }
    
    // 新しい提案ステータスの選択肢を更新
    const statusOptions = ["提案中", "面談", "結果待ち", "見送り", "辞退", "決定"];
    updateDropdownByTitle(items, "新しい提案ステータス", statusOptions);
    Logger.log("✓ 新しい提案ステータスの選択肢を更新");

    // 案件ステータス変更用：対象案件を選択を更新
    const caseOptionsForStatus = getCaseOptionsForStatusChange();
    Logger.log(`ステータス変更用案件オプション: ${caseOptionsForStatus.length}件`);

    if (caseOptionsForStatus.length > 0) {
      updateDropdownByTitle(items, "対象案件を選択", caseOptionsForStatus.map(opt => opt.label));

      const props = PropertiesService.getScriptProperties();
      props.setProperty("CASE_STATUS_MAPPING", JSON.stringify(caseOptionsForStatus));
      Logger.log("✓ 案件ステータス変更用マッピングを保存");
    } else {
      updateDropdownByTitle(items, "対象案件を選択", ["（現在、変更可能な案件はありません）"]);
      Logger.log("⚠ ステータス変更用案件オプションが0件のためデフォルト値を設定");
    }

    // 要員ステータス変更用：対象要員を選択を更新
    const staffOptionsForStatus = getStaffOptionsForStatusChange();
    Logger.log(`ステータス変更用要員オプション: ${staffOptionsForStatus.length}件`);

    if (staffOptionsForStatus.length > 0) {
      updateDropdownByTitle(items, "対象要員を選択", staffOptionsForStatus.map(opt => opt.label));

      const props = PropertiesService.getScriptProperties();
      props.setProperty("STAFF_STATUS_MAPPING", JSON.stringify(staffOptionsForStatus));
      Logger.log("✓ 要員ステータス変更用マッピングを保存");
    } else {
      updateDropdownByTitle(items, "対象要員を選択", ["（現在、変更可能な要員はありません）"]);
      Logger.log("⚠ ステータス変更用要員オプションが0件のためデフォルト値を設定");
    }

    // 新しい案件ステータスの選択肢を更新
    const caseStatusOptions = ["未処理", "営業中", "面談調整中", "決定", "終了"];
    updateDropdownByTitle(items, "新しい案件ステータス", caseStatusOptions);
    Logger.log("✓ 新しい案件ステータスの選択肢を更新");

    // 新しい要員ステータスの選択肢を更新
    const staffStatusOptions = ["営業中", "面談調整中", "オファー", "終了"];
    updateDropdownByTitle(items, "新しい要員ステータス", staffStatusOptions);
    Logger.log("✓ 新しい要員ステータスの選択肢を更新");

    Logger.log("\n✅ フォーム選択肢を更新しました");
    
  } catch (error) {
    Logger.log(`❌ エラー: ${error.message}`);
    Logger.log(`スタックトレース: ${error.stack}`);
    throw error;
  }
}

/** * 質問タイトルでプルダウンを検索して更新 */
function updateDropdownByTitle(items, questionTitle, choices) {
  for (const item of items) {
    if (item.getTitle() === questionTitle) {
      const itemType = item.getType();
      
      if (itemType === FormApp.ItemType.LIST) {
        item.asListItem().setChoiceValues(choices);
        Logger.log(`✓ "${questionTitle}" を更新（${choices.length}件）`);
        return true;
      } else if (itemType === FormApp.ItemType.MULTIPLE_CHOICE) {
        item.asMultipleChoiceItem().setChoiceValues(choices);
        Logger.log(`✓ "${questionTitle}" を更新（${choices.length}件）`);
        return true;
      } else {
        Logger.log(`⚠ "${questionTitle}" はプルダウンでもラジオボタンでもありません（型: ${itemType}）`);
        return false;
      }
    }
  }
  
  Logger.log(`❌ "${questionTitle}" という質問が見つかりません`);
  return false;
}

/** * トリガー設定用：15分ごと（9時〜18時のみ実行） */
function setHourlyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "updateFormChoicesWithTimeCheck") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  ScriptApp.newTrigger("updateFormChoicesWithTimeCheck")
    .timeBased()
    .everyMinutes(15)
    .create();
  
  Logger.log("✅ 15分ごとのトリガーを設定しました");
}

/** * 時間帯チェック付きの更新処理 */
function updateFormChoicesWithTimeCheck() {
  const now = new Date();
  const hour = now.getHours();

  if (hour >= 9 && hour <= 18) {
    Logger.log(`⏰ ${hour}時 - 実行します`);
    updateFormChoices();
  } else {
    Logger.log(`⏰ ${hour}時 - 営業時間外のためスキップ`);
  }
}

/** * フォームの現在の選択肢を確認（デバッグ用） */
function checkFormChoices() {
  const form = FormApp.openById(FORM_ID);
  const items = form.getItems();

  for (const item of items) {
    if (item.getTitle() === "対象提案を選択") {
      const listItem = item.asListItem();
      const choices = listItem.getChoices();
      Logger.log(`=== フォーム上の「対象提案を選択」===`);
      Logger.log(`選択肢数: ${choices.length}件`);
      choices.forEach((choice, i) => {
        Logger.log(`${i + 1}: ${choice.getValue()}`);
      });
      return;
    }
  }
  Logger.log("「対象提案を選択」が見つかりません");
}
