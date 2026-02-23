# SES営業分析システム 最終要件定義書

**作成日**: 2026年1月26日
**バージョン**: 1.0.0

---

## 📋 目次
1. システム概要
2. データベース構成
3. 週次レポート仕様
4. 月次レポート仕様
5. グラフ・可視化仕様
6. 実装仕様
7. スラッシュコマンド仕様

---

## 1. システム概要

### 目的
SES仲介営業における案件・要員・提案状況を週次・月次で自動分析し、Notionレポートとして可視化

### データソース
- 👤 **要員DB**（既存）
- 🧾 **案件DB**（既存）
- 📋 **提案DB**（既存）
- 📊 **営業コスト管理DB**（新規作成）

---

## 2. データベース構成

### 📊 営業コスト管理DB

**Notion DB ID**: `61b10c6de5544c0782142bcff662374a`

| プロパティ名 | 型 | 説明 |
|------------|-----|------|
| 対象週 | タイトル | 例: 2025年1月第1週（1/6-1/12） |
| 週開始日 | 日付 | その週の月曜日 |
| 週終了日 | 日付 | その週の日曜日 |
| 累積稼働時間（h） | 数値 | この週のチーム総稼働時間 |
| 週間予算時間（h） | 数値 | この週の予算時間 |
| 時間単価（円/h） | 数値 | 1時間あたりコスト |
| 実績金額 | 計算式 | `累積稼働時間 × 時間単価` |
| 予算金額 | 計算式 | `週間予算時間 × 時間単価` |
| 予算消化率（%） | 計算式 | `累積稼働時間 / 週間予算時間 × 100` |
| 精査件数 | 数値 | 日報から転記（精査したマッチング候補数） |
| 打診件数 | 数値 | 日報から転記（パートナーへ連絡した件数） |
| 備考 | テキスト | 特記事項 |

**運用**: 毎週金曜日に1レコード作成、月次は週次データを自動集計
**精査・打診**: 日報の件数を手動転記

### 既存データベース

#### 👤 要員DB

**Notion DB ID**: `2c2c01f8-7769-80c1-9af9-c5b101b91520`

- **プロパティ「要員回収日」**（created_time型）
- **ステータス**: 未処理、営業中、面談調整中、オファー、終了

#### 🧾 案件DB

**Notion DB ID**: `2c2c01f8-7769-8013-8dc0-ea41dac2c119`

- **プロパティ「案件回収日」**（created_time型）
- **ステータス**: 未処理、営業中、面談調整中、決定、終了

#### 📋 提案DB

**Notion DB ID**: `2c2c01f8-7769-8032-8e3a-c1bf4e933a67`

- **プロパティ「提案日」**（date型）
- **プロパティ「提案作成日」**（created_time型）
- **ステータス**: 候補、提案中、面談、結果待ち、見送り、辞退、決定

#### 📝 ステータス変更履歴DB

**Notion DB ID**: `35fd3c53-5d51-414f-b12f-c85521b3321b`

- ROI分析のアクション件数算出に使用（候補→提案中、提案中→面談、→決定 等の遷移回数）

#### 📊 分析レポート親ページ

**Notion Page ID**: `8d52d3fee1344c549e6715d24f7b8b4e`

**構造**:
```
📊 分析レポート
├── 📄 最新週次レポート（固定ページ、毎週上書き）
├── 📄 最新月次レポート（固定ページ、毎月上書き）
├── 📁 週次レポート履歴（各週のページ保存）
└── 📁 月次レポート履歴（各月のページ保存）
```

---

## 3. 週次レポート仕様

### セクション構成

1. **💰 営業コスト**
2. **💹 費用対効果（ROI）**
3. **⚠️ 期限超過アラート**
4. **📋 提案活動**
5. **👤 要員活動**
6. **🧾 案件活動**
7. **📊 週間分析**
8. **📈 グラフ・可視化**

### 期限超過アラート抽出条件

| DB | 日付プロパティ | 期限 | 対象ステータス |
|----|--------------|------|--------------|
| **提案DB** | 提案日 | 1週間以上 | 「提案中」のみ |
| **要員DB** | 要員回収日 | 2週間以上 | 「終了」以外 |
| **案件DB** | 案件回収日 | 2週間以上 | 「終了」以外 |

