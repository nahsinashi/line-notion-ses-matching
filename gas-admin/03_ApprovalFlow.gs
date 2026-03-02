/**
 * 03_ApprovalFlow.gs
 *
 * マッチング候補の承認フロー処理
 *
 * 【機能】
 * 1. マッチング候補登録時に管理者へボタン付き通知
 * 2. 管理者が承認 → 要員側パートナーにLINE送信
 * 3. パートナーの返答を管理者に転送
 *
 * 【フロー】
 * マッチング候補登録 → 管理者通知（承認/却下ボタン）
 *       ↓ 承認
 * 要員側パートナーにLINE送信（案件サマリ）
 *       ↓
 * パートナー返答 → 管理者に転送
 */

// ====== キャッシュ設定 ======

// 承認待ちキャッシュのプレフィックス
const PENDING_APPROVAL_PREFIX = 'pending_approval_';
// 承認待ちキャッシュの有効期間（秒）- 24時間
const PENDING_APPROVAL_EXPIRATION = 86400;

// 送信済みメッセージキャッシュのプレフィックス（パートナー返答紐付け用）
const SENT_MESSAGE_PREFIX = 'sent_msg_';
// 送信済みメッセージキャッシュの有効期間（秒）- 7日
const SENT_MESSAGE_EXPIRATION = 604800;

// パートナーごとの最新送信案件キャッシュ
const LATEST_SENT_PREFIX = 'latest_sent_';

// ====== ヘルパー関数 ======

/**
 * クエリ文字列をパースする（GAS用）
 * @param {string} queryString - "key1=value1&key2=value2" 形式
 * @returns {Object} パースされたオブジェクト
 */
function parseQueryString(queryString) {
  const params = {};
  if (!queryString) return params;

  const pairs = queryString.split('&');
  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }
  return params;
}

// ====== 承認待ちデータ管理 ======

/**
 * 承認待ちデータを保存
 * @param {string} proposalId - 提案ページID
 * @param {Object} data - 承認待ちデータ
 */
function savePendingApproval(proposalId, data) {
  const cache = CacheService.getScriptCache();
  const key = PENDING_APPROVAL_PREFIX + proposalId.replace(/-/g, '');
  cache.put(key, JSON.stringify(data), PENDING_APPROVAL_EXPIRATION);
  console.log(`✅ 承認待ちデータ保存: ${proposalId}`);
}

/**
 * 承認待ちデータを取得
 * @param {string} proposalId - 提案ページID
 * @returns {Object|null} 承認待ちデータ
 */
