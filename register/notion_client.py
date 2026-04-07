"""Notion API クライアント — Inbox / Cases / Staff / Proposals の操作"""

import json
import sys
import requests
from pathlib import Path
from datetime import datetime, timezone, timedelta

NOTION_API_URL = "https://api.notion.com/v1"
NOTION_VERSION = "2022-06-28"

JST = timezone(timedelta(hours=9))

VALID_SKILLS = ["Java", "JavaScript", "PHP", "TypeScript", "Python", "Go", "C#", "PM", "PMO"]


def load_config():
    """プロジェクトルートの .env と config/register-config.json を読み込む"""
    project_root = Path(__file__).parent.parent
    config = {}

    env_path = project_root / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                config[key.strip()] = val.strip()

    config_path = project_root / "config" / "register-config.json"
    if config_path.exists():
        with open(config_path, encoding="utf-8") as f:
            db_config = json.load(f)
        config.update({k: v for k, v in db_config.items() if not k.startswith("_")})

    return config


def load_line_mapping():
    """LINE UserID → 企業名マッピングを読み込む"""
    project_root = Path(__file__).parent.parent
    mapping_path = project_root / "config" / "line-user-mapping.json"
    if mapping_path.exists():
        with open(mapping_path, encoding="utf-8") as f:
            data = json.load(f)
        return {k: v for k, v in data.items() if not k.startswith("_")}
    return {}


