#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
配信実行スクリプト
ユーザー承認後、GAS WebApp経由でLINE配信を実行する
"""

import sys
import io
import json
import argparse
import requests

# Windows環境でのUnicode出力対応
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# ============================================================
# 設定読み込み
# ============================================================

import os

CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")


def load_config():
    """config.jsonから設定を読み込み"""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        print("config.jsonが見つかりません", file=sys.stderr)
        sys.exit(1)


# ============================================================
# メイン処理
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="配信実行")
    parser.add_argument("--cases", nargs="*", default=[],
                        help="配信する案件のNotionページID")
    parser.add_argument("--staff", nargs="*", default=[],
                        help="配信する要員のNotionページID")
    parser.add_argument("--test", action="store_true",
                        help="テストモード（管理者のみに送信）")
    args = parser.parse_args()

    config = load_config()

    gas_url = config.get("gas_webapp_url", "")
    token = config.get("broadcast_token", "")

    if not gas_url:
        print(json.dumps({
            "success": False,
            "message": "config.json の gas_webapp_url が未設定です"
        }, ensure_ascii=False))
        sys.exit(1)

    if not token:
        print(json.dumps({
            "success": False,
            "message": "config.json の broadcast_token が未設定です"
        }, ensure_ascii=False))
        sys.exit(1)

    if not args.cases and not args.staff:
        print(json.dumps({
            "success": False,
            "message": "配信対象が指定されていません（--cases / --staff）"
        }, ensure_ascii=False))
        sys.exit(1)

    # GAS WebAppに配信指示を送信
    payload = {
        "action": "broadcast",
        "token": token,
        "cases": args.cases,
        "staff": args.staff,
        "test_mode": args.test
    }

    print(f"GAS WebAppに配信指示を送信中...", file=sys.stderr)
    print(f"  案件: {len(args.cases)}件", file=sys.stderr)
    print(f"  要員: {len(args.staff)}件", file=sys.stderr)
    print(f"  テストモード: {args.test}", file=sys.stderr)

    try:
        response = requests.post(
            gas_url,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=300,  # GASは処理に時間がかかる場合がある
            allow_redirects=True  # GAS WebAppはリダイレクトする
        )

        if response.status_code == 200:
            result = response.json()
            print(json.dumps(result, ensure_ascii=False, indent=2))

            # 配信成功時に履歴を記録（再ピックアップ防止）
            if result.get("success"):
                try:
                    from broadcast import record_broadcast
                    all_ids = args.cases + args.staff
                    recorded = record_broadcast(all_ids)
                    print(f"配信履歴に{recorded}件を記録しました", file=sys.stderr)
                except Exception as e:
                    print(f"履歴記録エラー（配信自体は成功）: {e}", file=sys.stderr)
        else:
            print(json.dumps({
                "success": False,
                "message": f"GAS APIエラー: {response.status_code}",
                "body": response.text[:500]
            }, ensure_ascii=False))

    except requests.exceptions.Timeout:
        print(json.dumps({
            "success": False,
            "message": "GAS APIタイムアウト（300秒）"
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            "success": False,
            "message": f"リクエストエラー: {str(e)}"
        }, ensure_ascii=False))


if __name__ == "__main__":
    main()