function getPendingApproval(proposalId) {
  const cache = CacheService.getScriptCache();
  const key = PENDING_APPROVAL_PREFIX + proposalId.replace(/-/g, '');
  const data = cache.get(key);
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * 承認待ちデータを削除
 * @param {string} proposalId - 提案ページID
 */
function clearPendingApproval(proposalId) {
  const cache = CacheService.getScriptCache();
  const key = PENDING_APPROVAL_PREFIX + proposalId.replace(/-/g, '');
  cache.remove(key);
}

// ====== 送信メッセージ管理（パートナー返答紐付け用）======

/**
 * 送信メッセージを記録
 * @param {string} messageId - LINE送信メッセージID
 * @param {Object} data - {proposalId, caseId, staffId, partnerUserId, caseSummary, staffName}
 */
function saveSentMessage(messageId, data) {
  const cache = CacheService.getScriptCache();
  const key = SENT_MESSAGE_PREFIX + messageId;
  cache.put(key, JSON.stringify(data), SENT_MESSAGE_EXPIRATION);

  // パートナーごとの最新送信も更新
  const latestKey = LATEST_SENT_PREFIX + data.partnerUserId;
  cache.put(latestKey, JSON.stringify({
    messageId: messageId,
    ...data,
    sentAt: new Date().toISOString()
  }), SENT_MESSAGE_EXPIRATION);

  console.log(`✅ 送信メッセージ記録: ${messageId}`);
}

/**
 * 送信メッセージを取得（quotedMessageIdで検索）
 * @param {string} messageId - 引用元メッセージID
 * @returns {Object|null} 送信データ
 */
function getSentMessage(messageId) {
  const cache = CacheService.getScriptCache();
  const key = SENT_MESSAGE_PREFIX + messageId;
  const data = cache.get(key);
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * パートナーへの最新送信案件を取得
 * @param {string} partnerUserId - パートナーのLINE UserID
 * @returns {Object|null} 最新送信データ
 */
function getLatestSentToPartner(partnerUserId) {
  const cache = CacheService.getScriptCache();
  const key = LATEST_SENT_PREFIX + partnerUserId;
  const data = cache.get(key);
  if (data) {
    try {
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  }
  return null;
}

// ====== ボタン付きLINE通知 ======

/**
 * マッチング候補を管理者に通知（ボタン付き）
 * @param {string} proposalId - 提案ページID
 * @param {Object} matchData - マッチングデータ
 * @param {boolean} isMapped - パートナーがマッピング済みか
 */
function notifyMatchCandidateWithButtons(proposalId, matchData, isMapped) {
  if (!ADMIN_LINE_USER_ID) {
    console.log('⚠️ ADMIN_LINE_USER_ID未設定');
    return;
  }

  const {
    caseName,
    caseSummary,
    staffName,
    staffCompany,
    partnerUserId,
    matchScore,
    matchReason
  } = matchData;

  // 通知メッセージ作成
  let message = `📋 新しいマッチング候補\n\n`;
  message += `【案件】${caseName}\n`;
  if (caseSummary) {
    const shortSummary = caseSummary.length > 100 ? caseSummary.substring(0, 100) + '...' : caseSummary;
    message += `${shortSummary}\n\n`;
  }
  message += `【要員】${staffName}`;
  if (staffCompany) {
    message += `（${staffCompany}）`;
  }
  message += `\n\n`;

  if (matchScore) {
    message += `【マッチ度】${matchScore}%\n`;
  }
  if (matchReason) {
    const shortReason = matchReason.length > 150 ? matchReason.substring(0, 150) + '...' : matchReason;
    message += `【理由】${shortReason}\n`;
  }

  // マッピング状況
  if (!isMapped) {
    message += `\n⚠️ 要員側パートナー未特定\nLINE: ${partnerUserId}\n※マッピング追加で送信可能に`;

    // ボタンなしで送信
    sendPushMessage(ADMIN_LINE_USER_ID, message);
    return;
  }

  // 承認待ちデータを保存
  savePendingApproval(proposalId, matchData);

  // ボタン付きメッセージ送信
  sendQuickReplyMessage(ADMIN_LINE_USER_ID, message, [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '承認',
        data: `action=approve&proposalId=${proposalId.replace(/-/g, '')}`,
        displayText: '承認'
      }
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '却下',
        data: `action=reject&proposalId=${proposalId.replace(/-/g, '')}`,
        displayText: '却下'
      }
    }
  ]);
}

/**
 * クイックリプライ付きメッセージを送信
 * @param {string} userId - 送信先UserID
 * @param {string} text - メッセージテキスト
 * @param {Array} items - クイックリプライアイテム
 */
function sendQuickReplyMessage(userId, text, items) {
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

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      console.log('✅ クイックリプライ付きメッセージ送信成功');
    } else {
      console.error('❌ 送信エラー:', response.getResponseCode(), response.getContentText());
    }
  } catch (error) {
    console.error('❌ 送信例外:', error);
  }
}

// ====== Postbackイベント処理 ======

/**
 * Postbackイベントを処理（承認/却下ボタン押下時）
 * @param {Object} event - LINEイベント
 * @returns {Object} 処理結果
 */
