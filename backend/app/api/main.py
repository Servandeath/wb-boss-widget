"""
FastAPI-сервер для расширения (см. корневой README, "Как это устроено",
шаг 3-4). Расширение не знает ни про WB, ни про Google Sheets - только
спрашивает этот API "какие сейчас цифры".

Безопасность (см. README, "Безопасность"): биндится на внутренний адрес
рабочей сети (backend/app/config.API_HOST, не 0.0.0.0), плюс токен поверх
(API_TOKEN) - если задан, все эндпоинты кроме /health его требуют.

Запуск:
    uvicorn app.api.main:app --host <API_HOST> --port <API_PORT>
(из backend/, чтобы работал импорт app.*)
"""

from fastapi import Depends, FastAPI, Header, HTTPException

from app import config
from app.storage.db import get_connection, get_metrics

app = FastAPI(title="wb-boss-widget API")


def verify_token(authorization: str | None = Header(default=None)) -> None:
    if not config.API_TOKEN:
        return  # токен не настроен - см. предупреждение в .env.example

    expected = f"Bearer {config.API_TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="Неверный или отсутствующий токен")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/cabinets", dependencies=[Depends(verify_token)])
def list_cabinets() -> list[dict]:
    return [{"code": c.code, "name": c.name} for c in config.CABINETS]


@app.get("/metrics/{cabinet_code}", dependencies=[Depends(verify_token)])
def metrics_for_cabinet(cabinet_code: str, date_from: str, date_to: str) -> dict:
    """
    date_from/date_to - YYYY-MM-DD, включительно. Ответ:
    {"2026-08-23": {"revenue": ..., "cost": ..., "ad_spend": ..., "margin": ...}, ...}
    Дата без записей в ответе не появляется - см. storage/db.py, узкий
    формат: отсутствие строки значит "данных ещё нет".
    """
    if not any(c.code == cabinet_code for c in config.CABINETS):
        raise HTTPException(status_code=404, detail=f"Кабинет '{cabinet_code}' не настроен")

    conn = get_connection()
    try:
        rows = get_metrics(conn, cabinet_code, date_from, date_to)
    finally:
        conn.close()

    result: dict[str, dict[str, float]] = {}
    for date, metric, value in rows:
        result.setdefault(date, {})[metric] = value

    return result
