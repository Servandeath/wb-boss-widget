"""
Чтение листов таблицы с кэшированием: архивные месяцы (закончились,
больше не меняются) читаем через API один раз и сохраняем в JSON.
При повторном запуске - берём из файла, не тратим лишний запрос к API.
Живой лист (например "Лист1") кэшу не подлежит - там данные растут
каждый день.
"""

import json
from pathlib import Path

# backend/app/ingestion/sheet_reader.py -> parents[2] == backend/
BACKEND_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = BACKEND_DIR / "cache"

MONTH_SHEETS = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
]


def get_sheet_values(service, spreadsheet_id: str, sheet_name: str) -> list[list[str]]:
    """Прямой запрос к API за данными одного листа (без кэша)."""
    result = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=f"{sheet_name}!A1:Z"
    ).execute()
    return result.get("values", [])


def get_sheet_values_cached(service, spreadsheet_id: str, sheet_name: str) -> list[list[str]]:
    """
    Для архивных месяцев - проверяем файл кэша перед походом в API.
    Для живых листов - кэш не используем вообще, всегда свежий запрос.
    """
    if sheet_name not in MONTH_SHEETS:
        return get_sheet_values(service, spreadsheet_id, sheet_name)

    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / f"{sheet_name}.json"

    if cache_file.exists():
        print(f"'{sheet_name}': беру из кэша, в API не хожу")
        return json.loads(cache_file.read_text(encoding="utf-8"))

    print(f"'{sheet_name}': кэша нет, читаю через API и сохраняю")
    values = get_sheet_values(service, spreadsheet_id, sheet_name)
    cache_file.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")
    return values
