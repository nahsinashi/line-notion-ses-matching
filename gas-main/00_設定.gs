/**
 * 00_設定.gs - 共通設定・定数定義
 *
 * 【概要】
 * プロジェクト全体で使用するAPIキー・データベースIDを定義
 *
 * 【設定項目】
 * - Notion API Key（Integration Token）
 * - Google フォーム ID
 * - 各Notion DB ID（案件/要員/提案）
 * - Claude / Gemini API Key
 * - プロンプト管理スプレッドシート ID
 *
 * ※ 各値は自分の環境に合わせて書き換えてください
 */

// Notion API Key（Notion Integration Token）
const NOTION_API_KEY = "YOUR_NOTION_API_KEY";

// Google フォーム ID（登録フォームのURL末尾のID）
const FORM_ID = "YOUR_GOOGLE_FORM_ID";

// データベースID（ハイフン付き）
const CASE_DB_ID = "YOUR_CASE_DB_ID";         // 案件DB
const STAFF_DB_ID = "YOUR_STAFF_DB_ID";       // 要員DB
const PROPOSAL_DB_ID = "YOUR_PROPOSAL_DB_ID"; // 提案DB

// === Claude API ===
const CLAUDE_API_KEY = "YOUR_CLAUDE_API_KEY";

// === Gemini API ===
const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";

// === プロンプト管理スプレッドシート ===
const PROMPT_SHEET_ID = "YOUR_PROMPT_SHEET_ID";
