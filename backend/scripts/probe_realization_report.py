"""
Разведочный скрипт: ОДИН запрос к официальному отчёту о реализации WB
(reportDetailByPeriod) - проверить, что эндпоинт вообще отдаёт данные на
текущий токен, и посмотреть реальные поля. У этого эндпоинта исторически
жёсткий rate limit - НЕ гонять в цикле, один запуск - один запрос.

Не пагинирует, не пишет в SQLite, не трогает Google Sheets. Запускать
вручную:

    python backend/scripts/probe_realization_report.py [КОД_КАБИНЕТА] [дней_назад]
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_cabinet  # noqa: E402
from app.ingestion.wb_client import get_realization_report  # noqa: E402


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else 7

    cabinet = get_cabinet(code)
    if not cabinet.token:
        raise SystemExit(f"Нет токена для кабинета {code} в backend/.env")

    date_to = datetime.now()
    date_from = date_to - timedelta(days=days_back)

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), период: {date_from.date()} - {date_to.date()}")

    rows = get_realization_report(cabinet.token, date_from, date_to)

    print(f"Строк получено: {len(rows)}")
    if rows:
        print("Ключи первой строки:", sorted(rows[0].keys()))
        print()
        print("Первая строка целиком:")
        print(rows[0])


if __name__ == "__main__":
    main()
