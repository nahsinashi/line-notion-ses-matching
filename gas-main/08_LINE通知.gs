/**
 * ===================================================
 * 08_LINE通知.gs
 * ===================================================
 *
 * 【機能概要】
 * - 提案DBの登録/ステータス変更時に管理者へLINE通知
 * - 担当者フィルタ（要員担当 = 髙梨のもののみ）
 *
 * 【通知トリガー】
 * 1. 自動マッチングで「候補」登録時（04_マッチング.gs）
 * 2. フォームで「提案を登録」時（01_フォーム送信時の処理スクリプト.gs）
 * 3. フォームで「提案ステータスを変更」→「候補」or「提案中」時
 *
 * 【初期設定】
 * setupAdminLineUserId() を実行して管理者UserIDを設定
 */

// ============================================================
// 設定
// ============================================================

/**
 * 管理者LINE UserIDを設定（初回のみ実行）
 */
function setupAdminLineUserId() {
  const props = PropertiesService.getScriptProperties();
  // テストで使用していたUserID
  props.setProperty("ADMIN_LINE_USER_ID", "U1a1ba3866d295703c3108691279428f9");
  Logger.log("✅ 管理者LINE UserIDを設定しました");
}

/**
 * 管理者LINE UserIDを取得
 */
function getAdminLineUserId() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty("ADMIN_LINE_USER_ID");
}

/**
 * 現在の設定を確認
 */
function showNotificationConfig() {
  const props = PropertiesService.getScriptProperties();
  Logger.log("=== LINE通知設定 ===");
  Logger.log("ADMIN_LINE_USER_ID: " + (props.getProperty("ADMIN_LINE_USER_ID") || "❌ 未設定"));
  Logger.log("LINE_CHANNEL_ACCESS_TOKEN: " + (props.getProperty("LINE_CHANNEL_ACCESS_TOKEN") ? "✅ 設定済み" : "❌ 未設定"));
}

// ============================================================
// LINE送信
// ============================================================

/**
 * LINEでメッセージを送信
 * @param {string} userId - 送信先のLINE UserID
 * @param {string} message - 送信するメッセージ
 * @returns {boolean} 送信成功かどうか
 */
function sendLineNotification(userId, message) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  if (!accessToken) {
    Logger.log("❌ LINE_CHANNEL_ACCESS_TOKEN が未設定");
    return false;
  }

  if (!userId) {
    Logger.log("❌ 送信先UserIDが未指定");
    return false;
  }

  const url = "https://api.line.me/v2/bot/message/push";

  const payload = {
    to: userId,
    messages: [{ type: "text", text: message }]
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
      Logger.log("✅ LINE通知送信成功");
      return true;
    } else {
      Logger.log("❌ LINE通知エラー: " + responseCode);
      Logger.log(response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log("❌ LINE通知例外: " + error);
    return false;
  }
}

/**
 * LINEでメッセージを送信（エラー詳細を返す版）
 * @param {string} userId - 送信先のLINE UserID
 * @param {string} message - 送信するメッセージ
 * @returns {Object} {success: boolean, error: string, statusCode: number}
 */
function sendLineNotificationWithDetail(userId, message) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty("LINE_CHANNEL_ACCESS_TOKEN");

  if (!accessToken) {
    return { success: false, error: "LINE_CHANNEL_ACCESS_TOKEN未設定", statusCode: 0 };
  }
  if (!userId) {
    return { success: false, error: "送信先UserID未指定", statusCode: 0 };
  }

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: userId,
    messages: [{ type: "text", text: message }]
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
      return { success: true, error: null, statusCode: 200 };
    } else {
      const body = response.getContentText();
      Logger.log("❌ LINE通知エラー: " + responseCode + " " + body);
      return { success: false, error: body.substring(0, 300), statusCode: responseCode };
    }
  } catch (error) {
    Logger.log("❌ LINE通知例外: " + error);
    return { success: false, error: String(error).substring(0, 300), statusCode: 0 };
  }
}

// ============================================================
// 提案通知メイン処理
// ============================================================

/**
 * 提案登録/変更時の通知処理
 * @param {string} proposalPageId - 提案ページID
 * @param {string} status - ステータス（候補/提案中）
 * @param {string} memo - メモ（AI判定結果など）
 */
