"""
Читаем лист таблицы с кэшированием: архивные месяцы (закончились,
больше не меняются) читаем через API один раз и сохраняем в JSON.
При повторном запуске - берём из файла, не тратим лишний запрос к API.
Живой лист (Лист1) кэшу не подлежит - там данные растут каждый день.
"""

import json
from pathlib import Path
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SCRIPT_DIR = Path(__file__).resolve().parent
CREDENTIALS_FILE = SCRIPT_DIR / "credentials.json"
CACHE_DIR = SCRIPT_DIR / "cache"
SPREADSHEET_ID = "1CXqoIij9ZkFi9PnBDRShsjoJu9vGwgn4hJUuvtwVhLE"

MONTH_SHEETS = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
]


def get_sheet_values(service, sheet_name: str) -> list[list[str]]:
    """Прямой запрос к API за данными одного листа (без кэша)."""
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range=f"{sheet_name}!A1:Z"
    ).execute()
    return result.get("values", [])


def get_sheet_values_cached(service, sheet_name: str) -> list[list[str]]:
    """
    Для архивных месяцев - проверяем файл кэша перед походом в API.
    Для живых листов - кэш не используем вообще, всегда свежий запрос.
    """
    if sheet_name not in MONTH_SHEETS:
        return get_sheet_values(service, sheet_name)

    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / f"{sheet_name}.json"

    if cache_file.exists():
        print(f"'{sheet_name}': беру из кэша, в API не хожу")
        return json.loads(cache_file.read_text(encoding="utf-8"))

    print(f"'{sheet_name}': кэша нет, читаю через API и сохраняю")
    values = get_sheet_values(service, sheet_name)
    cache_file.write_text(json.dumps(values, ensure_ascii=False), encoding="utf-8")
    return values


def main():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds)

    for sheet_name in ["Июнь", "Лист1"]:
        values = get_sheet_values_cached(service, sheet_name)
        print(f"'{sheet_name}': получено строк = {len(values)}\n")


if __name__ == "__main__":
    main()