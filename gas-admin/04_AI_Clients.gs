/**
 * 04_AI_Clients.gs
 *
 * 各AI APIのクライアント関数を集約
 *
 * 【使用モデル】（2026年2月更新：コスト削減のためGeminiに移行）
 * - Gemini 2.5 Flash: 整形処理、マッチング（PDF無し）、LINE受信判定（高速・低コスト）
 * - Gemini 2.5 Pro: マッチング（PDF有り）（高品質PDF解析）
 * - GPT-4o-mini: コマンド解析、返答判定（低コスト）
 * - Claude Haiku: フォールバック用
 *
 * 【コスト比較】
 * - Claude Sonnet: $3/M入力 + $15/M出力
 * - Gemini 2.5 Flash: $0.15/M入力 + $0.60/M出力 → 約20倍コスト削減
 * - Gemini 2.5 Pro: $1.25/M入力 + $10.00/M出力 → 約1.5倍コスト削減
 */

// ====== Gemini API ======

/**
 * Gemini 2.5 Flashを呼び出す（テキストのみ）
 * @param {string} prompt - プロンプト
 * @param {number} maxTokens - 最大トークン数（デフォルト: 2000）
 * @returns {string|null} レスポンステキスト
 */
function callGeminiFlash(prompt, maxTokens = 2000) {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not configured');
    return null;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

    const payload = {
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.1  // 安定した出力のため低めに設定
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
      console.error('Gemini API error:', responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    // レスポンス構造: { candidates: [{ content: { parts: [{ text: "..." }] } }] }
    if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
      return result.candidates[0].content.parts[0].text;
    }

    console.error('Gemini API: Unexpected response structure', JSON.stringify(result));
    return null;

  } catch (error) {
    console.error('Gemini API exception:', error);
    return null;
  }
}

/**
 * Gemini 2.5 Proを呼び出す（PDF対応・高品質）
 * @param {string} prompt - プロンプト
 * @param {object|null} pdfDoc - PDF添付（base64形式）
 * @param {number} maxTokens - 最大トークン数（デフォルト: 4000）
 * @returns {string|null} レスポンステキスト
 */
function callGeminiPro(prompt, pdfDoc = null, maxTokens = 4000) {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not configured');
    return null;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=' + GEMINI_API_KEY;

    // コンテンツ構築
    const parts = [];

    // PDFがあれば添付
    if (pdfDoc && pdfDoc.source && pdfDoc.source.data) {
      parts.push({
        inline_data: {
          mime_type: 'application/pdf',
          data: pdfDoc.source.data
        }
      });
    }

    // テキストプロンプト
    parts.push({ text: prompt });

    const payload = {
      contents: [{ parts: parts }],
      generationConfig: {
        maxOutputTokens: maxTokens,
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
      console.error('Gemini Pro API error:', responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
      return result.candidates[0].content.parts[0].text;
    }

    console.error('Gemini 2.5 Pro API: Unexpected response structure', JSON.stringify(result));
    return null;

  } catch (error) {
    console.error('Gemini 2.5 Pro API exception:', error);
    return null;
  }
}

/**
 * Gemini 2.5 Flashを呼び出す（PDF対応版）
 * @param {string} prompt - プロンプト
 * @param {object|null} pdfDoc - PDF添付（base64形式）
 * @param {number} maxTokens - 最大トークン数（デフォルト: 2000）
 * @returns {string|null} レスポンステキスト
 */
function callGeminiFlashWithPdf(prompt, pdfDoc = null, maxTokens = 2000) {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY not configured');
    return null;
  }

  try {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + GEMINI_API_KEY;

    // コンテンツ構築
    const parts = [];

    // PDFがあれば添付
    if (pdfDoc && pdfDoc.source && pdfDoc.source.data) {
      parts.push({
        inline_data: {
          mime_type: 'application/pdf',
          data: pdfDoc.source.data
        }
      });
    }

    // テキストプロンプト
    parts.push({ text: prompt });

    const payload = {
      contents: [{ parts: parts }],
      generationConfig: {
        maxOutputTokens: maxTokens,
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
      console.error('Gemini Flash API error:', responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    if (result.candidates && result.candidates[0]?.content?.parts?.[0]?.text) {
      return result.candidates[0].content.parts[0].text;
    }

    console.error('Gemini Flash API: Unexpected response structure', JSON.stringify(result));
    return null;

  } catch (error) {
    console.error('Gemini Flash API exception:', error);
    return null;
  }
}

// ====== OpenAI API ======

/**
 * GPT-4o-miniを呼び出す
 * @param {string} prompt - プロンプト
 * @param {number} maxTokens - 最大トークン数（デフォルト: 500）
 * @returns {string|null} レスポンステキスト
 */
function callGPT4oMini(prompt, maxTokens = 500) {
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not configured');
    return null;
  }

  try {
    const url = 'https://api.openai.com/v1/chat/completions';

    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'user', content: prompt }
      ],
      max_tokens: maxTokens,
      temperature: 0.1  // 安定した出力のため低めに設定
    };

    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + OPENAI_API_KEY
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      console.error('OpenAI API error:', responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    // レスポンス構造: { choices: [{ message: { content: "..." } }] }
    if (result.choices && result.choices[0]?.message?.content) {
      return result.choices[0].message.content;
    }

    console.error('OpenAI API: Unexpected response structure', JSON.stringify(result));
    return null;

  } catch (error) {
    console.error('OpenAI API exception:', error);
    return null;
  }
}

