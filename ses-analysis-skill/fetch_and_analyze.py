#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SES営業分析システム - 週次レポート自動生成スクリプト
対象週: 2025年1月第4週（1/20-1/26）
"""

import os
import sys
import io
import json
import requests
import time
from datetime import datetime, timedelta
from collections import defaultdict
from urllib.parse import quote
from pathlib import Path
from dotenv import load_dotenv

# Windows環境でのUnicode出力対応
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# .envファイルを読み込み（同階層 → 親階層の順に探索）
_script_dir = Path(__file__).resolve().parent
_env_found = False
for _env_dir in [_script_dir, _script_dir.parent, *_script_dir.parents]:
    _env_path = _env_dir / ".env"
    if _env_path.is_file():
        load_dotenv(_env_path)
        _env_found = True
        break

# Notion API設定
NOTION_API_KEY = os.environ.get("NOTION_API_KEY", "")
if not NOTION_API_KEY:
    print("❌ 環境変数 NOTION_API_KEY が設定されていません。")
    if not _env_found:
        print(f"   .envファイルが見つかりません（探索起点: {_script_dir}）")
    else:
        print(f"   .envファイル ({_env_path}) に NOTION_API_KEY が含まれていません。")
    sys.exit(1)

NOTION_VERSION = "2022-06-28"
HEADERS = {
    "Authorization": f"Bearer {NOTION_API_KEY}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
}

# データベースID（環境変数またはデフォルト値）
# 環境変数で上書きする場合: NOTION_DB_提案, NOTION_DB_要員, NOTION_DB_案件, etc.
DB_IDS = {
    "提案": os.environ.get("NOTION_DB_提案", "2c2c01f8-7769-8032-8e3a-c1bf4e933a67"),
    "要員": os.environ.get("NOTION_DB_要員", "2c2c01f8-7769-80c1-9af9-c5b101b91520"),
    "案件": os.environ.get("NOTION_DB_案件", "2c2c01f8-7769-8013-8dc0-ea41dac2c119"),
    "営業コスト": os.environ.get("NOTION_DB_営業コスト", "61b10c6d-e554-4c07-8214-2bcff662374a"),
    "ステータス変更履歴": os.environ.get("NOTION_DB_ステータス変更履歴", "35fd3c53-5d51-414f-b12f-c85521b3321b")
}

# 対象期間
WEEK_START = datetime(2026, 1, 19)
WEEK_END = datetime(2026, 1, 25, 23, 59, 59)
WEEK_LABEL = "2026年1月第3週（1/19-1/25）"

# 期限超過チェック用
ONE_WEEK_AGO = WEEK_END - timedelta(days=7)
TWO_WEEKS_AGO = WEEK_END - timedelta(days=14)

# 固定値
HOURLY_RATE = 3750  # 時間単価（円/h）

# アクション別仮想単価（費用対効果算出用）
ACTION_VALUES = {
    "精査": 200,
    "打診": 500,
    "打ち合わせ": 2_000,
    "提案": 2_500,
    "面談": 7_000,
    "決定": 150_000,
}

def query_database(db_id, filter_params=None):
    """Notionデータベースをクエリ（ページネーション対応）"""
    url = f"https://api.notion.com/v1/databases/{db_id}/query"
    all_results = []
    start_cursor = None

    while True:
        payload = {"page_size": 100}
        if filter_params:
            payload["filter"] = filter_params
        if start_cursor:
            payload["start_cursor"] = start_cursor

        response = requests.post(url, headers=HEADERS, json=payload)
        if response.status_code != 200:
            print(f"エラー: {response.status_code}")
            print(response.text)
            return None

        data = response.json()
        all_results.extend(data.get("results", []))

        if not data.get("has_more"):
            break
        start_cursor = data.get("next_cursor")

    return {"results": all_results}

def get_property_value(page, prop_name):
    """プロパティ値を取得"""
    props = page.get("properties", {})
    prop = props.get(prop_name, {})
    prop_type = prop.get("type")

    if prop_type == "title":
        titles = prop.get("title", [])
        return titles[0].get("plain_text", "") if titles else ""
    elif prop_type == "rich_text":
        texts = prop.get("rich_text", [])
        return texts[0].get("plain_text", "") if texts else ""
    elif prop_type == "select":
        select = prop.get("select")
        return select.get("name", "") if select else ""
    elif prop_type == "date":
        date = prop.get("date")
        return date.get("start", "") if date else ""
    elif prop_type == "created_time":
        return prop.get("created_time", "")
    elif prop_type == "formula":
        formula = prop.get("formula", {})
        return formula.get("string", "")
    elif prop_type == "number":
        return prop.get("number")
    elif prop_type == "multi_select":
        multi_select = prop.get("multi_select", [])
        return [item.get("name", "") for item in multi_select]
    elif prop_type == "relation":
        relations = prop.get("relation", [])
        return [r.get("id", "") for r in relations]
    else:
        return ""

def update_notion_status(page_id, new_status, max_retries=3):
    """Notionページのステータスを更新（リトライ付き）"""
    url = f"https://api.notion.com/v1/pages/{page_id}"
    payload = {
        "properties": {
            "ステータス": {
                "select": {
                    "name": new_status
                }
            }
        }
    }
    for attempt in range(max_retries):
        response = requests.patch(url, headers=HEADERS, json=payload)
        if response.status_code == 200:
            print(f"  ✅ ステータス更新: {page_id[:8]}... → {new_status}")
            return True
        elif response.status_code in (429, 502, 503, 504):
            wait = 2 ** attempt
            print(f"  ⏳ リトライ ({attempt+1}/{max_retries}): {page_id[:8]}... - {response.status_code}, {wait}秒待機")
            time.sleep(wait)
        else:
            print(f"  ❌ ステータス更新失敗: {page_id[:8]}... - {response.status_code}")
            return False
    print(f"  ❌ リトライ上限到達: {page_id[:8]}... - {response.status_code}")
    return False

def analyze_teian():
    """提案DBを分析"""
    print("📋 提案DBを取得中...")
    data = query_database(DB_IDS["提案"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    analysis = {
        "新規登録_週内": [],
        "決定_週内": [],
        "候補_滞留": [],
        "提案中_期限超過": [],
        "候補_with_relations": [],
        "ステータス別": defaultdict(int)
    }

    for page in results:
        status = get_property_value(page, "ステータス")
        teian_date = get_property_value(page, "提案日")
        created_time = get_property_value(page, "提案作成日")
        teian_name = get_property_value(page, "提案名")

        # 週内のレコードのみ処理
        is_in_week = False
        if created_time:
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00'))
            # タイムゾーンを削除して比較
            created_dt_naive = created_dt.replace(tzinfo=None)
            if WEEK_START <= created_dt_naive <= WEEK_END:
                is_in_week = True
                analysis["新規登録_週内"].append({
                    "name": teian_name,
                    "status": status,
                    "date": created_time
                })

        # ステータス別カウント（週内のレコードのみ）
        if status and is_in_week:
            analysis["ステータス別"][status] += 1

        # 週内の決定案件
        if status == "決定" and teian_date:
            teian_dt = datetime.fromisoformat(teian_date)
            if WEEK_START.date() <= teian_dt.date() <= WEEK_END.date():
                analysis["決定_週内"].append({
                    "name": teian_name,
                    "date": teian_date,
                    "案件担当": get_property_value(page, "案件担当"),
                    "要員担当": get_property_value(page, "要員担当"),
                    "粗利見込": get_property_value(page, "粗利見込")
                })

        # 候補で1週間経過（滞留）
        if status == "候補" and created_time:
            created_dt_check = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)
            if created_dt_check.date() < ONE_WEEK_AGO.date():
                days_passed = (WEEK_END.date() - created_dt_check.date()).days
                analysis["候補_滞留"].append({
                    "page_id": page["id"],
                    "name": teian_name,
                    "date": created_time[:10],
                    "days": days_passed,
                    "案件担当": get_property_value(page, "案件担当"),
                    "要員担当": get_property_value(page, "要員担当")
                })

        # 候補の全件をリレーション付きで記録（連鎖終了用）
        if status == "候補":
            youin_ids = get_property_value(page, "要員DB") or []
            anken_ids = get_property_value(page, "案件DB") or []
            if youin_ids or anken_ids:
                analysis["候補_with_relations"].append({
                    "page_id": page["id"],
                    "name": teian_name,
                    "date": created_time[:10] if created_time else "",
                    "案件担当": get_property_value(page, "案件担当"),
                    "要員担当": get_property_value(page, "要員担当"),
                    "youin_ids": youin_ids if isinstance(youin_ids, list) else [],
                    "anken_ids": anken_ids if isinstance(anken_ids, list) else [],
                })

        # 提案中で1週間経過
        if status == "提案中" and teian_date:
            teian_dt = datetime.fromisoformat(teian_date)
            if teian_dt.date() < ONE_WEEK_AGO.date():
                days_passed = (WEEK_END.date() - teian_dt.date()).days
                analysis["提案中_期限超過"].append({
                    "page_id": page["id"],
                    "name": teian_name,
                    "date": teian_date,
                    "days": days_passed,
                    "案件担当": get_property_value(page, "案件担当"),
                    "要員担当": get_property_value(page, "要員担当")
                })

    return analysis

# 要員DB共通フィルター: 「終了」を除外（全利用箇所で不要なため）
YOUIN_EXCLUDE_DONE_FILTER = {
    "property": "ステータス",
    "select": {"does_not_equal": "終了"}
}

def analyze_youin():
    """要員DBを分析"""
    print("👤 要員DBを取得中...")
    data = query_database(DB_IDS["要員"], filter_params=YOUIN_EXCLUDE_DONE_FILTER)
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    analysis = {
        "新規登録_週内": 0,
        "期限超過": [],
        "ステータス別": defaultdict(int)
    }

    for page in results:
        status = get_property_value(page, "ステータス")
        created_time = get_property_value(page, "要員回収日")
        youin_name = get_property_value(page, "要員名")
        tantou = get_property_value(page, "担当")

        # 週内のレコードのみ処理
        is_in_week = False
        if created_time:
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00'))
            # タイムゾーンを削除して比較
            created_dt_naive = created_dt.replace(tzinfo=None)
            if WEEK_START <= created_dt_naive <= WEEK_END:
                is_in_week = True
                analysis["新規登録_週内"] += 1

        # ステータス別カウント（週内のレコードのみ）
        if status and is_in_week:
            analysis["ステータス別"][status] += 1

        # オファー以外で2週間経過（終了はAPIフィルターで除外済み）
        if status != "オファー" and created_time:
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00'))
            created_dt_naive = created_dt.replace(tzinfo=None)
            if created_dt_naive.date() < TWO_WEEKS_AGO.date():
                days_passed = (WEEK_END.date() - created_dt.date()).days
                analysis["期限超過"].append({
                    "page_id": page["id"],
                    "name": youin_name,
                    "date": created_time[:10],
                    "days": days_passed,
                    "status": status,
                    "担当": tantou
                })

    return analysis

def analyze_anken():
    """案件DBを分析"""
    print("🧾 案件DBを取得中...")
    data = query_database(DB_IDS["案件"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    analysis = {
        "新規登録_週内": 0,
        "期限超過": [],
        "ステータス別": defaultdict(int)
    }

    for page in results:
        status = get_property_value(page, "ステータス")
        created_time = get_property_value(page, "案件回収日")
        anken_name = get_property_value(page, "入力不要")  # タイトルフィールド
        tantou = get_property_value(page, "担当")

        # 週内のレコードのみ処理
        is_in_week = False
        if created_time:
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00'))
            # タイムゾーンを削除して比較
            created_dt_naive = created_dt.replace(tzinfo=None)
            if WEEK_START <= created_dt_naive <= WEEK_END:
                is_in_week = True
                analysis["新規登録_週内"] += 1

        # ステータス別カウント（週内のレコードのみ）
        if status and is_in_week:
            analysis["ステータス別"][status] += 1

        # 決定・終了以外で2週間経過
        if status not in ["決定", "終了"] and created_time:
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00'))
            created_dt_naive = created_dt.replace(tzinfo=None)
            if created_dt_naive.date() < TWO_WEEKS_AGO.date():
                days_passed = (WEEK_END.date() - created_dt.date()).days
                analysis["期限超過"].append({
                    "page_id": page["id"],
                    "name": anken_name,
                    "date": created_time[:10],
                    "days": days_passed,
                    "status": status,
                    "担当": tantou
                })

    return analysis

def auto_terminate_stagnant(teian_analysis, youin_analysis, anken_analysis):
    """滞留レコードを自動的に「終了」ステータスに変更する

    処理順序:
    1. 要員DB: 営業中 + 2週間以上滞留 → 終了
    2. 案件DB: 営業中 + 2週間以上滞留 → 終了
    3. 提案DB: 提案中 + 1週間以上滞留 → 終了
    4. 提案DB: 候補 + 紐付き要員/案件がステップ1-2で終了 → 終了（連鎖）
    """
    print("\n🔄 滞留レコードの自動終了処理を開始...")

    results = {
        "要員_terminated": [],
        "案件_terminated": [],
        "提案中_terminated": [],
        "候補_terminated": [],
    }

    terminated_youin_ids = set()
    terminated_anken_ids = set()

    # Step 1: 要員DB - 営業中 + 2週間以上 → 終了
    for item in youin_analysis.get("期限超過", []):
        if item.get("status") == "営業中" and item.get("page_id"):
            if update_notion_status(item["page_id"], "終了"):
                terminated_youin_ids.add(item["page_id"])
                results["要員_terminated"].append(item)

    # Step 2: 案件DB - 営業中 + 2週間以上 → 終了
    for item in anken_analysis.get("期限超過", []):
        if item.get("status") == "営業中" and item.get("page_id"):
            if update_notion_status(item["page_id"], "終了"):
                terminated_anken_ids.add(item["page_id"])
                results["案件_terminated"].append(item)

    # Step 3: 提案DB - 提案中 + 1週間以上 → 見送り
    for item in teian_analysis.get("提案中_期限超過", []):
        if item.get("page_id"):
            if update_notion_status(item["page_id"], "見送り"):
                results["提案中_terminated"].append(item)

    # Step 4: 提案DB - 候補で紐付き要員/案件が終了 → 見送り（連鎖）
    if terminated_youin_ids or terminated_anken_ids:
        for item in teian_analysis.get("候補_with_relations", []):
            youin_ids = set(item.get("youin_ids", []))
            anken_ids = set(item.get("anken_ids", []))
            if youin_ids & terminated_youin_ids or anken_ids & terminated_anken_ids:
                if update_notion_status(item["page_id"], "見送り"):
                    results["候補_terminated"].append(item)

    total = sum(len(v) for v in results.values())
    print(f"  合計 {total}件を自動終了しました。\n")

    return results


def analyze_cost():
    """営業コスト管理DBを分析"""
    print("💰 営業コスト管理DBを取得中...")
    data = query_database(DB_IDS["営業コスト"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    # 対象週のデータを探す
    target_week_str = WEEK_START.strftime("%Y-%m-%d")
    target_week_data = None
    for page in results:
        week_start = get_property_value(page, "週開始日")
        if week_start and week_start.startswith(target_week_str):
            target_week_data = page
            break

    if not target_week_data:
        return {"message": "該当週のデータが見つかりません"}

    # 対象週の累積稼働時間を取得
    current_cumulative = get_property_value(target_week_data, "累積稼働時間（h）")

    # 週間稼働時間を計算（前週との差分）
    weekly_hours = current_cumulative  # デフォルトは累積がそのまま週間（第1週の場合）

    # 同じ月の前週を探す
    target_week_start = get_property_value(target_week_data, "週開始日")
    if target_week_start:
        target_date = datetime.fromisoformat(target_week_start)
        target_month = target_date.strftime("%Y-%m")

        # その月の全レコードを週開始日でソート
        month_records = []
        for page in results:
            week_start = get_property_value(page, "週開始日")
            if week_start and week_start.startswith(target_month):
                cumulative = get_property_value(page, "累積稼働時間（h）")
                if cumulative is not None:
                    month_records.append({
                        "week_start": week_start,
                        "cumulative": cumulative
                    })

        # 週開始日でソート
        month_records.sort(key=lambda x: x["week_start"])

        # 対象週の前週を探す
        for i, record in enumerate(month_records):
            if record["week_start"] == target_week_start and i > 0:
                # 前週が見つかった
                prev_cumulative = month_records[i - 1]["cumulative"]
                weekly_hours = current_cumulative - prev_cumulative
                print(f"  前週の累積: {prev_cumulative}h → 週間稼働: {weekly_hours}h")
                break

    # 月間予算時間を取得
    monthly_budget = get_property_value(target_week_data, "月間予算時間（h）")

    # 固定時間単価で金額を計算（端数切り捨て）
    actual_amount = int(current_cumulative * HOURLY_RATE) if current_cumulative else 0
    budget_amount = int(monthly_budget * HOURLY_RATE) if monthly_budget else 0

    # 予算消化率を計算
    budget_rate = round((current_cumulative / monthly_budget * 100), 1) if monthly_budget and monthly_budget > 0 else 0

    return {
        "累積稼働時間": current_cumulative,
        "週間稼働時間": weekly_hours,
        "月間予算時間": monthly_budget,
        "時間単価": HOURLY_RATE,
        "予算消化率": budget_rate,
        "実績金額": actual_amount,
        "予算金額": budget_amount
    }

def analyze_trends():
    """週次トレンド分析（前週比較）- コントロール可能な活動量を追跡"""
    print("📈 トレンド分析中...")

    # 前週の範囲
    PREV_WEEK_START = WEEK_START - timedelta(days=7)
    PREV_WEEK_END = WEEK_END - timedelta(days=7)

    # 今週のデータ（コントロール可能な活動量）
    current_week = {
        "提案新規": 0,
        "要員新規": 0,
        "案件新規": 0,
        "提案_候補": 0,
        "提案_提案中": 0,
        "提案_面談": 0
    }

    # 前週のデータ
    prev_week = {
        "提案新規": 0,
        "要員新規": 0,
        "案件新規": 0,
        "提案_候補": 0,
        "提案_提案中": 0,
        "提案_面談": 0
    }

    # 提案DB分析（候補と提案中をカウント）
    teian_data = query_database(DB_IDS["提案"])
    if teian_data:
        for page in teian_data.get("results", []):
            created_time = get_property_value(page, "提案作成日")
            status = get_property_value(page, "ステータス")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                if WEEK_START <= created_dt <= WEEK_END:
                    current_week["提案新規"] += 1
                    if status == "候補":
                        current_week["提案_候補"] += 1
                    elif status == "提案中":
                        current_week["提案_提案中"] += 1
                    elif status == "面談":
                        current_week["提案_面談"] += 1
                elif PREV_WEEK_START <= created_dt <= PREV_WEEK_END:
                    prev_week["提案新規"] += 1
                    if status == "候補":
                        prev_week["提案_候補"] += 1
                    elif status == "提案中":
                        prev_week["提案_提案中"] += 1
                    elif status == "面談":
                        prev_week["提案_面談"] += 1

    # 要員DB分析
    youin_data = query_database(DB_IDS["要員"], filter_params=YOUIN_EXCLUDE_DONE_FILTER)
    if youin_data:
        for page in youin_data.get("results", []):
            created_time = get_property_value(page, "要員回収日")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                if WEEK_START <= created_dt <= WEEK_END:
                    current_week["要員新規"] += 1
                elif PREV_WEEK_START <= created_dt <= PREV_WEEK_END:
                    prev_week["要員新規"] += 1

    # 案件DB分析
    anken_data = query_database(DB_IDS["案件"])
    if anken_data:
        for page in anken_data.get("results", []):
            created_time = get_property_value(page, "案件回収日")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                if WEEK_START <= created_dt <= WEEK_END:
                    current_week["案件新規"] += 1
                elif PREV_WEEK_START <= created_dt <= PREV_WEEK_END:
                    prev_week["案件新規"] += 1

    return {"current": current_week, "previous": prev_week}

def analyze_status_changes():
    """ステータス変更履歴DBから期間中の変化を分析"""
    print("🔄 ステータス変更履歴を取得中...")
    data = query_database(DB_IDS["ステータス変更履歴"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    # 前週の範囲
    PREV_WEEK_START = WEEK_START - timedelta(days=7)
    PREV_WEEK_END = WEEK_END - timedelta(days=7)

    # 期間中のステータス変化を集計
    analysis = {
        "提案": {
            "changes": defaultdict(int),  # "候補→提案中": 3 のような形式（今週）
            "prev_changes": defaultdict(int),  # 前週の遷移カウント
            "離脱_提案中": {"見送り": 0, "辞退": 0},
            "離脱_面談": {"見送り": 0, "辞退": 0}
        },
        "要員": {
            "changes": defaultdict(int)
        },
        "案件": {
            "changes": defaultdict(int)
        }
    }

    for page in results:
        # 変更日時を取得
        change_date = get_property_value(page, "変更日時")
        if not change_date:
            continue

        # 日時パース
        try:
            change_dt = datetime.fromisoformat(change_date.replace('Z', '+00:00')).replace(tzinfo=None)
        except:
            continue

        # 今週または前週のレコードのみ
        is_current = WEEK_START <= change_dt <= WEEK_END
        is_prev = PREV_WEEK_START <= change_dt <= PREV_WEEK_END
        if not is_current and not is_prev:
            continue

        db_type = get_property_value(page, "DB種別")
        old_status = get_property_value(page, "旧ステータス")
        new_status = get_property_value(page, "新ステータス")

        if not db_type or not old_status or not new_status:
            continue

        # 変化をカウント
        change_key = f"{old_status}→{new_status}"

        if db_type == "提案":
            if is_current:
                analysis["提案"]["changes"][change_key] += 1

                # 離脱分析（提案中・面談からの見送り・辞退のみ）
                if old_status == "提案中" and new_status in ["見送り", "辞退"]:
                    analysis["提案"]["離脱_提案中"][new_status] += 1
                elif old_status == "面談" and new_status in ["見送り", "辞退"]:
                    analysis["提案"]["離脱_面談"][new_status] += 1
            else:
                analysis["提案"]["prev_changes"][change_key] += 1

        elif db_type == "要員":
            if is_current:
                analysis["要員"]["changes"][change_key] += 1

        elif db_type == "案件":
            if is_current:
                analysis["案件"]["changes"][change_key] += 1

    return analysis


def analyze_roi(cost_analysis, status_change_analysis):
    """費用対効果（ROI）分析

    精査・打診・打ち合わせ: 営業コスト管理DBから取得（手入力）
    提案・面談・決定: ステータス変更履歴DBから自動集計
    """
    print("💹 費用対効果（ROI）分析中...")

    # 精査・打診・打合せ件数を営業コスト管理DBから取得
    seisa_count = 0
    dashin_count = 0
    uchiawase_count = 0

    cost_data = query_database(DB_IDS["営業コスト"])
    if cost_data:
        for page in cost_data.get("results", []):
            week_start = get_property_value(page, "週開始日")
            if week_start and week_start.startswith(WEEK_START.strftime("%Y-%m-%d")):
                seisa_count = get_property_value(page, "精査件数") or 0
                dashin_count = get_property_value(page, "打診件数") or 0
                uchiawase_count = get_property_value(page, "打合せ件数") or 0
                break

    # 提案・面談・決定件数をステータス変更履歴から集計
    teian_changes = status_change_analysis.get("提案", {}).get("changes", {})
    teian_count = teian_changes.get("候補→提案中", 0)
    mendan_count = teian_changes.get("提案中→面談", 0)
    kettei_count = 0
    for change_key, count in teian_changes.items():
        if change_key.endswith("→決定"):
            kettei_count += count

    # アクション別バリュー計算
    actions = {
        "精査": {"count": seisa_count, "unit_value": ACTION_VALUES["精査"]},
        "打診": {"count": dashin_count, "unit_value": ACTION_VALUES["打診"]},
        "打ち合わせ": {"count": uchiawase_count, "unit_value": ACTION_VALUES["打ち合わせ"]},
        "提案": {"count": teian_count, "unit_value": ACTION_VALUES["提案"]},
        "面談": {"count": mendan_count, "unit_value": ACTION_VALUES["面談"]},
        "決定": {"count": kettei_count, "unit_value": ACTION_VALUES["決定"]},
    }

    total_value = 0
    for action_name, data in actions.items():
        data["subtotal"] = data["count"] * data["unit_value"]
        total_value += data["subtotal"]

    # 決定除外バリュー
    process_value = total_value - actions["決定"]["subtotal"]

    # 実績コスト
    actual_cost = cost_analysis.get("実績金額", 0) if "message" not in cost_analysis else 0

    # ROI計算
    total_roi = round((total_value / actual_cost * 100), 1) if actual_cost > 0 else 0
    process_roi = round((process_value / actual_cost * 100), 1) if actual_cost > 0 else 0

    # 月間累積ROI（全週分を集計）
    monthly_seisa = 0
    monthly_dashin = 0
    monthly_uchiawase = 0
    if cost_data:
        target_month = WEEK_START.strftime("%Y-%m")
        for page in cost_data.get("results", []):
            week_start = get_property_value(page, "週開始日")
            if week_start and week_start.startswith(target_month):
                monthly_seisa += get_property_value(page, "精査件数") or 0
                monthly_dashin += get_property_value(page, "打診件数") or 0
                monthly_uchiawase += get_property_value(page, "打合せ件数") or 0

    # 月間のステータス変更を集計（全期間のデータを再利用）
    monthly_teian = 0
    monthly_mendan = 0
    monthly_kettei = 0

    all_status_data = query_database(DB_IDS["ステータス変更履歴"])
    if all_status_data:
        target_month = WEEK_START.strftime("%Y-%m")
        for page in all_status_data.get("results", []):
            change_date = get_property_value(page, "変更日時")
            if not change_date:
                continue
            try:
                change_dt = datetime.fromisoformat(change_date.replace('Z', '+00:00')).replace(tzinfo=None)
            except:
                continue
            if not change_dt.strftime("%Y-%m") == target_month:
                continue
            db_type = get_property_value(page, "DB種別")
            old_status = get_property_value(page, "旧ステータス")
            new_status = get_property_value(page, "新ステータス")
            if db_type == "提案":
                if old_status == "候補" and new_status == "提案中":
                    monthly_teian += 1
                elif old_status == "提案中" and new_status == "面談":
                    monthly_mendan += 1
                elif new_status == "決定":
                    monthly_kettei += 1

    monthly_value = (monthly_seisa * ACTION_VALUES["精査"]
                     + monthly_dashin * ACTION_VALUES["打診"]
                     + monthly_uchiawase * ACTION_VALUES["打ち合わせ"]
                     + monthly_teian * ACTION_VALUES["提案"]
                     + monthly_mendan * ACTION_VALUES["面談"]
                     + monthly_kettei * ACTION_VALUES["決定"])
    monthly_process_value = monthly_value - (monthly_kettei * ACTION_VALUES["決定"])

    monthly_cost = cost_analysis.get("実績金額", 0) if "message" not in cost_analysis else 0
    monthly_total_roi = round((monthly_value / monthly_cost * 100), 1) if monthly_cost > 0 else 0
    monthly_process_roi = round((monthly_process_value / monthly_cost * 100), 1) if monthly_cost > 0 else 0

    return {
        "actions": actions,
        "total_value": total_value,
        "process_value": process_value,
        "actual_cost": actual_cost,
        "total_roi": total_roi,
        "process_roi": process_roi,
        "monthly_total_roi": monthly_total_roi,
        "monthly_process_roi": monthly_process_roi,
        "monthly_value": monthly_value,
        "monthly_process_value": monthly_process_value,
        "monthly_cost": monthly_cost,
    }


def analyze_skill_match():
    """スキル需給マッチング分析"""
    print("🎯 スキル需給分析中...")

    # 案件で求められているスキル集計
    anken_skills = defaultdict(int)
    anken_data = query_database(DB_IDS["案件"])
    if anken_data:
        for page in anken_data.get("results", []):
            status = get_property_value(page, "ステータス")
            # アクティブな案件のみ（決定・終了以外）
            if status not in ["決定", "終了"]:
                skills = get_property_value(page, "スキル要件")
                if skills:
                    for skill in skills:
                        anken_skills[skill] += 1

    # 要員の保有スキル集計
    youin_skills = defaultdict(int)
    youin_data = query_database(DB_IDS["要員"], filter_params=YOUIN_EXCLUDE_DONE_FILTER)
    if youin_data:
        for page in youin_data.get("results", []):
            skills = get_property_value(page, "スキル概要")
            if skills:
                for skill in skills:
                    youin_skills[skill] += 1

    # 需給マッチング計算
    skill_match = []
    all_skills = set(list(anken_skills.keys()) + list(youin_skills.keys()))

    for skill in all_skills:
        demand = anken_skills.get(skill, 0)
        supply = youin_skills.get(skill, 0)
        match_rate = round((supply / demand * 100), 1) if demand > 0 else 0

        skill_match.append({
            "skill": skill,
            "demand": demand,
            "supply": supply,
            "match_rate": match_rate,
            "status": "✅" if match_rate >= 100 else "⚠️" if match_rate >= 50 else "🔴"
        })

    # 需要が多い順にソート
    skill_match.sort(key=lambda x: x["demand"], reverse=True)

    return {
        "skill_match": skill_match,
        "anken_skills": dict(anken_skills),
        "youin_skills": dict(youin_skills)
    }

def generate_report():
    """レポートを生成"""
    print(f"\n{'='*60}")
    print(f"週次レポート生成: {WEEK_LABEL}")
    print(f"{'='*60}\n")

    # データ取得
    teian_analysis = analyze_teian()
    youin_analysis = analyze_youin()
    anken_analysis = analyze_anken()
    cost_analysis = analyze_cost()
    trend_analysis = analyze_trends()
    skill_analysis = analyze_skill_match()
    status_change_analysis = analyze_status_changes()
    roi_analysis = analyze_roi(cost_analysis, status_change_analysis)

    # 滞留レコードの自動終了処理
    terminate_results = auto_terminate_stagnant(teian_analysis, youin_analysis, anken_analysis)

    print(f"\n{'='*60}")
    print("✅ データ取得・自動終了処理完了")
    print(f"{'='*60}\n")

    # レポート出力
    report = f"""# 📊 週次レポート - {WEEK_LABEL}

