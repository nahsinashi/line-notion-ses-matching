#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配信候補ピックアップスクリプト
案件・要員をスコアリングし、配信候補をJSON出力する
"""

import os
import sys
import io
import json
import re
import argparse
import requests
from datetime import datetime, timezone, timedelta

# Windows環境でのUnicode出力対応
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# ============================================================
# .envファイル読み込み（dotenv不要）
# ============================================================

def load_dotenv(env_path=None):
    """スクリプトと同じディレクトリの.envファイルから環境変数を読み込む"""
    if env_path is None:
        env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value

load_dotenv()

# ============================================================
# Notion API設定
# ============================================================

NOTION_API_KEY = os.environ.get("NOTION_API_KEY", "")
if not NOTION_API_KEY:
    print("❌ NOTION_API_KEY が未設定です。環境変数または .env ファイルに設定してください。")
    sys.exit(1)

NOTION_VERSION = "2022-06-28"
HEADERS = {
    "Authorization": f"Bearer {NOTION_API_KEY}",
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json"
}

DB_IDS = {
    "案件": os.environ.get("NOTION_DB_CASES", "2c2c01f8-7769-8013-8dc0-ea41dac2c119"),
    "要員": os.environ.get("NOTION_DB_STAFF", "2c2c01f8-7769-80c1-9af9-c5b101b91520"),
}

# ============================================================
# スコアリング定数
# ============================================================

# メジャー言語ティア
LANG_TIER1 = {"PHP", "Java", "JavaScript", "TypeScript", "JS", "TS"}
LANG_TIER2 = {"Python", "C#"}
LANG_TIER3 = {"Go"}

# ============================================================
# Notion API ヘルパー
# ============================================================

def query_database(db_id, filter_params=None):
    """Notionデータベースをクエリ（ページネーション対応）"""
    url = f"https://api.notion.com/v1/databases/{db_id}/query"
    all_results = []
    has_more = True
    start_cursor = None

    while has_more:
        payload = {"page_size": 100}
        if filter_params:
            payload["filter"] = filter_params
        if start_cursor:
            payload["start_cursor"] = start_cursor

        response = requests.post(url, headers=HEADERS, json=payload)
        if response.status_code != 200:
            print(f"APIエラー: {response.status_code}", file=sys.stderr)
            print(response.text, file=sys.stderr)
            return all_results

        data = response.json()
        all_results.extend(data.get("results", []))
        has_more = data.get("has_more", False)
        start_cursor = data.get("next_cursor")

    return all_results


def get_property_value(page, prop_name):
    """プロパティ値を安全に取得"""
    props = page.get("properties", {})
    prop = props.get(prop_name, {})
    prop_type = prop.get("type")

    if prop_type == "title":
        title_arr = prop.get("title", [])
        return title_arr[0]["plain_text"] if title_arr else ""

    elif prop_type == "rich_text":
        text_arr = prop.get("rich_text", [])
        return text_arr[0]["plain_text"] if text_arr else ""

    elif prop_type == "number":
        return prop.get("number")

    elif prop_type == "select":
        sel = prop.get("select")
        return sel["name"] if sel else None

    elif prop_type == "multi_select":
        return [item["name"] for item in prop.get("multi_select", [])]

    elif prop_type == "date":
        date_obj = prop.get("date")
        return date_obj["start"] if date_obj else None

    elif prop_type == "files":
        files = prop.get("files", [])
        result = []
        for f in files:
            file_info = {"name": f.get("name", "")}
            if f.get("type") == "external":
                file_info["url"] = f["external"]["url"]
            elif f.get("type") == "file":
                file_info["url"] = f["file"]["url"]
            result.append(file_info)
        return result

    return None


# ============================================================
# 案件スコアリング
# ============================================================

def score_case_price(price):
    """案件単価スコア（30点満点）
    ゾーンを細分化して差をつける
    """
    if price is None:
        return 5
    price_man = price / 10000  # 円→万円変換
    if 65 <= price_man <= 80:
        return 30      # ど真ん中スイートスポット
    elif (60 <= price_man < 65) or (80 < price_man <= 85):
        return 24      # 良い範囲
    elif (55 <= price_man < 60) or (85 < price_man <= 90):
        return 18      # まあまあ
    elif (50 <= price_man < 55) or (90 < price_man <= 95):
        return 12      # やや外れる
    else:
        return 6       # 範囲外


def score_case_language(skills):
    """案件 開発言語メジャー度（20点満点）
    配点を25→20に減（差がつきにくいため）
    """
    if not skills:
        return 5
    skill_set = set(skills)
    if skill_set & LANG_TIER1:
        return 20
    elif skill_set & LANG_TIER2:
        return 15
    elif skill_set & LANG_TIER3:
        return 10
    else:
        return 5


def score_case_freshness(created_time_str):
    """案件 鮮度（25点満点）
    旧「商流」軸を廃止し、案件の新しさで差をつける
    - 3日以内: 25点
    - 7日以内: 20点
    - 14日以内: 15点
    - 30日以内: 10点
    - それ以上: 5点
    """
    if not created_time_str:
        return 10
    try:
        created = datetime.fromisoformat(created_time_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        days_ago = (now - created).days
        if days_ago <= 3:
            return 25
        elif days_ago <= 7:
            return 20
        elif days_ago <= 14:
            return 15
        elif days_ago <= 30:
            return 10
        else:
            return 5
    except (ValueError, TypeError):
        return 10


def score_case_remote(remote_value, raw_text=""):
    """案件 リモート可（25点満点）
    サマリー/原文から「リモートメイン」等を検出して細分化
    """
    if remote_value is None and not raw_text:
        return 8

    combined = f"{remote_value or ''} {raw_text or ''}"

    if "フルリモート" in combined:
        return 25
    elif "リモートメイン" in combined or "在宅メイン" in combined:
        return 22
    elif "ハイブリッド" in combined or "リモート" in combined:
        # ハイブリッドの中でも頻度で差をつける
        if "週1出社" in combined or "月数回出社" in combined:
            return 20
        elif "週2" in combined or "週3" in combined:
            return 16
        else:
            return 14
    else:
        # 常駐・オンサイト
        return 6


def score_case(page):
    """案件の総合スコア（100点満点）
    改訂版: 単価30 + 言語20 + 鮮度25 + リモート25
    """
    price = get_property_value(page, "営業単価")
    skills = get_property_value(page, "スキル要件")
    remote = get_property_value(page, "リモート")
    raw_text = get_property_value(page, "原文")
    summary = get_property_value(page, "サマリー")
    created_time = page.get("created_time", "")

    p = score_case_price(price)
    l = score_case_language(skills)
    f = score_case_freshness(created_time)
    r = score_case_remote(remote, f"{summary or ''} {raw_text or ''}")

    return {
        "total": p + l + f + r,
        "breakdown": {
            "単価": f"{p}/30",
            "言語": f"{l}/20",
            "鮮度": f"{f}/25",
            "リモート": f"{r}/25",
        }
    }


# ============================================================
# 要員スコアリング
# ============================================================

def extract_age(summary):
    """サマリーテキストから年齢を抽出"""
    if not summary:
        return None
    match = re.search(r'(\d{2})\s*歳', summary)
    return int(match.group(1)) if match else None


def score_staff_age(summary):
    """要員 年齢スコア（25点満点）
    28-32歳をスイートスポットに細分化
    """
    age = extract_age(summary)
    if age is None:
        return 8
    if 28 <= age <= 32:
        return 25      # ど真ん中
    elif (26 <= age <= 27) or (33 <= age <= 35):
        return 20      # 良いレンジ
    elif (24 <= age <= 25) or (36 <= age <= 38):
        return 14      # まあまあ
    elif 39 <= age <= 42:
        return 8       # やや厳しい
    else:
        return 3       # 範囲外


def score_staff_price(price):
    """要員 単価スコア（25点満点）
    65-75万をスイートスポットに細分化
    """
    if price is None:
        return 8
    price_man = price / 10000  # 円→万円変換
    if 65 <= price_man <= 75:
        return 25      # ど真ん中
    elif (60 <= price_man < 65) or (75 < price_man <= 80):
        return 20      # 良いレンジ
    elif (55 <= price_man < 60) or (80 < price_man <= 85):
        return 14      # まあまあ
    elif (50 <= price_man < 55) or (85 < price_man <= 90):
        return 8       # やや外れる
    else:
        return 4       # 範囲外


def score_staff_language(skills):
    """要員 開発言語メジャー度（15点満点）
    差がつきにくいので配点は控えめ
    """
    if not skills:
        return 3
    skill_set = set(skills)
    if skill_set & LANG_TIER1:
        return 15
    elif skill_set & LANG_TIER2:
        return 11
    elif skill_set & LANG_TIER3:
        return 7
    else:
        return 3


def score_staff_skill_sheet(page):
    """要員 スキルシート有無（10点満点）
    スキルシートがあると配信効果が高い
    """
    skill_sheets = get_property_value(page, "スキルシート")
    if skill_sheets and len(skill_sheets) > 0:
        return 10
    return 0


def score_staff_freshness(created_time_str):
    """要員 鮮度（25点満点）
    新しく登録された要員ほど動きやすい
    - 3日以内: 25点
    - 7日以内: 20点
    - 14日以内: 15点
    - 30日以内: 10点
    - それ以上: 5点
    """
    if not created_time_str:
        return 10
    try:
        created = datetime.fromisoformat(created_time_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        days_ago = (now - created).days
        if days_ago <= 3:
            return 25
        elif days_ago <= 7:
            return 20
        elif days_ago <= 14:
            return 15
        elif days_ago <= 30:
            return 10
        else:
            return 5
    except (ValueError, TypeError):
        return 10


def score_staff(page):
    """要員の総合スコア（100点満点）
    改訂版: 年齢25 + 単価25 + 鮮度25 + 言語15 + SS10 = 100
    """
    summary = get_property_value(page, "サマリー")
    price = get_property_value(page, "営業単価")
    skills = get_property_value(page, "スキル概要")
    created_time = page.get("created_time", "")

    a = score_staff_age(summary)
    p = score_staff_price(price)
    l = score_staff_language(skills)
    s = score_staff_skill_sheet(page)
    f = score_staff_freshness(created_time)

    return {
        "total": a + p + l + s + f,
        "breakdown": {
            "年齢": f"{a}/25",
            "単価": f"{p}/25",
            "鮮度": f"{f}/25",
            "言語": f"{l}/15",
            "SS": f"{s}/10",
        }
    }


# ============================================================
# データ取得
# ============================================================

def fetch_active_cases():
    """営業中の案件を取得"""
    filter_params = {
        "property": "ステータス",
        "select": {"equals": "営業中"}
    }
    return query_database(DB_IDS["案件"], filter_params)


def fetch_active_staff():
    """営業中の要員を取得"""
    filter_params = {
        "property": "ステータス",
        "select": {"equals": "営業中"}
    }
    return query_database(DB_IDS["要員"], filter_params)


# ============================================================
# メイン処理
# ============================================================

def build_case_result(page, score_result):
    """案件のスコア結果を辞書に変換"""
    title = get_property_value(page, "入力不要")
    summary = get_property_value(page, "サマリー")
    price = get_property_value(page, "営業単価")
    skills = get_property_value(page, "スキル要件")
    remote = get_property_value(page, "リモート")
    source_company = get_property_value(page, "案件元企業")

    return {
        "type": "case",
        "page_id": page["id"],
        "title": title or "(無題)",
        "score": score_result["total"],
        "breakdown": score_result["breakdown"],
        "summary": summary or "",
        "price": price / 10000 if price else None,  # 万円表示
        "skills": skills or [],
        "remote": remote,
        "source_company": source_company or "",
    }


def build_staff_result(page, score_result):
    """要員のスコア結果を辞書に変換"""
    name = get_property_value(page, "要員名")
    summary = get_property_value(page, "サマリー")
    price = get_property_value(page, "営業単価")
    skills = get_property_value(page, "スキル概要")
    source_company = get_property_value(page, "要員元企業")
    skill_sheets = get_property_value(page, "スキルシート")

    has_skill_sheet = bool(skill_sheets and len(skill_sheets) > 0)
    skill_sheet_files = []
    if has_skill_sheet:
        for f in skill_sheets:
            skill_sheet_files.append({
                "name": f.get("name", ""),
                "url": f.get("url", ""),
            })

    age = extract_age(summary)

    return {
        "type": "staff",
        "page_id": page["id"],
        "title": name or "(無名)",
        "score": score_result["total"],
        "breakdown": score_result["breakdown"],
        "summary": summary or "",
        "price": price / 10000 if price else None,  # 万円表示
        "skills": skills or [],
        "age": age,
        "source_company": source_company or "",
        "has_skill_sheet": has_skill_sheet,
        "skill_sheet_files": skill_sheet_files,
    }


# ============================================================
# 配信履歴（再配信防止）
# ============================================================

HISTORY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "broadcast_history.json")
COOLDOWN_DAYS = 7  # 配信後N日間は再ピックアップ対象外


def load_history():
    """配信履歴を読み込む"""
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_history(history):
    """配信履歴を保存する"""
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)


def record_broadcast(page_ids, titles=None):
    """配信実行時に呼び出し：page_idリストを履歴に記録する
    titles: page_idに対応するタイトル（名前）のリスト（同名別ID対策）
    """
    history = load_history()
    now_str = datetime.now(timezone.utc).isoformat()
    for i, pid in enumerate(page_ids):
        entry = {"timestamp": now_str}
        if titles and i < len(titles):
            entry["title"] = titles[i]
        history[pid] = entry
    save_history(history)
    return len(page_ids)


def get_recently_broadcast(history=None):
    """COOLDOWN_DAYS以内に配信済みのpage_idセットとタイトルセットを返す"""
    if history is None:
        history = load_history()
    cutoff = datetime.now(timezone.utc) - timedelta(days=COOLDOWN_DAYS)
    recent_ids = set()
    recent_titles = set()
    expired = []

    for pid, val in history.items():
        try:
            # 新形式: {"timestamp": "...", "title": "..."} / 旧形式: "timestamp文字列"
            if isinstance(val, dict):
                ts_str = val.get("timestamp", "")
                title = val.get("title", "")
            else:
                ts_str = val
                title = ""

            ts = datetime.fromisoformat(ts_str)
            if ts >= cutoff:
                recent_ids.add(pid)
                if title:
                    recent_titles.add(title)
            else:
                expired.append(pid)
        except (ValueError, TypeError):
            expired.append(pid)

    # 期限切れのエントリを掃除
    if expired:
        for pid in expired:
            del history[pid]
        save_history(history)

    return recent_ids, recent_titles


def exclude_recently_broadcast(scored_list):
    """COOLDOWN_DAYS以内に配信済みの案件・要員を除外
    page_idだけでなくタイトル（名前）でも除外する（同名別ID対策）
    """
    recent_ids, recent_titles = get_recently_broadcast()
    if not recent_ids and not recent_titles:
        return scored_list, 0

    before = len(scored_list)
    filtered = [
        item for item in scored_list
        if item["page_id"] not in recent_ids
        and item.get("title", "") not in recent_titles
    ]
    excluded = before - len(filtered)
    return filtered, excluded


def deduplicate(scored_list):
    """page_idとタイトル（名前）の両方で重複を排除
    同名の別page_idレコード（Notion側の重複登録）も除外する
    """
    seen_ids = set()
    seen_titles = set()
    result = []
    for item in scored_list:
        pid = item["page_id"]
        title = item.get("title", "")
        if pid not in seen_ids and title not in seen_titles:
            seen_ids.add(pid)
            if title:
                seen_titles.add(title)
            result.append(item)
    return result


def pick_top_n(scored_list, top_n):
    """上位N件をピックアップ（厳密にN件で切る）
    スコア降順 → 同点の場合は鮮度(breakdown)で2次ソート済みのため、
    単純にN件で切る。
    """
    if not scored_list or top_n <= 0:
        return []
    return scored_list[:top_n]


def main():
    parser = argparse.ArgumentParser(description="配信候補ピックアップ")
    parser.add_argument("--top", type=int, default=3,
                        help="案件・要員それぞれの上位N件をピックアップ（デフォルト: 3）")
    parser.add_argument("--threshold", type=int, default=0,
                        help="最低スコア足切り（デフォルト: 0＝足切りなし）")
    parser.add_argument("--type", choices=["all", "cases", "staff"],
                        default="all", help="対象タイプ")
    parser.add_argument("--include-sent", action="store_true",
                        help="配信済みも含める（履歴除外をスキップ）")
    parser.add_argument("--record", nargs="*", default=None,
                        help="指定page_idを配信済みとして履歴に記録（ピックアップは行わない）")
    parser.add_argument("--record-titles", nargs="*", default=None,
                        help="--record と併用：page_idに対応するタイトル")
    args = parser.parse_args()

    # --record モード: 配信済み記録のみ行って終了
    if args.record is not None:
        count = record_broadcast(args.record, args.record_titles)
        print(json.dumps({
            "action": "record",
            "recorded": count,
            "page_ids": args.record,
        }, ensure_ascii=False, indent=2))
        return

    results = {
        "cases": [],
        "staff": [],
        "stats": {
            "total_cases_checked": 0,
            "total_staff_checked": 0,
            "top_n": args.top,
            "threshold": args.threshold,
            "cases_excluded_by_history": 0,
            "staff_excluded_by_history": 0,
        }
    }

    # 案件スコアリング
    if args.type in ("all", "cases"):
        print("案件データを取得中...", file=sys.stderr)
        cases = fetch_active_cases()
        results["stats"]["total_cases_checked"] = len(cases)
        print(f"  営業中の案件: {len(cases)}件", file=sys.stderr)

        all_scored = []
        for page in cases:
            score_result = score_case(page)
            if score_result["total"] >= args.threshold:
                all_scored.append(build_case_result(page, score_result))

        # 重複排除
        all_scored = deduplicate(all_scored)

        # 配信済み除外（7日以内）
        if not args.include_sent:
            all_scored, excluded = exclude_recently_broadcast(all_scored)
            results["stats"]["cases_excluded_by_history"] = excluded
            if excluded > 0:
                print(f"  配信済み除外: {excluded}件（{COOLDOWN_DAYS}日以内）", file=sys.stderr)

        # スコア降順ソート → 上位N件
        all_scored.sort(key=lambda x: x["score"], reverse=True)
        results["cases"] = pick_top_n(all_scored, args.top)
        print(f"  配信候補: {len(results['cases'])}件（上位{args.top}、全{len(all_scored)}件中）", file=sys.stderr)

    # 要員スコアリング
    if args.type in ("all", "staff"):
        print("要員データを取得中...", file=sys.stderr)
        staff = fetch_active_staff()
        results["stats"]["total_staff_checked"] = len(staff)
        print(f"  営業中の要員: {len(staff)}件", file=sys.stderr)

        all_scored = []
        for page in staff:
            score_result = score_staff(page)
            if score_result["total"] >= args.threshold:
                all_scored.append(build_staff_result(page, score_result))

        # 重複排除
        all_scored = deduplicate(all_scored)

        # 配信済み除外（7日以内）
        if not args.include_sent:
            all_scored, excluded = exclude_recently_broadcast(all_scored)
            results["stats"]["staff_excluded_by_history"] = excluded
            if excluded > 0:
                print(f"  配信済み除外: {excluded}件（{COOLDOWN_DAYS}日以内）", file=sys.stderr)

        # スコア降順ソート → 上位N件
        all_scored.sort(key=lambda x: x["score"], reverse=True)
        results["staff"] = pick_top_n(all_scored, args.top)
        print(f"  配信候補: {len(results['staff'])}件（上位{args.top}、全{len(all_scored)}件中）", file=sys.stderr)

    # JSON出力（stdoutに）
    print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
