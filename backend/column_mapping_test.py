"""
Читаем таблицу и строим индекс колонок по КАНОНИЧЕСКИМ именам, а не по
позиции и не напрямую по русским названиям WB.

Идея: остальной код (агрегация, запись в БД, API) работает только с
каноническими именами (date, sku, orders_count и т.д.) и не знает,
что источник - именно WB. Когда появится Ozon/Lamoda/МойСклад - для
каждого пишется свой словарь сопоставления, а остальная логика не
меняется вообще.
"""

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
from pathlib import Path

# Путь строим относительно расположения ЭТОГО файла (__file__),
# а не текущей папки терминала - так скрипт работает одинаково,
# из какой бы директории его ни запустили
SCRIPT_DIR = Path(__file__).resolve().parent
CREDENTIALS_FILE = SCRIPT_DIR / "credentials.json"

SPREADSHEET_ID = "1CXqoIij9ZkFi9PnBDRShsjoJu9vGwgn4hJUuvtwVhLE"
SHEET_NAME = "Лист1"

# Сопоставление "как называется у WB" -> "как называем у себя".
# Только этот словарь придётся менять/дополнять для нового источника -
# всё остальное в скрипте останется без изменений.
WB_COLUMN_MAP = {
    "Дата": "date",
    "NM ID": "sku",
    "Вендор Код": "vendor_code",
    "Бренд": "brand",
    "Название": "name",
    "Открытые корзины": "open_carts",
    "Добавления в корзину": "cart_additions",
    "Заказы": "orders_count",
    "Сумма Заказов": "orders_sum",
}


def normalize_header(raw: str) -> str:
    """
    Приводим заголовок к 'чистому' виду перед сравнением со словарём:
    убираем неразрывный пробел (\xa0), убираем обычные пробелы по краям.
    Без этого 'Заказы' и '\xa0Заказы' считались бы разными колонками.
    """
    return raw.replace("\xa0", " ").strip()


def build_column_index(header_row: list[str], column_map: dict[str, str]) -> dict[str, int]:
    """
    Строим словарь {каноническое_имя: номер_позиции_в_строке}.
    Если колонка из column_map не найдена в таблице - сообщаем явно,
    а не падаем молча и не подставляем None куда попало.
    """
    index: dict[str, int] = {}

    # Сначала нормализуем все заголовки таблицы один раз
    normalized_headers = [normalize_header(h) for h in header_row]

    for raw_name, canonical_name in column_map.items():
        if raw_name in normalized_headers:
            position = normalized_headers.index(raw_name)
            index[canonical_name] = position
        else:
            print(f"Внимание: колонка '{raw_name}' не найдена в таблице "
                  f"(ожидали найти для поля '{canonical_name}')")

    return index


def main():
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    service = build("sheets", "v4", credentials=creds)

    # Читаем с запасом по столбцам (A:Z), но только первые 20 строк -
    # этого достаточно, чтобы увидеть заголовок и немного данных
    range_name = f"{SHEET_NAME}!A1:Z20"
    result = service.spreadsheets().values().get(
        spreadsheetId=SPREADSHEET_ID, range=range_name
    ).execute()

    values = result.get("values", [])
    if not values:
        print("Данные не найдены")
        return

    # В этой таблице первая строка - служебная ("Данные за период..."),
    # реальные заголовки колонок - вторая строка (индекс 1)
    header_row = values[1]
    data_rows = values[2:]

    column_index = build_column_index(header_row, WB_COLUMN_MAP)
    print(f"\nПостроен индекс колонок: {column_index}\n")

    # Проверяем индекс в деле: печатаем дату и заказы по каждой строке,
    # обращаясь по каноническому имени, а не по номеру позиции
    for row in data_rows:
        date = row[column_index["date"]] if "date" in column_index else "?"
        orders = row[column_index["orders_count"]] if "orders_count" in column_index else "?"
        print(f"date={date}  orders={orders}")


if __name__ == "__main__":
    main()