// ====== Claude API（フォールバック用）======

/**
 * Claude Haikuを呼び出す（フォールバック用）
 * @param {string} prompt - プロンプト
 * @param {number} maxTokens - 最大トークン数（デフォルト: 500）
 * @returns {string|null} レスポンステキスト
 */
function callClaudeHaiku(prompt, maxTokens = 500) {
  if (!CLAUDE_API_KEY) {
    console.error('CLAUDE_API_KEY not configured');
    return null;
  }

  try {
    const url = 'https://api.anthropic.com/v1/messages';

    const payload = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [
        { role: 'user', content: prompt }
      ]
    };

    const response = UrlFetchApp.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const responseCode = response.getResponseCode();

    if (responseCode !== 200) {
      console.error('Claude API error:', responseCode, response.getContentText());
      return null;
    }

    const result = JSON.parse(response.getContentText());

    if (result.content && result.content[0]?.text) {
      return result.content[0].text;
    }

    return null;

  } catch (error) {
    console.error('Claude API exception:', error);
    return null;
  }
}

// ====== ユーティリティ関数 ======

/**
 * AIレスポンスからJSONを抽出してパース
 * @param {string} responseText - AIのレスポンステキスト
 * @returns {Object|null} パースされたJSONオブジェクト
 */
function parseAIResponseAsJSON(responseText) {
  if (!responseText) return null;

  try {
    let jsonStr = responseText.trim();

    // コードブロックがあれば除去
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    return JSON.parse(jsonStr);

  } catch (error) {
    console.error('JSON parse error:', error);
    console.error('Response text:', responseText);
    return null;
  }
}

// ====== テスト関数 ======

/**
 * Gemini APIのテスト
 */
function testGeminiAPI() {
  const prompt = '「こんにちは」と返答してください。JSON形式で: {"message": "こんにちは"}';
  console.log('=== Gemini API Test ===');
  console.log('Prompt:', prompt);

  const response = callGeminiFlash(prompt);
  console.log('Response:', response);

  const parsed = parseAIResponseAsJSON(response);
  console.log('Parsed:', JSON.stringify(parsed));
}

/**
 * OpenAI APIのテスト
 */
function testOpenAIAPI() {
  const prompt = '「こんにちは」と返答してください。JSON形式で: {"message": "こんにちは"}';
  console.log('=== OpenAI API Test ===');
  console.log('Prompt:', prompt);

  const response = callGPT4oMini(prompt);
  console.log('Response:', response);

  const parsed = parseAIResponseAsJSON(response);
  console.log('Parsed:', JSON.stringify(parsed));
}

/**
 * 全APIの接続テスト
 */
function testAllAPIs() {
  console.log('=== API Connection Test ===\n');

  // Gemini Flash
  console.log('1. Gemini 2.5 Flash:');
  if (GEMINI_API_KEY) {
    const geminiResult = callGeminiFlash('Say "OK" in JSON: {"status": "OK"}');
    console.log('  Result:', geminiResult ? 'SUCCESS' : 'FAILED');
  } else {
    console.log('  Result: SKIPPED (API key not set)');
  }

  // Gemini 2.5 Pro
  console.log('\n2. Gemini 2.5 Pro:');
  if (GEMINI_API_KEY) {
    const geminiProResult = callGeminiPro('Say "OK" in JSON: {"status": "OK"}');
    console.log('  Result:', geminiProResult ? 'SUCCESS' : 'FAILED');
  } else {
    console.log('  Result: SKIPPED (API key not set)');
  }

  // OpenAI
  console.log('\n3. GPT-4o-mini:');
  if (OPENAI_API_KEY) {
    const openaiResult = callGPT4oMini('Say "OK" in JSON: {"status": "OK"}');
    console.log('  Result:', openaiResult ? 'SUCCESS' : 'FAILED');
  } else {
    console.log('  Result: SKIPPED (API key not set)');
  }

  // Claude (fallback)
  console.log('\n4. Claude Haiku (fallback):');
  if (CLAUDE_API_KEY) {
    const claudeResult = callClaudeHaiku('Say "OK" in JSON: {"status": "OK"}');
    console.log('  Result:', claudeResult ? 'SUCCESS' : 'FAILED');
  } else {
    console.log('  Result: SKIPPED (API key not set)');
  }

  console.log('\n=== Test Complete ===');
}

/**
 * Gemini 2.5 Pro APIのテスト
 */
function testGeminiProAPI() {
  const prompt = '「こんにちは」と返答してください。JSON形式で: {"message": "こんにちは"}';
  console.log('=== Gemini 2.5 Pro API Test ===');
  console.log('Prompt:', prompt);

  const response = callGeminiPro(prompt);
  console.log('Response:', response);

  const parsed = parseAIResponseAsJSON(response);
  console.log('Parsed:', JSON.stringify(parsed));
}
