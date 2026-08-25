"""
Разведочный скрипт: ОДИН запрос к WB API (статистика продаж) для одного
кабинета - проверить, что токен рабочий, и посмотреть форму ответа.

Не пагинирует, не пишет в SQLite, не трогает Google Sheets - только
смотрит. Запускать вручную:

    python backend/scripts/probe_wb_sales.py [КОД_КАБИНЕТА] [YYYY-MM-DD]

По умолчанию: кабинет MANI, dateFrom = вчера.
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_cabinet  # noqa: E402
from app.ingestion.wb_client import get_sales  # noqa: E402


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    date_from = (
        datetime.strptime(sys.argv[2], "%Y-%m-%d")
        if len(sys.argv) > 2
        else datetime.now() - timedelta(days=1)
    )

    cabinet = get_cabinet(code)
    if not cabinet.token:
        raise SystemExit(f"Нет токена для кабинета {code} в backend/.env")

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), dateFrom={date_from.date()}")

    rows = get_sales(cabinet.token, date_from)

    print(f"Строк получено: {len(rows)}")
    if rows:
        print("Ключи первой строки:", sorted(rows[0].keys()))


if __name__ == "__main__":
    main()
