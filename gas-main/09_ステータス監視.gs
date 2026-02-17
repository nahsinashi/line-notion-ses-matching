/**
 * ステータス変更履歴の監視・記録
 *
 * 機能:
 * 1. Googleフォーム経由のステータス変更を即時記録
 * 2. Notion直接変更を定期ポーリングで検知・記録
 */

// ステータス変更履歴DB ID
// スクリプトプロパティ「STATUS_HISTORY_DB_ID」から読み込み
const STATUS_HISTORY_DB_ID = PropertiesService.getScriptProperties().getProperty('STATUS_HISTORY_DB_ID');

// 監視対象DB
const WATCHED_DBS = {
  "提案": {
    id: PROPOSAL_DB_ID,  // 既存の定数を使用
    nameProperty: "提案名",
    statusProperty: "ステータス"
  },
  "要員": {
    id: STAFF_DB_ID,  // 既存の定数を使用
    nameProperty: "要員名",
    statusProperty: "ステータス"
  },
  "案件": {
    id: CASE_DB_ID,  // 既存の定数を使用
    nameProperty: "案件名",
    statusProperty: "ステータス"
  }
};

/**
 * ステータス変更を履歴DBに記録する（共通関数）
 *
 * @param {string} dbType - DB種別（提案/要員/案件）
 * @param {string} recordId - NotionページID
 * @param {string} recordName - レコード名
 * @param {string} oldStatus - 旧ステータス
 * @param {string} newStatus - 新ステータス
 * @param {string} note - 備考（オプション）
 */
