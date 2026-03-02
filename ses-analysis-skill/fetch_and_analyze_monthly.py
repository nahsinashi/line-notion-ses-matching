#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SES営業分析システム - 月次レポート自動生成スクリプト
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
for _env_dir in [_script_dir, _script_dir.parent, *_script_dir.parents]:
    _env_path = _env_dir / ".env"
    if _env_path.is_file():
        load_dotenv(_env_path)
        break

# Notion API設定
NOTION_API_KEY = os.environ.get("NOTION_API_KEY", "")
if not NOTION_API_KEY:
    print("❌ 環境変数 NOTION_API_KEY が設定されていません。")
    sys.exit(1)

NOTION_VERSION = "2022-06-28"
HEADERS = {
    "Authorization": f"Bearer {NOTION_API_KEY}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
}

# データベースID（環境変数またはデフォルト値）
DB_IDS = {
    "提案": os.environ.get("NOTION_DB_提案", "2c2c01f8-7769-8032-8e3a-c1bf4e933a67"),
    "要員": os.environ.get("NOTION_DB_要員", "2c2c01f8-7769-80c1-9af9-c5b101b91520"),
    "案件": os.environ.get("NOTION_DB_案件", "2c2c01f8-7769-8013-8dc0-ea41dac2c119"),
    "営業コスト": os.environ.get("NOTION_DB_営業コスト", "61b10c6d-e554-4c07-8214-2bcff662374a"),
    "ステータス変更履歴": os.environ.get("NOTION_DB_ステータス変更履歴", "35fd3c53-5d51-414f-b12f-c85521b3321b")
}

# 対象期間（デフォルト値、実行時に上書きされる）
MONTH_START = datetime(2026, 1, 1)
MONTH_END = datetime(2026, 1, 31, 23, 59, 59)
MONTH_LABEL = "2026年1月"

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
            print(f"❌ エラー: {response.status_code} - {response.text}")
            return None

        data = response.json()
        all_results.extend(data.get("results", []))

        if not data.get("has_more"):
            break
        start_cursor = data.get("next_cursor")

    return {"results": all_results}

def get_property_value(page, property_name):
    """ページプロパティから値を取得"""
    props = page.get("properties", {})
    prop = props.get(property_name, {})
    prop_type = prop.get("type")

    if prop_type == "title":
        title_list = prop.get("title", [])
        return title_list[0].get("text", {}).get("content", "") if title_list else ""
    elif prop_type == "rich_text":
        rich_text = prop.get("rich_text", [])
        return rich_text[0].get("text", {}).get("content", "") if rich_text else ""
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

