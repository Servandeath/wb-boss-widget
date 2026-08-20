"""
Получаем список всех листов (вкладок) в таблице - нужно, чтобы
отличить архивные месяцы (Январь, Февраль, ...) от текущего Лист1.
"""

from pathlib import Path
from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SCRIPT_DIR = Path(__file__).resolve().parent
CREDENTIALS_FILE = SCRIPT_DIR / "credentials.json"
SPREADSHEET_ID = "1CXqoIij9ZkFi9PnBDRShsjoJu9vGwgn4hJUuvtwVhLE"

# Архивные листы - названия месяцев. Всё, что НЕ в этом списке
# (например "Лист1") - текущие живые данные, не кэшируем
MONTH_SHEETS = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
]


def main():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds)

    # Запрос БЕЗ диапазона - получаем метаданные всей таблицы,
    # а не данные конкретного листа
    metadata = service.spreadsheets().get(spreadsheetId=SPREADSHEET_ID).execute()

    sheet_titles = [s["properties"]["title"] for s in metadata["sheets"]]
    print(f"Все листы в таблице: {sheet_titles}\n")

    archive_sheets = [s for s in sheet_titles if s in MONTH_SHEETS]
    live_sheets = [s for s in sheet_titles if s not in MONTH_SHEETS]

    print(f"Архивные (можно кэшировать): {archive_sheets}")
    print(f"Живые (читать каждый раз заново): {live_sheets}")


if __name__ == "__main__":
    main()
