"""
Реальный прогон: считает метрики по дням (app/metrics/margin.py) из
отчёта о реализации WB и пишет в SQLite (backend/data/metrics.db, в
.gitignore). Себестоимость - backend/data/costs.csv (если файла нет,
cost = 0 и margin = payout). Запускать вручную:

    python scripts/run_margin_ingest.py [КОД_КАБИНЕТА|ALL] [дней_назад]

ALL - все кабинеты из WB_CABINETS по очереди с паузой между ними (лимит
finance-api - 1 запрос/минуту на кабинет; пауза - чтобы не долбить WB
пачкой и из этого же скрипта не упираться в общий лимит с GAS).
"""

import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import CABINETS, get_cabinet  # noqa: E402
from app.metrics.margin import compute_and_store_margin  # noqa: E402

PAUSE_BETWEEN_CABINETS_S = 65


def ingest(code: str, days_back: int) -> None:
    cabinet = get_cabinet(code)
    if not cabinet.token:
        print(f"Пропуск {code}: нет токена в backend/.env")
        return

    date_to = datetime.now()
    date_from = date_to - timedelta(days=days_back)

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), период: {date_from.date()} - {date_to.date()}")
    result = compute_and_store_margin(cabinet, date_from, date_to)

    print(f"Дней посчитано и записано: {len(result)}")
    for date, m in result.items():
        warn = f"  (без себестоимости: {m['units_without_cost']:.0f} шт.)" if m["units_without_cost"] else ""
        print(f"  {date}: к перечислению {m['payout']:>14,.2f}  маржа {m['margin']:>14,.2f}{warn}")


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else 3

    codes = [c.code for c in CABINETS] if code.upper() == "ALL" else [code]
    for i, c in enumerate(codes):
        if i:
            time.sleep(PAUSE_BETWEEN_CABINETS_S)
        try:
            ingest(c, days_back)
        except Exception as e:  # один упавший кабинет не должен ронять остальные
            print(f"Ошибка по кабинету {c}: {e}")
        print()


if __name__ == "__main__":
    main()
