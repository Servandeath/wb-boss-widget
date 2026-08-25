"""
Разведочный скрипт: список вкладок (без чтения данных) в cost-таблицах
из backend/.env (COST_SHEET_URL_*) - понять структуру, прежде чем
проектировать метрики/схему SQLite. Один metadata-запрос на таблицу,
данные строк не читаем. Запускать вручную:

    python backend/scripts/probe_cost_sheets.py
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import CABINETS  # noqa: E402
from app.sheets_client import get_service  # noqa: E402

SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


def extract_spreadsheet_id(url: str) -> str | None:
    match = SPREADSHEET_ID_RE.search(url)
    return match.group(1) if match else None


def main():
    if not CABINETS:
        raise SystemExit("Кабинеты не настроены (backend/.env, WB_CABINETS)")

    # Общие cost-таблицы одинаковые для всех кабинетов - берём из первого
    urls = CABINETS[0].cost_sheet_urls
    if not urls:
        raise SystemExit("Нет cost_sheet_urls (backend/.env, COST_SHEET_URL_*)")

    service = get_service()

    for url in urls:
        spreadsheet_id = extract_spreadsheet_id(url)
        if not spreadsheet_id:
            print(f"Не удалось извлечь ID из: {url}")
            continue

        try:
            metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
        except Exception as e:
            print(f"ОШИБКА для {spreadsheet_id}: {e}\n")
            continue

        title = metadata.get("properties", {}).get("title", "")
        sheet_titles = [s["properties"]["title"] for s in metadata["sheets"]]

        print(f"Таблица: {title} ({spreadsheet_id})")
        print(f"Вкладки: {sheet_titles}\n")


if __name__ == "__main__":
    main()
