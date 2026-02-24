/**
 * LINE Webhook受信用 doPost
 *
 * n8nを経由せずにLINE → GAS直接連携
 *
 * 処理フロー:
 * 1. LINE Webhook受信
 * 2. 再送チェック（messageId重複防止）
 * 3. メッセージタイプ判定（テキスト/ファイル）
 * 4. テキスト: Claude判定 → 既存GAS呼び出し
 * 5. ファイル: 既存GAS呼び出し（要員ファイル追加）
 */

// ====== 定数 ======

// 既存GAS WebApp URL
const EXISTING_GAS_URL = 'https://script.google.com/macros/s/AKfycbwpPz5RhV2kXs7e4mp8DG2-BbrJOsQQu_gVybXYUudTAikkW-YgN-kSfk8gxcGrlBhn/exec';

// 処理済みメッセージのキャッシュキープレフィックス
const PROCESSED_MESSAGE_PREFIX = 'processed_';
// キャッシュ有効期間（秒）- 5分
const CACHE_EXPIRATION = 300;

// メッセージ結合用の待機時間（秒）- 3秒
const MESSAGE_BUFFER_TIME = 3;
// メッセージバッファのキャッシュキープレフィックス
const MESSAGE_BUFFER_PREFIX = 'buffer_';

// ====== Webhook受信 ======

/**
 * メッセージが処理済みかチェック
 */
function isMessageProcessed(messageId) {
  const cache = CacheService.getScriptCache();
  const key = PROCESSED_MESSAGE_PREFIX + messageId;
  return cache.get(key) !== null;
}

/**
 * メッセージを処理済みとしてマーク
 */
function markMessageAsProcessed(messageId) {
  const cache = CacheService.getScriptCache();
  const key = PROCESSED_MESSAGE_PREFIX + messageId;
  cache.put(key, 'processed', CACHE_EXPIRATION);
}

/**
 * メッセージバッファを取得
 */
