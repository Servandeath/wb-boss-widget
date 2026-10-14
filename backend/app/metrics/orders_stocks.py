"""
Оперативные метрики: заказы по дням из Order Feed и снимок остатков на
складах WB (app/ingestion/wb_client.py). В отличие от маржи (отчёт о
реализации - раз в неделю) эти данные почти в реальном времени.

Заказы, день - дата createdAt (WB отдаёт её в МСК, "+03:00"):

    orders       сколько товаров заказано (1 строка Order Feed = 1 товар)
    orders_sum   сумма sellerPrice по ним, руб.
    cancels      из них сейчас в статусе "cancel"
    buyouts      из них сейчас в статусе "buyout"
    returns      из них сейчас в статусе "return"/"returnDefective"

cancels/buyouts/returns - ТЕКУЩИЙ статус: за свежий день они ещё растут
по мере того, как заказы доезжают до покупателя, - это нормально.

Order Feed фильтрует по времени текущего статуса, поэтому в выгрузку
попадают и старые заказы, у которых статус сменился внутри окна. Дни
раньше начала окна неполные - их не пишем (first_full_date).

Остатки - снимок на момент загрузки, пишется на сегодняшнюю дату (МСК):
stock (quantity на складах WB), stock_to_client (inWayToClient),
stock_from_client (inWayFromClient), stock_seller (quantity на своих
складах продавца - FBS, у МАНИ это ~14% заказов). История копится сама -
по снимку в день загрузки.
"""

from collections import defaultdict
from datetime import datetime, timedelta, timezone

from app.config import Cabinet
from app.ingestion.wb_client import get_order_feed, get_seller_stocks, get_wb_stocks
from app.storage.db import get_connection, upsert_metric

MSK = timezone(timedelta(hours=3))
ORDER_FEED_MAX_DAYS = 31  # дальше WB не отдаёт

ORDER_METRICS = ("orders", "orders_sum", "cancels", "buyouts", "returns")
STATUS_METRIC = {
    "cancel": "cancels",
    "buyout": "buyouts",
    "return": "returns",
    "returnDefective": "returns",
}


def compute_daily_orders(orders: list[dict], first_full_date: str) -> dict[str, dict[str, float]]:
    """Строки Order Feed -> {date: {metric: value}}, только дни >= first_full_date."""
    days: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(ORDER_METRICS, 0.0))

    for order in orders:
        date = str(order.get("createdAt") or "")[:10]
        if not date or date < first_full_date:
            continue

        day = days[date]
        day["orders"] += 1
        day["orders_sum"] += float(order.get("sellerPrice") or 0)
        status_metric = STATUS_METRIC.get(order.get("status"))
        if status_metric:
            day[status_metric] += 1

    return {date: {m: round(v, 2) for m, v in days[date].items()} for date in sorted(days)}


def compute_stock_snapshot(wb_items: list[dict], seller_items: list[dict]) -> dict[str, float]:
    return {
        "stock": sum(float(i.get("quantity") or 0) for i in wb_items),
        "stock_to_client": sum(float(i.get("inWayToClient") or 0) for i in wb_items),
        "stock_from_client": sum(float(i.get("inWayFromClient") or 0) for i in wb_items),
        "stock_seller": sum(float(i.get("quantity") or 0) for i in seller_items),
    }


def _store(cabinet_code: str, by_date: dict[str, dict[str, float]]) -> None:
    conn = get_connection()
    try:
        for date, metrics in by_date.items():
            for metric, value in metrics.items():
                upsert_metric(conn, cabinet_code, date, metric, value)
        conn.commit()
    finally:
        conn.close()


def ingest_orders(cabinet: Cabinet, days_back: int, now: datetime | None = None) -> dict[str, dict[str, float]]:
    """Заказы за последние days_back дней (не больше 31) -> SQLite."""
    now = now or datetime.now(MSK)
    days_back = min(days_back, ORDER_FEED_MAX_DAYS)
    start = (now - timedelta(days=days_back)).replace(hour=0, minute=0, second=0, microsecond=0)

    orders = get_order_feed(cabinet.token, start, now)
    result = compute_daily_orders(orders, start.strftime("%Y-%m-%d"))
    _store(cabinet.code, result)
    return result


def ingest_stocks(cabinet: Cabinet, now: datetime | None = None) -> dict[str, float]:
    """Снимок остатков на складах WB и продавца -> SQLite на сегодняшнюю дату (МСК)."""
    now = now or datetime.now(MSK)
    snapshot = compute_stock_snapshot(get_wb_stocks(cabinet.token), get_seller_stocks(cabinet.token))
    _store(cabinet.code, {now.strftime("%Y-%m-%d"): snapshot})
    return snapshot