def analyze_monthly_cost():
    """月次営業コスト分析"""
    print("💰 営業コスト管理DBを取得中...")
    data = query_database(DB_IDS["営業コスト"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    # 対象月のデータを収集
    month_records = []
    target_month = MONTH_START.strftime("%Y-%m")

    for page in results:
        week_start = get_property_value(page, "週開始日")
        if week_start and week_start.startswith(target_month):
            cumulative = get_property_value(page, "累積稼働時間（h）")
            if cumulative is not None:
                month_records.append({
                    "week_start": week_start,
                    "cumulative": cumulative
                })

    if not month_records:
        return {"message": "該当月のデータが見つかりません"}

    # 週開始日でソート
    month_records.sort(key=lambda x: x["week_start"])

    # 週別稼働時間を計算
    weekly_data = []
    for i, record in enumerate(month_records):
        if i == 0:
            # 第1週は累積がそのまま週間
            weekly_hours = record["cumulative"]
        else:
            # 前週との差分
            weekly_hours = record["cumulative"] - month_records[i - 1]["cumulative"]

        weekly_data.append({
            "week": f"第{i+1}週",
            "weekly_hours": weekly_hours,
            "cumulative": record["cumulative"]
        })

    # 月末の累積稼働時間
    total_hours = month_records[-1]["cumulative"]

    # 月間予算時間（最新レコードから取得）
    monthly_budget = get_property_value(
        [p for p in results if get_property_value(p, "週開始日") == month_records[-1]["week_start"]][0],
        "月間予算時間（h）"
    )

    # 金額計算（端数切り捨て）
    actual_amount = int(total_hours * HOURLY_RATE) if total_hours else 0
    budget_amount = int(monthly_budget * HOURLY_RATE) if monthly_budget else 0

    # 予算消化率
    budget_rate = round((total_hours / monthly_budget * 100), 1) if monthly_budget and monthly_budget > 0 else 0

    return {
        "total_hours": total_hours,
        "monthly_budget": monthly_budget,
        "budget_rate": budget_rate,
        "actual_amount": actual_amount,
        "budget_amount": budget_amount,
        "weekly_data": weekly_data
    }

def analyze_monthly_trends():
    """月次トレンド分析 - 週別推移"""
    print("📈 月次トレンド分析中...")

    # 月内の全週を取得（月曜日開始）
    weeks = []
    current = MONTH_START
    week_num = 1

    while current <= MONTH_END:
        # 週の開始（月曜日）
        week_start = current - timedelta(days=current.weekday())
        # 週の終了（日曜日）
        week_end = week_start + timedelta(days=6, hours=23, minutes=59, seconds=59)

        # 月内の部分のみ
        actual_start = max(week_start, MONTH_START)
        actual_end = min(week_end, MONTH_END)

        weeks.append({
            "num": week_num,
            "start": actual_start,
            "end": actual_end,
            "label": f"第{week_num}週",
            "提案新規": 0,
            "要員新規": 0,
            "案件新規": 0,
            "提案_候補": 0,
            "提案_提案中": 0,
            "提案_面談": 0
        })

        current = week_end + timedelta(seconds=1)
        week_num += 1

    # 提案DB分析（候補と提案中をカウント）
    teian_data = query_database(DB_IDS["提案"])
    if teian_data:
        for page in teian_data.get("results", []):
            created_time = get_property_value(page, "提案作成日")
            status = get_property_value(page, "ステータス")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                # どの週に属するか判定
                for week in weeks:
                    if week["start"] <= created_dt <= week["end"]:
                        week["提案新規"] += 1
                        if status == "候補":
                            week["提案_候補"] += 1
                        elif status == "提案中":
                            week["提案_提案中"] += 1
                        elif status == "面談":
                            week["提案_面談"] += 1
                        break

    # 要員DB分析
    youin_data = query_database(DB_IDS["要員"])
    if youin_data:
        for page in youin_data.get("results", []):
            created_time = get_property_value(page, "要員回収日")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                for week in weeks:
                    if week["start"] <= created_dt <= week["end"]:
                        week["要員新規"] += 1
                        break

    # 案件DB分析
    anken_data = query_database(DB_IDS["案件"])
    if anken_data:
        for page in anken_data.get("results", []):
            created_time = get_property_value(page, "案件回収日")

            if created_time:
                created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)

                for week in weeks:
                    if week["start"] <= created_dt <= week["end"]:
                        week["案件新規"] += 1
                        break

    return {"weeks": weeks}


def analyze_status_changes():
    """ステータス変更履歴DBから月間の変化を分析"""
    print("🔄 ステータス変更履歴を取得中...")
    data = query_database(DB_IDS["ステータス変更履歴"])
    if not data:
        return {}

    results = data.get("results", [])
    print(f"  取得件数: {len(results)}件")

    # 月内の全週を取得（月曜日開始）— 週別遷移集計用
    weekly_bins = []
    current = MONTH_START
    week_num = 1
    while current <= MONTH_END:
        week_start = current - timedelta(days=current.weekday())
        week_end = week_start + timedelta(days=6, hours=23, minutes=59, seconds=59)
        actual_start = max(week_start, MONTH_START)
        actual_end = min(week_end, MONTH_END)
        weekly_bins.append({
            "num": week_num,
            "start": actual_start,
            "end": actual_end,
            "label": f"第{week_num}週",
        })
        current = week_end + timedelta(seconds=1)
        week_num += 1

    # 月間のステータス変化を集計
    analysis = {
        "提案": {
            "changes": defaultdict(int),  # "候補→提案中": 3 のような形式
            "weekly_changes": [defaultdict(int) for _ in weekly_bins],  # 週別遷移カウント
            "離脱_提案中": {"見送り": 0, "辞退": 0},
            "離脱_面談": {"見送り": 0, "辞退": 0}
        },
        "要員": {
            "changes": defaultdict(int)
        },
        "案件": {
            "changes": defaultdict(int)
        },
        "weekly_labels": [w["label"] for w in weekly_bins]
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

        # 月内のレコードのみ
        if not (MONTH_START <= change_dt <= MONTH_END):
            continue

        db_type = get_property_value(page, "DB種別")
        old_status = get_property_value(page, "旧ステータス")
        new_status = get_property_value(page, "新ステータス")

        if not db_type or not old_status or not new_status:
            continue

        # 変化をカウント
        change_key = f"{old_status}→{new_status}"

        if db_type == "提案":
            analysis["提案"]["changes"][change_key] += 1

            # 週別遷移カウント
            for i, wb in enumerate(weekly_bins):
                if wb["start"] <= change_dt <= wb["end"]:
                    analysis["提案"]["weekly_changes"][i][change_key] += 1
                    break

            # 離脱分析（提案中・面談からの見送り・辞退のみ）
            if old_status == "提案中" and new_status in ["見送り", "辞退"]:
                analysis["提案"]["離脱_提案中"][new_status] += 1
            elif old_status == "面談" and new_status in ["見送り", "辞退"]:
                analysis["提案"]["離脱_面談"][new_status] += 1

        elif db_type == "要員":
            analysis["要員"]["changes"][change_key] += 1

        elif db_type == "案件":
            analysis["案件"]["changes"][change_key] += 1

    return analysis


def analyze_monthly_roi(cost_analysis, status_change_analysis):
    """月次費用対効果（ROI）分析

    精査・打診・打ち合わせ: 営業コスト管理DBから月間累計取得（手入力）
    提案・面談・決定: ステータス変更履歴DBから月間自動集計
    """
    print("💹 月次費用対効果（ROI）分析中...")

    # 精査・打診・打合せ件数を営業コスト管理DBから月間累計取得
    monthly_seisa = 0
    monthly_dashin = 0
    monthly_uchiawase = 0
    weekly_roi_data = []

    cost_data = query_database(DB_IDS["営業コスト"])
    target_month = MONTH_START.strftime("%Y-%m")

    if cost_data:
        month_records = []
        for page in cost_data.get("results", []):
            week_start = get_property_value(page, "週開始日")
            if week_start and week_start.startswith(target_month):
                seisa = get_property_value(page, "精査件数") or 0
                dashin = get_property_value(page, "打診件数") or 0
                uchiawase = get_property_value(page, "打合せ件数") or 0
                cumulative = get_property_value(page, "累積稼働時間（h）") or 0
                monthly_seisa += seisa
                monthly_dashin += dashin
                monthly_uchiawase += uchiawase
                month_records.append({
                    "week_start": week_start,
                    "seisa": seisa,
                    "dashin": dashin,
                    "uchiawase": uchiawase,
                    "cumulative": cumulative,
                })
        month_records.sort(key=lambda x: x["week_start"])

        # 週別のコスト計算
        for i, record in enumerate(month_records):
            if i == 0:
                weekly_hours = record["cumulative"]
            else:
                weekly_hours = record["cumulative"] - month_records[i - 1]["cumulative"]
            weekly_cost = int(weekly_hours * HOURLY_RATE)
            record["weekly_cost"] = weekly_cost

    # 提案・面談・決定件数をステータス変更履歴から月間集計
    teian_changes = status_change_analysis.get("提案", {}).get("changes", {})
    teian_count = teian_changes.get("候補→提案中", 0)
    mendan_count = teian_changes.get("提案中→面談", 0)
    kettei_count = 0
    for change_key, count in teian_changes.items():
        if change_key.endswith("→決定"):
            kettei_count += count

    # 週別ROIデータを構築（ステータス変更を週別に振り分け）
    all_status_data = query_database(DB_IDS["ステータス変更履歴"])
    weekly_status_counts = defaultdict(lambda: {"提案": 0, "面談": 0, "決定": 0})

    if all_status_data:
        for page in all_status_data.get("results", []):
            change_date = get_property_value(page, "変更日時")
            if not change_date:
                continue
            try:
                change_dt = datetime.fromisoformat(change_date.replace('Z', '+00:00')).replace(tzinfo=None)
            except:
                continue
            if not (MONTH_START <= change_dt <= MONTH_END):
                continue
            db_type = get_property_value(page, "DB種別")
            old_status = get_property_value(page, "旧ステータス")
            new_status = get_property_value(page, "新ステータス")
            if db_type != "提案":
                continue

            # どの週に属するか判定
            week_key = None
            if cost_data:
                for record in month_records:
                    ws = datetime.fromisoformat(record["week_start"])
                    we = ws + timedelta(days=6, hours=23, minutes=59, seconds=59)
                    if ws <= change_dt <= we:
                        week_key = record["week_start"]
                        break
            if not week_key:
                continue

            if old_status == "候補" and new_status == "提案中":
                weekly_status_counts[week_key]["提案"] += 1
            elif old_status == "提案中" and new_status == "面談":
                weekly_status_counts[week_key]["面談"] += 1
            elif new_status == "決定":
                weekly_status_counts[week_key]["決定"] += 1

    # 週別ROIを計算
    if cost_data:
        for i, record in enumerate(month_records):
            wk = record["week_start"]
            sc = weekly_status_counts.get(wk, {"提案": 0, "面談": 0, "決定": 0})
            weekly_value = (record["seisa"] * ACTION_VALUES["精査"]
                          + record["dashin"] * ACTION_VALUES["打診"]
                          + record.get("uchiawase", 0) * ACTION_VALUES["打ち合わせ"]
                          + sc["提案"] * ACTION_VALUES["提案"]
                          + sc["面談"] * ACTION_VALUES["面談"]
                          + sc["決定"] * ACTION_VALUES["決定"])
            weekly_process_value = weekly_value - (sc["決定"] * ACTION_VALUES["決定"])
            weekly_cost = record.get("weekly_cost", 0)
            weekly_total_roi = round((weekly_value / weekly_cost * 100), 1) if weekly_cost > 0 else 0
            weekly_process_roi = round((weekly_process_value / weekly_cost * 100), 1) if weekly_cost > 0 else 0

            weekly_roi_data.append({
                "week": f"第{i+1}週",
                "week_start": wk,
                "seisa": record["seisa"],
                "dashin": record["dashin"],
                "uchiawase": record.get("uchiawase", 0),
                "teian": sc["提案"],
                "mendan": sc["面談"],
                "kettei": sc["決定"],
                "value": weekly_value,
                "process_value": weekly_process_value,
                "cost": weekly_cost,
                "total_roi": weekly_total_roi,
                "process_roi": weekly_process_roi,
            })

    # アクション別バリュー計算
    actions = {
        "精査": {"count": monthly_seisa, "unit_value": ACTION_VALUES["精査"]},
        "打診": {"count": monthly_dashin, "unit_value": ACTION_VALUES["打診"]},
        "打ち合わせ": {"count": monthly_uchiawase, "unit_value": ACTION_VALUES["打ち合わせ"]},
        "提案": {"count": teian_count, "unit_value": ACTION_VALUES["提案"]},
        "面談": {"count": mendan_count, "unit_value": ACTION_VALUES["面談"]},
        "決定": {"count": kettei_count, "unit_value": ACTION_VALUES["決定"]},
    }

    total_value = 0
    for action_name, data in actions.items():
        data["subtotal"] = data["count"] * data["unit_value"]
        total_value += data["subtotal"]

    process_value = total_value - actions["決定"]["subtotal"]

    # 実績コスト
    actual_cost = cost_analysis.get("actual_amount", 0) if "message" not in cost_analysis else 0

    # ROI計算
    total_roi = round((total_value / actual_cost * 100), 1) if actual_cost > 0 else 0
    process_roi = round((process_value / actual_cost * 100), 1) if actual_cost > 0 else 0

    return {
        "actions": actions,
        "total_value": total_value,
        "process_value": process_value,
        "actual_cost": actual_cost,
        "total_roi": total_roi,
        "process_roi": process_roi,
        "weekly_roi_data": weekly_roi_data,
    }


def analyze_skill_match():
    """スキル需給マッチング分析（月末時点）"""
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
    youin_data = query_database(DB_IDS["要員"])
    if youin_data:
        for page in youin_data.get("results", []):
            status = get_property_value(page, "ステータス")
            # アクティブな要員のみ（終了以外）
            if status != "終了":
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

def detect_and_terminate_stagnant():
    """滞留レコードを検出し自動的に「終了」ステータスに変更する

    処理順序:
    1. 要員DB: 営業中 + 2週間以上滞留 → 終了
    2. 案件DB: 営業中 + 2週間以上滞留 → 終了
    3. 提案DB: 提案中 + 1週間以上滞留 → 終了
    4. 提案DB: 候補 + 紐付き要員/案件がステップ1-2で終了 → 終了（連鎖）
    """
    print("\n🔄 滞留レコードの自動終了処理を開始...")

    one_week_ago = MONTH_END - timedelta(days=7)
    two_weeks_ago = MONTH_END - timedelta(days=14)

    results = {
        "要員_terminated": [],
        "案件_terminated": [],
        "提案中_terminated": [],
        "候補_terminated": [],
        "要員_remaining": [],
        "案件_remaining": [],
        "候補_remaining": [],
    }

    terminated_youin_ids = set()
    terminated_anken_ids = set()

    # Step 1: 要員DB - 営業中 + 2週間以上 → 終了
    youin_filter = {"property": "ステータス", "select": {"does_not_equal": "終了"}}
    youin_data = query_database(DB_IDS["要員"], filter_params=youin_filter)
    if youin_data:
        for page in youin_data.get("results", []):
            status = get_property_value(page, "ステータス")
            created_time = get_property_value(page, "要員回収日")
            if not created_time or status == "オファー":
                continue
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)
            if created_dt.date() < two_weeks_ago.date():
                days_passed = (MONTH_END.date() - created_dt.date()).days
                item = {
                    "page_id": page["id"],
                    "name": get_property_value(page, "要員名"),
                    "date": created_time[:10],
                    "days": days_passed,
                    "status": status,
                    "担当": get_property_value(page, "担当"),
                }
                if status == "営業中":
                    if update_notion_status(page["id"], "終了"):
                        terminated_youin_ids.add(page["id"])
                        results["要員_terminated"].append(item)
                else:
                    results["要員_remaining"].append(item)

    # Step 2: 案件DB - 営業中 + 2週間以上 → 終了
    anken_data = query_database(DB_IDS["案件"])
    if anken_data:
        for page in anken_data.get("results", []):
            status = get_property_value(page, "ステータス")
            created_time = get_property_value(page, "案件回収日")
            if not created_time or status in ["決定", "終了"]:
                continue
            created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)
            if created_dt.date() < two_weeks_ago.date():
                days_passed = (MONTH_END.date() - created_dt.date()).days
                item = {
                    "page_id": page["id"],
                    "name": get_property_value(page, "入力不要"),
                    "date": created_time[:10],
                    "days": days_passed,
                    "status": status,
                    "担当": get_property_value(page, "担当"),
                }
                if status == "営業中":
                    if update_notion_status(page["id"], "終了"):
                        terminated_anken_ids.add(page["id"])
                        results["案件_terminated"].append(item)
                else:
                    results["案件_remaining"].append(item)

    # Step 3 & 4: 提案DB
    teian_data = query_database(DB_IDS["提案"])
    if teian_data:
        for page in teian_data.get("results", []):
            status = get_property_value(page, "ステータス")

            # Step 3: 提案中 + 1週間以上 → 終了
            if status == "提案中":
                teian_date = get_property_value(page, "提案日")
                if teian_date:
                    teian_dt = datetime.fromisoformat(teian_date)
                    if teian_dt.date() < one_week_ago.date():
                        days_passed = (MONTH_END.date() - teian_dt.date()).days
                        item = {
                            "page_id": page["id"],
                            "name": get_property_value(page, "提案名"),
                            "date": teian_date,
                            "days": days_passed,
                            "案件担当": get_property_value(page, "案件担当"),
                            "要員担当": get_property_value(page, "要員担当"),
                        }
                        if update_notion_status(page["id"], "見送り"):
                            results["提案中_terminated"].append(item)

            # 候補の滞留チェック + 連鎖終了
            elif status == "候補":
                created_time = get_property_value(page, "提案作成日")
                youin_ids = get_property_value(page, "要員DB") or []
                anken_ids = get_property_value(page, "案件DB") or []
                youin_id_set = set(youin_ids) if isinstance(youin_ids, list) else set()
                anken_id_set = set(anken_ids) if isinstance(anken_ids, list) else set()

                # Step 4: 連鎖終了（紐付き要員/案件が終了）
                if youin_id_set & terminated_youin_ids or anken_id_set & terminated_anken_ids:
                    item = {
                        "page_id": page["id"],
                        "name": get_property_value(page, "提案名"),
                        "date": created_time[:10] if created_time else "",
                        "案件担当": get_property_value(page, "案件担当"),
                        "要員担当": get_property_value(page, "要員担当"),
                    }
                    if update_notion_status(page["id"], "見送り"):
                        results["候補_terminated"].append(item)
                # 候補滞留（1週間以上、連鎖対象外）
                elif created_time:
                    created_dt = datetime.fromisoformat(created_time.replace('Z', '+00:00')).replace(tzinfo=None)
                    if created_dt.date() < one_week_ago.date():
                        days_passed = (MONTH_END.date() - created_dt.date()).days
                        results["候補_remaining"].append({
                            "page_id": page["id"],
                            "name": get_property_value(page, "提案名"),
                            "date": created_time[:10],
                            "days": days_passed,
                            "案件担当": get_property_value(page, "案件担当"),
                            "要員担当": get_property_value(page, "要員担当"),
                        })

    total = sum(len(results[k]) for k in ["要員_terminated", "案件_terminated", "提案中_terminated", "候補_terminated"])
    print(f"  合計 {total}件を自動終了しました。\n")

    return results