### 出力内容

- **新規登録**: 対象週に作成されたレコード（名前リスト表示）
- **決定**: 提案DB・案件DBで「決定」になったもの（名前リスト表示）
- **終了**: 要員DB・案件DBで「終了」になったもの（名前リスト表示）
- **見送り・辞退**: 提案DBで該当ステータスになったもの（名前リスト表示）
- **前週比**: 前週のデータと比較（増減を表示）

---

## 4. 月次レポート仕様

### セクション構成

1. **💰 月間営業コスト**（週別集計テーブル）
2. **💹 月間費用対効果（ROI）**（週別ROI推移グラフ付き）
3. **📋 提案活動（月間集計）**
4. **👤 要員活動（月間集計）**
5. **🧾 案件活動（月間集計）**
6. **📊 月間総合分析**
7. **📈 3ヶ月トレンド**
8. **📉 グラフ・可視化**

### 出力ルール

#### ✅ 個別名を表示するもの

**提案DB:**
- 決定案件のリスト
- 進行中の重要案件（面談、結果待ち）

**要員DB:**
- 進行中の重要要員（面談調整中、オファー）

**案件DB:**
- 決定案件のリスト
- 進行中の重要案件（面談調整中）

#### ❌ 個別名を表示しないもの

- 新規登録の詳細リスト（件数のみ）
- 終了案件・終了要員の詳細リスト（件数のみ）
- 見送り・辞退の詳細リスト（件数のみ）

### 前月比

- 前月のデータと比較（増減を表示）
- データがない場合は "-" と表示

---

## 5. グラフ・可視化仕様

### 実装方式
- **QuickChart.io** のURL生成方式でグラフを作成
- NotionページにはQuickChart.ioの外部URLとして埋め込み
- ローカルの画像生成・アップロードは不要

### 週次レポート用グラフ

| # | グラフ名 | 種類 | 説明 |
|---|---------|------|------|
| 1 | 提案ファネル | 横棒グラフ | ステータス別の提案件数 |
| 2 | 受注率トレンド | 折れ線グラフ | 直近4週の受注率推移 |
| 3 | 粗利見込み | 積み上げ棒グラフ | ステータス別の粗利見込額 |
| 4 | スキル別需給バランス | 横棒グラフ | スキルごとの案件数 vs 要員数 |
| 5 | 案件スキル構成 | 円グラフ | 全案件のスキル要件割合 |
| 6 | 要員スキル構成 | 円グラフ | 稼働可能要員のスキル割合 |

### 月次レポート用グラフ

| # | グラフ名 | 種類 | 説明 |
|---|---------|------|------|
| 1 | 月間コスト推移 | 棒グラフ | 週別の実績コストと予算 |
| 2 | 提案決定率トレンド | 折れ線グラフ | 3ヶ月の決定率推移 |
| 3 | 月間ステータス別案件数 | 積み上げ棒グラフ | 提案DBのステータス別推移 |
| 4 | スキル需給バランス | 横棒グラフ | 週次と同じ |
| 5 | 月間粗利構成 | 円グラフ | 決定案件の粗利割合 |

---

## 6. 実装仕様

### 技術スタック

- **言語**: Python 3
- **ライブラリ**:
  - `requests`: Notion API操作（REST API直接呼び出し）
  - `datetime`: 日付計算
  - `collections`: データ集計
  - `urllib.parse`: QuickChart.io URL生成
- **グラフ生成**: QuickChart.io（URL生成方式）
- **Notion API**: v2022-06-28

### 実行フロー

#### フェーズ1: データ取得

```python
# 1. 対象期間を決定
target_period = calculate_period(args.date or args.month)

# 2. Notion APIでデータ取得
proposals = fetch_proposal_db(target_period)
personnel = fetch_personnel_db(target_period)
projects = fetch_project_db(target_period)
costs = fetch_cost_db(target_period)

# 3. 進捗表示
print("✓ 提案DB: {len(proposals)}件取得")
print("✓ 要員DB: {len(personnel)}件取得")
print("✓ 案件DB: {len(projects)}件取得")
print("✓ 営業コスト管理DB: {len(costs)}件取得")
```

