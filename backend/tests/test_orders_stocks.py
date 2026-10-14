"""
Заказы по дням из Order Feed и снимок остатков - на синтетических строках
в формате WB, без сети. Плюс пагинация get_order_feed/get_wb_stocks.
"""

from datetime import datetime

from app.ingestion import wb_client
from app.metrics.orders_stocks import MSK, compute_daily_orders, compute_stock_snapshot


def _order(created, status="created", price=1000):
    return {"createdAt": f"{created}T10:00:00+03:00", "status": status, "sellerPrice": price}


def test_daily_orders_by_created_date_and_status():
    orders = [
        _order("2026-10-12", price=1500),
        _order("2026-10-12", "cancel", 500),
        _order("2026-10-12", "buyout", 700),
        _order("2026-10-13", "return"),
        _order("2026-10-13", "returnDefective"),
    ]

    result = compute_daily_orders(orders, "2026-10-12")

    assert result["2026-10-12"] == {"orders": 3, "orders_sum": 2700, "cancels": 1, "buyouts": 1, "returns": 0}
    assert result["2026-10-13"]["returns"] == 2


def test_days_before_window_are_dropped():
    # старый заказ попал в выгрузку, потому что сменил статус внутри окна
    orders = [_order("2026-08-11", "buyout"), _order("2026-10-12")]

    assert list(compute_daily_orders(orders, "2026-10-12")) == ["2026-10-12"]


def test_stock_snapshot_sums():
    wb_items = [
        {"quantity": 5, "inWayToClient": 1, "inWayFromClient": 0},
        {"quantity": 0, "inWayToClient": 2, "inWayFromClient": 3},
    ]
    seller_items = [{"quantity": 7}, {"quantity": 1}]

    assert compute_stock_snapshot(wb_items, seller_items) == {
        "stock": 5, "stock_to_client": 3, "stock_from_client": 3, "stock_seller": 8,
    }


class _Resp:
    def __init__(self, payload, status_code=200):
        self.status_code = status_code
        self._payload = payload
        self.headers = {}
        self.text = ""

    def json(self):
        return self._payload


def _patch(monkeypatch, payloads):
    calls = []

    def fake_request(method, url, params=None, json=None, headers=None, timeout=None):
        calls.append({"url": url, "json": {**json, "pagination": dict(json.get("pagination", {}))}})
        return _Resp(payloads.pop(0))

    monkeypatch.setattr(wb_client.requests, "request", fake_request)
    monkeypatch.setattr(wb_client.time, "sleep", lambda s: None)
    return calls


def test_order_feed_paginates_with_snapshot(monkeypatch):
    monkeypatch.setattr(wb_client, "ORDER_FEED_PAGE_LIMIT", 2)
    calls = _patch(monkeypatch, [
        {"data": {"snapshotTime": "2026-10-14T10:00:00Z", "orders": [{"n": 1}, {"n": 2}]}},
        {"data": {"snapshotTime": "2026-10-14T10:00:00Z", "orders": [{"n": 3}]}},
    ])
    now = datetime(2026, 10, 14, 12, 0, tzinfo=MSK)

    orders = wb_client.get_order_feed("tok", now.replace(day=12), now)

    assert [o["n"] for o in orders] == [1, 2, 3]
    assert [c["json"]["pagination"]["offset"] for c in calls] == [0, 2]
    assert "snapshotTime" not in calls[0]["json"]["pagination"]
    assert calls[1]["json"]["pagination"]["snapshotTime"] == "2026-10-14T10:00:00Z"
    assert calls[0]["json"]["selectedPeriod"]["start"] == "2026-10-12T12:00:00+03:00"


def test_wb_stocks_single_page(monkeypatch):
    calls = _patch(monkeypatch, [{"data": {"items": [{"quantity": 1}]}}])

    assert wb_client.get_wb_stocks("tok") == [{"quantity": 1}]
    assert len(calls) == 1
