/**
 * LINE→GAS直接連携 管理者用スクリプト - 設定
 *
 * 全てのAPIキー・シークレットはスクリプトプロパティから読み込みます。
 * 初回セットアップ時に checkConfig() で設定状況を確認してください。
 *
 * 【スクリプトプロパティの設定方法】
 * GASエディタ → プロジェクトの設定 → スクリプトプロパティ で以下を登録:
 *   - LINE_CHANNEL_ACCESS_TOKEN
 *   - LINE_CHANNEL_SECRET
 *   - CLAUDE_API_KEY
 *   - GEMINI_API_KEY
 *   - OPENAI_API_KEY
 *   - ADMIN_LINE_USER_ID
 */

// ====== 設定値 ======

// LINE設定
const LINE_CHANNEL_ACCESS_TOKEN = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
const LINE_CHANNEL_SECRET = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_SECRET');

// Claude API設定
const CLAUDE_API_KEY = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');

// Gemini API設定
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

// OpenAI API設定
const OPENAI_API_KEY = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');

// 管理者LINE UserID
const ADMIN_LINE_USER_ID = PropertiesService.getScriptProperties().getProperty('ADMIN_LINE_USER_ID');

// ====== 設定確認 ======

/**
 * 設定を確認
 * GASエディタで手動実行して、設定状況を確認してください。
 */
function checkConfig() {
  const props = PropertiesService.getScriptProperties();
  const keys = [
    'LINE_CHANNEL_ACCESS_TOKEN',
    'LINE_CHANNEL_SECRET',
    'CLAUDE_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ADMIN_LINE_USER_ID'
  ];

  console.log('=== 設定状況 ===');
  keys.forEach(key => {
    const val = props.getProperty(key);
    console.log(`- ${key}: ${val ? '✅ 設定済み' : '❌ 未設定'}`);
  });
}