function processPostbackEvent(event) {
  const userId = event.source.userId;
  const postbackData = event.postback.data;

  console.log(`📨 Postback受信: ${postbackData}`);

  // 管理者以外は無視
  if (userId !== ADMIN_LINE_USER_ID) {
    console.log('⏭️ 管理者以外のPostbackはスキップ');
    return { skipped: true, reason: 'Not admin' };
  }

  // パラメータ解析（GASではURLSearchParamsが使えないため手動パース）
  const params = parseQueryString(postbackData);
  const action = params.action;
  const proposalId = params.proposalId;

  if (!action || !proposalId) {
    console.log('⚠️ パラメータ不足');
    return { error: 'Missing parameters' };
  }

  // Notion APIから提案データを直接取得（キャッシュ依存を廃止）
  const matchData = getMatchDataFromProposal(proposalId);
  if (!matchData) {
    sendPushMessage(userId, '⚠️ 提案データの取得に失敗しました。');
    return { error: 'Failed to fetch proposal data from Notion' };
  }

  // 処理済みチェック（gas-adminのキャッシュで管理）
  if (isProposalProcessed(proposalId)) {
    sendPushMessage(userId, '⚠️ この候補は既に処理済みです。');
    return { error: 'Already processed' };
  }

  if (action === 'approve') {
    return processApproval(proposalId, matchData);
  } else if (action === 'reject') {
    return processRejection(proposalId, matchData);
  }

  return { error: 'Unknown action' };
}

/**
 * 承認処理
 * @param {string} proposalId - 提案ページID
 * @param {Object} pendingData - 承認待ちデータ
 * @returns {Object} 処理結果
 */
function processApproval(proposalId, pendingData) {
  const {
    caseName,
    caseSummary,
    staffName,
    staffCompany,
    partnerUserId
  } = pendingData;

  console.log(`✅ 承認処理開始: ${proposalId}`);

  // パートナーに送信するメッセージを作成
  let partnerMessage = `${staffName}さん向けの案件のご紹介です。\n\n`;
  partnerMessage += `━━━━━━━━━━━━━━━━━━\n`;
  partnerMessage += caseSummary || caseName;
  partnerMessage += `\n━━━━━━━━━━━━━━━━━━\n\n`;
  partnerMessage += `ご興味がありましたらお知らせください。`;

  // パートナーにLINE送信
  const sendResult = sendPushMessageWithTracking(partnerUserId, partnerMessage, {
    proposalId: proposalId,
    caseId: pendingData.caseId,
    staffId: pendingData.staffId,
    partnerUserId: partnerUserId,
    caseName: caseName,
    caseSummary: caseSummary,
    staffName: staffName,
    staffCompany: staffCompany
  });

  if (sendResult.success) {
    // 管理者に送信完了通知
    sendPushMessage(ADMIN_LINE_USER_ID,
      `✅ ${staffCompany || 'パートナー'}に送信しました。\n\n` +
      `案件: ${caseName}\n` +
      `要員: ${staffName}\n\n` +
      `返答があれば転送します。`
    );

    // 処理済みとしてキャッシュに記録
    markProposalProcessed(proposalId, 'approved');

    return { success: true, action: 'approved' };
  } else {
    sendPushMessage(ADMIN_LINE_USER_ID, `❌ 送信に失敗しました: ${sendResult.error}`);
    return { success: false, error: sendResult.error };
  }
}

/**
 * 却下処理
 * @param {string} proposalId - 提案ページID
 * @param {Object} pendingData - 承認待ちデータ
 * @returns {Object} 処理結果
 */
function processRejection(proposalId, pendingData) {
  console.log(`❌ 却下処理: ${proposalId}`);

  // Notionの提案ステータスを「見送り」に更新
  updateProposalStatus(proposalId, '見送り');

  // 処理済みとしてキャッシュに記録
  markProposalProcessed(proposalId, 'rejected');

  console.log(`✅ 却下処理完了: 案件=${pendingData.caseName}, 要員=${pendingData.staffName}`);

  return { success: true, action: 'rejected' };
}

