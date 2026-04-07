# Notion Database Schema

このシステムで使用する5つのNotionデータベースの定義です。

親ページ: **SES Matching System**

---

## 1. Inbox DB

GASからの一次受け皿。LINE受信した原文をそのまま格納する。

| プロパティ名 | 型 | 説明 | 設定方法 |
|------------|-----|------|---------|
| **タイトル** | title | 「{入力経路}: {userId or 不明}」 | GAS自動 |
| **原文** | rich_text | メッセージ本文（最大2000文字。全文はページ本文にも保存） | GAS自動 |
| **入力経路** | select | LINE / メール / 手動 | GAS自動 |
| **userId** | rich_text | LINE userId（メールの場合は空） | GAS自動 |
| **ステータス** | select | 未処理 / 処理済み / エラー | 自動 |
| **処理先URL** | url | Cases/StaffページURL | 処理時自動 |
| **添付ファイル** | files | スキルシート等（Google DriveのURL） | GAS自動 |

### ステータス選択肢

| 値 | 色 | 説明 |
|---|---|------|
| 未処理 | default | 登録直後。Claude Code処理待ち |
| 処理済み | green | Cases/Staffに登録完了 |
| エラー | red | 処理中にエラー発生 |

### 入力経路選択肢

| 値 | 色 |
|---|---|
| LINE | green |
| メール | blue |
| 手動 | default |

---

## 2. Cases DB（案件DB）

AI整形済みの案件情報を管理するデータベース。

| プロパティ名 | 型 | 説明 | 設定方法 |
|------------|-----|------|---------|
| **入力不要** | title | 案件名（AI整形で原文から抽出） | AI自動 |
| **原文** | rich_text | パートナー原文をそのまま保存 | 自動 |
| **サマリー** | rich_text | 営業用テキスト（■区切り形式） | AI自動 |
| **案件元企業** | rich_text | パートナー企業名 | LINE自動/手動 |
| **ステータス** | select | 案件の進捗状態 | 手動 |
| **スキル要件** | multi_select | 主要開発言語 | AI自動 |
| **スキル詳細** | rich_text | FW、DB、ツール等 | AI自動 |
| **営業単価** | number (yen) | 原文単価から5万円引き | AI自動 |
| **勤務地** | rich_text | 場所・出社条件・リモート情報 | AI自動 |
| **案件開始** | date | 開始時期（即日→翌月1日） | AI自動 |
| **案件開始（年月）** | formula | YYYY/MM形式 | 自動計算 |
| **案件回収日** | created_time | ページ作成日時 | 自動 |
| **入力経路** | select | LINE / メール / 手動 | 自動 |

### Formula

#### 案件開始（年月）
```
if(empty(prop("案件開始")), "", formatDate(prop("案件開始"), "YYYY/MM"))
```

### ステータス選択肢

| 値 | 色 | 説明 |
|---|---|------|
| 営業中 | yellow | 営業活動中 |
| 面談調整中 | blue | 面談日程調整中 |
| 決定 | purple | 案件決定 |
| 終了 | red | 案件クローズ（棚卸し含む） |

### スキル要件選択肢

Java, JavaScript, PHP, TypeScript, Python, Go, C#, PM, PMO

---

## 3. Staff DB（要員DB）

AI整形済みの要員情報を管理するデータベース。

| プロパティ名 | 型 | 説明 | 設定方法 |
|------------|-----|------|---------|
| **要員名** | title | イニシャル_最寄駅（例：K.S_渋谷） | AI自動 |
| **原文** | rich_text | パートナー原文をそのまま保存 | 自動 |
| **サマリー** | rich_text | 営業用テキスト（■区切り形式） | AI自動 |
| **要員元企業** | rich_text | パートナー企業名 | LINE自動/手動 |
| **ステータス** | select | 要員の進捗状態 | 手動 |
| **スキル概要** | multi_select | 主要開発言語 | AI自動 |
| **スキル詳細** | rich_text | FW、DB、ツール等 | AI自動 |
| **営業単価** | number (yen) | 希望単価から5万円アップ | AI自動 |
| **スキルシート** | files | PDFファイル | LINE自動/手動 |
| **稼働開始** | date | 稼働開始時期（即日→翌月1日） | AI自動 |
| **稼働開始（年月）** | formula | YYYY/MM形式 | 自動計算 |
| **要員回収日** | created_time | ページ作成日時 | 自動 |
| **入力経路** | select | LINE / メール / 手動 | 自動 |

