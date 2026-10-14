"""
Тесты пагинации отчёта о реализации (finance-api) без сети: requests и
time.sleep подменяются, проверяем курсор rrdId и остановку на 204.
"""

from datetime import date

from app.ingestion import wb_client


class _Resp:
    def __init__(self, status_code, payload=None):
        self.status_code = status_code
        self._payload = payload
        self.headers = {}
        self.text = ""

    def json(self):
        return self._payload


def _patch(monkeypatch, responses):
    calls = []

    def fake_request(method, url, params=None, json=None, headers=None, timeout=None):
        calls.append({"method": method, "url": url, "json": dict(json) if json else None})
        return responses.pop(0)

    monkeypatch.setattr(wb_client.requests, "request", fake_request)
    monkeypatch.setattr(wb_client.time, "sleep", lambda s: None)
    return calls


def test_realization_report_paginates_until_204(monkeypatch):
    calls = _patch(monkeypatch, [
        _Resp(200, [{"rrdId": 1}, {"rrdId": 2}]),
        _Resp(200, [{"rrdId": 3}, {"rrdId": 4}]),
        _Resp(204),
    ])

    rows = wb_client.get_realization_report("tok", date(2026, 9, 1), date(2026, 9, 30), limit=2)

    assert [r["rrdId"] for r in rows] == [1, 2, 3, 4]
    assert [c["json"]["rrdId"] for c in calls] == [0, 2, 4]
    assert all(c["method"] == "POST" for c in calls)
    assert calls[0]["url"] == wb_client.REALIZATION_REPORT_URL
    assert calls[0]["json"]["dateFrom"] == "2026-09-01"
    assert calls[0]["json"]["dateTo"] == "2026-09-30"


def test_realization_report_short_page_stops_without_extra_request(monkeypatch):
    calls = _patch(monkeypatch, [_Resp(200, [{"rrdId": 1}])])

    rows = wb_client.get_realization_report("tok", date(2026, 9, 1), date(2026, 9, 30), limit=2)

    assert rows == [{"rrdId": 1}]
    assert len(calls) == 1


def test_realization_report_no_data(monkeypatch):
    _patch(monkeypatch, [_Resp(204)])

    assert wb_client.get_realization_report("tok", date(2026, 9, 1), date(2026, 9, 30)) == []
