"""
Чтение вспомогательных Google Sheets, которые пока временно заменяют
"свою систему" себестоимости и учёта рекламы (см. backend/.env,
STOCK_SHEET_URL/ADS_AGGREGATOR_SHEET_URL и docs про кабинеты). ID таблиц
берутся из config - захардкожены только имена вкладок и колонок внутри
них (это структура конкретных существующих таблиц владельца, не общий
механизм на будущее).
"""

from collections import defaultdict

from app import config
from app.sheets_client import get_service

ULTRA_SHEET_NAME = "Ультра"
ULTRA_KEY_COL = 3  # "NM ID-Размер"
ULTRA_COST_COL = 17  # "Себес"

ADS_SHEET_NAME = "ВСЕ"
ADS_DATE_COL = 1  # "Дата/NmId" - первые 10 символов = дата dd.mm.yyyy
ADS_CAB_COL = 6  # "Кэб"
ADS_SPEND_COL = 15  # "Сумма ЗатратРК"


def _sheet_row_count(spreadsheet_id: str, sheet_name: str) -> int:
    service = get_service()
    metadata = service.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    return next(
        s["properties"]["gridProperties"]["rowCount"]
        for s in metadata["sheets"]
        if s["properties"]["title"] == sheet_name
    )


def load_cost_lookup() -> dict[str, float]:
    """key = 'nmId-техразмер' -> себестоимость (float). Источник: "Ультра"."""
    if not config.STOCK_SHEET_ID:
        raise RuntimeError("STOCK_SHEET_URL не задан в backend/.env")

    service = get_service()
    row_count = _sheet_row_count(config.STOCK_SHEET_ID, ULTRA_SHEET_NAME)

    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=config.STOCK_SHEET_ID, range=f"{ULTRA_SHEET_NAME}!A3:T{row_count}")
        .execute()
    )

    lookup = {}
    for row in result.get("values", []):
        if len(row) <= max(ULTRA_KEY_COL, ULTRA_COST_COL):
            continue
        key = str(row[ULTRA_KEY_COL]).strip()
        cost_raw = str(row[ULTRA_COST_COL]).strip().replace("\xa0", "").replace(" ", "")
        if not key or not cost_raw:
            continue
        try:
            lookup[key] = float(cost_raw.replace(",", "."))
        except ValueError:
            continue
    return lookup


def load_ad_spend_by_date(cabinet_name: str) -> dict[str, float]:
    """key = 'YYYY-MM-DD' -> расход на рекламу за день (сумма по всем nmId кабинета). Источник: "ВСЕ"."""
    if not config.ADS_AGGREGATOR_SHEET_ID:
        raise RuntimeError("ADS_AGGREGATOR_SHEET_URL не задан в backend/.env")

    service = get_service()
    row_count = _sheet_row_count(config.ADS_AGGREGATOR_SHEET_ID, ADS_SHEET_NAME)

    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=config.ADS_AGGREGATOR_SHEET_ID, range=f"{ADS_SHEET_NAME}!A3:P{row_count}")
        .execute()
    )

    spend_by_date: dict[str, float] = defaultdict(float)
    for row in result.get("values", []):
        if len(row) <= max(ADS_DATE_COL, ADS_CAB_COL, ADS_SPEND_COL):
            continue
        if str(row[ADS_CAB_COL]).strip() != cabinet_name:
            continue

        date_raw = str(row[ADS_DATE_COL]).strip()[:10]  # "dd.mm.yyyy"
        parts = date_raw.split(".")
        if len(parts) != 3:
            continue
        iso_date = f"{parts[2]}-{parts[1]}-{parts[0]}"

        spend_raw = str(row[ADS_SPEND_COL]).strip()
        if not spend_raw:
            continue
        try:
            spend_by_date[iso_date] += float(spend_raw.replace(",", "."))
        except ValueError:
            continue

    return dict(spend_by_date)
