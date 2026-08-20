"""
Читаем таблицу и строим индекс колонок по КАНОНИЧЕСКИМ именам, а не по
позиции и не напрямую по русским названиям WB.

Идея: остальной код (агрегация, запись в БД, API) работает только с
каноническими именами (date, sku, orders_count и т.д.) и не знает,
что источник - именно WB. Когда появится Ozon/Lamoda/МойСклад - для
каждого пишется свой словарь сопоставления в этом же пакете (mapping/),
а остальная логика не меняется вообще.
"""

# Сопоставление "как называется у WB" -> "как называем у себя".
# Только этот словарь придётся менять/дополнять для нового источника -
# всё остальное в модуле останется без изменений.
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