function recordStatusChange(dbType, recordId, recordName, oldStatus, newStatus, note = "") {
  // 同じステータスの場合は記録しない
  if (oldStatus === newStatus) {
    Logger.log("ステータス変更なし: " + recordName);
    return false;
  }

  const url = "https://api.notion.com/v1/pages";

  const now = new Date();
  const isoDateTime = Utilities.formatDate(now, "Asia/Tokyo", "yyyy-MM-dd'T'HH:mm:ss'+09:00'");

  const payload = {
    parent: {
      database_id: STATUS_HISTORY_DB_ID
    },
    properties: {
      "レコード名": {
        title: [
          {
            text: {
              content: recordName || "（名前なし）"
            }
          }
        ]
      },
      "DB種別": {
        select: {
          name: dbType
        }
      },
      "レコードID": {
        rich_text: [
          {
            text: {
              content: recordId
            }
          }
        ]
      },
      "変更日時": {
        date: {
          start: isoDateTime
        }
      },
      "旧ステータス": {
        select: {
          name: oldStatus || "（なし）"
        }
      },
      "新ステータス": {
        select: {
          name: newStatus
        }
      }
    }
  };

  // 備考がある場合は追加
  if (note) {
    payload.properties["備考"] = {
      rich_text: [
        {
          text: {
            content: note
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

    if (response.getResponseCode() === 200) {
      Logger.log(`✅ 履歴記録: [${dbType}] ${recordName} : ${oldStatus} → ${newStatus}`);
      return true;
    } else {
      Logger.log("❌ 履歴記録エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log("❌ 履歴記録例外: " + error);
    return false;
  }
}

/**
 * Notionページから現在のステータスを取得
 */
function getCurrentStatus(pageId, statusProperty) {
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
      const page = JSON.parse(response.getContentText());
      const statusProp = page.properties[statusProperty];
      if (statusProp && statusProp.select) {
        return statusProp.select.name;
      }
    }
  } catch (error) {
    Logger.log("⚠️ ステータス取得エラー: " + error);
  }

  return null;
}

/**
 * Notionページからレコード名を取得
 */
function getRecordName(pageId, nameProperty) {
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
      const page = JSON.parse(response.getContentText());
      const nameProp = page.properties[nameProperty];

      // titleタイプの場合
      if (nameProp && nameProp.title && nameProp.title.length > 0) {
        return nameProp.title.map(t => t.plain_text).join("");
      }
      // formulaタイプの場合（提案名など）
      if (nameProp && nameProp.formula && nameProp.formula.string) {
        return nameProp.formula.string;
      }
    }
  } catch (error) {
    Logger.log("⚠️ レコード名取得エラー: " + error);
  }

  return "（名前なし）";
}

// ============================================================
// フォーム経由のステータス変更時に呼び出す関数
// ============================================================

/**
 * 提案ステータス変更時に履歴記録（フォーム経由）
 * updateProposalStatus()から呼び出す
 */
function recordProposalStatusChange(pageId, oldStatus, newStatus, recordName) {
  recordStatusChange("提案", pageId, recordName, oldStatus, newStatus, "フォーム経由");
}

/**
 * 案件ステータス変更時に履歴記録（フォーム経由）
 * updateCaseStatus()から呼び出す
 */
function recordCaseStatusChange(pageId, oldStatus, newStatus, recordName) {
  recordStatusChange("案件", pageId, recordName, oldStatus, newStatus, "フォーム経由");
}

/**
 * 要員ステータス変更時に履歴記録（フォーム経由）
 * updateStaffStatus()から呼び出す
 */
function recordStaffStatusChange(pageId, oldStatus, newStatus, recordName) {
  recordStatusChange("要員", pageId, recordName, oldStatus, newStatus, "フォーム経由");
}

// ============================================================
// Notion直接変更の監視（定期ポーリング）
// ============================================================

/**
 * 全DBのステータス変更を監視（メイン関数）
 * トリガーで15分ごとに実行
 */
function watchAllStatusChanges() {
  Logger.log("=== ステータス監視開始 ===");
  Logger.log("実行時刻: " + new Date().toLocaleString("ja-JP"));

  let totalChanges = 0;

  for (const [dbType, config] of Object.entries(WATCHED_DBS)) {
    const changes = watchDatabaseStatusChanges(dbType, config);
    totalChanges += changes;
  }

  Logger.log(`=== 監視完了: ${totalChanges}件の変更を検知 ===`);
}

/**
 * 指定DBのステータス変更を監視
 */
function watchDatabaseStatusChanges(dbType, config) {
  Logger.log(`\n--- ${dbType}DB監視中 ---`);

  const props = PropertiesService.getScriptProperties();
  const snapshotKey = `STATUS_SNAPSHOT_${dbType}`;

  // 前回のスナップショットを取得
  const previousSnapshotJson = props.getProperty(snapshotKey);
  const previousSnapshot = previousSnapshotJson ? JSON.parse(previousSnapshotJson) : {};

  // 現在のステータス一覧を取得
  const currentSnapshot = {};
  const records = queryAllRecords(config.id);

  let changesDetected = 0;

  records.forEach(record => {
    const pageId = record.id;
    const statusProp = record.properties[config.statusProperty];
    const currentStatus = statusProp?.select?.name || null;

    // レコード名を取得
    let recordName = "（名前なし）";
    const nameProp = record.properties[config.nameProperty];
    if (nameProp) {
      if (nameProp.title && nameProp.title.length > 0) {
        recordName = nameProp.title.map(t => t.plain_text).join("");
      } else if (nameProp.formula && nameProp.formula.string) {
        recordName = nameProp.formula.string;
      }
    }

    // 現在のスナップショットに保存
    currentSnapshot[pageId] = {
      status: currentStatus,
      name: recordName
    };

    // 前回と比較
    const previous = previousSnapshot[pageId];

    if (previous) {
      // 既存レコード: ステータスが変わったか確認
      if (previous.status !== currentStatus && currentStatus !== null) {
        Logger.log(`変更検知: ${recordName} : ${previous.status} → ${currentStatus}`);
        recordStatusChange(dbType, pageId, recordName, previous.status, currentStatus, "Notion直接変更");
        changesDetected++;
      }
    } else {
      // 新規レコード: 初回記録（変更履歴には記録しない）
      Logger.log(`新規レコード: ${recordName} (${currentStatus})`);
    }
  });

  // スナップショットを更新
  props.setProperty(snapshotKey, JSON.stringify(currentSnapshot));

  Logger.log(`${dbType}DB: ${records.length}件監視、${changesDetected}件変更`);

  return changesDetected;
}

/**
 * データベースの全レコードを取得
 */
function queryAllRecords(databaseId) {
  const url = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const allResults = [];
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
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      const response = UrlFetchApp.fetch(url, options);

      if (response.getResponseCode() === 200) {
        const data = JSON.parse(response.getContentText());
        allResults.push(...data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
      } else {
        Logger.log("❌ クエリエラー: " + response.getResponseCode());
        hasMore = false;
      }
    } catch (error) {
      Logger.log("❌ クエリ例外: " + error);
      hasMore = false;
    }
  }

  return allResults;
}

// ============================================================
// セットアップ・管理用関数
// ============================================================

/**
 * ステータス監視トリガーを設定（15分ごと）
 * 初回のみ手動実行
 */
function setupStatusWatchTrigger() {
  // 既存のトリガーを削除
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === "watchAllStatusChanges") {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  // 新しいトリガーを作成（15分ごと）
  ScriptApp.newTrigger("watchAllStatusChanges")
    .timeBased()
    .everyMinutes(15)
    .create();

  Logger.log("✅ ステータス監視トリガーを設定しました（15分ごと）");
}

/**
 * スナップショットを初期化
 * 初回セットアップ時、または手動リセット時に実行
 */
function initializeStatusSnapshots() {
  Logger.log("=== スナップショット初期化開始 ===");

  const props = PropertiesService.getScriptProperties();

  for (const [dbType, config] of Object.entries(WATCHED_DBS)) {
    Logger.log(`\n--- ${dbType}DBの初期化 ---`);

    const records = queryAllRecords(config.id);
    const snapshot = {};

    records.forEach(record => {
      const pageId = record.id;
      const statusProp = record.properties[config.statusProperty];
      const currentStatus = statusProp?.select?.name || null;

      let recordName = "（名前なし）";
      const nameProp = record.properties[config.nameProperty];
      if (nameProp) {
        if (nameProp.title && nameProp.title.length > 0) {
          recordName = nameProp.title.map(t => t.plain_text).join("");
        } else if (nameProp.formula && nameProp.formula.string) {
          recordName = nameProp.formula.string;
        }
      }

      snapshot[pageId] = {
        status: currentStatus,
        name: recordName
      };
    });

    const snapshotKey = `STATUS_SNAPSHOT_${dbType}`;
    props.setProperty(snapshotKey, JSON.stringify(snapshot));

    Logger.log(`${dbType}DB: ${records.length}件を保存`);
  }

  Logger.log("\n=== スナップショット初期化完了 ===");
}

/**
 * 現在のスナップショットを確認（デバッグ用）
 */
function showCurrentSnapshots() {
  const props = PropertiesService.getScriptProperties();

  for (const dbType of Object.keys(WATCHED_DBS)) {
    const snapshotKey = `STATUS_SNAPSHOT_${dbType}`;
    const snapshotJson = props.getProperty(snapshotKey);

    Logger.log(`\n=== ${dbType}DBスナップショット ===`);

    if (snapshotJson) {
      const snapshot = JSON.parse(snapshotJson);
      const count = Object.keys(snapshot).length;
      Logger.log(`レコード数: ${count}件`);

      // 最初の5件だけ表示
      let i = 0;
      for (const [pageId, data] of Object.entries(snapshot)) {
        if (i >= 5) {
          Logger.log("...(以下省略)");
          break;
        }
        Logger.log(`  ${data.name}: ${data.status}`);
        i++;
      }
    } else {
      Logger.log("（スナップショットなし）");
    }
  }
}

/**
 * 手動テスト: 履歴記録のテスト
 */
function testRecordStatusChange() {
  recordStatusChange(
    "提案",
    "test-page-id-12345",
    "テスト太郎 × テスト案件",
    "候補",
    "提案中",
    "手動テスト"
  );
}