// ====== Notionステータス更新 ======

/**
 * 提案ページのステータスを更新（既存の選択肢のみ使用）
 * @param {string} proposalId - 提案ページID
 * @param {string} status - 新しいステータス（'見送り' 等、提案DBに既存の選択肢）
 */
function updateProposalStatus(proposalId, status) {
  const url = `https://api.notion.com/v1/pages/${proposalId.replace(/-/g, '')}`;

  const payload = {
    properties: {
      'ステータス': {
        select: { name: status }
      }
    }
  };

  const options = {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() === 200) {
      console.log(`✅ 提案ステータス更新: ${proposalId} → ${status}`);
    } else {
      console.error(`❌ ステータス更新エラー: ${response.getResponseCode()}`, response.getContentText());
    }
  } catch (error) {
    console.error('❌ ステータス更新例外:', error);
  }
}

// ====== 処理済み管理（gas-adminキャッシュ）======

const PROCESSED_PREFIX = 'processed_';
// 処理済みキャッシュの有効期間（秒）- 7日
const PROCESSED_EXPIRATION = 604800;

/**
 * 提案を処理済みとして記録
 * @param {string} proposalId - 提案ページID
 * @param {string} action - 'approved' または 'rejected'
 */
function markProposalProcessed(proposalId, action) {
  const cache = CacheService.getScriptCache();
  const key = PROCESSED_PREFIX + proposalId.replace(/-/g, '');
  cache.put(key, action, PROCESSED_EXPIRATION);
  console.log(`✅ 処理済み記録: ${proposalId} → ${action}`);
}

/**
 * 提案が処理済みかどうか判定
 * @param {string} proposalId - 提案ページID
 * @returns {boolean} 処理済みならtrue
 */
function isProposalProcessed(proposalId) {
  const cache = CacheService.getScriptCache();
  const key = PROCESSED_PREFIX + proposalId.replace(/-/g, '');
  return !!cache.get(key);
}

// ====== パートナーへのメッセージ送信（トラッキング付き）======

/**
 * パートナーにメッセージを送信し、送信情報を記録
 * @param {string} userId - 送信先UserID
 * @param {string} message - メッセージ
 * @param {Object} trackingData - トラッキング用データ
 * @returns {Object} {success: boolean, messageId?: string, error?: string}
 */
function sendPushMessageWithTracking(userId, message, trackingData) {
  const url = 'https://api.line.me/v2/bot/message/push';

  const payload = {
    to: userId,
    messages: [
      { type: 'text', text: message }
    ]
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
        'X-Line-Retry-Key': Utilities.getUuid() // リトライ対策
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();

    if (responseCode === 200) {
      // LINE APIはpush時にmessageIdを返さないため、タイムスタンプベースのIDを生成
      const pseudoMessageId = `sent_${Date.now()}_${userId.substring(0, 8)}`;

      // トラッキングデータを保存
      saveSentMessage(pseudoMessageId, trackingData);

      console.log(`✅ パートナーへ送信成功: ${userId}`);
      return { success: true, messageId: pseudoMessageId };
    } else {
      console.error('❌ 送信エラー:', responseCode, response.getContentText());
      return { success: false, error: `HTTP ${responseCode}` };
    }
  } catch (error) {
    console.error('❌ 送信例外:', error);
    return { success: false, error: error.message };
  }
}

// ====== パートナー返答処理 ======

/**
 * パートナーからの返答かどうか判定
 * @param {string} text - メッセージテキスト
 * @param {string} userId - 送信者UserID
 * @param {string} quotedMessageId - 引用元メッセージID（あれば）
 * @returns {Object|null} 返答データ（返答でなければnull）
 */