function getMessageBuffer(userId) {
  const cache = CacheService.getScriptCache();
  const key = MESSAGE_BUFFER_PREFIX + userId;
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
 * メッセージバッファを保存
 */
function saveMessageBuffer(userId, messages, timestamp) {
  const cache = CacheService.getScriptCache();
  const key = MESSAGE_BUFFER_PREFIX + userId;
  const data = {
    messages: messages,
    timestamp: timestamp,
    userId: userId
  };
  // 30秒間保持（処理完了後にクリアされる）
  cache.put(key, JSON.stringify(data), 30);
}

/**
 * メッセージバッファをクリア
 */
function clearMessageBuffer(userId) {
  const cache = CacheService.getScriptCache();
  const key = MESSAGE_BUFFER_PREFIX + userId;
  cache.remove(key);
}

/**
 * LINE Webhookのエントリポイント
 *
 * 複数メッセージ対応:
 * - 同一ユーザーから短時間(3秒以内)に複数メッセージが来た場合は結合
 * - LINEの分割送信に対応
 */
function doPost(e) {
  const startTime = new Date().getTime();

  try {
    const events = JSON.parse(e.postData.contents).events;

    if (!events || events.length === 0) {
      return createResponse({ status: 'no events' });
    }

    const results = [];

    // ユーザーごとにテキストメッセージをグループ化
    const textMessagesByUser = {};
    const otherEvents = [];

    for (const event of events) {
      // 再送対策：メッセージIDで重複チェック
      if (event.type === 'message' && event.message.id) {
        const messageId = event.message.id;

        if (isMessageProcessed(messageId)) {
          console.log(`⏭️ 再送スキップ: messageId=${messageId}`);
          results.push({
            type: event.type,
            messageId: messageId,
            skipped: true,
            reason: 'Duplicate message (already processed)'
          });
          continue;
        }

        markMessageAsProcessed(messageId);
      }

      // テキストメッセージはユーザーごとにグループ化
      if (event.type === 'message' && event.message.type === 'text') {
        const userId = event.source.userId;
        if (!textMessagesByUser[userId]) {
          textMessagesByUser[userId] = [];
        }
        textMessagesByUser[userId].push(event);
      } else {
        otherEvents.push(event);
      }
    }

    // 各ユーザーのテキストメッセージを処理（結合対応）
    for (const userId in textMessagesByUser) {
      const userEvents = textMessagesByUser[userId];
      const result = processTextMessagesWithBuffer(userEvents, userId, startTime);
      if (result) {
        results.push(result);
      }
    }

    // テキスト以外のイベントを処理
    for (const event of otherEvents) {
      const result = processEvent(event, startTime);
      results.push(result);
    }

    const totalTime = new Date().getTime() - startTime;
    console.log(`Total processing time: ${totalTime}ms`);

    return createResponse({
      status: 'ok',
      processingTime: totalTime,
      results: results
    });

  } catch (error) {
    console.error('doPost error:', error);
    return createResponse({
      status: 'error',
      message: error.message
    });
  }
}

/**
 * テキストメッセージをバッファリングして処理
 * 同一ユーザーからの連続メッセージを結合
 */
function processTextMessagesWithBuffer(events, userId, startTime) {
  // 現在のメッセージを取得
  const currentMessages = events.map(e => e.message.text);
  const currentTimestamp = events[0].timestamp;

  // バッファを確認
  const buffer = getMessageBuffer(userId);

  if (buffer) {
    // 前のメッセージがある場合、時間差を確認
    const timeDiff = (currentTimestamp - buffer.timestamp) / 1000; // 秒に変換

    if (timeDiff <= MESSAGE_BUFFER_TIME) {
      // 3秒以内なら結合
      console.log(`📎 メッセージ結合: userId=${userId}, 前=${buffer.messages.length}件, 今=${currentMessages.length}件`);
      const combinedMessages = [...buffer.messages, ...currentMessages];
      saveMessageBuffer(userId, combinedMessages, currentTimestamp);

      // まだ後続メッセージが来る可能性があるため、遅延処理
      Utilities.sleep(MESSAGE_BUFFER_TIME * 1000);

      // バッファを再確認
      const finalBuffer = getMessageBuffer(userId);
      if (finalBuffer && finalBuffer.timestamp === currentTimestamp) {
        // 同じタイムスタンプなら処理実行
        clearMessageBuffer(userId);
        const combinedText = finalBuffer.messages.join('\n\n');

        const result = {
          type: 'message',
          timestamp: currentTimestamp,
          messageType: 'text',
          userId: userId,
          combinedCount: finalBuffer.messages.length,
          times: {}
        };

        processTextMessage(combinedText, userId, result);
        result.times.total = new Date().getTime() - startTime;
        return result;
      } else {
        // 別のリクエストが処理したのでスキップ
        return null;
      }
    }
  }

  // 新しいバッファを作成
  saveMessageBuffer(userId, currentMessages, currentTimestamp);

  // 後続メッセージを待つ
  Utilities.sleep(MESSAGE_BUFFER_TIME * 1000);

  // バッファを再確認
  const finalBuffer = getMessageBuffer(userId);
  if (finalBuffer && finalBuffer.timestamp === currentTimestamp) {
    // 同じタイムスタンプなら処理実行
    clearMessageBuffer(userId);
    const combinedText = finalBuffer.messages.join('\n\n');

    const result = {
      type: 'message',
      timestamp: currentTimestamp,
      messageType: 'text',
      userId: userId,
      combinedCount: finalBuffer.messages.length,
      times: {}
    };

    processTextMessage(combinedText, userId, result);
    result.times.total = new Date().getTime() - startTime;
    return result;
  }

  // 別のリクエストが処理したのでスキップ
  return null;
}

/**
 * 個別イベントを処理
 */
function processEvent(event, startTime) {
  const result = {
    type: event.type,
    timestamp: event.timestamp,
    times: {}
  };

  // Postbackイベント（ボタン押下）の処理
  if (event.type === 'postback') {
    console.log('📨 Postbackイベント受信:', JSON.stringify(event.postback));

    // processPostbackEvent関数が存在するか確認
    if (typeof processPostbackEvent === 'function') {
      result.postback = processPostbackEvent(event);
    } else {
      console.error('❌ processPostbackEvent関数が見つかりません');
      // フォールバック：管理者に通知
      if (ADMIN_LINE_USER_ID) {
        sendPushMessage(ADMIN_LINE_USER_ID, '❌ 承認処理エラー: processPostbackEvent関数が見つかりません。03_ApprovalFlow.gsを追加してください。');
      }
      result.error = 'processPostbackEvent not found';
    }
    result.times.total = new Date().getTime() - startTime;
    return result;
  }

  if (event.type !== 'message') {
    result.skipped = true;
    result.reason = 'Not a message event';
    return result;
  }

  const message = event.message;
  const userId = event.source.userId;

  result.messageType = message.type;
  result.userId = userId;

  // リプライの引用元メッセージIDを取得（あれば）
  if (message.quotedMessageId) {
    result.quotedMessageId = message.quotedMessageId;
  }

  // テキストメッセージの場合
  if (message.type === 'text') {
    processTextMessage(message.text, userId, result);
  }
  // ファイルの場合
  else if (message.type === 'file' || message.type === 'image') {
    processFileMessage(message, userId, result);
  }
  else {
    result.skipped = true;
    result.reason = `Unsupported message type: ${message.type}`;
  }

  result.times.total = new Date().getTime() - startTime;
  return result;
}

// ====== テキストメッセージ処理 ======

/**
 * テキストメッセージを処理
 */
function processTextMessage(text, userId, result) {
  // Step 0: 管理者コマンドをチェック（優先処理）
  // AI判定による自然言語コマンドにも対応
  if (isAdminCommand(text, userId)) {
    console.log('🔧 管理者コマンド候補検出:', text);
    const cmdResult = processAdminCommand(text, userId);

    // AI判定で管理者コマンドではないと判断された場合
    // → 通常のメッセージとして案件/要員判定に進む
    if (cmdResult.isNotAdminCommand) {
      console.log('📋 管理者コマンドではない → 通常判定へ');
    } else {
      // 管理者コマンドとして処理完了
      result.adminCommand = cmdResult;
      result.isAdminCommand = true;
      return;
    }
  }

  // Step 0.5: パートナーからの返答かチェック
  // quotedMessageIdがあればリプライとして処理
  const quotedMessageId = result.quotedMessageId || null;
  const replyData = checkPartnerReply(text, userId, quotedMessageId);

  if (replyData) {
    // パートナーからの返答（LINE通知転送は廃止、ログのみ記録）
    const companyName = getCompanyNameByUserId(userId);
    console.log(`📩 パートナー返答検出: ${companyName || userId}, 案件: ${replyData.sentData?.caseName || '(不明)'}`);
    result.isPartnerReply = true;
    result.replyData = {
      type: replyData.type,
      caseName: replyData.sentData?.caseName
    };
    return;
  }

  // Step 1: AI判定（Gemini Flash優先、Claude Haikuフォールバック）
  const aiStart = new Date().getTime();
  const judgmentResults = callAIJudgment(text);
  result.times.ai = new Date().getTime() - aiStart;

  if (!judgmentResults || judgmentResults.length === 0) {
    console.log('❌ AI判定失敗またはresultsが空');
    result.error = 'AI judgment failed';
    return;
  }

  console.log(`📋 判定結果: ${judgmentResults.length}件`);
  result.judgmentCount = judgmentResults.length;
  result.registrations = [];

  // Step 2: 各結果を処理
  for (const item of judgmentResults) {
    const regResult = processJudgmentItem(item, userId);
    result.registrations.push(regResult);
  }

  // ※処理完了通知は廃止（LINE通知数を節約、ログのみ記録）
  // 登録結果はGASのログで確認可能
}

/**
 * LINE受信メッセージの判定（Gemini Flash優先）
 * ※原文は完全に保持する
 * ※フォールバック: Gemini失敗時はClaude Haikuを使用
 */
function callAIJudgment(text) {
  const prompt = buildJudgmentPrompt(text);

  // 1. Gemini 2.0 Flashで判定（メイン）
  if (GEMINI_API_KEY) {
    console.log('🤖 Gemini 2.0 Flashで判定中...');
    const geminiResponse = callGeminiFlash(prompt, 2000);

    if (geminiResponse) {
      const parsed = parseAIResponseAsJSON(geminiResponse);
      if (parsed && parsed.results) {
        console.log('✅ Gemini判定成功');
        return parsed.results;
      }
    }
    console.log('⚠️ Gemini判定失敗、フォールバック実行');
  }

  // 2. Claude Haikuでフォールバック
  if (CLAUDE_API_KEY) {
    console.log('🤖 Claude Haikuでフォールバック判定中...');
    const claudeResponse = callClaudeHaiku(prompt, 2000);

    if (claudeResponse) {
      const parsed = parseAIResponseAsJSON(claudeResponse);
      if (parsed && parsed.results) {
        console.log('✅ Claude判定成功（フォールバック）');
        return parsed.results;
      }
    }
  }

  console.error('❌ 全てのAI判定が失敗');
  return null;
}

/**
 * 判定用プロンプトを構築
 * @param {string} text - 判定対象テキスト
 * @returns {string} プロンプト
 */
function buildJudgmentPrompt(text) {
  return `以下のメッセージを分析し、「案件情報」「要員情報」「それ以外」を判定してください。

【メッセージ】
${text}

【出力形式】JSONのみ出力すること
{
  "results": [
    {
      "type": "案件" または "要員" または "除外",
      "企業名": "不明な場合は空文字",
      "担当者": "不明な場合は空文字",
      "initial": "要員の場合はイニシャル2文字、それ以外は空文字",
      "原文": "メッセージ全文をそのまま完全にコピー（省略禁止）"
    }
  ]
}

════════════════════════════════════════
【案件情報の定義】以下の項目が**3つ以上**記載されている場合のみ「案件」
════════════════════════════════════════
案件情報には通常、以下のような項目が含まれる：
□ 案件名・作業内容（「案件名：〜」「内容：〜」「業務：〜」など）
□ 勤務場所（「場所：〜」「勤務形態：〜」「〜駅」「オンサイト」「リモート」など）
□ 期間・人数（「期間：〜」「〜月〜」「即日〜」「長期」「〜名」など）
□ 必須スキル・環境（「必須スキル：」「環境：」「言語：」+ 具体的な技術名）
□ 単価（「単価：〜万」「金額：〜」「スキル見合い」など）
□ 面談（「面談：〜回」「Web面談」など）
□ 制限・備考（「外国籍〜」「年齢〜」「〜まで」「派遣免許」など）

※上記のような「項目：値」形式の記載が3つ以上ない場合は「除外」

════════════════════════════════════════
【要員情報の定義】必須項目2つ以上 かつ 任意項目2つ以上で「要員」
════════════════════════════════════════
■必須項目（以下から**2つ以上**必要）:
□ スキル・技術の具体的記載（「Java」「Python」「React」「PM経験」等の具体的な技術名・役割）
□ 経歴・実績の具体的記載（「〜年経験」「〜開発に従事」「〜プロジェクト」等）
□ 稼働時期の記載（「即日」「〜月〜」「〜から稼働可」等）

■任意項目（以下から**2つ以上**必要）:
□ 氏名・イニシャル（「〜様」「〜氏」「■ A.B」など）
□ 年齢・性別（「〜歳」「男性」「女性」など）
□ 最寄駅・居住地（「最寄駅：〜」「〜駅」「東京都〜」など）
□ 所属（「所属：〜」「自社プロパー」「弊社正社員」「フリーランス」など）
□ 単価（「単価：〜万」「〜万円」など）
□ 人物像（「人物：〜」「コミュニケーション〜」など）

【判定例】
✅ 登録: 「A.B 35歳 渋谷 Java5年 React経験あり 60万 即日〜」
  → 必須: スキル(Java,React)+経歴(5年)+稼働(即日) = 3つ ✓
  → 任意: 名前+年齢+駅+単価 = 4つ ✓

❌ 除外: 「弊社社員F.Kの履歴書を送ります。希望単価45万です」
  → 必須: 0つ（スキル・経歴・稼働時期の記載なし）✗
  → 任意: 名前+所属+単価 = 3つ ✓ だが必須が不足

❌ 除外: 「スキルシートは後ほど送ります」
  → 必須: 0つ ✗
  → 任意: 0つ ✗

※必須項目が2つ未満、または任意項目が2つ未満の場合は「除外」
※「送ります」「ご紹介します」等の予告文のみで具体的情報がない場合は「除外」

════════════════════════════════════════
【除外】上記の定義を満たさないものは全て「除外」
════════════════════════════════════════
以下は「除外」の典型例（案件でも要員でもない）：
- 挨拶・お礼のみ（「ありがとうございます」「お疲れ様です」）
- 返答・確認のみ（「承知しました」「〜でしょうか？」「了解です」）
- 進捗報告のみ（「折衝中です」「確認します」「進めています」）
- 既存情報への言及のみ（「項番〜」「弊社案件の〜」「IN土台〜」）
- 質問・相談のみ（「〜可能ですか？」「〜どうでしょうか？」）

※構造化された「項目：値」形式の情報がなく、会話・やり取りの文章は全て「除外」

════════════════════════════════════════
【案件の追加除外条件】定義を満たしても以下は「除外」
════════════════════════════════════════
1. インフラ構築メイン（AWS/GCP/Azure基盤構築・設計が主業務で、アプリ開発言語の記載がない）
2. DevOps/SRE/プラットフォーム系（CI/CD構築、Terraform、Ansible、Kubernetes運用が主業務）
3. データ基盤・ETL系（Snowflake、Airflow、データパイプライン構築が主業務）
   ※ただしPython/Java等でのアプリ開発が主業務に含まれる場合は対象
4. ヘルプデスク、運用監視、保守のみの案件
5. 地方勤務のみ（東京・神奈川・千葉・埼玉以外が勤務地）

════════════════════════════════════════
【要員の追加除外条件】定義を満たしても以下は「除外」
════════════════════════════════════════
1. 外国籍の要員（「外国籍」「中国籍」「ベトナム籍」「韓国籍」等の記載がある場合）
2. インフラ系スキルのみの要員（AWS/GCP/Azure構築・設計が主スキルで、アプリ開発言語の経験がない）
3. 地方在住の要員（東京・神奈川・千葉・埼玉以外が最寄駅・居住地）
4. 経験年数2年半未満の要員（「経験2年」「経験1年」「未経験」等）
5. 希望単価90万円超の要員（「単価：95万」「100万希望」等）
6. ヘルプデスク、運用監視、保守のみのスキルの要員
7. データ基盤・ETL系スキルのみの要員（Snowflake、Airflow等が主スキル）
8. DevOps/SRE/プラットフォーム系スキルのみの要員（CI/CD、Terraform、Kubernetes等が主スキル）
9. フリーランスの要員（「フリーランス」「個人事業主」「フリー」「FL」等、所属が企業ではなく個人である記載がある場合）

════════════════════════════════════════
【イニシャル抽出】要員の場合のみ
════════════════════════════════════════
- 名前からアルファベット大文字2文字に変換（山田太郎→YT、R.S→RS、IA→IA）
- 不明な場合はXX

【複数の案件/要員がある場合】
- results配列に複数入れる
- 各オブジェクトの「原文」にはメッセージ全文を入れる`;
}

// parseAIResponse は 04_AI_Clients.gs の parseAIResponseAsJSON に統合済み

/**
 * 判定結果1件を処理（既存GAS呼び出し）
 */
function processJudgmentItem(item, userId) {
  const regResult = {
    type: item.type,
    initial: item.initial || '',
    status: 'pending'
  };

  try {
    if (item.type === '案件') {
      // 案件登録
      const response = callExistingGas({
        '登録タイプ': '案件を登録',
        '担当者': '髙梨',
        '原文': item.原文 || item.text || '',
        'userId': userId
      });
      regResult.status = 'success';
      regResult.response = response;
      console.log(`✅ 案件登録完了`);

    } else if (item.type === '要員') {
      // 要員一時保存
      const response = callExistingGas({
        '登録タイプ': '要員を一時保存',
        '担当者': '髙梨',
        '原文': item.原文 || item.text || '',
        'userId': userId,
        'initial': item.initial || 'XX'
      });
      regResult.status = 'success';
      regResult.response = response;
      console.log(`✅ 要員一時保存完了 (initial: ${item.initial})`);

    } else {
      // 除外
      regResult.status = 'skipped';
      regResult.reason = '除外対象';
      console.log(`⏭️ 除外: ${item.reason || '対象外'}`);
    }

  } catch (error) {
    regResult.status = 'error';
    regResult.error = error.message;
    console.error(`❌ 登録エラー:`, error);
  }

  return regResult;
}

/**
 * 既存GAS WebAppを呼び出し
 */
function callExistingGas(params) {
  try {
    const response = UrlFetchApp.fetch(EXISTING_GAS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(params),
      muteHttpExceptions: true,
      followRedirects: true
    });

    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();

    console.log(`GAS Response: ${responseCode}`);

    if (responseCode === 200 || responseCode === 302) {
      try {
        return JSON.parse(responseText);
      } catch {
        return { raw: responseText };
      }
    } else {
      throw new Error(`GAS error: ${responseCode} - ${responseText}`);
    }

  } catch (error) {
    console.error('callExistingGas error:', error);
    throw error;
  }
}

