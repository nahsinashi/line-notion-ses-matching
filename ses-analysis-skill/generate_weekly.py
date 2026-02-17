#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
週次レポート生成 - コマンドライン版
使用方法: python generate_weekly.py 2026-01-19
"""

import sys
import subprocess
from datetime import datetime, timedelta

def get_week_range(date_str):
    """週開始日から週の範囲を取得"""
    week_start = datetime.strptime(date_str, "%Y-%m-%d")
    week_end = week_start + timedelta(days=6, hours=23, minutes=59, seconds=59)

    # 週番号を計算
    week_num = (week_start.day - 1) // 7 + 1
    week_label = f"{week_start.year}年{week_start.month}月第{week_num}週（{week_start.strftime('%m/%d')}-{week_end.strftime('%m/%d')}）"

    return week_start, week_end, week_label

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python generate_weekly.py YYYY-MM-DD [--no-notion] [--file-only]")
        print("例: python generate_weekly.py 2026-01-19")
        print("  デフォルト: Notionに投稿 + ファイル保存")
        print("  --no-notion: Notion投稿をスキップ（ファイルのみ保存）")
        print("  --file-only: --no-notion と同じ")
        sys.exit(1)

    date_str = sys.argv[1]
    skip_notion = "--no-notion" in sys.argv or "--file-only" in sys.argv
    upload_to_notion = not skip_notion
    save_file = True  # ファイルは常に保存

    try:
        week_start, week_end, week_label = get_week_range(date_str)
    except ValueError:
        print("エラー: 日付フォーマットが正しくありません（YYYY-MM-DD形式で入力してください）")
        sys.exit(1)

    print(f"週次レポートを生成します: {week_label}")
    print(f"期間: {week_start.strftime('%Y-%m-%d')} 〜 {week_end.strftime('%Y-%m-%d')}")

    # fetch_and_analyze.pyを編集して実行
    import fetch_and_analyze as script

    # 対象期間を上書き
    script.WEEK_START = week_start.replace(hour=0, minute=0, second=0, microsecond=0)
    script.WEEK_END = week_end
    script.WEEK_LABEL = week_label
    script.ONE_WEEK_AGO = week_end - timedelta(days=7)
    script.TWO_WEEKS_AGO = week_end - timedelta(days=14)

    # レポート生成を実行
    report = script.generate_report()

    # ファイル保存（--notion-only でない場合のみ）
    if save_file:
        filename = f"weekly_report_{week_start.strftime('%Y_%m_%d')}.md"
        with open(filename, "w", encoding="utf-8") as f:
            f.write(report)
        print(f"\n✅ レポートを {filename} に保存しました")

    # Notionに投稿
    if upload_to_notion:
        result = script.update_latest_report_page(report)
        if result["success"]:
            print(f"✅ 最新週次レポートを更新しました: {result['page_url']}")
        else:
            print(f"❌ Notion投稿エラー: {result['error']}")