function checkPartnerReply(text, userId, quotedMessageId) {
  // 管理者からのメッセージは対象外
  if (userId === ADMIN_LINE_USER_ID) {
    return null;
  }

  // 1. リプライの場合：引用元メッセージで紐付け
  if (quotedMessageId) {
    const sentData = getSentMessage(quotedMessageId);
    if (sentData) {
      console.log(`✅ リプライで紐付け成功: ${quotedMessageId}`);
      return {
        type: 'reply',
        sentData: sentData,
        replyText: text
      };
    }
  }

  // 2. リプライなし：最新の送信案件をチェック
  const latestSent = getLatestSentToPartner(userId);
  if (!latestSent) {
    return null; // このパートナーには送信履歴なし
  }

  // 送信から7日以内かチェック
  const sentAt = new Date(latestSent.sentAt);
  const now = new Date();
  const daysDiff = (now - sentAt) / (1000 * 60 * 60 * 24);
  if (daysDiff > 7) {
    return null; // 7日以上前の送信は紐付けしない
  }

  // 3. AI判定で返答かどうか判断（GPT-4o-mini優先、Claude Haikuフォールバック）
  const isReply = judgeIfReplyWithAI(text, latestSent.caseSummary);

  if (isReply) {
    console.log(`✅ AI判定で返答と判定`);
    return {
      type: 'ai_judged',
      sentData: latestSent,
      replyText: text
    };
  }

  return null;
}

/**
 * 返答かどうかを判定（GPT-4o-mini優先）
 * ※フォールバック: OpenAI失敗時はClaude Haikuを使用
 * @param {string} text - 受信メッセージ
 * @param {string} caseSummary - 送信した案件サマリ
 * @returns {boolean} 返答ならtrue
 */
function judgeIfReplyWithAI(text, caseSummary) {
  const prompt = buildReplyJudgmentPrompt(text, caseSummary);

  // 1. GPT-4o-miniで判定（メイン）
  if (OPENAI_API_KEY) {
    console.log('🤖 GPT-4o-miniで返答判定中...');
    const openaiResponse = callGPT4oMini(prompt, 200);

    if (openaiResponse) {
      const parsed = parseAIResponseAsJSON(openaiResponse);
      if (parsed) {
        console.log(`✅ GPT返答判定: isReply=${parsed.isReply}, confidence=${parsed.confidence}`);
        return parsed.isReply && parsed.confidence >= 60;
      }
    }
    console.log('⚠️ GPT判定失敗、フォールバック実行');
  }

  // 2. Claude Haikuでフォールバック
  if (CLAUDE_API_KEY) {
    console.log('🤖 Claude Haikuでフォールバック返答判定中...');
    const claudeResponse = callClaudeHaiku(prompt, 200);

    if (claudeResponse) {
      const parsed = parseAIResponseAsJSON(claudeResponse);
      if (parsed) {
        console.log(`✅ Claude返答判定（フォールバック）: isReply=${parsed.isReply}, confidence=${parsed.confidence}`);
        return parsed.isReply && parsed.confidence >= 60;
      }
    }
  }

  console.log('⚠️ 返答判定失敗、デフォルトでfalse');
  return false;
}

/**
 * 返答判定用プロンプトを構築
 * @param {string} text - 受信メッセージ
 * @param {string} caseSummary - 送信した案件サマリ
 * @returns {string} プロンプト
 */
function buildReplyJudgmentPrompt(text, caseSummary) {
  return `以下のメッセージが、案件紹介への返答かどうか判定してください。

【送信した案件概要】
${caseSummary ? caseSummary.substring(0, 500) : '(不明)'}

【受信したメッセージ】
${text}

【判定基準】
- 返答である: 「OK」「お願いします」「進めてください」「興味あります」「NGです」「今回は見送り」等の意思表示
- 返答ではない: 新しい案件情報、要員情報、その他の話題

【出力形式】
JSON形式で出力。他の文字は含めないこと。
{
  "isReply": true または false,
  "confidence": 確信度（0-100）,
  "interpretation": "肯定的" または "否定的" または "質問" または "その他"
}`;
}

/**
 * パートナー返答を管理者に転送
 * @param {Object} replyData - 返答データ
 * @param {string} partnerCompany - パートナー企業名
 */