class NotionClient:
    def __init__(self, config=None):
        self.config = config or load_config()
        self.api_key = self.config.get("NOTION_API_KEY", "")
        self.inbox_db_id = self.config.get("inbox_db_id", "")
        self.cases_db_id = self.config.get("cases_db_id", "")
        self.staff_db_id = self.config.get("staff_db_id", "")
        self.proposals_db_id = self.config.get("proposals_db_id", "")
        self.history_db_id = self.config.get("history_db_id", "")

    @property
    def headers(self):
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        }

    def _post(self, endpoint, payload):
        url = f"{NOTION_API_URL}/{endpoint}"
        resp = requests.post(url, headers=self.headers, json=payload)
        if resp.status_code >= 400:
            print(f"ERROR {resp.status_code}: {resp.text}", file=sys.stderr)
        resp.raise_for_status()
        return resp.json()

    def _patch(self, endpoint, payload):
        url = f"{NOTION_API_URL}/{endpoint}"
        resp = requests.patch(url, headers=self.headers, json=payload)
        if resp.status_code >= 400:
            print(f"ERROR {resp.status_code}: {resp.text}", file=sys.stderr)
        resp.raise_for_status()
        return resp.json()

    # =========================================================
    # Inbox 操作
    # =========================================================

    def create_inbox_entry(self, raw_text, source, user_id=""):
        """Inbox に原文エントリを作成（GASから呼ばれる想定）"""
        title = f"{source}: {user_id or '不明'}"
        properties = {
            "タイトル": _title(title),
            "原文": _rich_text(raw_text[:2000]),
            "入力経路": _select(source),
            "userId": _rich_text(user_id),
            "ステータス": _select("未処理"),
        }
        return self._post("pages", {"parent": {"database_id": self.inbox_db_id}, "properties": properties})

    def get_unprocessed_inbox(self):
        """Inbox の「未処理」エントリを取得"""
        return self.query_database("inbox", {"property": "ステータス", "select": {"equals": "未処理"}})

    def mark_inbox_processed(self, page_id, destination_url=""):
        """Inbox エントリを「処理済み」に更新"""
        properties = {"ステータス": _select("処理済み")}
        if destination_url:
            properties["処理先URL"] = {"url": destination_url}
        return self._patch(f"pages/{page_id}", {"properties": properties})

    def mark_inbox_error(self, page_id):
        """Inbox エントリを「エラー」に更新"""
        return self._patch(f"pages/{page_id}", {"properties": {"ステータス": _select("エラー")}})

    def archive_page(self, page_id):
        """Notionページをアーカイブ（削除）"""
        return self._patch(f"pages/{page_id}", {"archived": True})

    def get_grouped_inbox(self, window_minutes=10):
        """未処理Inboxエントリを userId + 時間近接でグルーピングして返す

        Returns:
            list[dict]: 各グループは以下の形式:
                {
                    "userId": str,
                    "company": str,       # マッピングから解決した企業名
                    "source": str,        # 入力経路
                    "entries": [          # 時間順のエントリリスト
                        {"page_id": str, "raw_text": str, "created_time": str, "has_file": bool}
                    ],
                    "combined_text": str, # 全エントリの原文を結合
                }
        """
        result = self.get_unprocessed_inbox()
        pages = result.get("results", [])
        if not pages:
            return []

        # ページデータを抽出し created_time でソート
        entries = []
        for page in pages:
            data = extract_page_data(page)
            file_urls = data.get("添付ファイル", []) or []
            raw_text = data.get("原文", "")

            # 原文が2000文字ちょうど → ページ本文(blocks)から全文取得を試みる
            if len(raw_text) >= 2000:
                try:
                    full_text = self.get_page_full_text(data["page_id"])
                    if full_text and len(full_text) > len(raw_text):
                        raw_text = full_text
                except Exception:
                    pass  # blocks取得失敗時はプロパティの原文をそのまま使う

            entry = {
                "page_id": data["page_id"],
                "userId": data.get("userId", ""),
                "source": data.get("入力経路", ""),
                "raw_text": raw_text,
                "created_time": page.get("created_time", ""),
                "has_file": bool(file_urls),
                "file_urls": file_urls if isinstance(file_urls, list) else [],
            }
            entries.append(entry)

        entries.sort(key=lambda e: e["created_time"])

        # userId ごとにグルーピング → 時間窓で分割
        from collections import defaultdict
        by_user = defaultdict(list)
        for entry in entries:
            key = entry["userId"] or entry["page_id"]  # userId無しは個別扱い
            by_user[key].append(entry)

        groups = []
        for user_key, user_entries in by_user.items():
            current_group = [user_entries[0]]
            for entry in user_entries[1:]:
                prev_time = _parse_time(current_group[-1]["created_time"])
                curr_time = _parse_time(entry["created_time"])
                if prev_time and curr_time and (curr_time - prev_time).total_seconds() <= window_minutes * 60:
                    current_group.append(entry)
                else:
                    groups.append(current_group)
                    current_group = [entry]
            groups.append(current_group)

        # グループを構造化
        result_groups = []
        for group_entries in groups:
            user_id = group_entries[0]["userId"]
            combined = "\n---\n".join(e["raw_text"] for e in group_entries if e["raw_text"])
            all_files = []
            for e in group_entries:
                all_files.extend(e.get("file_urls", []))
            result_groups.append({
                "userId": user_id,
                "company": resolve_company_name(user_id) if user_id else "",
                "source": group_entries[0]["source"],
                "entries": group_entries,
                "combined_text": combined,
                "file_urls": all_files,
            })

        return result_groups

    # =========================================================
    # Cases 操作
    # =========================================================

    def create_case(self, data, raw_text, company, source="手動"):
        """Cases DB に案件ページを作成"""
        properties = {
            "入力不要": _title(data.get("案件名", " ")),
            "原文": _rich_text(raw_text[:2000]),
            "サマリー": _rich_text(data.get("サマリー", "")[:2000]),
            "案件元企業": _rich_text(company),
            "ステータス": _select("営業中"),
            "入力経路": _select(source),
        }
        _add_if(properties, "スキル要件", _multi_select, data.get("スキル要件"), VALID_SKILLS)
        _add_if(properties, "スキル詳細", _rich_text, data.get("スキル詳細"))
        _add_if(properties, "営業単価", _number, data.get("営業単価"))
        _add_if(properties, "勤務地", _rich_text, data.get("勤務地"))
        _add_if(properties, "案件開始", _date, data.get("案件開始"))

        return self._post("pages", {"parent": {"database_id": self.cases_db_id}, "properties": properties})

    def get_active_cases(self):
        """Cases DB の「営業中」エントリを取得"""
        return self.query_database("cases", {"property": "ステータス", "select": {"equals": "営業中"}})

    # =========================================================
    # Staff 操作
    # =========================================================

    def create_staff(self, data, raw_text, company, source="手動", file_urls=None):
        """Staff DB に要員ページを作成"""
        properties = {
            "要員名": _title(data.get("要員名", " ")),
            "原文": _rich_text(raw_text[:2000]),
            "サマリー": _rich_text(data.get("サマリー", "")[:2000]),
            "要員元企業": _rich_text(company),
            "ステータス": _select("営業中"),
            "入力経路": _select(source),
        }
        _add_if(properties, "スキル概要", _multi_select, data.get("スキル概要"), VALID_SKILLS)
        _add_if(properties, "スキル詳細", _rich_text, data.get("スキル詳細"))
        _add_if(properties, "営業単価", _number, data.get("営業単価"))
        _add_if(properties, "稼働開始", _date, data.get("稼働開始"))
        if file_urls:
            staff_name = data.get("要員名", "不明")
            if len(file_urls) == 1:
                files = [{"type": "external", "name": f"SS_{staff_name}", "external": {"url": file_urls[0]}}]
            else:
                files = [{"type": "external", "name": f"SS_{staff_name}_{i+1}", "external": {"url": url}} for i, url in enumerate(file_urls)]
            properties["スキルシート"] = {"files": files}

        return self._post("pages", {"parent": {"database_id": self.staff_db_id}, "properties": properties})

    def get_active_staff(self):
        """Staff DB の「営業中」エントリを取得"""
        return self.query_database("staff", {"property": "ステータス", "select": {"equals": "営業中"}})

    # =========================================================
    # Proposals 操作
    # =========================================================

    def create_proposal(self, case_name, staff_name, judgment, score,
                        case_page_id, staff_page_id, memo=""):
        """Proposals DB にマッチング候補を作成（ページ本文にメモを記載）"""
        today = datetime.now(JST).strftime("%Y-%m-%d")
        title = f"【自動】{judgment}（{score}点）{case_name} × {staff_name}"
        properties = {
            "提案名": _title(title),
            "案件DB": {"relation": [{"id": case_page_id}]},
            "要員DB": {"relation": [{"id": staff_page_id}]},
            "ステータス": _select("候補"),
            "メモ": _rich_text(memo[:2000]),
            "提案日": _date(today),
        }
        children = _memo_to_blocks(memo)
        payload = {
            "parent": {"database_id": self.proposals_db_id},
            "properties": properties,
            "children": children,
        }
        return self._post("pages", payload)

    def get_proposals_by_status(self, status):
        """Proposals DB から指定ステータスのエントリを取得"""
        return self.query_database("proposals", {"property": "ステータス", "select": {"equals": status}})

    def get_proposal_detail(self, proposal_page_id):
        """Proposal とリレーション先の案件・要員データをまとめて取得"""
        page = self.get_page(proposal_page_id)
        proposal = extract_page_data(page)

        # relation から案件・要員の page_id を取得
        props = page.get("properties", {})
        case_ids = [r["id"] for r in props.get("案件DB", {}).get("relation", [])]
        staff_ids = [r["id"] for r in props.get("要員DB", {}).get("relation", [])]

        case_data = extract_page_data(self.get_page(case_ids[0])) if case_ids else {}
        staff_data = extract_page_data(self.get_page(staff_ids[0])) if staff_ids else {}

        # 送信先 userId を解決
        staff_company = staff_data.get("要員元企業", "")
        case_company = case_data.get("案件元企業", "")

        return {
            "proposal": proposal,
            "case": case_data,
            "staff": staff_data,
            "staff_company_user_id": resolve_user_id(staff_company),
            "case_company_user_id": resolve_user_id(case_company),
        }

    def is_action_done(self, page_id, action_keyword):
        """履歴DBで特定アクションが実行済みか確認（重複送信防止）"""
        if not self.history_db_id:
            return False
        result = self.query_database("history", {
            "and": [
                {"property": "対象ページID", "rich_text": {"equals": page_id}},
                {"property": "変更理由", "rich_text": {"contains": action_keyword}},
            ]
        })
        return len(result.get("results", [])) > 0

    def update_proposal_status(self, page_id, new_status, reason=""):
        """Proposal のステータスを更新し、履歴を記録"""
        page = self.get_page(page_id)
        page_data = extract_page_data(page)
        old_status = page_data.get("ステータス", "")
        page_name = page_data.get("提案名", "")

        self.update_page_status(page_id, new_status)

        if self.history_db_id:
            self.record_status_change(page_id, "Proposals", page_name, old_status, new_status, reason)

        return {"page_id": page_id, "name": page_name, "old_status": old_status, "new_status": new_status}

    # =========================================================
    # ステータス更新（汎用）
    # =========================================================

    def update_page_status(self, page_id, new_status):
        """ページのステータスを更新"""
        return self._patch(f"pages/{page_id}", {"properties": {"ステータス": _select(new_status)}})

    # =========================================================
    # ステータス変更履歴
    # =========================================================

    def record_status_change(self, page_id, db_type, page_name, old_status, new_status, reason=""):
        """ステータス変更履歴を記録"""
        if not self.history_db_id:
            return None

        now = datetime.now(JST).strftime("%Y-%m-%d")
        title = f"{db_type}: {page_name} [{old_status} → {new_status}]"
        properties = {
            "タイトル": _title(title[:200]),
            "対象DB": _select(db_type),
            "対象ページID": _rich_text(page_id),
            "旧ステータス": _rich_text(old_status),
            "新ステータス": _rich_text(new_status),
            "変更理由": _rich_text(reason),
            "変更日時": _date(now),
        }
        return self._post("pages", {"parent": {"database_id": self.history_db_id}, "properties": properties})

    def create_history_db(self, parent_page_id):
        """ステータス変更履歴DBを新規作成（初回セットアップ用）"""
        payload = {
            "parent": {"type": "page_id", "page_id": parent_page_id},
            "title": [{"text": {"content": "ステータス変更履歴"}}],
            "properties": {
                "タイトル": {"title": {}},
                "対象DB": {"select": {"options": [
                    {"name": "Cases", "color": "blue"},
                    {"name": "Staff", "color": "green"},
                    {"name": "Proposals", "color": "purple"},
                ]}},
                "対象ページID": {"rich_text": {}},
                "旧ステータス": {"rich_text": {}},
                "新ステータス": {"rich_text": {}},
                "変更理由": {"rich_text": {}},
                "変更日時": {"date": {}},
            },
        }
        return self._post("databases", payload)

    # =========================================================
    # 棚卸し（自動終了）
    # =========================================================

    def get_stale_entries(self, db_type, days=14):
        """指定日数以上経過した「営業中」のエントリを取得"""
        cutoff = (datetime.now(JST) - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00+09:00")
        filter_obj = {
            "and": [
                {"property": "ステータス", "select": {"equals": "営業中"}},
                {"timestamp": "created_time", "created_time": {"before": cutoff}},
            ]
        }
        return self.query_database(db_type, filter_obj)

    def close_stale_entries(self, days=14):
        """Cases/Staff の棚卸し — 指定日数以上経過の営業中を終了に変更"""
        results = {"cases": [], "staff": []}
        name_keys = {"cases": "入力不要", "staff": "要員名"}

        for db_type in ("cases", "staff"):
            stale = self.get_stale_entries(db_type, days)
            for page in stale.get("results", []):
                page_data = extract_page_data(page)
                page_id = page_data["page_id"]
                page_name = page_data.get(name_keys[db_type], "")

                self.update_page_status(page_id, "終了")

                if self.history_db_id:
                    self.record_status_change(
                        page_id, db_type.capitalize(), page_name,
                        "営業中", "終了", f"棚卸し: {days}日経過のため自動終了",
                    )
                results[db_type].append({"page_id": page_id, "name": page_name})

        return results

    # =========================================================
    # 汎用クエリ
    # =========================================================

    def query_database(self, db_type, filter_obj=None):
        """データベースをクエリ。db_type: inbox/cases/staff/proposals/history"""
        db_id = {
            "inbox": self.inbox_db_id,
            "cases": self.cases_db_id,
            "staff": self.staff_db_id,
            "proposals": self.proposals_db_id,
            "history": self.history_db_id,
        }.get(db_type, "")

        if not db_id:
            print(f"ERROR: {db_type} の DB ID が未設定です", file=sys.stderr)
            return {"results": []}

        payload = {}
        if filter_obj:
            payload["filter"] = filter_obj

        return self._post(f"databases/{db_id}/query", payload)

    def get_page(self, page_id):
        """ページの詳細を取得"""
        url = f"{NOTION_API_URL}/pages/{page_id}"
        resp = requests.get(url, headers=self.headers)
        resp.raise_for_status()
        return resp.json()

    def get_page_blocks(self, page_id):
        """ページのブロック（本文）を取得"""
        url = f"{NOTION_API_URL}/blocks/{page_id}/children"
        resp = requests.get(url, headers=self.headers, params={"page_size": 100})
        resp.raise_for_status()
        return resp.json()

    def get_page_full_text(self, page_id):
        """ページ本文からテキストを結合して取得（原文2000文字超対応）"""
        blocks = self.get_page_blocks(page_id)
        lines = []
        for block in blocks.get("results", []):
            block_type = block.get("type", "")
            if block_type in ("paragraph", "heading_1", "heading_2", "heading_3",
                              "bulleted_list_item", "numbered_list_item"):
                rich_text = block.get(block_type, {}).get("rich_text", [])
                text = "".join(t.get("plain_text", "") for t in rich_text)
                lines.append(text)
        return "\n".join(lines)


# =========================================================
# プロパティ生成ヘルパー
# =========================================================

def _title(text):
    return {"title": [{"text": {"content": str(text)}}]}

def _rich_text(text):
    text = str(text).replace("<br>", "\n")
    return {"rich_text": [{"text": {"content": text}}]}

def _select(name):
    return {"select": {"name": str(name)}}

def _multi_select(values, valid_list=None):
    if valid_list:
        values = [v for v in values if v in valid_list]
    return {"multi_select": [{"name": v} for v in values]}

def _number(value):
    return {"number": value}

def _date(date_str):
    return {"date": {"start": date_str}}

def _memo_to_blocks(memo):
    """マッチングメモをNotionのブロック（ページ本文）に変換"""
    blocks = []
    for line in memo.replace("<br>", "\n").split("\n"):
        if line.startswith("【") and line.endswith("】"):
            blocks.append({
                "object": "block", "type": "heading_3",
                "heading_3": {"rich_text": [{"text": {"content": line}}]}
            })
        elif line.startswith("【"):
            blocks.append({
                "object": "block", "type": "heading_3",
                "heading_3": {"rich_text": [{"text": {"content": line}}]}
            })
        elif line.strip():
            blocks.append({
                "object": "block", "type": "paragraph",
                "paragraph": {"rich_text": [{"text": {"content": line}}]}
            })
    return blocks


def _add_if(props, key, fn, value, *args):
    if value is not None:
        props[key] = fn(value, *args) if args else fn(value)


def _parse_time(iso_str):
    """ISO 8601文字列をdatetimeに変換（Notion形式対応）"""
    if not iso_str:
        return None
    try:
        # "2026-03-31T08:32:00.000Z" 形式
        clean = iso_str.replace("Z", "+00:00")
        if "." in clean:
            clean = clean.split(".")[0] + clean[clean.rfind("+"):]
        return datetime.fromisoformat(clean)
    except (ValueError, IndexError):
        return None


# =========================================================
# ページデータ抽出ヘルパー
# =========================================================

def extract_page_data(page):
    """Notionページから主要データを辞書で取得"""
    props = page.get("properties", {})
    data = {"page_id": page["id"], "url": page.get("url", "")}

    for key, prop in props.items():
        ptype = prop.get("type", "")
        if ptype == "title":
            texts = prop.get("title", [])
            data[key] = texts[0]["plain_text"] if texts else ""
        elif ptype == "rich_text":
            texts = prop.get("rich_text", [])
            data[key] = texts[0]["plain_text"] if texts else ""
        elif ptype == "select":
            sel = prop.get("select")
            data[key] = sel["name"] if sel else ""
        elif ptype == "multi_select":
            data[key] = [s["name"] for s in prop.get("multi_select", [])]
        elif ptype == "number":
            data[key] = prop.get("number")
        elif ptype == "date":
            d = prop.get("date")
            data[key] = d["start"] if d else None
        elif ptype == "url":
            data[key] = prop.get("url", "")
        elif ptype == "files":
            files = prop.get("files", [])
            urls = []
            for f in files:
                if f.get("type") == "external":
                    urls.append(f["external"]["url"])
                elif f.get("type") == "file":
                    urls.append(f["file"]["url"])
            data[key] = urls

    return data


# =========================================================
# LINE マッピング
# =========================================================

def resolve_company_name(user_id):
    """LINE UserIDから企業名を解決"""
    mapping = load_line_mapping()
    return mapping.get(user_id, "")


def add_line_mapping(user_id, company_name):
    """LINE UserID → 企業名マッピングを追加"""
    project_root = Path(__file__).parent.parent
    mapping_path = project_root / "config" / "line-user-mapping.json"

    data = {}
    if mapping_path.exists():
        with open(mapping_path, encoding="utf-8") as f:
            data = json.load(f)

    data[user_id] = company_name

    with open(mapping_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return company_name


def is_unmapped_user(user_id):
    """userIdがマッピング未登録かどうか"""
    if not user_id:
        return False
    mapping = load_line_mapping()
    return user_id not in mapping


def resolve_user_id(company_name):
    """企業名からLINE UserIDを逆引き（部分一致）"""
    mapping = load_line_mapping()
    # 正規化: 株式会社等を除去して比較
    def normalize(name):
        for prefix in ("株式会社", "(株)", "（株）"):
            name = name.replace(prefix, "")
        return name.strip()

    target = normalize(company_name)
    for uid, name in mapping.items():
        if normalize(name) == target:
            return uid
    return ""


# =========================================================
# CLI
# =========================================================

def main():
    if len(sys.argv) < 2:
        print("Usage: python notion_client.py <command>")
        print("Commands: check-config, unprocessed, active-cases, active-staff, resolve-user <userId>")
        sys.exit(1)

    client = NotionClient()
    cmd = sys.argv[1]

    if cmd == "check-config":
        print(f"API Key: {'SET' if client.api_key else 'MISSING'}")
        print(f"Inbox DB:     {client.inbox_db_id or 'MISSING'}")
        print(f"Cases DB:     {client.cases_db_id or 'MISSING'}")
        print(f"Staff DB:     {client.staff_db_id or 'MISSING'}")
        print(f"Proposals DB: {client.proposals_db_id or 'MISSING'}")
        mapping = load_line_mapping()
        print(f"LINE mapping: {len(mapping)}件")

    elif cmd == "unprocessed":
        result = client.get_unprocessed_inbox()
        entries = result.get("results", [])
        print(f"未処理: {len(entries)}件")
        for page in entries:
            d = extract_page_data(page)
            source = d.get("入力経路", "?")
            user_id = d.get("userId", "")
            company = resolve_company_name(user_id) if user_id else ""
            label = company or user_id or "不明"
            print(f"  [{source}] {label}: {d.get('原文', '')[:80]}...")

    elif cmd == "active-cases":
        result = client.get_active_cases()
        entries = result.get("results", [])
        print(f"営業中案件: {len(entries)}件")
        for page in entries:
            d = extract_page_data(page)
            print(json.dumps(d, ensure_ascii=False, indent=2))

    elif cmd == "active-staff":
        result = client.get_active_staff()
        entries = result.get("results", [])
        print(f"営業中要員: {len(entries)}件")
        for page in entries:
            d = extract_page_data(page)
            print(json.dumps(d, ensure_ascii=False, indent=2))

    elif cmd == "grouped-inbox":
        groups = client.get_grouped_inbox()
        print(f"グループ数: {len(groups)}")
        for i, g in enumerate(groups, 1):
            label = g["company"] or g["userId"] or "不明"
            n = len(g["entries"])
            has_file = any(e["has_file"] for e in g["entries"])
            file_mark = " [+file]" if has_file else ""
            preview = g["combined_text"][:200].encode("cp932", errors="replace").decode("cp932")
            print(f"\n--- Group {i}: {label} ({n}件{file_mark}) ---")
            print(preview)

    elif cmd == "add-mapping" and len(sys.argv) > 3:
        user_id = sys.argv[2]
        company = sys.argv[3]
        add_line_mapping(user_id, company)
        print(f"マッピング追加: {user_id} -> {company}")

    elif cmd == "resolve-user" and len(sys.argv) > 2:
        user_id = sys.argv[2]
        company = resolve_company_name(user_id)
        print(company or f"マッピングなし: {user_id}")

    elif cmd == "create-history-db":
        parent_page_id = "334c01f8-7769-81b4-bfdf-f3fe08b0875f"
        result = client.create_history_db(parent_page_id)
        db_id = result["id"].replace("-", "")
        print(f"ステータス変更履歴DB作成完了")
        print(f"DB ID: {db_id}")
        print(f"URL: {result.get('url', '')}")
        print(f"\n→ config/register-config.json に以下を追加してください:")
        print(f'  "history_db_id": "{db_id}"')

    elif cmd == "stale-check":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 14
        for db_type, name_key in [("cases", "入力不要"), ("staff", "要員名")]:
            stale = client.get_stale_entries(db_type, days)
            entries = stale.get("results", [])
            print(f"\n{db_type.upper()} - {days}日以上経過の営業中: {len(entries)}件")
            for page in entries:
                d = extract_page_data(page)
                print(f"  {d.get(name_key, '?')}")

    elif cmd == "close-stale":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 14
        results = client.close_stale_entries(days)
        total = len(results["cases"]) + len(results["staff"])
        print(f"棚卸し完了: {total}件を終了に変更")
        for db_type in ("cases", "staff"):
            for entry in results[db_type]:
                print(f"  [{db_type}] {entry['name']}")

    elif cmd == "proposals" and len(sys.argv) > 2:
        status = sys.argv[2]
        result = client.get_proposals_by_status(status)
        entries = result.get("results", [])
        print(f"Proposals（{status}）: {len(entries)}件")
        for page in entries:
            d = extract_page_data(page)
            print(json.dumps(d, ensure_ascii=False, indent=2))

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print("Commands: check-config, unprocessed, active-cases, active-staff,")
        print("          resolve-user <userId>, create-history-db, stale-check [days],")
        print("          close-stale [days], proposals <status>")
        sys.exit(1)


if __name__ == "__main__":
    main()
