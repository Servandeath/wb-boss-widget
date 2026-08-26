"""
Реальный прогон: считает margin/revenue/cost/ad_spend по дням и пишет в
SQLite (backend/data/metrics.db, в .gitignore). Один запрос к
reportDetailByPeriod (жёсткий rate limit - не гонять в цикле). Запускать
вручную:

    python backend/scripts/run_margin_ingest.py [КОД_КАБИНЕТА] [дней_назад]
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_cabinet  # noqa: E402
from app.metrics.margin import compute_and_store_margin  # noqa: E402
from app.storage.db import get_connection, get_metrics  # noqa: E402


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    cabinet = get_cabinet(code)
    if not cabinet.token:
        raise SystemExit(f"Нет токена для кабинета {code} в backend/.env")

    date_to = datetime.now()
    date_from = date_to - timedelta(days=days_back)

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), период: {date_from.date()} - {date_to.date()}")
    result = compute_and_store_margin(cabinet, date_from, date_to)

    print(f"Дней посчитано и записано: {len(result)}")
    for date, metrics in result.items():
        print(f"  {date}: {metrics}")

    print()
    print("Проверка чтения обратно из SQLite:")
    conn = get_connection()
    rows = get_metrics(conn, cabinet.code, date_from.strftime("%Y-%m-%d"), date_to.strftime("%Y-%m-%d"))
    conn.close()
    for row in rows:
        print(f"  {row}")


if __name__ == "__main__":
    main()
