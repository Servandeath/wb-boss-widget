"""
SQLite-слой в узком формате cabinet/date/metric/value (см. корневой
README, раздел "Хранение данных"). Отсутствие строки = данных ещё нет,
а не "данные - ноль" - поэтому upsert, а не всегда-запись нуля.
"""

import sqlite3
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
DB_PATH = BACKEND_DIR / "data" / "metrics.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS metrics (
    cabinet TEXT NOT NULL,
    date TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (cabinet, date, metric)
);
"""


def get_connection() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(SCHEMA)
    return conn


def upsert_metric(conn: sqlite3.Connection, cabinet: str, date: str, metric: str, value: float) -> None:
    conn.execute(
        "INSERT INTO metrics (cabinet, date, metric, value) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (cabinet, date, metric) DO UPDATE SET value = excluded.value",
        (cabinet, date, metric, value),
    )


def get_metrics(conn: sqlite3.Connection, cabinet: str, date_from: str, date_to: str) -> list[tuple]:
    """Все строки кабинета за период [date_from; date_to], включительно."""
    cursor = conn.execute(
        "SELECT date, metric, value FROM metrics "
        "WHERE cabinet = ? AND date >= ? AND date <= ? ORDER BY date, metric",
        (cabinet, date_from, date_to),
    )
    return cursor.fetchall()