function forwardPartnerReplyToAdmin(replyData, partnerCompany) {
  if (!ADMIN_LINE_USER_ID) return;

  const { sentData, replyText } = replyData;

  let message = `📩 パートナー返答\n`;
  message += `${partnerCompany || '(企業名不明)'} より\n\n`;
  message += `「${replyText}」\n\n`;
  message += `━━━━━━━━━━━━━━━━━━\n`;
  message += `案件: ${sentData.caseName || '(不明)'}\n`;
  message += `要員: ${sentData.staffName || '(不明)'}\n`;

  sendPushMessage(ADMIN_LINE_USER_ID, message);
  console.log('✅ 管理者に返答転送完了');
}

// ====== Notion連携ヘルパー ======

/**
 * 提案ページからマッチングデータを取得
 * @param {string} proposalPageId - 提案ページID
 * @returns {Object|null} マッチングデータ
 */
function getMatchDataFromProposal(proposalPageId) {
  const pageId = proposalPageId.replace(/-/g, '');
  const url = `https://api.notion.com/v1/pages/${pageId}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      console.error('❌ 提案ページ取得エラー:', response.getResponseCode());
      return null;
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    // リレーション先のIDを取得
    const caseRelation = props['案件DB']?.relation?.[0]?.id;
    const staffRelation = props['要員DB']?.relation?.[0]?.id;

    // メモからマッチ度・理由を抽出
    const memo = props['メモ']?.rich_text?.[0]?.plain_text || '';
    const scoreMatch = memo.match(/(\d+)点/);
    const matchScore = scoreMatch ? parseInt(scoreMatch[1]) : null;

    // 案件・要員の詳細を取得
    let caseData = {};
    let staffData = {};
    let partnerUserId = null;

    if (caseRelation) {
      caseData = getCaseDetails(caseRelation);
    }

    if (staffRelation) {
      staffData = getStaffDetails(staffRelation);
      partnerUserId = staffData.partnerUserId;
    }

    return {
      proposalId: proposalPageId,
      caseId: caseRelation,
      staffId: staffRelation,
      caseName: caseData.name || '(案件名不明)',
      caseSummary: caseData.summary || '',
      staffName: staffData.name || '(要員名不明)',
      staffCompany: staffData.company || '',
      partnerUserId: partnerUserId,
      matchScore: matchScore,
      matchReason: memo
    };
  } catch (error) {
    console.error('❌ getMatchDataFromProposal例外:', error);
    return null;
  }
}

/**
 * 案件の詳細を取得
 * @param {string} casePageId - 案件ページID
 * @returns {Object} {name, summary}
 */
function getCaseDetails(casePageId) {
  const url = `https://api.notion.com/v1/pages/${casePageId.replace(/-/g, '')}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      return { name: '', summary: '' };
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    return {
      name: props['入力不要']?.title?.[0]?.plain_text || '',
      summary: props['サマリー']?.rich_text?.[0]?.plain_text || ''
    };
  } catch (error) {
    console.error('⚠️ getCaseDetails error:', error);
    return { name: '', summary: '' };
  }
}

/**
 * 要員の詳細を取得（所属企業のLINE UserIDも含む）
 * @param {string} staffPageId - 要員ページID
 * @returns {Object} {name, company, partnerUserId}
 */