#### フェーズ2: 分析・集計

```python
# 1. 新規登録カウント
new_proposals = filter_by_created_time(proposals, target_period)
new_personnel = filter_by_created_time(personnel, target_period)
new_projects = filter_by_created_time(projects, target_period)

# 2. 期限超過アラート（週次のみ）
if report_type == "weekly":
    overdue_proposals = filter_overdue(proposals, "提案日", days=7, status="提案中")
    overdue_personnel = filter_overdue(personnel, "要員回収日", days=14, exclude_status="終了")
    overdue_projects = filter_overdue(projects, "案件回収日", days=14, exclude_status="終了")

# 3. 前週比/前月比
prev_data = fetch_previous_period_data()
comparison = calculate_comparison(current_data, prev_data)

# 4. 進捗表示
print("✓ 集計処理完了")
print(f"✓ 新規登録: 提案{len(new_proposals)}件、要員{len(new_personnel)}件、案件{len(new_projects)}件")
if report_type == "weekly":
    print(f"✓ 期限超過アラート: {len(overdue_proposals) + len(overdue_personnel) + len(overdue_projects)}件")
```

#### フェーズ3: グラフ生成

```python
# 1. QuickChart.io URLでグラフ生成
graph_urls = []
graph_urls.append(create_quickchart_url("bar", cost_data))
graph_urls.append(create_quickchart_url("pie", skill_data))
# ... 他のグラフ

# 2. 進捗表示
print(f"✓ グラフURL生成完了（{len(graph_urls)}枚）")
```

#### フェーズ4: 確認

```python
# 1. サマリー表示
print("\n【{report_type}レポート サマリー】")
print(f"期間: {start_date} - {end_date}")
print(f"\n- 営業コスト: ¥{actual_cost:,} / ¥{budget_cost:,} ({consumption_rate:.1f}%)")
print(f"- 提案決定: {decided_proposals}件")
if report_type == "weekly":
    print(f"- 期限超過アラート: {total_overdue}件")

# 2. 確認プロンプト
response = input("\nNotionに出力しますか？ (yes/no): ")
```

#### フェーズ5: Notion出力

```python
if response.lower() == "yes":
    # 1. Markdownレポート生成（QuickChart.io URLを含む）
    print("\nNotionレポートを生成中...")
    markdown = generate_report_markdown(data, graph_urls)

    # 3. 最新レポートページ更新
    update_latest_report(markdown, report_type)
    print(f"✓ 「最新{report_type_ja}レポート」更新完了")

    # 4. 履歴ページ作成
    history_url = create_history_page(markdown, target_period, report_type)
    print(f"✓ 「{report_type_ja}レポート履歴/{period_name}」作成完了")

    print("\n完了しました！")
    print(f"📊 最新レポート: {latest_report_url}")
    print(f"📁 履歴: {history_url}")
```

### 日付計算

#### 週次レポート

```python
def calculate_weekly_period(date_str=None):
    """
    週次レポートの期間を計算（月曜日〜日曜日）

    Args:
        date_str: YYYY-MM-DD形式の日付（省略時は今週）

    Returns:
        (start_date, end_date, week_name)
    """
    if date_str:
        target_date = datetime.strptime(date_str, "%Y-%m-%d")
    else:
        target_date = datetime.now()

    # その週の月曜日を取得
    monday = target_date - timedelta(days=target_date.weekday())

    # その週の日曜日を取得
    sunday = monday + timedelta(days=6)

    # 週名を生成（例: 2025年1月第4週（1/20-1/26））
    week_number = (monday.day - 1) // 7 + 1
    week_name = f"{monday.year}年{monday.month}月第{week_number}週（{monday.month}/{monday.day}-{sunday.month}/{sunday.day}）"

    return monday, sunday, week_name
```

#### 月次レポート

