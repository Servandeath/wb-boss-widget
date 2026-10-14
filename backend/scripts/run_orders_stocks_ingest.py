"""
Реальный прогон оперативных метрик (app/metrics/orders_stocks.py):
заказы по дням из Order Feed + снимок остатков на складах WB -> SQLite.
Запускать вручную:

    python scripts/run_orders_stocks_ingest.py [КОД_КАБИНЕТА|ALL] [дней_назад]

дней_назад - для заказов, максимум 31 (ограничение WB). Остатки - всегда
текущий снимок. Order Feed - 1 запрос/минуту, при большом числе заказов
загрузка идёт по странице в минуту - это нормально.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import CABINETS, get_cabinet  # noqa: E402
from app.metrics.orders_stocks import ingest_orders, ingest_stocks  # noqa: E402

PAUSE_BETWEEN_CABINETS_S = 65


def ingest(code: str, days_back: int) -> None:
    cabinet = get_cabinet(code)
    if not cabinet.token:
        print(f"Пропуск {code}: нет токена в backend/.env")
        return

    print(f"Кабинет: {cabinet.name} ({cabinet.code})", flush=True)

    stock = ingest_stocks(cabinet)
    print(
        f"  Остатки на складах WB: {stock['stock']:,.0f} шт., "
        f"в пути к клиенту {stock['stock_to_client']:,.0f}, от клиента {stock['stock_from_client']:,.0f}; "
        f"на складе продавца {stock['stock_seller']:,.0f} шт."
    )

    orders = ingest_orders(cabinet, days_back)
    print(f"  Заказы, дней записано: {len(orders)}")
    for date, m in orders.items():
        print(
            f"  {date}: заказов {m['orders']:>6,.0f} на {m['orders_sum']:>14,.2f}  "
            f"отмен {m['cancels']:>5,.0f}  выкуплено {m['buyouts']:>5,.0f}"
        )


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else 7

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