### Formula

#### 稼働開始（年月）
```
if(empty(prop("稼働開始")), "", formatDate(prop("稼働開始"), "YYYY/MM"))
```

### ステータス選択肢

| 値 | 色 | 説明 |
|---|---|------|
| 営業中 | yellow | 営業活動中 |
| 面談調整中 | blue | 面談日程調整中 |
| オファー | purple | オファー段階 |
| 終了 | red | 要員クローズ（棚卸し含む） |

### スキル概要選択肢

Java, JavaScript, PHP, TypeScript, Python, Go, C#, PM, PMO

---

## 4. Proposals DB（提案DB）

案件と要員のマッチング提案を管理するデータベース。

| プロパティ名 | 型 | 説明 | 設定方法 |
|------------|-----|------|---------|
| **提案名** | title | 「【自動】OK（85点）案件名 × 要員名」 | AI自動 |
| **案件DB** | relation → Cases | 紐付く案件 | AI自動 |
| **要員DB** | relation → Staff | 紐付く要員 | AI自動 |
| **ステータス** | select | 提案の進捗状態 | 手動/自動 |
| **メモ** | rich_text | マッチング結果詳細 | AI自動 |
| **提案日** | date | 提案日 | 自動 |
| **面談設定日** | date | 面談日 | 手動 |
| **提案作成日** | created_time | ページ作成日時 | 自動 |

### ステータス選択肢

| 値 | 色 | 説明 |
|---|---|------|
| 候補 | gray | AIマッチングで自動生成 |
| 打診中 | yellow | 要員元に打診送信済み |
| 提案中 | pink | 案件元に提案送信済み |
| 面談 | blue | 面談設定済み |
| 結果待ち | purple | 面談後の結果待ち |
| 見送り | red | 見送り |
| 辞退 | orange | 辞退 |
| 決定 | green | 決定 |

### ステータス遷移

```
候補 → 打診中（ユーザーがNotionで変更）
打診中 → 提案中（返答OK → 自動）/ 見送り（返答NG → 自動）
提案中 → 面談 → 結果待ち → 決定 / 見送り / 辞退
```

---

## 5. ステータス変更履歴DB

全DBのステータス変更を自動記録するデータベース。

| プロパティ名 | 型 | 説明 | 設定方法 |
|------------|-----|------|---------|
| **タイトル** | title | 「{DB種別}: {ページ名} [{旧} → {新}]」 | 自動 |
| **対象DB** | select | Cases / Staff / Proposals | 自動 |
| **対象ページID** | rich_text | Notionページ ID | 自動 |
| **旧ステータス** | rich_text | 変更前のステータス | 自動 |
| **新ステータス** | rich_text | 変更後のステータス | 自動 |
| **変更理由** | rich_text | 変更の理由（例：棚卸し、打診返答OK等） | 自動 |
| **変更日時** | date | 変更日 | 自動 |

### 対象DB選択肢

| 値 | 色 |
|---|---|
| Cases | blue |
| Staff | green |
| Proposals | purple |

---

## DB ID一覧

`config/register-config.json` に設定:

```json
{
  "inbox_db_id": "Inbox DBのID",
  "cases_db_id": "Cases DBのID",
  "staff_db_id": "Staff DBのID",
  "proposals_db_id": "Proposals DBのID",
  "history_db_id": "ステータス変更履歴DBのID"
}
```

### DB IDの取得方法

1. Notionでデータベースページを開く
2. URLの `notion.so/` 以降の32文字がデータベースID
   - 例: `https://www.notion.so/2c2c01f8776980138dc0ea41dac2c119`
   - ID: `2c2c01f8776980138dc0ea41dac2c119`
