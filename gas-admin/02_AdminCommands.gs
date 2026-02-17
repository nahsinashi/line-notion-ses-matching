/**
 * 管理者向けLINEコマンド処理
 *
 * 対応コマンド:
 * - ヘルプ / help : 使い方を表示
 *
 * ※ 承認/却下はPostbackボタンで処理（03_ApprovalFlow.gs）
 */

// ====== コマンド判定 ======

/**
 * 管理者コマンドかどうか判定
 * @param {string} text - メッセージテキスト
 * @param {string} userId - LINE UserID
 * @returns {boolean} 管理者コマンドならtrue
 */
function isAdminCommand(text, userId) {
  // 管理者以外は無視
  if (userId !== ADMIN_LINE_USER_ID) {
    return false;
  }

  const command = text.trim().toLowerCase();

  // ヘルプコマンドのみ対応
  return command === 'ヘルプ' || command === 'help' || command === '?';
}

/**
 * 管理者コマンドを処理
 * @param {string} text - メッセージテキスト
 * @param {string} userId - LINE UserID
 * @returns {Object} 処理結果
 */
function processAdminCommand(text, userId) {
  const command = text.trim().toLowerCase();
  const result = {
    type: 'admin_command',
    command: command,
    status: 'pending'
  };

  try {
    let response = '';

    if (command === 'ヘルプ' || command === 'help' || command === '?') {
      response = getHelpMessage();
    } else {
      // ヘルプ以外は管理者コマンドではない
      result.isNotAdminCommand = true;
      return result;
    }

    // LINE返信
    sendPushMessage(userId, response);
    result.status = 'success';
    result.response = response.substring(0, 100) + '...';

  } catch (error) {
    console.error('Admin command error:', error);
    result.status = 'error';
    result.error = error.message;
    sendPushMessage(userId, '❌ コマンド実行エラー: ' + error.message);
  }

  return result;
}

// ====== ヘルプ ======

/**
 * ヘルプメッセージを取得
 */
function getHelpMessage() {
  return `📋 LINE-Notion連携システム

【自動処理】
・案件/要員情報を送信 → 自動で登録
・ファイル送信 → 要員に紐付けて保存

【マッチング候補】
・通知のボタンで「承認」→ パートナーに案件を送信
・通知のボタンで「却下」→ 送信せず終了

【パートナー返答】
・パートナーからの返答は自動で転送されます`;
}