// ====== ファイルメッセージ処理 ======

/**
 * ファイルメッセージを処理
 */
function processFileMessage(message, userId, result) {
  const fileInfo = {
    messageId: message.id,
    type: message.type,
    fileName: message.fileName || `${message.type}_${message.id}`,
    fileSize: message.fileSize || 0
  };

  // 画像の場合
  if (message.type === 'image') {
    fileInfo.fileName = `image_${message.id}.jpg`;
  }

  result.fileInfo = fileInfo;

  try {
    // 既存GASに要員ファイル追加
    console.log(`📤 既存GAS呼び出し開始: ${fileInfo.fileName}`);
    const response = callExistingGas({
      '登録タイプ': '要員ファイルを追加',
      '担当者': '髙梨',
      'userId': userId,
      'files': [fileInfo]
    });

    result.status = 'success';
    result.response = response;
    console.log(`✅ ファイル追加完了: ${fileInfo.fileName}`);
    console.log(`📥 既存GAS応答:`, JSON.stringify(response));

    // ※ファイル受信通知は廃止（LINE通知数を節約、ログのみ記録）

  } catch (error) {
    result.status = 'error';
    result.error = error.message;
    console.error(`❌ ファイル追加エラー:`, error);

    // ※ファイル処理エラー通知も廃止（ログのみ記録）
  }
}

