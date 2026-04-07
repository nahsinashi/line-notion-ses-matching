# LINE x Notion SES マッチングシステム

SES（システムエンジニアリングサービス）営業業務を効率化するための、LINE と Notion を連携したマッチングシステムです。

## システム概要

パートナー企業がLINEで送信した案件・要員情報を **Notion Inbox** に一次受けし、**Claude Code** が定期的に分類・整形・マッチングを行います。AI処理をClaude Codeサブスクリプションに集約し、従量課金APIを使用しない設計です。

### 主な機能

1. **LINE → Inbox 自動登録** — GAS Webhookで受信し、原文をInbox DBに蓄積
2. **AI分類・整形** — Claude Codeが案件/要員を自動判別し、Cases/Staff DBに整形登録
3. **AIマッチング** — 新規登録時に反対側DBと照合、スコア70+で候補自動生成
4. **打診・提案フロー** — Notionステータス変更をトリガーに、LINEで自動送信
5. **棚卸し** — 2週間経過の案件/要員を自動クローズ
6. **定期配信** — 案件・要員のスコアリング配信（`/broadcast`）

## アーキテクチャ

```
┌─────────────┐     ┌─────────────┐
│  LINE受信    │     │  メール受信   │（Phase 4: 未実装）
│（パートナー） │     │（転送メール） │
└──────┬──────┘     └──────┬──────┘
       │                    │
       ▼                    ▼
┌──────────────────────────────────┐
│  gas-inbox（GAS）                 │
│  LINE Webhook受信 → Inbox DB登録  │
│  LINE Push Message送信            │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Inbox DB（Notion）               │
│  原文 + 入力経路 + userId          │
│  ステータス: 未処理 / 処理済み     │
└──────────────┬───────────────────┘
               │
               ▼
┌────────────────────────────────────────────────────┐
│  Claude Code（/process-queue 定期実行）              │
│                                                     │
│  ① Inbox「未処理」取得 → 分類（案件/要員/その他）    │
│  ② AI整形 → Cases DB / Staff DB にページ作成        │
│  ③ マッチング → スコア70+ で Proposals DB に候補登録 │
│  ④ 打診中検知 → 要員元へ打診文LINE送信              │
│  ⑤ 返答検知 → OK/NG判定 → ステータス自動更新       │
│  ⑥ 提案中検知 → 案件元へ提案文LINE送信              │
│  ⑦ 棚卸し → 2週間経過の営業中を自動終了             │
└────────────────────────────────────────────────────┘
               │
    ┌──────────┴──────────┐
    ▼                     ▼
┌────────────────┐  ┌──────────────────────────────┐
│ Cases / Staff   │  │ Proposals DB                  │
│ DB（営業中）    │  │ 候補 → 打診中 → 提案中 → ... │
└────────────────┘  └──────────────────────────────┘
```

## フォルダ構成

```
line-notion-matching/
├── gas-inbox/                   # GAS（LINE受信/送信）
│   ├── 00_Config.gs             #   スクリプトプロパティ管理
│   ├── 01_Webhook.gs            #   LINE受信 → Inbox登録
│   └── 02_SendMessage.gs        #   LINE送信（Push Message API）
├── register/                    # Notion API操作（Python）
│   ├── notion_client.py         #   ページ作成・更新・検索
│   └── requirements.txt         #   requests
├── config/                      # 設定ファイル（gitignore対象）
│   ├── register-config.json     #   DB ID設定
│   └── line-user-mapping.json   #   LINE userId → 企業名マッピング
├── prompts/                     # AI整形・マッチングルール
│   ├── 案件整形プロンプト.txt
│   ├── 要員整形プロンプト.txt
│   ├── マッチングプロンプト.txt
│   ├── 打診文テンプレート.txt
│   └── 提案文テンプレート.txt
├── .claude/commands/            # Claude Codeスキル
│   ├── process-queue.md         #   /process-queue — 定期実行
│   └── broadcast.md             #   /broadcast — 配信
├── broadcast-skill/             # 配信用Pythonスクリプト
├── gas-main/                    # 旧GAS（メンバー向けフォーム維持）
├── gas-admin/                   # 旧GAS（停止済み・参照用）
├── docs/                        # ドキュメント
│   ├── notion-schema.md         #   DBスキーマ定義
│   └── 改修計画_フォーム省略.md  #   システム改修計画
└── .env                         # API Key（gitignore対象）
```

## Notion DB構成

| DB名 | 役割 |
|------|------|
| **Inbox** | GASからの一次受け皿（原文 + userId + ステータス） |
| **Cases** | AI整形済みの案件情報 |
| **Staff** | AI整形済みの要員情報 |
| **Proposals** | マッチング候補・提案管理 |
| **ステータス変更履歴** | 全DBのステータス遷移記録 |

詳細スキーマ → [docs/notion-schema.md](./docs/notion-schema.md)

## Claude Code スキル

| コマンド | 用途 |
|---------|------|
| `/process-queue` | 定期実行: Inbox処理 → 整形登録 → マッチング → 打診/提案 → 棚卸し |
| `/broadcast` | LINE配信: 案件・要員のスコアリング → 候補ピックアップ → 配信 |

## 使用技術

| カテゴリ | 技術 | 用途 |
|---------|------|------|
| Webhook/送信 | Google Apps Script | LINE受信 → Inbox登録、LINE Push送信 |
| メッセージング | LINE Messaging API | Webhook受信、Push Message |
| データベース | Notion API | 案件/要員/提案/Inbox管理 |
| AI処理 | Claude Code（サブスク） | 分類・整形・マッチング・打診/提案文生成 |
| Python | notion_client.py | Notion API操作クライアント |
| ファイル保存 | Google Drive API | スキルシートPDF |

## セットアップ

### 必要なもの

- Google アカウント（GAS実行用）
- LINE Developers アカウント
- Notion アカウント（Integration作成）
- Claude Code（サブスクリプション）

### 環境設定

1. Notionデータベースを作成 → [スキーマ定義](./docs/notion-schema.md)
2. LINE Bot を作成
3. gas-inbox をGASにデプロイ → Webhook URLを設定
4. `.env` にNotion API Keyを設定
5. `config/register-config.json` にDB IDを設定
6. `config/line-user-mapping.json` にLINE userId → 企業名マッピングを登録

### 旧システム（メンバー向け）

`gas-main/` のGoogleフォーム経由登録はメンバーが使用中のため維持。

## 提案フロー

```
候補（マッチングスコア70+で自動生成）
  ↓ Notionでステータスを「打診中」に変更
打診中 → Claude Codeが検知 → 要員元へ打診文LINE送信
  ↓ 要員元がLINEで返答 → Inboxに入る
  ↓ Claude Codeが返答を検知 → OK/NG判定
  ├─ OK → ステータスを「提案中」に → 案件元へ提案文送信
  └─ NG → ステータスを「見送り」に
提案中 → 面談 → 結果待ち → 決定 / 見送り / 辞退
```

## ドキュメント

| ドキュメント | 内容 |
|-------------|------|
| [Notionスキーマ](./docs/notion-schema.md) | データベース構造・プロパティ定義 |
| [改修計画](./docs/改修計画_フォーム省略.md) | システム改修計画・実装状況 |

## ライセンス

MIT License
