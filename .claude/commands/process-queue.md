# Inbox処理キュー（定期実行）

Notion Inbox DBの未処理エントリを取得し、分類・整形・登録・マッチングを一括処理する。

## 実行コマンド

```bash
cd C:\Users\user\claude-workspace\line-notion-matching
```

## 処理フロー

### Step 1: Inbox取得・グルーピング

```bash
PYTHONIOENCODING=utf-8 python -c "
import json, sys
sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'register')
from notion_client import NotionClient
client = NotionClient()
groups = client.get_grouped_inbox()
print(json.dumps([{
    'userId': g['userId'], 'company': g['company'], 'source': g['source'],
    'combined_text': g['combined_text'], 'file_urls': g.get('file_urls', []),
    'entries': [{'page_id': e['page_id']} for e in g['entries']]
} for g in groups], ensure_ascii=False, indent=2))
"
```

未処理が0件なら「未処理なし」と報告して終了。

### Step 2: 各グループを分類

各グループの `combined_text` を読み、以下に分類する:

| 分類 | 判定基準 | 処理 |
|------|----------|------|
| **案件** | 案件概要・作業内容・単価・商流等を含む | → Step 3A |
| **要員** | 氏名・スキル・稼働・単価等を含む | → Step 3B |
| **打診への返答** | 直近の打診に対するOK/NGの返答 | → Step 3C |
| **その他** | 挨拶、お礼、雑談、質問など | → Step 3D |

**1つのグループに案件と要員が混在している場合**: 文中の区切り（＝＝＝、***、---等）で分割し、それぞれを個別の案件/要員として処理する。

### Step 3A: 案件の整形・登録

1. `prompts/案件整形プロンプト.txt` のルールに従い、原文からJSONを生成
   - **【案件元企業】にはグループの `company` を設定**
   - サマリーの商流: 原文の「弊社」および案件元企業名 → 「上位」、「貴社」→「弊社」
   - 営業単価: 原文 - 5万円
   - 1グループに複数案件がある場合は個別に整形
2. Python で Cases DB に登録:

```python
from notion_client import NotionClient
client = NotionClient()
result = client.create_case(data, raw_text, company, source="LINE")
```

3. 登録後のページURLを記録

### Step 3B: 要員の整形・登録

1. `prompts/要員整形プロンプト.txt` のルールに従い、原文からJSONを生成
   - **【要員元企業】にはグループの `company` を設定**
   - サマリーの所属: 原文の「弊社社員」→「1社先正社員」等（プロンプトの変換ルール参照）
   - 営業単価: 原文 + 5万円
   - スキルシートURL（Google Spreadsheet/Drive リンク）があれば file_urls に含める
   - 1グループに複数要員がある場合は個別に整形
2. Python で Staff DB に登録:

```python
result = client.create_staff(data, raw_text, company, source="LINE", file_urls=urls)
```

3. 登録後のページURLを記録

### Step 3C: 打診への返答処理

1. Proposals DB から「打診中」の提案を取得
2. 返答元の userId/企業名から、該当する打診を特定
3. 返答内容をAI判定:
   - OK系（了解、大丈夫、問題ない、提案OK等）→ ステータスを「提案中」に更新
   - NG系（辞退、NGで、見送り等）→ ステータスを「見送り」に更新
   - 不明 → 処理せず、ユーザーに確認を促す

```python
client.update_proposal_status(page_id, new_status, reason="打診返答: OK/NG")
```

### Step 3D: その他（挨拶・雑談）

処理済みにするだけ。登録先URLは空。

### Step 4: Inboxステータス更新

処理した全エントリを「処理済み」に更新:

```python
for entry in group['entries']:
    client.mark_inbox_processed(entry['page_id'], destination_url)
```

エラー発生時は「エラー」に更新:

```python
client.mark_inbox_error(entry['page_id'])
```

### Step 5: マッチング（新規登録分）

Step 3A/3Bで新規登録した案件/要員に対し、反対側DBの「営業中」エントリとマッチングを行う。

1. 新規案件がある場合 → `client.get_active_staff()` で営業中要員を取得
2. 新規要員がある場合 → `client.get_active_cases()` で営業中案件を取得
3. `prompts/マッチングプロンプト.txt` のルールに従い、各ペアを判定
4. スコア70点以上 → Proposals DB に候補を作成:

```python
client.create_proposal(case_name, staff_name, judgment, score, case_page_id, staff_page_id, memo=detailed_result)
```

**マッチング対象が多い場合（5件×5件=25ペア超）**: 事前にスキル要件の重なりで絞り込み、有望なペアのみ詳細判定する。

### Step 6: 打診・提案の送信チェック

1. **打診中チェック**: Proposals DB の「打診中」を取得し、未送信のものがあればLINE送信
   - `prompts/打診文テンプレート.txt` で打診文を生成
   - 要員元企業の userId が判明 → LINE送信（gas-inbox経由）
   - userId 不明 → 文面を表示し手動送信を依頼
   - 重複チェック: `client.is_action_done(page_id, "打診送信")` で確認

2. **提案中チェック**: Proposals DB の「提案中」を取得し、未送信のものがあれば
   - `prompts/提案文テンプレート.txt` で提案文を生成
   - 案件元企業の userId が判明 → LINE送信
   - 重複チェック: `client.is_action_done(page_id, "提案送信")` で確認

### Step 7: 棚卸し

14日以上経過の「営業中」案件/要員を自動終了:

```bash
PYTHONIOENCODING=utf-8 python -c "
import sys; sys.stdout.reconfigure(encoding='utf-8')
sys.path.insert(0, 'register')
from notion_client import NotionClient
client = NotionClient()
results = client.close_stale_entries(days=14)
total = len(results['cases']) + len(results['staff'])
print(f'棚卸し: {total}件終了')
"
```

### Step 8: 結果報告

処理結果をまとめて報告:

```
=== Inbox処理結果 ===
- 案件登録: X件（企業名: 案件名, ...）
- 要員登録: X件（企業名: 要員名, ...）
- 返答処理: X件（OK: X, NG: X）
- その他: X件（処理済み）
- マッチング: X件の候補生成
- 打診送信: X件
- 提案送信: X件
- 棚卸し: X件終了
- エラー: X件
```

## 注意事項

- 案件/要員の整形は `prompts/` 内のプロンプトのルールを厳守すること
- Notionの既存Selectオプションのみ使用（新規追加禁止）
- マッチングは全ペア網羅より精度優先。スキルが明らかに合わないペアはスキップ
- LINE送信はgas-inboxの送信機能デプロイ後に有効化（未デプロイ時は文面表示のみ）
- 原文が2000文字で切れている場合、`get_grouped_inbox` が自動的にページ本文から全文取得を試みる