// ====== 通知 ======

/**
 * 処理結果を管理者に通知
 * ※除外メッセージは通知しない（案件・要員の登録成功時のみ通知）
 */
function sendProcessNotification(result, judgmentResults) {
  if (!ADMIN_LINE_USER_ID) return;

  // 登録成功した案件・要員のみをフィルタリング
  const successItems = [];
  for (let i = 0; i < judgmentResults.length; i++) {
    const item = judgmentResults[i];
    const reg = result.registrations[i];
    if (reg.status === 'success' && (item.type === '案件' || item.type === '要員')) {
      successItems.push({ item, reg });
    }
  }

  // 成功したものがなければ通知しない
  if (successItems.length === 0) {
    console.log('⏭️ 登録成功がないため管理者通知をスキップ');
    return;
  }

  let message = `📥 LINE受信処理完了\n\n`;
  message += `👤 UserID: ${result.userId}\n`;
  message += `⏱️ 処理時間: ${result.times.ai}ms\n`;
  message += `📋 登録数: ${successItems.length}件\n\n`;

  for (const { item, reg } of successItems) {
    message += `✅ ${item.type}`;
    if (item.initial) message += ` (${item.initial})`;
    message += `\n`;
  }

  sendPushMessage(ADMIN_LINE_USER_ID, message);
}

// ====== ヘルパー関数 ======

/**
 * LINEプロフィール取得
 */
function getLineProfile(userId) {
  try {
    const url = `https://api.line.me/v2/bot/profile/${userId}`;
    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      muteHttpExceptions: true
    });

    if (response.getResponseCode() === 200) {
      return JSON.parse(response.getContentText());
    }
  } catch (error) {
    console.error('Profile fetch error:', error);
  }
  return null;
}

/**
 * Push Message送信
 */
function sendPushMessage(userId, message) {
  const url = 'https://api.line.me/v2/bot/message/push';

  const payload = {
    to: userId,
    messages: [
      { type: 'text', text: message }
    ]
  };

  try {
    UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (error) {
    console.error('Push message error:', error);
  }
}

/**
 * HTTPレスポンスを作成
 */
function createResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====== デバッグ用 ======

/**
 * doGet - Webアプリの動作確認用
 */
function doGet(e) {
  return createResponse({
    status: 'ok',
    message: 'LINE→GAS直接連携（本番）',
    timestamp: new Date().toISOString()
  });
}