レポート作成日: {datetime.now().strftime('%Y年%m月%d日 %H:%M')}

---

## 💰 営業コスト

"""

    if "message" in cost_analysis:
        report += f"⚠️ {cost_analysis['message']}\n\n"
        report += "営業コスト管理DBに以下の形式でデータを入力してください:\n"
        report += f"- 対象週: {WEEK_LABEL}\n"
        report += f"- 週開始日: {WEEK_START.strftime('%Y-%m-%d')}\n"
        report += f"- 累積稼働時間（h）: 月初からの累積時間を入力\n\n"
    else:
        report += "| 項目 | 値 |\n"
        report += "|------|-----|\n"
        report += f"| 週間稼働時間 | {cost_analysis.get('週間稼働時間', '-')} h |\n"
        report += f"| 累積稼働時間 | {cost_analysis.get('累積稼働時間', '-')} h |\n"
        report += f"| 月間予算時間 | {cost_analysis.get('月間予算時間', '-')} h |\n"
        report += f"| 予算消化率 | {cost_analysis.get('予算消化率', '-')} % |\n"
        report += f"| 時間単価 | ¥{cost_analysis.get('時間単価', '-')}/h |\n"
        jisseki = cost_analysis.get('実績金額', '-')
        yosan = cost_analysis.get('予算金額', '-')
        report += f"| 実績金額 | ¥{jisseki:,} |\n" if isinstance(jisseki, (int, float)) else f"| 実績金額 | {jisseki} |\n"
        report += (f"| 予算金額 | ¥{yosan:,} |\n\n" if isinstance(yosan, (int, float)) else f"| 予算金額 | {yosan} |\n\n")

    # =============================================
    # セクション2: 🎯 営業アクションサマリー
    # =============================================
    report += "## 🎯 営業アクションサマリー\n\n"

    # Graph A: 営業アクション横棒グラフ（人的活動量）
    action_labels = ["精査", "打診", "打合せ", "提案", "面談", "決定"]
    action_keys = ["精査", "打診", "打ち合わせ", "提案", "面談", "決定"]
    action_counts = [roi_analysis["actions"][k]["count"] for k in action_keys]
    action_colors = [
        "rgba(173, 216, 230, 0.8)",
        "rgba(135, 190, 220, 0.8)",
        "rgba(100, 160, 210, 0.8)",
        "rgba(65, 130, 200, 0.8)",
        "rgba(30, 100, 190, 0.8)",
        "rgba(0, 70, 180, 0.8)"
    ]

    action_chart_config = {
        "type": "horizontalBar",
        "data": {
            "labels": action_labels,
            "datasets": [{
                "label": "件数",
                "data": action_counts,
                "backgroundColor": action_colors,
                "borderColor": [c.replace("0.8", "1") for c in action_colors],
                "borderWidth": 1
            }]
        },
        "options": {
            "title": {
                "display": True,
                "text": "営業アクション実績（人的活動量）",
                "fontSize": 16
            },
            "scales": {
                "xAxes": [{
                    "ticks": {"beginAtZero": True, "stepSize": 1},
                    "scaleLabel": {"display": True, "labelString": "件数"}
                }]
            },
            "legend": {"display": False}
        }
    }
    action_chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(action_chart_config))}&width=700&height=350"
    report += f"![営業アクション実績]({action_chart_url})\n\n"

    # アクション別バリューテーブル
    report += "### アクション別バリュー\n\n"
    report += "| アクション | 件数 | 仮想単価 | 小計 |\n"
    report += "|-----------|------|---------|------|\n"
    for action_name in ["精査", "打診", "打ち合わせ", "提案", "面談", "決定"]:
        data = roi_analysis["actions"][action_name]
        report += f"| {action_name} | {data['count']}件 | ¥{data['unit_value']:,} | ¥{data['subtotal']:,} |\n"
    report += f"| 合計バリュー | | | ¥{roi_analysis['total_value']:,} |\n\n"

    # コスト vs バリュー バーチャート
    roi_chart_config = {
        "type": "bar",
        "data": {
            "labels": ["投資（コスト）", "回収（総合）", "回収（プロセス）"],
            "datasets": [{
                "label": "金額",
                "data": [roi_analysis["actual_cost"], roi_analysis["total_value"], roi_analysis["process_value"]],
                "backgroundColor": [
                    "rgba(255, 99, 132, 0.7)",
                    "rgba(54, 162, 235, 0.7)",
                    "rgba(75, 192, 192, 0.7)"
                ],
                "borderColor": [
                    "rgb(255, 99, 132)",
                    "rgb(54, 162, 235)",
                    "rgb(75, 192, 192)"
                ],
                "borderWidth": 1
            }]
        },
        "options": {
            "title": {
                "display": True,
                "text": "コスト vs 営業バリュー",
                "fontSize": 16
            },
            "scales": {
                "yAxes": [{
                    "ticks": {"beginAtZero": True},
                    "scaleLabel": {"display": True, "labelString": "金額（円）"}
                }]
            },
            "legend": {"display": False}
        }
    }
    roi_chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(roi_chart_config))}&width=700&height=400"
    report += f"![コスト vs バリュー]({roi_chart_url})\n\n"

    # ROIサマリー
    report += "### ROIサマリー\n\n"
    report += "| 項目 | 週次 | 月間累積 |\n"
    report += "|------|------|----------|\n"

    total_roi = roi_analysis["total_roi"]
    roi_badge = "✅" if total_roi >= 100 else "⚠️" if total_roi >= 80 else "🔴"
    process_roi = roi_analysis["process_roi"]
    proc_badge = "✅" if process_roi >= 100 else "⚠️" if process_roi >= 80 else "🔴"
    m_total_roi = roi_analysis["monthly_total_roi"]
    m_badge = "✅" if m_total_roi >= 100 else "⚠️" if m_total_roi >= 80 else "🔴"
    m_process_roi = roi_analysis["monthly_process_roi"]
    mp_badge = "✅" if m_process_roi >= 100 else "⚠️" if m_process_roi >= 80 else "🔴"

    report += f"| 投資（コスト） | ¥{roi_analysis['actual_cost']:,} | ¥{roi_analysis['monthly_cost']:,} |\n"
    report += f"| 回収（バリュー） | ¥{roi_analysis['total_value']:,} | ¥{roi_analysis['monthly_value']:,} |\n"
    report += f"| 総合ROI | {total_roi}% {roi_badge} | {m_total_roi}% {m_badge} |\n"
    report += f"| プロセスROI | {process_roi}% {proc_badge} | {m_process_roi}% {mp_badge} |\n\n"

    # 判定メッセージ
    if total_roi >= 100:
        report += "✅ 投資以上のバリューを創出しています。\n\n"
    elif total_roi >= 80:
        report += "⚠️ あと少しで投資回収です。面談・提案の積み上げを意識しましょう。\n\n"
    else:
        report += "🔴 投資回収に向けて、精査・打診のアクション量を増やしましょう。\n\n"

    report += "---\n\n"

    # =============================================
    # セクション3: 📊 提案プロセス分析
    # =============================================
    report += "## 📊 提案プロセス分析\n\n"

    curr = trend_analysis["current"]
    prev = trend_analysis["previous"]
    teian_changes = status_change_analysis.get("提案", {}).get("changes", {})
    prev_teian_changes = status_change_analysis.get("提案", {}).get("prev_changes", {})

    # Graph B: 提案プロセス棒グラフ — ステータス遷移ベース
    process_chart_config = {
        "type": "bar",
        "data": {
            "labels": ["前週", "今週"],
            "datasets": [
                {
                    "label": "AI候補生成",
                    "data": [prev["提案新規"], curr["提案新規"]],
                    "backgroundColor": "rgba(201, 203, 207, 0.7)",
                    "borderColor": "rgb(201, 203, 207)",
                    "borderWidth": 1
                },
                {
                    "label": "候補→提案中",
                    "data": [prev_teian_changes.get("候補→提案中", 0), teian_changes.get("候補→提案中", 0)],
                    "backgroundColor": "rgba(54, 162, 235, 0.7)",
                    "borderColor": "rgb(54, 162, 235)",
                    "borderWidth": 1
                },
                {
                    "label": "提案中→面談",
                    "data": [prev_teian_changes.get("提案中→面談", 0), teian_changes.get("提案中→面談", 0)],
                    "backgroundColor": "rgba(75, 192, 192, 0.7)",
                    "borderColor": "rgb(75, 192, 192)",
                    "borderWidth": 1
                }
            ]
        },
        "options": {
            "title": {
                "display": True,
                "text": "提案プロセス推移（遷移実績ベース）",
                "fontSize": 16
            },
            "scales": {
                "xAxes": [{"stacked": False}],
                "yAxes": [{
                    "stacked": False,
                    "ticks": {"beginAtZero": True},
                    "scaleLabel": {"display": True, "labelString": "件数"}
                }]
            },
            "legend": {"display": True, "position": "top"}
        }
    }
    process_chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(process_chart_config))}&width=700&height=400"
    report += f"![提案プロセス内訳]({process_chart_url})\n\n"

    # 3分類テーブル
    ai_koho_count = len(teian_analysis.get("新規登録_週内", []))
    jinteki_count = teian_changes.get("候補→提案中", 0)
    yuuko_count = teian_changes.get("提案中→面談", 0)

    report += "### 提案活動の3分類\n\n"
    report += "| 分類 | 件数 | 説明 |\n"
    report += "|------|------|------|\n"
    report += f"| AI候補生成 | {ai_koho_count}件 | AIマッチングによる自動候補生成 |\n"
    report += f"| 人的提案数 | {jinteki_count}件 | 候補→提案中（人的判断で精査・提案） |\n"
    report += f"| 有効提案数 | {yuuko_count}件 | 提案中→面談以降（実質的な進捗） |\n\n"

    # 転換率テーブル（メインKPI）— ステータス変更履歴DBの遷移実績ベース
    report += "### 転換率（メインKPI）\n\n"

    prev_changes = status_change_analysis.get("提案", {}).get("prev_changes", {})
    curr_koho_to_teian_count = teian_changes.get("候補→提案中", 0)
    prev_koho_to_teian_count = prev_changes.get("候補→提案中", 0)
    curr_new = curr["提案新規"]
    prev_new = prev["提案新規"]
    curr_koho_to_teian_rate = round((curr_koho_to_teian_count / curr_new * 100), 1) if curr_new > 0 else 0
    prev_koho_to_teian_rate = round((prev_koho_to_teian_count / prev_new * 100), 1) if prev_new > 0 else 0
    diff_koho = round(curr_koho_to_teian_rate - prev_koho_to_teian_rate, 1)

    curr_teian_to_mendan_count = teian_changes.get("提案中→面談", 0)
    prev_teian_to_mendan_count = prev_changes.get("提案中→面談", 0)
    curr_teian_to_mendan_rate = round((curr_teian_to_mendan_count / curr_koho_to_teian_count * 100), 1) if curr_koho_to_teian_count > 0 else 0
    prev_teian_to_mendan_rate = round((prev_teian_to_mendan_count / prev_koho_to_teian_count * 100), 1) if prev_koho_to_teian_count > 0 else 0
    diff_mendan = round(curr_teian_to_mendan_rate - prev_teian_to_mendan_rate, 1)

    report += "| 転換指標 | 今週 | 前週 | 増減 |\n"
    report += "|----------|------|------|------|\n"
    report += f"| 候補→提案中 | {curr_koho_to_teian_rate}% ({curr_koho_to_teian_count}/{curr_new}) | {prev_koho_to_teian_rate}% ({prev_koho_to_teian_count}/{prev_new}) | {'+' if diff_koho > 0 else ''}{diff_koho}% |\n"
    report += f"| 提案中→面談 | {curr_teian_to_mendan_rate}% ({curr_teian_to_mendan_count}/{curr_koho_to_teian_count}) | {prev_teian_to_mendan_rate}% ({prev_teian_to_mendan_count}/{prev_koho_to_teian_count}) | {'+' if diff_mendan > 0 else ''}{diff_mendan}% |\n\n"

    if curr_koho_to_teian_rate < 20:
        report += "🔴 転換率が低いです。候補案件の精査基準や判断スピードを見直しましょう。\n\n"
    elif curr_koho_to_teian_rate < 50:
        report += "⚠️ 転換率の改善余地があります。候補案件を積極的に精査しましょう。\n\n"
    else:
        report += "✅ 転換率は良好です。現状のペースを維持しましょう。\n\n"

    report += "---\n\n"

    # ステータス変化分析（履歴DBから）
    report += "## 🔄 期間中のステータス変化\n\n"

    teian_changes = status_change_analysis.get("提案", {}).get("changes", {})
    youin_changes = status_change_analysis.get("要員", {}).get("changes", {})
    anken_changes = status_change_analysis.get("案件", {}).get("changes", {})

    # 提案DBのステータス変化
    report += "### 📋 提案DB\n\n"
    if teian_changes:
        report += "| 変化 | 件数 |\n"
        report += "|------|------|\n"
        # 進捗順にソート（候補→提案中→面談→内定→決定）
        status_order = ["候補", "提案中", "面談", "内定", "決定", "見送り", "辞退", "終了"]
        sorted_changes = sorted(teian_changes.items(),
                                key=lambda x: (status_order.index(x[0].split("→")[0]) if x[0].split("→")[0] in status_order else 99,
                                               status_order.index(x[0].split("→")[1]) if x[0].split("→")[1] in status_order else 99))
        for change, count in sorted_changes:
            report += f"| {change} | {count}件 |\n"
        report += "\n"

        # 転換率の計算（期間中の実績）
        koho_to_teian = teian_changes.get("候補→提案中", 0)
        teian_to_mendan = teian_changes.get("提案中→面談", 0)
        mendan_to_naitei = teian_changes.get("面談→内定", 0)
        naitei_to_kettei = teian_changes.get("内定→決定", 0)

        report += "**期間中の転換実績:**\n"
        if koho_to_teian > 0:
            report += f"- 候補→提案中: {koho_to_teian}件\n"
        if teian_to_mendan > 0:
            report += f"- 提案中→面談: {teian_to_mendan}件\n"
        if mendan_to_naitei > 0:
            report += f"- 面談→内定: {mendan_to_naitei}件\n"
        if naitei_to_kettei > 0:
            report += f"- 内定→決定: {naitei_to_kettei}件\n"
        report += "\n"
    else:
        report += "期間中のステータス変化なし\n\n"

    # 離脱分析（提案中・面談からのみ）
    teian_ridatsu_teianchu = status_change_analysis.get("提案", {}).get("離脱_提案中", {})
    teian_ridatsu_mendan = status_change_analysis.get("提案", {}).get("離脱_面談", {})

    ridatsu_teianchu_total = teian_ridatsu_teianchu.get("見送り", 0) + teian_ridatsu_teianchu.get("辞退", 0)
    ridatsu_mendan_total = teian_ridatsu_mendan.get("見送り", 0) + teian_ridatsu_mendan.get("辞退", 0)

    if ridatsu_teianchu_total > 0 or ridatsu_mendan_total > 0:
        report += "### ⚠️ 離脱分析（提案中・面談から）\n\n"
        report += "| 離脱元 | 見送り | 辞退 | 計 |\n"
        report += "|--------|--------|------|----|\n"
        if ridatsu_teianchu_total > 0:
            report += f"| 提案中から | {teian_ridatsu_teianchu.get('見送り', 0)}件 | {teian_ridatsu_teianchu.get('辞退', 0)}件 | {ridatsu_teianchu_total}件 |\n"
        if ridatsu_mendan_total > 0:
            report += f"| 面談から | {teian_ridatsu_mendan.get('見送り', 0)}件 | {teian_ridatsu_mendan.get('辞退', 0)}件 | {ridatsu_mendan_total}件 |\n"
        report += "\n"

    # 要員DBのステータス変化
    report += "### 👤 要員DB\n\n"
    if youin_changes:
        report += "| 変化 | 件数 |\n"
        report += "|------|------|\n"
        for change, count in youin_changes.items():
            report += f"| {change} | {count}件 |\n"
        report += "\n"
    else:
        report += "期間中のステータス変化なし\n\n"

    # 案件DBのステータス変化
    report += "### 🧾 案件DB\n\n"
    if anken_changes:
        report += "| 変化 | 件数 |\n"
        report += "|------|------|\n"
        for change, count in anken_changes.items():
            report += f"| {change} | {count}件 |\n"
        report += "\n"
    else:
        report += "期間中のステータス変化なし\n\n"

    report += "---\n\n"

    # スキル需給分析
    report += "## 🎯 スキル需給マッチング分析\n\n"

    skill_match = skill_analysis["skill_match"]

    if skill_match:
        # TOP10スキルのみ表示
        top_skills = skill_match[:10]

        # 円グラフ2つ（案件需要 vs 要員供給）
        demand_labels = [s["skill"] for s in top_skills if s["demand"] > 0]
        demand_data = [s["demand"] for s in top_skills if s["demand"] > 0]

        supply_labels = [s["skill"] for s in top_skills if s["supply"] > 0]
        supply_data = [s["supply"] for s in top_skills if s["supply"] > 0]

        # 案件需要円グラフ
        demand_chart_config = {
            "type": "outlabeledPie",
            "data": {
                "labels": demand_labels,
                "datasets": [{
                    "data": demand_data,
                    "backgroundColor": [
                        "rgba(255, 99, 132, 0.8)",
                        "rgba(54, 162, 235, 0.8)",
                        "rgba(255, 206, 86, 0.8)",
                        "rgba(75, 192, 192, 0.8)",
                        "rgba(153, 102, 255, 0.8)",
                        "rgba(255, 159, 64, 0.8)",
                        "rgba(199, 199, 199, 0.8)",
                        "rgba(83, 102, 255, 0.8)",
                        "rgba(255, 102, 178, 0.8)",
                        "rgba(102, 255, 178, 0.8)"
                    ]
                }]
            },
            "options": {
                "title": {
                    "display": True,
                    "text": "案件スキル需要"
                },
                "plugins": {
                    "legend": {
                        "display": True,
                        "position": "right"
                    },
                    "outlabels": {
                        "text": "%l: %p",
                        "color": "white",
                        "stretch": 15,
                        "font": {
                            "resizable": True,
                            "minSize": 10,
                            "maxSize": 14
                        }
                    }
                }
            }
        }

        demand_chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(demand_chart_config))}&width=500&height=300"

        # 要員供給円グラフ
        supply_chart_config = {
            "type": "outlabeledPie",
            "data": {
                "labels": supply_labels,
                "datasets": [{
                    "data": supply_data,
                    "backgroundColor": [
                        "rgba(75, 192, 192, 0.8)",
                        "rgba(153, 102, 255, 0.8)",
                        "rgba(255, 159, 64, 0.8)",
                        "rgba(255, 99, 132, 0.8)",
                        "rgba(54, 162, 235, 0.8)",
                        "rgba(255, 206, 86, 0.8)",
                        "rgba(199, 199, 199, 0.8)",
                        "rgba(83, 102, 255, 0.8)",
                        "rgba(255, 102, 178, 0.8)",
                        "rgba(102, 255, 178, 0.8)"
                    ]
                }]
            },
            "options": {
                "title": {
                    "display": True,
                    "text": "要員スキル供給"
                },
                "plugins": {
                    "legend": {
                        "display": True,
                        "position": "right"
                    },
                    "outlabels": {
                        "text": "%l: %p",
                        "color": "white",
                        "stretch": 15,
                        "font": {
                            "resizable": True,
                            "minSize": 10,
                            "maxSize": 14
                        }
                    }
                }
            }
        }

        supply_chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(supply_chart_config))}&width=500&height=300"

        report += f"### 案件スキル需要 vs 要員スキル供給\n\n"
        report += f"![案件需要]({demand_chart_url})\n\n"
        report += f"![要員供給]({supply_chart_url})\n\n"

        # スキルマッチング表
        report += "### スキル需給一覧（TOP10）\n\n"
        report += "| スキル | 案件需要 | 要員供給 | 充足率 | 状態 |\n"
        report += "|--------|----------|----------|--------|------|\n"
        for skill_info in top_skills:
            report += f"| {skill_info['skill']} | {skill_info['demand']}件 | {skill_info['supply']}名 | {skill_info['match_rate']}% | {skill_info['status']} |\n"
        report += "\n"
    else:
        report += "⚠️ スキルデータがありません\n\n"

    report += "---\n\n"
    report += "## ⚠️ 期限超過アラート\n\n"

    # 自動終了処理結果
    total_terminated = sum(len(v) for v in terminate_results.values())
    terminated_ids = set()
    for items in terminate_results.values():
        for item in items:
            terminated_ids.add(item.get("page_id", ""))

    if total_terminated > 0:
        report += f"### 🔄 自動終了処理（合計 {total_terminated}件）\n\n"
        report += "以下のレコードを自動的に「終了」ステータスに変更しました。\n\n"

        # 要員DB 営業中→終了
        if terminate_results["要員_terminated"]:
            report += f"#### 👤 要員DB（営業中 → 終了: {len(terminate_results['要員_terminated'])}件）\n\n"
            report += "| 要員名 | 回収日 | 経過日数 | 担当 |\n"
            report += "|--------|--------|----------|------|\n"
            for item in terminate_results["要員_terminated"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['担当']} |\n"
            report += "\n"

        # 案件DB 営業中→終了
        if terminate_results["案件_terminated"]:
            report += f"#### 🧾 案件DB（営業中 → 終了: {len(terminate_results['案件_terminated'])}件）\n\n"
            report += "| 案件名 | 回収日 | 経過日数 | 担当 |\n"
            report += "|--------|--------|----------|------|\n"
            for item in terminate_results["案件_terminated"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['担当']} |\n"
            report += "\n"

        # 提案DB 提案中→終了
        if terminate_results["提案中_terminated"]:
            report += f"#### 📋 提案DB 提案中 → 見送り: {len(terminate_results['提案中_terminated'])}件\n\n"
            report += "| 提案名 | 提案日 | 経過日数 | 案件担当 | 要員担当 |\n"
            report += "|--------|--------|----------|----------|----------|\n"
            for item in terminate_results["提案中_terminated"]:
                report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['days']}日 | {item['案件担当']} | {item['要員担当']} |\n"
            report += "\n"

        # 提案DB 候補→終了（連鎖）
        if terminate_results["候補_terminated"]:
            report += f"#### 📋 提案DB 候補 → 見送り（連鎖）: {len(terminate_results['候補_terminated'])}件\n\n"
            report += "| 提案名 | 作成日 | 案件担当 | 要員担当 |\n"
            report += "|--------|--------|----------|----------|\n"
            for item in terminate_results["候補_terminated"]:
                report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['案件担当']} | {item['要員担当']} |\n"
            report += "\n"
    else:
        report += "### 🔄 自動終了処理\n\n"
        report += "自動終了対象のレコードはありませんでした。\n\n"

    # 自動終了対象外の期限超過（要確認）
    remaining_koho = [item for item in teian_analysis.get("候補_滞留", []) if item.get("page_id") not in terminated_ids]
    remaining_youin = [item for item in youin_analysis.get("期限超過", []) if item.get("page_id") not in terminated_ids]
    remaining_anken = [item for item in anken_analysis.get("期限超過", []) if item.get("page_id") not in terminated_ids]

    has_remaining = remaining_koho or remaining_youin or remaining_anken
    if has_remaining:
        report += "### ⚠️ 要確認（自動終了対象外の期限超過）\n\n"

        if remaining_koho:
            report += f"#### 📋 提案DB（候補で1週間以上滞留: {len(remaining_koho)}件）\n\n"
            report += "| 提案名 | 作成日 | 経過日数 | 案件担当 | 要員担当 |\n"
            report += "|--------|--------|----------|----------|----------|\n"
            for item in remaining_koho:
                report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['days']}日 | {item['案件担当']} | {item['要員担当']} |\n"
            report += "\n"

        if remaining_youin:
            report += f"#### 👤 要員DB（営業中以外で2週間以上経過: {len(remaining_youin)}件）\n\n"
            report += "| 要員名 | 回収日 | 経過日数 | ステータス | 担当 |\n"
            report += "|--------|--------|----------|------------|------|\n"
            for item in remaining_youin:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['status']} | {item['担当']} |\n"
            report += "\n"

        if remaining_anken:
            report += f"#### 🧾 案件DB（営業中以外で2週間以上経過: {len(remaining_anken)}件）\n\n"
            report += "| 案件名 | 回収日 | 経過日数 | ステータス | 担当 |\n"
            report += "|--------|--------|----------|------------|------|\n"
            for item in remaining_anken:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['status']} | {item['担当']} |\n"
            report += "\n"

    # =============================================
    # セクション5: 📥 インプット指標（参考）
    # =============================================
    report += "---\n\n"
    report += "## 📥 インプット指標（参考）\n\n"
    report += "自動処理で取り込まれたデータ量の参考値です。\n\n"

    report += "| 指標 | 今週 | 前週 | 増減 |\n"
    report += "|------|------|------|------|\n"

    for key, label in [("要員新規", "要員新規登録"), ("案件新規", "案件新規登録")]:
        current_val = curr[key]
        prev_val = prev[key]
        diff = current_val - prev_val
        arrow = "⬆️" if diff > 0 else "⬇️" if diff < 0 else "➡️"
        sign = "+" if diff > 0 else ""
        report += f"| {label} | {current_val}件 | {prev_val}件 | {sign}{diff}件 {arrow} |\n"

    report += f"| AI候補生成数 | {len(teian_analysis.get('新規登録_週内', []))}件 | {prev['提案新規']}件 | （参考値） |\n\n"

    # 決定案件（あれば表示）
    if teian_analysis.get("決定_週内"):
        report += f"### ✅ 決定案件（{WEEK_LABEL}）\n\n"
        report += f"該当件数: {len(teian_analysis['決定_週内'])}件\n\n"
        report += "| 提案名 | 提案日 | 案件担当 | 要員担当 | 粗利見込 |\n"
        report += "|--------|--------|----------|----------|----------|\n"
        for item in teian_analysis["決定_週内"]:
            report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['案件担当']} | {item['要員担当']} | {item['粗利見込']} |\n"
        report += "\n"

    # データ駆動のアクション生成
    report += "---\n\n"
    report += "## 📝 次週アクション\n\n"

    action_num = 1

    # 1. 候補→提案中の転換促進（コントロール可能な重点指標）
    koho_count = teian_analysis.get("ステータス別", {}).get("候補", 0)
    if koho_count > 0:
        report += f"{action_num}. 候補案件の提案判断（{koho_count}件）\n"
        report += "   - 候補ステータスの案件を精査し、提案中へ進めるか判断\n"
        report += "   - 判定会議で継続/終了を決定\n\n"
        action_num += 1

    # 2. 自動終了処理結果と残存滞留案件
    if total_terminated > 0:
        report += f"{action_num}. 自動終了処理済み（{total_terminated}件）\n"
        report += "   - 詳細は「期限超過アラート」セクション参照\n\n"
        action_num += 1

    remaining_overdue = len(remaining_koho) + len(remaining_youin) + len(remaining_anken)
    if remaining_overdue > 0:
        report += f"{action_num}. 残存滞留案件の継続判定（{remaining_overdue}件）\n"
        if remaining_koho:
            report += f"   - 提案DB（候補）: {len(remaining_koho)}件が1週間以上滞留\n"
        if remaining_youin:
            report += f"   - 要員DB: {len(remaining_youin)}件が2週間以上滞留\n"
        if remaining_anken:
            report += f"   - 案件DB: {len(remaining_anken)}件が2週間以上滞留\n"
        report += "   - 判定会議で継続/終了を決定\n\n"
        action_num += 1

    # 3. 見送り状況の確認
    mimokuri_count = teian_analysis.get("ステータス別", {}).get("見送り", 0)
    jitai_count = teian_analysis.get("ステータス別", {}).get("辞退", 0)
    if mimokuri_count > 0 or jitai_count > 0:
        report += f"{action_num}. 見送り/辞退の傾向確認\n"
        if mimokuri_count > 0:
            report += f"   - 見送り: {mimokuri_count}件\n"
        if jitai_count > 0:
            report += f"   - 辞退: {jitai_count}件\n"
        report += "   - 提案精度向上のため、パターンを把握\n\n"
        action_num += 1

    # 4. スキル需給ギャップ対応
    skill_shortage = [s for s in skill_analysis.get("skill_match", []) if s.get("demand", 0) > 0 and s.get("match_rate", 100) < 100]
    if skill_shortage:
        top_shortage = skill_shortage[:3]
        report += f"{action_num}. スキル需給ギャップ対応\n"
        for s in top_shortage:
            report += f"   - {s['skill']}: 需要{s['demand']}件 vs 供給{s['supply']}名（充足率{s['match_rate']}%）\n"
        report += "   - パートナーへの要員募集を検討\n\n"
        action_num += 1

    # 5. コスト管理（予算超過の場合）
    if "message" not in cost_analysis:
        budget_rate = cost_analysis.get("予算消化率", 0)
        if budget_rate > 90:
            report += f"{action_num}. 営業コスト管理\n"
            report += f"   - 予算消化率: {budget_rate}%\n"
            if budget_rate > 100:
                report += "   - 予算超過中。成約率の高い案件に集中\n\n"
            else:
                report += "   - 残り予算を効率的に活用\n\n"
            action_num += 1

    # アクションがない場合
    if action_num == 1:
        report += "特になし。現状のペースを維持。\n\n"

    report += "---\n\n"
    report += f"レポート生成: Claude Code SES Analysis Skill v1.0.0\n"

    return report

def get_page_children(page_id):
    """ページの子ブロックを取得"""
    url = f"https://api.notion.com/v1/blocks/{page_id}/children"
    response = requests.get(url, headers=HEADERS)
    if response.status_code == 200:
        return response.json().get("results", [])
    return []

def delete_block(block_id):
    """ブロックを削除"""
    url = f"https://api.notion.com/v1/blocks/{block_id}"
    response = requests.delete(url, headers=HEADERS)
    return response.status_code == 200

def move_page(page_id, new_parent_id):
    """ページを別の親ページに移動"""
    url = f"https://api.notion.com/v1/pages/{page_id}"
    payload = {
        "parent": {"page_id": new_parent_id}
    }
    response = requests.patch(url, headers=HEADERS, json=payload)
    return response.status_code == 200

def clear_page_content(page_id):
    """ページの全コンテンツを削除"""
    print(f"📄 ページ内容をクリア中...")
    children = get_page_children(page_id)
    for child in children:
        delete_block(child["id"])
    print(f"  ✅ {len(children)}個のブロックを削除しました")

def update_latest_report_page(report_content):
    """最新週次レポートページを更新し、古いレポートを履歴に移動"""
    print("\n📤 最新週次レポートを更新中...")

    PARENT_PAGE_ID = "8d52d3fee1344c549e6715d24f7b8b4e"  # 親ページ（レポート一覧）
    HISTORY_PAGE_ID = "43cdef347c5042039b4f640e24d789bd"  # 週次レポート履歴

    # 親ページの子ページを検索して「週次レポート」を探す
    url = f"https://api.notion.com/v1/blocks/{PARENT_PAGE_ID}/children"
    response = requests.get(url, headers=HEADERS)

    existing_report_page_id = None
    if response.status_code == 200:
        children = response.json().get("results", [])
        for child in children:
            if child["type"] == "child_page":
                # ページタイトルを取得
                page_id = child["id"]
                page_url = f"https://api.notion.com/v1/pages/{page_id}"
                page_response = requests.get(page_url, headers=HEADERS)
                if page_response.status_code == 200:
                    page_data = page_response.json()
                    title_prop = page_data.get("properties", {}).get("title", {})
                    title_array = title_prop.get("title", [])
                    if title_array:
                        title = title_array[0].get("text", {}).get("content", "")
                        # 「週次レポート」または「2026年1月」のような週次レポートタイトルを検索
                        if "週" in title or "週次" in title:
                            existing_report_page_id = page_id
                            print(f"  📦 既存のレポート「{title}」を履歴に移動中...")
                            break

    # 既存の週次レポートがあれば履歴に移動
    if existing_report_page_id:
        move_page(existing_report_page_id, HISTORY_PAGE_ID)
        print(f"  ✅ 履歴に移動しました")

    # 新しいレポートページを作成
    return create_notion_page(report_content, parent_page_id=PARENT_PAGE_ID)

def create_notion_page(report_content, parent_page_id=None):
    """Notionページを作成してレポートを投稿"""
    print("\n📝 Notionページを作成中...")

    # デフォルトの親ページID（最新週次レポートページ）
    if not parent_page_id:
        parent_page_id = "04e37658d8f4412ebebe2bc6b1b6de32"  # 最新週次レポート

    # タイトル作成
    title = f"{WEEK_LABEL}"

    # Markdownを簡易的にNotionブロックに変換
    blocks = []
    lines = report_content.split('\n')

    i = 0
    while i < len(lines):
        line = lines[i].strip()

        # 空行はスキップ
        if not line:
            i += 1
            continue

        # 見出し（長いプレフィックスから判定。Notionはheading_3までなので####以上はheading_3にマッピング）
        if line.startswith('#### '):
            blocks.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"type": "text", "text": {"content": line[5:]}}]
                }
            })
        elif line.startswith('### '):
            blocks.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"type": "text", "text": {"content": line[4:]}}]
                }
            })
        elif line.startswith('## '):
            blocks.append({
                "object": "block",
                "type": "heading_2",
                "heading_2": {
                    "rich_text": [{"type": "text", "text": {"content": line[3:]}}]
                }
            })
        elif line.startswith('# '):
            blocks.append({
                "object": "block",
                "type": "heading_1",
                "heading_1": {
                    "rich_text": [{"type": "text", "text": {"content": line[2:]}}]
                }
            })
        # 画像
        elif line.startswith('![') and '](' in line and line.endswith(')'):
            # ![alt](url) 形式
            url_start = line.index('](') + 2
            url = line[url_start:-1]
            blocks.append({
                "object": "block",
                "type": "image",
                "image": {
                    "type": "external",
                    "external": {"url": url}
                }
            })
        # 区切り線
        elif line == '---':
            blocks.append({
                "object": "block",
                "type": "divider",
                "divider": {}
            })
        # テーブル（Notionネイティブテーブル）
        elif line.startswith('|'):
            # テーブル行を収集
            table_lines = [line]
            j = i + 1
            while j < len(lines) and lines[j].strip().startswith('|'):
                table_lines.append(lines[j].strip())
                j += 1

            # テーブル解析
            if len(table_lines) >= 2:
                # ヘッダー行
                header = [cell.strip() for cell in table_lines[0].split('|')[1:-1]]
                # データ行（セパレータ行をスキップ）
                data_rows = []
                for row_line in table_lines[2:]:
                    row = [cell.strip() for cell in row_line.split('|')[1:-1]]
                    if row:
                        data_rows.append(row)

                # Notionテーブルを作成
                if header:
                    table_width = len(header)
                    table_children = []

                    # ヘッダー行
                    header_cells = []
                    for cell in header:
                        header_cells.append([{"type": "text", "text": {"content": cell}}])
                    table_children.append({
                        "type": "table_row",
                        "table_row": {"cells": header_cells}
                    })

                    # データ行
                    for row in data_rows:
                        row_cells = []
                        for idx in range(table_width):
                            cell_content = row[idx] if idx < len(row) else ""
                            row_cells.append([{"type": "text", "text": {"content": cell_content}}])
                        table_children.append({
                            "type": "table_row",
                            "table_row": {"cells": row_cells}
                        })

                    blocks.append({
                        "object": "block",
                        "type": "table",
                        "table": {
                            "table_width": table_width,
                            "has_column_header": True,
                            "has_row_header": False,
                            "children": table_children
                        }
                    })

            i = j - 1  # テーブル終了位置に移動
        # 太字・通常テキスト
        else:
            # 1000文字制限対策
            if len(line) > 2000:
                line = line[:2000]

            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": line}}]
                }
            })

        i += 1

    # Notionページ作成（最大100ブロックずつ）
    url = "https://api.notion.com/v1/pages"

    # 最初のページ作成（最初の100ブロック）
    initial_blocks = blocks[:100]

    payload = {
        "parent": {"page_id": parent_page_id},
        "properties": {
            "title": {
                "title": [{"text": {"content": title}}]
            }
        },
        "children": initial_blocks
    }

    try:
        response = requests.post(url, headers=HEADERS, json=payload)
        response.raise_for_status()
        page_data = response.json()
        page_id = page_data["id"]
        page_url = page_data["url"]

        print(f"✅ Notionページを作成しました: {page_url}")

        # 残りのブロックを追加
        if len(blocks) > 100:
            remaining_blocks = blocks[100:]
            append_url = f"https://api.notion.com/v1/blocks/{page_id}/children"

            # 100ブロックずつ追加
            for batch_start in range(0, len(remaining_blocks), 100):
                batch = remaining_blocks[batch_start:batch_start + 100]
                append_payload = {"children": batch}

                response = requests.patch(append_url, headers=HEADERS, json=append_payload)
                response.raise_for_status()
                print(f"  📄 ブロック {batch_start + 100} ~ {min(batch_start + 200, len(blocks))} を追加")

        return {"success": True, "page_id": page_id, "page_url": page_url}

    except requests.exceptions.RequestException as e:
        print(f"❌ Notionページ作成エラー: {e}")
        if hasattr(e.response, 'text'):
            print(f"   詳細: {e.response.text}")
        return {"success": False, "error": str(e)}

if __name__ == "__main__":
    report = generate_report()

    # ファイルに保存
    output_file = "weekly_report_2025_01_20_complete.md"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n✅ レポートを {output_file} に保存しました\n")
    print(report)