function notifyProposalToAdmin(proposalPageId, status, memo) {
  Logger.log("=== 提案通知処理開始 ===");
  Logger.log("提案ID: " + proposalPageId);
  Logger.log("ステータス: " + status);

  // 管理者UserIDを取得
  const adminUserId = getAdminLineUserId();
  if (!adminUserId) {
    Logger.log("⚠️ 管理者LINE UserIDが未設定です（setupAdminLineUserId を実行してください）");
    return;
  }

  // 提案ページの詳細を取得
  const proposalData = getProposalDetails(proposalPageId);
  if (!proposalData) {
    Logger.log("❌ 提案データの取得に失敗");
    return;
  }

  Logger.log("案件名: " + proposalData.caseName);
  Logger.log("案件担当: " + proposalData.caseManager);
  Logger.log("要員名: " + proposalData.staffName);
  Logger.log("要員担当: " + proposalData.staffManager);

  // 担当チェック（要員担当 = 髙梨のもののみ通知）
  // ※案件担当は全てハードコードで髙梨になるため、要員側でフィルタリング
  const targetManager = "髙梨";
  if (proposalData.staffManager !== targetManager) {
    Logger.log("⏭️ 要員担当が対象外のためスキップ");
    Logger.log("  対象担当: " + targetManager);
    Logger.log("  要員担当: " + proposalData.staffManager);
    return;
  }

  // 「候補」ステータスの場合はボタン付き通知を試みる
  if (status === "候補") {
    const buttonNotifySent = notifyMatchCandidateWithButtonsFromExistingGas(proposalPageId, proposalData, memo);
    if (buttonNotifySent) {
      Logger.log("=== ボタン付き通知送信完了 ===");
      return;
    }
    // ボタン付き通知が失敗した場合は従来の通知にフォールバック
    Logger.log("⚠️ ボタン付き通知失敗、従来通知にフォールバック");
  }

  // 通知メッセージ作成（従来の通知）
  const statusLabel = status === "候補" ? "【マッチング候補】" : "【提案中】";
  const notionUrl = `https://notion.so/${proposalPageId.replace(/-/g, "")}`;

  let message = `${statusLabel}\n\n`;
  message += `案件: ${proposalData.caseName}\n`;
  message += `要員: ${proposalData.staffName}\n`;

  if (memo) {
    // メモが長い場合は先頭300文字に制限
    const shortMemo = memo.length > 300 ? memo.substring(0, 300) + "..." : memo;
    message += `\nメモ:\n${shortMemo}\n`;
  }

  message += `\n${notionUrl}`;

  // LINE送信
  const sent = sendLineNotification(adminUserId, message);

  if (sent) {
    Logger.log("=== 提案通知処理完了 ===");
  } else {
    Logger.log("=== 提案通知処理失敗 ===");
  }
}

// ============================================================
// Phase 4: ボタン付き通知機能
// ============================================================

/**
 * マッチング候補をボタン付きで通知（既存GASから呼び出し用）
 * @param {string} proposalPageId - 提案ページID
 * @param {Object} proposalData - 提案データ（caseName, staffName等）
 * @param {string} memo - メモ（マッチング詳細）
 * @returns {boolean} 送信成功かどうか
 */
function notifyMatchCandidateWithButtonsFromExistingGas(proposalPageId, proposalData, memo) {
  const adminUserId = getAdminLineUserId();
  if (!adminUserId) return false;

  // 案件・要員の詳細情報を取得
  const caseDetails = proposalData.caseId ? getCaseDetailsForNotification(proposalData.caseId) : {};
  const staffDetails = proposalData.staffId ? getStaffDetailsForNotification(proposalData.staffId) : {};

  // マッチ度を抽出
  const scoreMatch = memo ? memo.match(/(\d+)点/) : null;
  const matchScore = scoreMatch ? parseInt(scoreMatch[1]) : null;

  // パートナーのLINE UserIDを取得
  const partnerUserId = getUserIdByCompanyNameLocal(staffDetails.company);
  const isMapped = !!partnerUserId;

  // 通知メッセージ作成
  let message = `📋 新しいマッチング候補\n\n`;
  message += `【案件】${proposalData.caseName}\n`;
  if (caseDetails.summary) {
    const shortSummary = caseDetails.summary.length > 100 ? caseDetails.summary.substring(0, 100) + '...' : caseDetails.summary;
    message += `${shortSummary}\n\n`;
  }
  message += `【要員】${proposalData.staffName}`;
  if (staffDetails.company) {
    message += `（${staffDetails.company}）`;
  }
  message += `\n\n`;

  if (matchScore) {
    message += `【マッチ度】${matchScore}%\n`;
  }
  if (memo) {
    const shortReason = memo.length > 150 ? memo.substring(0, 150) + '...' : memo;
    message += `【理由】${shortReason}\n`;
  }

  // マッピングなしの場合
  if (!isMapped) {
    message += `\n⚠️ 要員側パートナー未特定\n`;
    message += `企業名: ${staffDetails.company || '(不明)'}\n`;
    message += `※マッピング追加で送信可能に`;

    // ボタンなしで送信
    return sendLineNotification(adminUserId, message);
  }

  // 承認待ちデータを保存
  const pendingData = {
    proposalId: proposalPageId,
    caseId: proposalData.caseId,
    staffId: proposalData.staffId,
    caseName: proposalData.caseName,
    caseSummary: caseDetails.summary || '',
    staffName: proposalData.staffName,
    staffCompany: staffDetails.company || '',
    partnerUserId: partnerUserId,
    matchScore: matchScore,
    matchReason: memo
  };
  savePendingApprovalLocal(proposalPageId, pendingData);

  // ボタン付きメッセージ送信
  return sendQuickReplyMessageLocal(adminUserId, message, [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '承認',
        data: `action=approve&proposalId=${proposalPageId.replace(/-/g, '')}`,
        displayText: '承認'
      }
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '却下',
        data: `action=reject&proposalId=${proposalPageId.replace(/-/g, '')}`,
        displayText: '却下'
      }
    }
  ]);
}

