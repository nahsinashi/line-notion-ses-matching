#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
月次レポート生成 - コマンドライン版
使用方法: python generate_monthly.py 2026-01
"""

import sys
import subprocess
from datetime import datetime, timedelta
from calendar import monthrange

def get_month_range(month_str):
    """月開始日から月の範囲を取得"""
    year, month = map(int, month_str.split('-'))

    # 月の最初の日
    month_start = datetime(year, month, 1)

    # 月の最後の日
    last_day = monthrange(year, month)[1]
    month_end = datetime(year, month, last_day, 23, 59, 59)

    month_label = f"{year}年{month}月"

    return month_start, month_end, month_label

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python generate_monthly.py YYYY-MM [--notion]")
        print("例: python generate_monthly.py 2026-01")
        print("  --notion: Notionにレポートを投稿")
        sys.exit(1)

    month_str = sys.argv[1]
    upload_to_notion = "--notion" in sys.argv

    try:
        month_start, month_end, month_label = get_month_range(month_str)
    except ValueError:
        print("エラー: 月フォーマットが正しくありません（YYYY-MM形式で入力してください）")
        sys.exit(1)

    print(f"月次レポートを生成します: {month_label}")
    print(f"期間: {month_start.strftime('%Y-%m-%d')} 〜 {month_end.strftime('%Y-%m-%d')}")

    # fetch_and_analyze_monthly.pyをインポートして実行
    import fetch_and_analyze_monthly as script

    # 対象期間を上書き
    script.MONTH_START = month_start
    script.MONTH_END = month_end
    script.MONTH_LABEL = month_label

    # レポート生成を実行
    report = script.generate_monthly_report()

    # ファイル名を生成
    filename = f"monthly_report_{month_start.strftime('%Y_%m')}.md"
    with open(filename, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"\n✅ レポートを {filename} に保存しました")

    # Notionに投稿
    if upload_to_notion:
        result = script.update_latest_monthly_report_page(report)
        if result["success"]:
            print(f"✅ 最新月次レポートを更新しました: {result['page_url']}")
        else:
            print(f"❌ Notion投稿エラー: {result['error']}")