```python
def calculate_monthly_period(month_str=None):
    """
    月次レポートの期間を計算（月初〜月末）

    Args:
        month_str: YYYY-MM形式の月（省略時は今月）

    Returns:
        (start_date, end_date, month_name, weeks)
    """
    if month_str:
        target_date = datetime.strptime(month_str + "-01", "%Y-%m-%d")
    else:
        target_date = datetime.now()

    # 月初
    start_date = target_date.replace(day=1)

    # 月末
    next_month = start_date + timedelta(days=32)
    end_date = next_month.replace(day=1) - timedelta(days=1)

    # 月名（例: 2025年1月）
    month_name = f"{start_date.year}年{start_date.month}月"

    # その月の全週を取得
    weeks = get_weeks_in_month(start_date, end_date)

    return start_date, end_date, month_name, weeks
```

### エラーハンドリング

```python
try:
    # データ取得
    data = fetch_notion_data()
except NotionAPIError as e:
    print(f"❌ Notion API接続エラー: {e}")
    print("Notion統合のアクセス権限を確認してください")
    sys.exit(1)

try:
    # グラフURL生成（QuickChart.io）
    graph_urls = generate_quickchart_urls(data)
except Exception as e:
    print(f"⚠️ グラフURL生成に失敗: {e}")
    print("テキストのみでレポートを生成します")
    graph_urls = []

# データ不足の警告
if len(new_proposals) == 0:
    print("⚠️ 警告: 対象期間に新規提案がありません")
```

---

## 7. スラッシュコマンド仕様

### コマンド名

`/ses-analysis` または `/分析`

### サブコマンド

#### `weekly` - 週次レポート生成

```bash
# 今週のレポートを生成
/ses-analysis weekly

# 特定の週を指定
/ses-analysis weekly --date 2025-01-20
```

**引数:**
- `--date`: 対象週の任意の日付（YYYY-MM-DD形式）
- 省略時は現在の週

#### `monthly` - 月次レポート生成

```bash
# 今月のレポートを生成
/ses-analysis monthly

# 特定の月を指定
/ses-analysis monthly --month 2025-01
```

**引数:**
- `--month`: 対象月（YYYY-MM形式）
- 省略時は現在の月

### 実行例

```
ユーザー: /ses-analysis weekly

Claude: 週次レポートを生成します...

✓ Notion DBからデータ取得中...
✓ 提案DB: 15件取得
✓ 要員DB: 28件取得
✓ 案件DB: 20件取得
✓ 営業コスト管理DB: 1件取得

✓ 集計・分析処理中...
✓ 新規登録: 提案3件、要員5件、案件2件
✓ 期限超過アラート: 提案2件、要員3件、案件2件

✓ グラフ生成中...
✓ グラフ生成完了（6枚）

【週次レポート サマリー】
期間: 2025/01/20 - 2025/01/26

- 営業コスト: ¥190,000 / ¥200,000 (95.0%)
- 提案決定: 1件
- 期限超過アラート: 7件

Notionに出力しますか？ (yes/no): yes

Notionレポートを生成中...

✓ グラフ画像アップロード完了
✓ 「最新週次レポート」更新完了
✓ 「週次レポート履歴/2025年1月第4週（1/20-1/26）」作成完了

完了しました！
📊 最新レポート: https://notion.so/8d52d3fee1344c549e6715d24f7b8b4e
📁 履歴: https://notion.so/...
```

---

## 📝 要件サマリー

### 集計対象

| DB | 新規登録 | 決定/終了 | 期限超過アラート |
|----|---------|----------|----------------|
| **提案DB** | 提案作成日で判定 | 決定、見送り、辞退 | 提案中かつ提案日から1週間以上 |
| **要員DB** | 要員回収日で判定 | 終了 | 終了以外かつ要員回収日から2週間以上 |
| **案件DB** | 案件回収日で判定 | 決定、終了 | 終了以外かつ案件回収日から2週間以上 |

### 出力ルール

**週次レポート:**
- 全ての新規登録・決定・終了を名前リスト表示
- 期限超過アラートを表示

**月次レポート:**
- 決定案件・進行中の重要案件/要員のみ名前リスト表示
- 新規登録・終了・見送り・辞退は件数のみ
- 週別コスト集計テーブルを含める

### チーム視点
- 担当者別の分解は不要
- 全てチーム全体の集計値

---

以上