def generate_monthly_report():
    """月次レポートを生成"""
    print(f"\n{'='*60}")
    print(f"月次レポート生成: {MONTH_LABEL}")
    print(f"{'='*60}\n")

    # データ取得
    cost_analysis = analyze_monthly_cost()
    trend_analysis = analyze_monthly_trends()
    skill_analysis = analyze_skill_match()
    status_change_analysis = analyze_status_changes()
    roi_analysis = analyze_monthly_roi(cost_analysis, status_change_analysis)

    # 滞留レコードの自動終了処理
    terminate_results = detect_and_terminate_stagnant()

    print(f"\n{'='*60}")
    print("✅ データ取得・自動終了処理完了")
    print(f"{'='*60}\n")

    # レポート出力
    report = f"""# 📊 月次レポート - {MONTH_LABEL}

レポート作成日: {datetime.now().strftime('%Y年%m月%d日 %H:%M')}

---

## 💰 営業コスト

"""

    if "message" in cost_analysis:
        report += f"⚠️ {cost_analysis['message']}\n\n"
    else:
        report += "| 項目 | 値 |\n"
        report += "|------|-----|\n"
        report += f"| 月間累積稼働時間 | {cost_analysis.get('total_hours', '-')} h |\n"
        report += f"| 月間予算時間 | {cost_analysis.get('monthly_budget', '-')} h |\n"
        report += f"| 予算消化率 | {cost_analysis.get('budget_rate', '-')} % |\n"
        report += f"| 時間単価 | ¥{HOURLY_RATE}/h |\n"
        report += f"| 実績金額 | ¥{cost_analysis.get('actual_amount', 0):,} |\n"
        report += f"| 予算金額 | ¥{cost_analysis.get('budget_amount', 0):,} |\n\n"

        # 週別推移グラフ
        weekly_data = cost_analysis.get("weekly_data", [])
        if weekly_data:
            report += "### 週別稼働時間推移\n\n"

            chart_config = {
                "type": "bar",
                "data": {
                    "labels": [w["week"] for w in weekly_data],
                    "datasets": [{
                        "label": "週間稼働時間",
                        "data": [w["weekly_hours"] for w in weekly_data],
                        "backgroundColor": "rgba(75, 192, 192, 0.7)",
                        "borderColor": "rgb(75, 192, 192)",
                        "borderWidth": 1
                    }]
                },
                "options": {
                    "title": {
                        "display": True,
                        "text": "週別稼働時間の推移",
                        "fontSize": 16
                    },
                    "scales": {
                        "yAxes": [{
                            "ticks": {"beginAtZero": True},
                            "scaleLabel": {"display": True, "labelString": "時間（h）"}
                        }]
                    }
                }
            }

            chart_url = f"https://quickchart.io/chart?c={quote(json.dumps(chart_config))}&width=700&height=400"
            report += f"![週別稼働時間]({chart_url})\n\n"

            report += "| 週 | 週間稼働時間 | 累積稼働時間 |\n"
            report += "|----|------------|-------------|\n"
            for w in weekly_data:
                report += f"| {w['week']} | {w['weekly_hours']} h | {w['cumulative']} h |\n"
            report += "\n"

    # =============================================
    # セクション2: 🎯 月間営業アクションサマリー
    # =============================================
    report += "## 🎯 月間営業アクションサマリー\n\n"

    # Graph A: 営業アクション横棒グラフ（月間累計）
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
                "text": "月間営業アクション実績（人的活動量）",
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
    report += f"![月間営業アクション実績]({action_chart_url})\n\n"

    # Graph D: 週別アクション推移折れ線グラフ
    weekly_roi_data = roi_analysis.get("weekly_roi_data", [])
    if weekly_roi_data:
        action_trend_config = {
            "type": "line",
            "data": {
                "labels": [w["week"] for w in weekly_roi_data],
                "datasets": [
                    {
                        "label": "精査",
                        "data": [w["seisa"] for w in weekly_roi_data],
                        "borderColor": "rgba(173, 216, 230, 1)",
                        "backgroundColor": "rgba(173, 216, 230, 0.1)",
                        "tension": 0.4
                    },
                    {
                        "label": "打診",
                        "data": [w["dashin"] for w in weekly_roi_data],
                        "borderColor": "rgba(135, 190, 220, 1)",
                        "backgroundColor": "rgba(135, 190, 220, 0.1)",
                        "tension": 0.4
                    },
                    {
                        "label": "提案",
                        "data": [w["teian"] for w in weekly_roi_data],
                        "borderColor": "rgba(65, 130, 200, 1)",
                        "backgroundColor": "rgba(65, 130, 200, 0.1)",
                        "tension": 0.4
                    },
                    {
                        "label": "面談",
                        "data": [w["mendan"] for w in weekly_roi_data],
                        "borderColor": "rgba(30, 100, 190, 1)",
                        "backgroundColor": "rgba(30, 100, 190, 0.1)",
                        "tension": 0.4
                    },
                    {
                        "label": "決定",
                        "data": [w["kettei"] for w in weekly_roi_data],
                        "borderColor": "rgba(0, 70, 180, 1)",
                        "backgroundColor": "rgba(0, 70, 180, 0.1)",
                        "tension": 0.4
                    }
                ]
            },
            "options": {
                "title": {
                    "display": True,
                    "text": "週別営業アクション推移",
                    "fontSize": 16
                },
                "scales": {
                    "yAxes": [{
                        "ticks": {"beginAtZero": True, "stepSize": 1},
                        "scaleLabel": {"display": True, "labelString": "件数"}
                    }]
                }
            }
        }
        action_trend_url = f"https://quickchart.io/chart?c={quote(json.dumps(action_trend_config))}&width=700&height=400"
        report += f"![週別営業アクション推移]({action_trend_url})\n\n"

    # アクション別バリューテーブル
    report += "### アクション別バリュー（月間累計）\n\n"
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
                "text": "月間コスト vs 営業バリュー",
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

    # 月間ROIサマリー
    report += "### 月間ROIサマリー\n\n"
    report += "| 項目 | 金額 |\n"
    report += "|------|------|\n"
    report += f"| 投資（実績コスト） | ¥{roi_analysis['actual_cost']:,} |\n"
    report += f"| 回収（営業バリュー） | ¥{roi_analysis['total_value']:,} |\n"

    total_roi = roi_analysis["total_roi"]
    roi_badge = "✅" if total_roi >= 100 else "⚠️" if total_roi >= 80 else "🔴"
    report += f"| 総合ROI | {total_roi}% {roi_badge} |\n"

    process_roi = roi_analysis["process_roi"]
    proc_badge = "✅" if process_roi >= 100 else "⚠️" if process_roi >= 80 else "🔴"
    report += f"| プロセスROI（決定除外） | {process_roi}% {proc_badge} |\n\n"

    # 判定メッセージ
    if total_roi >= 100:
        report += "✅ 月間で投資以上のバリューを創出しています。\n\n"
    elif total_roi >= 80:
        report += "⚠️ あと少しで投資回収です。来月は面談・提案の積み上げを意識しましょう。\n\n"
    else:
        report += "🔴 投資回収に向けて、精査・打診のアクション量を増やしましょう。\n\n"

    # 週別ROI推移グラフ
    weekly_roi_data = roi_analysis.get("weekly_roi_data", [])
    if weekly_roi_data:
        report += "### 週別ROI推移\n\n"

        roi_trend_config = {
            "type": "line",
            "data": {
                "labels": [w["week"] for w in weekly_roi_data],
                "datasets": [
                    {
                        "label": "総合ROI",
                        "data": [w["total_roi"] for w in weekly_roi_data],
                        "borderColor": "rgb(54, 162, 235)",
                        "backgroundColor": "rgba(54, 162, 235, 0.1)",
                        "tension": 0.4
                    },
                    {
                        "label": "プロセスROI",
                        "data": [w["process_roi"] for w in weekly_roi_data],
                        "borderColor": "rgb(75, 192, 192)",
                        "backgroundColor": "rgba(75, 192, 192, 0.1)",
                        "tension": 0.4
                    }
                ]
            },
            "options": {
                "title": {
                    "display": True,
                    "text": "週別ROI推移（%）",
                    "fontSize": 16
                },
                "scales": {
                    "yAxes": [{
                        "ticks": {"beginAtZero": True},
                        "scaleLabel": {"display": True, "labelString": "ROI（%）"}
                    }]
                },
                "annotation": {
                    "annotations": [{
                        "type": "line",
                        "mode": "horizontal",
                        "scaleID": "y-axis-0",
                        "value": 100,
                        "borderColor": "rgb(255, 99, 132)",
                        "borderWidth": 2,
                        "borderDash": [6, 6],
                        "label": {
                            "enabled": True,
                            "content": "損益分岐点",
                            "position": "right"
                        }
                    }]
                }
            }
        }
        roi_trend_url = f"https://quickchart.io/chart?c={quote(json.dumps(roi_trend_config))}&width=700&height=400"
        report += f"![週別ROI推移]({roi_trend_url})\n\n"

        # 週別ROIテーブル
        report += "| 週 | コスト | バリュー | 総合ROI | プロセスROI |\n"
        report += "|----|--------|---------|---------|------------|\n"
        for w in weekly_roi_data:
            t_badge = "✅" if w["total_roi"] >= 100 else "⚠️" if w["total_roi"] >= 80 else "🔴"
            p_badge = "✅" if w["process_roi"] >= 100 else "⚠️" if w["process_roi"] >= 80 else "🔴"
            report += f"| {w['week']} | ¥{w['cost']:,.0f} | ¥{w['value']:,} | {w['total_roi']}% {t_badge} | {w['process_roi']}% {p_badge} |\n"
        report += "\n"

    report += "---\n\n"

    # =============================================
    # セクション3: 📊 提案プロセス分析（月間）
    # =============================================
    report += "## 📊 提案プロセス分析（月間）\n\n"

    weeks = trend_analysis["weeks"]
    teian_changes = status_change_analysis.get("提案", {}).get("changes", {})
    weekly_changes = status_change_analysis.get("提案", {}).get("weekly_changes", [])

    # Graph C: 提案プロセス積み上げ棒グラフ（週別推移）— ステータス遷移ベース
    weekly_koho_teian = [wc.get("候補→提案中", 0) for wc in weekly_changes]
    weekly_teian_mendan = [wc.get("提案中→面談", 0) for wc in weekly_changes]
    # AI候補生成数から遷移済み件数を差し引いた残数を「未処理候補」として表示
    weekly_unprocessed = []
    for i, w in enumerate(weeks):
        koho_teian = weekly_koho_teian[i] if i < len(weekly_koho_teian) else 0
        teian_mendan = weekly_teian_mendan[i] if i < len(weekly_teian_mendan) else 0
        unprocessed = max(0, w["提案新規"] - koho_teian - teian_mendan)
        weekly_unprocessed.append(unprocessed)

    process_chart_config = {
        "type": "bar",
        "data": {
            "labels": [w["label"] for w in weeks],
            "datasets": [
                {
                    "label": "AI候補生成",
                    "data": [w["提案新規"] for w in weeks],
                    "backgroundColor": "rgba(201, 203, 207, 0.7)",
                    "borderColor": "rgb(201, 203, 207)",
                    "borderWidth": 1
                },
                {
                    "label": "候補→提案中",
                    "data": weekly_koho_teian,
                    "backgroundColor": "rgba(54, 162, 235, 0.7)",
                    "borderColor": "rgb(54, 162, 235)",
                    "borderWidth": 1
                },
                {
                    "label": "提案中→面談",
                    "data": weekly_teian_mendan,
                    "backgroundColor": "rgba(75, 192, 192, 0.7)",
                    "borderColor": "rgb(75, 192, 192)",
                    "borderWidth": 1
                }
            ]
        },
        "options": {
            "title": {
                "display": True,
                "text": "提案プロセス推移（遷移実績ベース）週別",
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

    # 月間3分類テーブル
    total_teian = sum(w["提案新規"] for w in weeks)
    jinteki_count = teian_changes.get("候補→提案中", 0)
    yuuko_count = teian_changes.get("提案中→面談", 0)

    report += "### 提案活動の3分類（月間）\n\n"
    report += "| 分類 | 件数 | 説明 |\n"
    report += "|------|------|------|\n"
    report += f"| AI候補生成 | {total_teian}件 | AIマッチングによる自動候補生成 |\n"
    report += f"| 人的提案数 | {jinteki_count}件 | 候補→提案中（人的判断で精査・提案） |\n"
    report += f"| 有効提案数 | {yuuko_count}件 | 提案中→面談以降（実質的な進捗） |\n\n"

    # 転換率（メインKPI）— ステータス変更履歴DBの遷移実績ベース
    report += "### 転換率（メインKPI）\n\n"

    koho_to_teian_count = teian_changes.get("候補→提案中", 0)
    teian_to_mendan_count = teian_changes.get("提案中→面談", 0)
    koho_to_teian_rate = round((koho_to_teian_count / total_teian * 100), 1) if total_teian > 0 else 0
    teian_to_mendan_rate = round((teian_to_mendan_count / koho_to_teian_count * 100), 1) if koho_to_teian_count > 0 else 0

    report += "| 転換指標 | 月間実績 |\n"
    report += "|----------|----------|\n"
    report += f"| 候補→提案中 | {koho_to_teian_rate}% ({koho_to_teian_count}/{total_teian}) |\n"
    report += f"| 提案中→面談 | {teian_to_mendan_rate}% ({teian_to_mendan_count}/{koho_to_teian_count}) |\n\n"

    # 週別転換率の内訳 — ステータス変更履歴DBの遷移実績ベース
    weekly_changes = status_change_analysis.get("提案", {}).get("weekly_changes", [])
    weekly_labels = status_change_analysis.get("weekly_labels", [])
    report += "#### 週別内訳\n\n"
    report += "| 週 | AI候補生成 | 候補→提案中 | 提案中→面談 | 候補→提案中率 |\n"
    report += "|----|-----------|------------|------------|---------------|\n"
    for i, w in enumerate(weeks):
        wc = weekly_changes[i] if i < len(weekly_changes) else {}
        w_koho_teian = wc.get("候補→提案中", 0)
        w_teian_mendan = wc.get("提案中→面談", 0)
        w_new = w["提案新規"]
        w_rate = round((w_koho_teian / w_new * 100), 1) if w_new > 0 else 0
        report += f"| {w['label']} | {w_new}件 | {w_koho_teian}件 | {w_teian_mendan}件 | {w_rate}% |\n"
    report += "\n"

    if koho_to_teian_rate < 20:
        report += "🔴 転換率が低いです。候補案件の精査基準や判断スピードを見直しましょう。\n\n"
    elif koho_to_teian_rate < 50:
        report += "⚠️ 転換率の改善余地があります。候補案件を積極的に精査しましょう。\n\n"
    else:
        report += "✅ 転換率は良好です。現状のペースを維持しましょう。\n\n"

    report += "---\n\n"

    # =============================================
    # セクション5: 📥 インプット指標（参考）
    # =============================================
    report += "## 📥 インプット指標（参考）\n\n"
    report += "自動処理で取り込まれたデータ量の参考値です。\n\n"

    total_youin = sum(w["要員新規"] for w in weeks)
    total_anken = sum(w["案件新規"] for w in weeks)

    report += "| 週 | 要員新規 | 案件新規 | AI候補生成 |\n"
    report += "|----|----------|----------|------------|\n"
    for w in weeks:
        report += f"| {w['label']} | {w['要員新規']}件 | {w['案件新規']}件 | {w['提案新規']}件 |\n"
    report += f"| 月間合計 | {total_youin}件 | {total_anken}件 | {total_teian}件 |\n\n"

    report += "---\n\n"

    # ステータス変化分析（履歴DBから）
    report += "## 🔄 月間ステータス変化\n\n"

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

        # 転換率の計算（月間の実績）
        koho_to_teian = teian_changes.get("候補→提案中", 0)
        teian_to_mendan = teian_changes.get("提案中→面談", 0)
        mendan_to_naitei = teian_changes.get("面談→内定", 0)
        naitei_to_kettei = teian_changes.get("内定→決定", 0)

        report += "**月間の転換実績:**\n"
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
        report += "月間のステータス変化なし\n\n"

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
        report += "月間のステータス変化なし\n\n"

    # 案件DBのステータス変化
    report += "### 🧾 案件DB\n\n"
    if anken_changes:
        report += "| 変化 | 件数 |\n"
        report += "|------|------|\n"
        for change, count in anken_changes.items():
            report += f"| {change} | {count}件 |\n"
        report += "\n"
    else:
        report += "月間のステータス変化なし\n\n"

    report += "---\n\n"

    # スキル需給分析
    report += "## 🎯 スキル需給マッチング分析（月末時点）\n\n"

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
                "title": {"display": True, "text": "案件スキル需要"},
                "plugins": {
                    "legend": {"display": True, "position": "right"},
                    "outlabels": {
                        "text": "%l: %p",
                        "color": "white",
                        "stretch": 15,
                        "font": {"resizable": True, "minSize": 10, "maxSize": 14}
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
                "title": {"display": True, "text": "要員スキル供給"},
                "plugins": {
                    "legend": {"display": True, "position": "right"},
                    "outlabels": {
                        "text": "%l: %p",
                        "color": "white",
                        "stretch": 15,
                        "font": {"resizable": True, "minSize": 10, "maxSize": 14}
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

        # 需給ギャップ分析
        oversupply = [s for s in skill_match if s["demand"] == 0 and s["supply"] > 0]
        undersupply = [s for s in skill_match if s["demand"] > 0 and s["match_rate"] < 100]

        if oversupply:
            report += "供給過多スキル: " + ", ".join([f"{s['skill']}({s['supply']}名)" for s in oversupply[:5]]) + "\n\n"

        if undersupply:
            report += "供給不足スキル: " + ", ".join([f"{s['skill']}({s['match_rate']}%)" for s in undersupply[:5]]) + "\n\n"
    else:
        report += "⚠️ スキルデータがありません\n\n"

    report += "---\n\n"

    # =============================================
    # 期限超過アラート・自動終了処理
    # =============================================
    report += "## ⚠️ 期限超過アラート\n\n"

    total_terminated = sum(len(terminate_results[k]) for k in ["要員_terminated", "案件_terminated", "提案中_terminated", "候補_terminated"])

    if total_terminated > 0:
        report += f"### 🔄 自動終了処理（合計 {total_terminated}件）\n\n"
        report += "以下のレコードを自動的に「終了」ステータスに変更しました。\n\n"

        if terminate_results["要員_terminated"]:
            report += f"#### 👤 要員DB（営業中 → 終了: {len(terminate_results['要員_terminated'])}件）\n\n"
            report += "| 要員名 | 回収日 | 経過日数 | 担当 |\n"
            report += "|--------|--------|----------|------|\n"
            for item in terminate_results["要員_terminated"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['担当']} |\n"
            report += "\n"

        if terminate_results["案件_terminated"]:
            report += f"#### 🧾 案件DB（営業中 → 終了: {len(terminate_results['案件_terminated'])}件）\n\n"
            report += "| 案件名 | 回収日 | 経過日数 | 担当 |\n"
            report += "|--------|--------|----------|------|\n"
            for item in terminate_results["案件_terminated"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['担当']} |\n"
            report += "\n"

        if terminate_results["提案中_terminated"]:
            report += f"#### 📋 提案DB 提案中 → 見送り: {len(terminate_results['提案中_terminated'])}件\n\n"
            report += "| 提案名 | 提案日 | 経過日数 | 案件担当 | 要員担当 |\n"
            report += "|--------|--------|----------|----------|----------|\n"
            for item in terminate_results["提案中_terminated"]:
                report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['days']}日 | {item['案件担当']} | {item['要員担当']} |\n"
            report += "\n"

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

    # 自動終了対象外の残存滞留
    has_remaining = terminate_results["候補_remaining"] or terminate_results["要員_remaining"] or terminate_results["案件_remaining"]
    if has_remaining:
        report += "### ⚠️ 要確認（自動終了対象外の期限超過）\n\n"

        if terminate_results["候補_remaining"]:
            report += f"#### 📋 提案DB（候補で1週間以上滞留: {len(terminate_results['候補_remaining'])}件）\n\n"
            report += "| 提案名 | 作成日 | 経過日数 | 案件担当 | 要員担当 |\n"
            report += "|--------|--------|----------|----------|----------|\n"
            for item in terminate_results["候補_remaining"]:
                report += f"| {item['name'] or '(未入力)'} | {item['date']} | {item['days']}日 | {item['案件担当']} | {item['要員担当']} |\n"
            report += "\n"

        if terminate_results["要員_remaining"]:
            report += f"#### 👤 要員DB（営業中以外で2週間以上経過: {len(terminate_results['要員_remaining'])}件）\n\n"
            report += "| 要員名 | 回収日 | 経過日数 | ステータス | 担当 |\n"
            report += "|--------|--------|----------|------------|------|\n"
            for item in terminate_results["要員_remaining"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['status']} | {item['担当']} |\n"
            report += "\n"

        if terminate_results["案件_remaining"]:
            report += f"#### 🧾 案件DB（営業中以外で2週間以上経過: {len(terminate_results['案件_remaining'])}件）\n\n"
            report += "| 案件名 | 回収日 | 経過日数 | ステータス | 担当 |\n"
            report += "|--------|--------|----------|------------|------|\n"
            for item in terminate_results["案件_remaining"]:
                report += f"| {item['name']} | {item['date']} | {item['days']}日 | {item['status']} | {item['担当']} |\n"
            report += "\n"

    report += "---\n\n"

    # データ駆動の月次振り返りとアクション生成
    report += "## 📝 月次振り返りと次月アクション\n\n"

    # 今月の実績サマリー
    report += "### 今月の実績\n\n"
    report += f"- 人的提案数（候補→提案中）: {jinteki_count}件\n"
    report += f"- 有効提案数（提案中→面談）: {yuuko_count}件\n"
    report += f"- 候補→提案中 転換率: {koho_to_teian_rate}%\n"
    report += f"- AI候補生成: {total_teian}件（参考）\n"
    report += f"- 要員回収: {total_youin}件\n"
    report += f"- 案件回収: {total_anken}件\n\n"

    # 週別パフォーマンス分析
    report += "### 週別パフォーマンス\n\n"

    # 最も人的提案アクションが多かった週（ステータス変更履歴の候補→提案中遷移ベース）
    weekly_changes_for_perf = status_change_analysis.get("提案", {}).get("weekly_changes", [])
    week_teian_counts = []
    for i, w in enumerate(weeks):
        wc = weekly_changes_for_perf[i] if i < len(weekly_changes_for_perf) else {}
        week_teian_counts.append((w["label"], wc.get("候補→提案中", 0)))

    if week_teian_counts:
        best_label, best_count = max(week_teian_counts, key=lambda x: x[1])
        worst_label, worst_count = min(week_teian_counts, key=lambda x: x[1])

        if best_count > 0:
            report += f"- 最多アクション週: {best_label}（人的提案{best_count}件）\n"
        if worst_count < best_count:
            report += f"- 最少アクション週: {worst_label}（人的提案{worst_count}件）\n"
    report += "\n"

    # 次月の重点施策（データ駆動）
    report += "### 次月の重点施策\n\n"

    action_num = 1

    # 1. 候補→提案中の転換率改善
    if koho_to_teian_rate < 50:
        report += f"{action_num}. 候補→提案中の転換率改善\n"
        report += f"   - 今月の転換率: {koho_to_teian_rate}%\n"
        report += "   - 候補案件の精査基準を見直し\n"
        report += "   - 判断スピードの向上\n\n"
        action_num += 1

    # 2. 活動量の平準化
    weekly_variance = max(w["提案新規"] for w in weeks) - min(w["提案新規"] for w in weeks)
    if weekly_variance > 10:
        report += f"{action_num}. 週別活動量の平準化\n"
        report += f"   - 週間の差: 最大{weekly_variance}件\n"
        report += "   - 週次KPIの設定と進捗管理\n\n"
        action_num += 1

    # 3. スキル需給ギャップ対応
    skill_shortage = [s for s in skill_analysis.get("skill_match", []) if s.get("demand", 0) > 0 and s.get("match_rate", 100) < 100]
    if skill_shortage:
        top_shortage = skill_shortage[:3]
        report += f"{action_num}. スキル需給ギャップ対応\n"
        for s in top_shortage:
            report += f"   - {s['skill']}: 充足率{s['match_rate']}%\n"
        report += "   - パートナーへの要員募集を強化\n\n"
        action_num += 1

    # 4. 見送り傾向の把握
    # 見送り率が高い場合
    total_mimokuri = sum(1 for w in weeks for _ in range(w.get("見送り", 0)))
    if total_teian > 0:
        report += f"{action_num}. 提案精度の向上\n"
        report += "   - 見送り/辞退パターンの把握\n"
        report += "   - マッチング精度の改善検討\n\n"
        action_num += 1

    # アクションがない場合
    if action_num == 1:
        report += "現状のペースを維持し、安定した活動を継続。\n\n"

    report += "---\n\n"
    report += f"レポート生成: Claude Code SES Analysis Skill v1.0.0\n"

    return report

def move_page(page_id, new_parent_id):
    """ページを新しい親ページに移動"""
    url = f"https://api.notion.com/v1/pages/{page_id}"
    payload = {
        "parent": {
            "type": "page_id",
            "page_id": new_parent_id
        }
    }
    response = requests.patch(url, headers=HEADERS, json=payload)
    return response.status_code == 200

def create_notion_page_monthly(report_content, parent_page_id):
    """Notionページを作成してレポートを投稿"""
    print("\n📝 Notionページを作成中...")

    # タイトル作成
    title = f"{MONTH_LABEL}"

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

        # 見出し
        if line.startswith('# '):
            blocks.append({
                "object": "block",
                "type": "heading_1",
                "heading_1": {
                    "rich_text": [{"type": "text", "text": {"content": line[2:]}}]
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
        elif line.startswith('### '):
            blocks.append({
                "object": "block",
                "type": "heading_3",
                "heading_3": {
                    "rich_text": [{"type": "text", "text": {"content": line[4:]}}]
                }
            })
        # 画像
        elif line.startswith('![') and '](' in line and line.endswith(')'):
            alt_start = line.index('[') + 1
            alt_end = line.index(']')
            alt_text = line[alt_start:alt_end]
            url_start = line.index('](') + 2
            url = line[url_start:-1]
            if len(url) <= 2000:
                blocks.append({
                    "object": "block",
                    "type": "image",
                    "image": {
                        "type": "external",
                        "external": {"url": url}
                    }
                })
            else:
                # URL が2000文字を超える場合はブックマークで代替
                blocks.append({
                    "object": "block",
                    "type": "bookmark",
                    "bookmark": {
                        "url": url[:2000]
                    }
                })
        # 区切り線
        elif line == '---':
            blocks.append({
                "object": "block",
                "type": "divider",
                "divider": {}
            })
        # テーブル（簡易版）
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
        # リスト
        elif line.startswith('- '):
            blocks.append({
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [{"type": "text", "text": {"content": line[2:]}}]
                }
            })
        elif line.startswith('1. ') or (len(line) > 3 and line[0].isdigit() and line[1] == '.' and line[2] == ' '):
            content = line[3:] if line[1] == '.' else line[line.index('. ') + 2:]
            blocks.append({
                "object": "block",
                "type": "numbered_list_item",
                "numbered_list_item": {
                    "rich_text": [{"type": "text", "text": {"content": content}}]
                }
            })
        # 通常のテキスト
        else:
            # 太字などを含むテキスト
            blocks.append({
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [{"type": "text", "text": {"content": line}}]
                }
            })

        i += 1

    # ブロック数制限（100件まで）
    if len(blocks) > 100:
        blocks = blocks[:100]
        print(f"  ⚠️ ブロック数が多いため、最初の100ブロックのみ投稿します")

    # ページ作成
    url = "https://api.notion.com/v1/pages"
    payload = {
        "parent": {
            "type": "page_id",
            "page_id": parent_page_id
        },
        "properties": {
            "title": {
                "title": [{"type": "text", "text": {"content": title}}]
            }
        },
        "children": blocks
    }

    response = requests.post(url, headers=HEADERS, json=payload)
    if response.status_code == 200:
        result = response.json()
        page_url = result.get("url", "")
        print(f"  ✅ ページ作成完了: {page_url}")
        return {"success": True, "page_url": page_url, "page_id": result.get("id")}
    else:
        error_msg = f"{response.status_code} - {response.text}"
        print(f"  ❌ エラー: {error_msg}")
        return {"success": False, "error": error_msg}

def update_latest_monthly_report_page(report_content):
    """最新月次レポートページを更新し、古いレポートを履歴に移動"""
    print("\n📤 最新月次レポートを更新中...")

    PARENT_PAGE_ID = "8d52d3fee1344c549e6715d24f7b8b4e"  # 親ページ（レポート一覧）
    HISTORY_PAGE_ID = "702c7c347282405ba16cd1601f2b8405"  # 月次レポート履歴

    # 親ページの子ページを検索して「月次」を探す
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
                        # 「YYYY年M月」形式の月次レポートを検索（履歴ページは除外）
                        import re
                        if re.match(r'^\d{4}年\d{1,2}月$', title):
                            existing_report_page_id = page_id
                            print(f"  📦 既存のレポート「{title}」を履歴に移動中...")
                            break

    # 既存の月次レポートがあれば履歴に移動
    if existing_report_page_id:
        move_page(existing_report_page_id, HISTORY_PAGE_ID)
        print(f"  ✅ 履歴に移動しました")

    # 新しいレポートページを作成
    return create_notion_page_monthly(report_content, parent_page_id=PARENT_PAGE_ID)

if __name__ == "__main__":
    report = generate_monthly_report()

    # ファイルに保存
    output_file = f"monthly_report_{MONTH_START.strftime('%Y_%m')}.md"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n✅ レポートを {output_file} に保存しました")