/**
 * 案件の詳細を取得（通知用）
 */
function getCaseDetailsForNotification(casePageId) {
  if (!casePageId) return {};

  const url = `https://api.notion.com/v1/pages/${casePageId.replace(/-/g, '')}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + NOTION_API_KEY,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      return {};
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    return {
      name: props['入力不要']?.title?.[0]?.plain_text || '',
      summary: props['サマリー']?.rich_text?.[0]?.plain_text || ''
    };
  } catch (error) {
    Logger.log('⚠️ getCaseDetailsForNotification error: ' + error);
    return {};
  }
}

/**
 * 要員の詳細を取得（通知用）
 */
function getStaffDetailsForNotification(staffPageId) {
  if (!staffPageId) return {};

  const url = `https://api.notion.com/v1/pages/${staffPageId.replace(/-/g, '')}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + NOTION_API_KEY,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      return {};
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    return {
      name: props['要員名']?.title?.[0]?.plain_text || '',
      company: props['要員元企業']?.rich_text?.[0]?.plain_text || ''
    };
  } catch (error) {
    Logger.log('⚠️ getStaffDetailsForNotification error: ' + error);
    return {};
  }
}

/**
 * 企業名からLINE UserIDを逆引き（ローカル版）
 */
function getUserIdByCompanyNameLocal(companyName) {
  if (!companyName) return null;

  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty('LINE_USER_MAPPING') || '{}';

  try {
    const mapping = JSON.parse(mappingJson);

    // 企業名 → UserID の逆引き
    for (const userId in mapping) {
      if (mapping[userId] === companyName) {
        return userId;
      }
    }

    // 「LINE:Uxxxx」形式の場合はUserIDを抽出
    if (companyName.startsWith('LINE:')) {
      return companyName.replace('LINE:', '');
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 承認待ちデータを保存（ローカル版）
 */
function savePendingApprovalLocal(proposalId, data) {
  const cache = CacheService.getScriptCache();
  const key = 'pending_approval_' + proposalId.replace(/-/g, '');
  cache.put(key, JSON.stringify(data), 86400); // 24時間
  Logger.log('✅ 承認待ちデータ保存: ' + proposalId);
}

/**
 * クイックリプライ付きメッセージを送信（ローカル版）
 */
function sendQuickReplyMessageLocal(userId, text, items) {
  const props = PropertiesService.getScriptProperties();
  const accessToken = props.getProperty('LINE_CHANNEL_ACCESS_TOKEN');

  if (!accessToken) {
    Logger.log('❌ LINE_CHANNEL_ACCESS_TOKEN が未設定');
    return false;
  }

  const url = 'https://api.line.me/v2/bot/message/push';

  const payload = {
    to: userId,
    messages: [
      {
        type: 'text',
        text: text,
        quickReply: {
          items: items
        }
      }
    ]
  };

  const options = {
    method: 'post',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();

    if (responseCode === 200) {
      Logger.log('✅ クイックリプライ付きメッセージ送信成功');
      return true;
    } else {
      Logger.log('❌ 送信エラー: ' + responseCode + ' ' + response.getContentText());
      return false;
    }
  } catch (error) {
    Logger.log('❌ 送信例外: ' + error);
    return false;
  }
}

// ============================================================
// Notion データ取得
// ============================================================

/**
 * 提案ページから詳細情報を取得
 * @param {string} proposalPageId - 提案ページID
 * @returns {Object|null} {caseName, caseManager, staffName, staffManager}
 */
function getProposalDetails(proposalPageId) {
  const pageId = proposalPageId.replace(/-/g, "");
  const url = `https://api.notion.com/v1/pages/${pageId}`;

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
      Logger.log("❌ 提案ページ取得エラー: " + response.getResponseCode());
      Logger.log(response.getContentText());
      return null;
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    // リレーション先のIDを取得
    const caseRelation = props["案件DB"]?.relation?.[0]?.id;
    const staffRelation = props["要員DB"]?.relation?.[0]?.id;

    // 案件・要員の詳細を取得
    let caseName = "";
    let caseManager = "";
    let staffName = "";
    let staffManager = "";

    if (caseRelation) {
      const caseData = getCaseOrStaffInfo(caseRelation, "case");
      caseName = caseData.name;
      caseManager = caseData.manager;
    }

    if (staffRelation) {
      const staffData = getCaseOrStaffInfo(staffRelation, "staff");
      staffName = staffData.name;
      staffManager = staffData.manager;
    }

    return {
      caseName: caseName || "（不明）",
      caseManager: caseManager || "",
      staffName: staffName || "（不明）",
      staffManager: staffManager || "",
      caseId: caseRelation || null,
      staffId: staffRelation || null
    };

  } catch (error) {
    Logger.log("❌ 提案詳細取得例外: " + error);
    return null;
  }
}

/**
 * 案件または要員の名前と担当者を取得
 * @param {string} pageId - ページID
 * @param {string} type - "case" または "staff"
 * @returns {Object} {name, manager}
 */
function getCaseOrStaffInfo(pageId, type) {
  const url = `https://api.notion.com/v1/pages/${pageId.replace(/-/g, "")}`;

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
      Logger.log("⚠️ " + type + "ページ取得エラー: " + response.getResponseCode());
      return { name: "", manager: "" };
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    if (type === "case") {
      return {
        name: props["入力不要"]?.title?.[0]?.plain_text || "",
        manager: props["担当"]?.select?.name || ""
      };
    } else {
      return {
        name: props["要員名"]?.title?.[0]?.plain_text || "",
        manager: props["担当"]?.select?.name || ""
      };
    }

  } catch (error) {
    Logger.log("⚠️ 案件/要員情報取得エラー: " + error);
    return { name: "", manager: "" };
  }
}

// ============================================================
// テスト用関数
// ============================================================

/**
 * 通知テスト（LINE送信のみ）
 */
function testLineSend() {
  const adminUserId = getAdminLineUserId();
  if (!adminUserId) {
    Logger.log("❌ 管理者UserIDが未設定です");
    return;
  }

  const testMessage = "【テスト通知】\n\nこれはLINE通知のテストです。\n\n" + new Date().toLocaleString("ja-JP");
  sendLineNotification(adminUserId, testMessage);
}

/**
 * 通知テスト（提案ページ指定）
 * ※テスト前に testProposalId を設定してください
 */
function testNotifyProposal() {
  // ====== ここを書き換えてテスト ======
  const testProposalId = ""; // 提案ページIDを入れる（例: "2d5c01f8-7769-8188-ab53-d9493c62bbd2"）
  // ==================================

  if (!testProposalId) {
    Logger.log("❌ テスト用ページIDを設定してください");
    Logger.log("提案DBから任意のページIDをコピーして testProposalId に設定");
    return;
  }

  notifyProposalToAdmin(testProposalId, "候補", "テスト通知です。\nこのメッセージはテストで送信されています。");
}

/**
 * 設定確認とテストを一括実行
 */
function runNotificationDiagnostics() {
  Logger.log("========================================");
  Logger.log("LINE通知 診断開始");
  Logger.log("========================================");

  // 1. 設定確認
  showNotificationConfig();

  // 2. 管理者UserID確認
  const adminUserId = getAdminLineUserId();
  if (!adminUserId) {
    Logger.log("\n❌ 管理者UserIDが未設定です");
    Logger.log("→ setupAdminLineUserId() を実行してください");
    return;
  }
  Logger.log("\n✅ 管理者UserID: " + adminUserId);

  // 3. LINE送信テスト
  Logger.log("\n--- LINE送信テスト ---");
  const testResult = sendLineNotification(adminUserId, "【診断テスト】LINE通知が正常に動作しています。");

  if (testResult) {
    Logger.log("\n✅ 診断完了: LINE通知は正常に動作しています");
  } else {
    Logger.log("\n❌ 診断完了: LINE通知に問題があります");
  }

  Logger.log("========================================");
}
