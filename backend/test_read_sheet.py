"""
Тестовый скрипт: проверяем, что service account может прочитать данные
из таблицы. Ничего не считаем, не пишем в SQLite - только смотрим,
что API вообще отвечает и отдаёт данные.
"""

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# Права только на чтение - роботу писать в таблицы не нужно
SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Путь к ключу service account (в .gitignore, в репозиторий не попадает)
CREDENTIALS_FILE = "credentials.json"

# ID таблицы - берётся из URL между /d/ и /edit
SPREADSHEET_ID = "1CXqoIij9ZkFi9PnBDRShsjoJu9vGwgn4hJUuvtwVhLE"

# Какой лист и диапазон читаем. A1:J20 - первые 20 строк, чтобы
# не тащить сразу всю таблицу на этапе проверки
RANGE_NAME = "Лист1!A1:J20"


def main():
    # Загружаем ключ и создаём объект авторизации
    creds = Credentials.from_service_account_file(
        CREDENTIALS_FILE, scopes=SCOPES
    )

    # Собираем клиент для Sheets API (v4 - актуальная версия)
    service = build("sheets", "v4", credentials=creds)

    # Делаем запрос: взять значения из указанного диапазона
    sheet = service.spreadsheets()
    result = sheet.values().get(
        spreadsheetId=SPREADSHEET_ID, range=RANGE_NAME
    ).execute()

    # API возвращает данные под ключом "values" - список списков
    values = result.get("values", [])

    if not values:
        print("Данные не найдены - проверь доступ или название листа")
        return

    print(f"Получено строк: {len(values)}\n")
    for row in values:
        print(row)


if __name__ == "__main__":
    main()