function getStaffDetails(staffPageId) {
  const url = `https://api.notion.com/v1/pages/${staffPageId.replace(/-/g, '')}`;

  const options = {
    method: 'get',
    headers: {
      'Authorization': `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': '2022-06-28'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      return { name: '', company: '', partnerUserId: null };
    }

    const page = JSON.parse(response.getContentText());
    const props = page.properties;

    const name = props['要員名']?.title?.[0]?.plain_text || '';
    const company = props['要員元企業']?.rich_text?.[0]?.plain_text || '';

    // 企業名からLINE UserIDを逆引き
    const partnerUserId = getUserIdByCompanyName(company);

    return {
      name: name,
      company: company,
      partnerUserId: partnerUserId
    };
  } catch (error) {
    console.error('⚠️ getStaffDetails error:', error);
    return { name: '', company: '', partnerUserId: null };
  }
}

/**
 * 企業名からLINE UserIDを逆引き
 * @param {string} companyName - 企業名
 * @returns {string|null} LINE UserID
 */
function getUserIdByCompanyName(companyName) {
  if (!companyName) return null;

  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty('LINE_USER_MAPPING') || '{}';

  try {
    const mapping = JSON.parse(mappingJson);

    // 企業名 → UserID の逆引き
    for (const [userId, name] of Object.entries(mapping)) {
      if (name === companyName) {
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
 * UserIDから企業名を取得
 * @param {string} userId - LINE UserID
 * @returns {string|null} 企業名
 */
function getCompanyNameByUserId(userId) {
  const props = PropertiesService.getScriptProperties();
  const mappingJson = props.getProperty('LINE_USER_MAPPING') || '{}';

  try {
    const mapping = JSON.parse(mappingJson);
    return mapping[userId] || null;
  } catch (e) {
    return null;
  }
}

// ====== テスト関数 ======

/**
 * Postback処理のデバッグテスト
 * 手動で実行して、設定とキャッシュを確認
 */
function debugPostbackProcessing() {
  console.log('=== Postbackデバッグ ===');

  // 1. 設定確認
  console.log('ADMIN_LINE_USER_ID:', ADMIN_LINE_USER_ID || '(未設定)');

  // 2. キャッシュ確認
  const cache = CacheService.getScriptCache();
  const testKey = PENDING_APPROVAL_PREFIX + 'testproposalid123';
  const cachedData = cache.get(testKey);
  console.log('キャッシュキー:', testKey);
  console.log('キャッシュデータ:', cachedData || '(なし)');

  // 3. 擬似Postbackイベントを処理
  const mockEvent = {
    type: 'postback',
    source: { userId: ADMIN_LINE_USER_ID },
    postback: { data: 'action=approve&proposalId=testproposalid123' }
  };

  console.log('擬似イベント:', JSON.stringify(mockEvent));

  if (typeof processPostbackEvent === 'function') {
    const result = processPostbackEvent(mockEvent);
    console.log('処理結果:', JSON.stringify(result));
  } else {
    console.log('❌ processPostbackEvent関数が見つかりません');
  }
}

/**
 * ボタン付き通知のテスト
 */
function testButtonNotification() {
  const testMatchData = {
    caseName: 'テスト案件 PHP/Laravel',
    caseSummary: '【案件概要】PHP/Laravelでの開発案件です。\n【単価】60-70万\n【場所】リモート可\n【期間】3ヶ月以上',
    staffName: 'テスト要員',
    staffCompany: 'テスト株式会社',
    partnerUserId: ADMIN_LINE_USER_ID, // テスト用に管理者に送信
    matchScore: 85,
    matchReason: '【一次判定】OK（85点）\nスキルマッチ、単価範囲内'
  };

  notifyMatchCandidateWithButtons('test-proposal-id-123', testMatchData, true);
  console.log('✅ テスト通知送信完了');
}

/**
 * 返答判定のテスト
 */
function testReplyJudgment() {
  const testCases = [
    { text: 'OKです、進めてください', expected: true },
    { text: '興味あります', expected: true },
    { text: '今回は見送りでお願いします', expected: true },
    { text: '【案件情報】PHP/Laravel開発...', expected: false },
    { text: '新しい要員の紹介です', expected: false }
  ];

  const caseSummary = '【案件概要】PHP/Laravelでの開発案件です。【単価】60-70万';

  for (const tc of testCases) {
    const result = judgeIfReplyWithAI(tc.text, caseSummary);
    console.log(`"${tc.text}" → ${result} (expected: ${tc.expected})`);
  }
}
