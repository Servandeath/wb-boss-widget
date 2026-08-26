"""
Тесты API на TestClient (без реального сервера/сети). Кабинеты и путь к
SQLite подменяются на тестовые - тесты не зависят от backend/.env и не
трогают продовую базу.
"""

from fastapi.testclient import TestClient

from app import config
from app.api.main import app
from app.storage import db


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CABINETS", [config.Cabinet(code="TEST", name="Тест", token="x")])
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "metrics.db")
    monkeypatch.setattr(config, "API_TOKEN", "")


def test_health_no_token_required():
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_list_cabinets(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    client = TestClient(app)

    resp = client.get("/cabinets")
    assert resp.status_code == 200
    assert resp.json() == [{"code": "TEST", "name": "Тест"}]


def test_metrics_unknown_cabinet_404(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    client = TestClient(app)

    resp = client.get("/metrics/NOPE", params={"date_from": "2026-01-01", "date_to": "2026-01-31"})
    assert resp.status_code == 404


def test_metrics_returns_stored_values(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)

    conn = db.get_connection()
    db.upsert_metric(conn, "TEST", "2026-08-23", "revenue", 1000.0)
    db.upsert_metric(conn, "TEST", "2026-08-23", "margin", 300.0)
    conn.commit()
    conn.close()

    client = TestClient(app)
    resp = client.get("/metrics/TEST", params={"date_from": "2026-08-01", "date_to": "2026-08-31"})

    assert resp.status_code == 200
    assert resp.json() == {"2026-08-23": {"revenue": 1000.0, "margin": 300.0}}


def test_token_required_when_configured(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setattr(config, "API_TOKEN", "secret123")
    client = TestClient(app)

    resp_no_auth = client.get("/cabinets")
    assert resp_no_auth.status_code == 401

    resp_wrong = client.get("/cabinets", headers={"Authorization": "Bearer wrong"})
    assert resp_wrong.status_code == 401

    resp_ok = client.get("/cabinets", headers={"Authorization": "Bearer secret123"})
    assert resp_ok.status_code == 200
