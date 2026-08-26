"""
PoC: маржа по вчерашним продажам одного кабинета.

маржа ~= forPay (WB API, уже за вычетом комиссии+логистики WB)
         - Себес (таблица "Ультра", по ключу nmId-размер)

Реклама (вкладка "Затраты") сюда не включена - она агрегирована по
дню/nmId, а не на единицу продажи, добавим отдельно на уровне агрегатов
метрик, не построчно.

Только чтение (WB API - один запрос продаж; Google Sheets - один запрос
на всю вкладку "Ультра"), ничего никуда не пишет. Запускать вручную:

    python backend/scripts/poc_margin.py [КОД_КАБИНЕТА] [YYYY-MM-DD]
"""

import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_cabinet  # noqa: E402
from app.ingestion.wb_client import get_sales  # noqa: E402
from app.sheets_client import get_service  # noqa: E402

ULTRA_SPREADSHEET_ID = "1QZN-M2Q7OYhC8b5uHW2ZDx84PR1zoDxavLo2EKGtHA8"
ULTRA_SHEET_NAME = "Ультра"
ULTRA_KEY_COL = 3  # "NM ID-Размер", 0-indexed
ULTRA_COST_COL = 17  # "Себес", 0-indexed


def load_cost_lookup() -> dict[str, float]:
    """key = 'nmId-техразмер' -> себестоимость (float)."""
    service = get_service()

    # Диапазон без верхней границы читал бы всё, но Sheets API на
    # values().get() с открытым диапазоном может быть медленнее/менее
    # предсказуемым - берём реальный rowCount листа явно.
    metadata = service.spreadsheets().get(spreadsheetId=ULTRA_SPREADSHEET_ID).execute()
    row_count = next(
        s["properties"]["gridProperties"]["rowCount"]
        for s in metadata["sheets"]
        if s["properties"]["title"] == ULTRA_SHEET_NAME
    )

    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=ULTRA_SPREADSHEET_ID, range=f"{ULTRA_SHEET_NAME}!A3:T{row_count}")
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


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    date_from = (
        datetime.strptime(sys.argv[2], "%Y-%m-%d")
        if len(sys.argv) > 2
        else datetime.now() - timedelta(days=1)
    )

    cabinet = get_cabinet(code)
    if not cabinet.token:
        raise SystemExit(f"Нет токена для кабинета {code} в backend/.env")

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), dateFrom={date_from.date()}")

    print("Гружу продажи из WB API...")
    sales = get_sales(cabinet.token, date_from)
    print(f"Продаж получено: {len(sales)}")

    print("Гружу себестоимость из 'Ультра'...")
    cost_lookup = load_cost_lookup()
    print(f"Строк себестоимости: {len(cost_lookup)}")

    matched = 0
    matched_revenue = 0.0
    unmatched_revenue = 0.0
    total_cost = 0.0
    unmatched_examples = []

    for sale in sales:
        nm_id = str(sale.get("nmId", ""))
        tech_size = str(sale.get("techSize", "")).strip()
        for_pay = float(sale.get("forPay", 0) or 0)

        key = f"{nm_id}-{tech_size}"
        cost = cost_lookup.get(key)

        if cost is None:
            unmatched_revenue += for_pay
            if len(unmatched_examples) < 5:
                unmatched_examples.append(key)
            continue

        matched += 1
        matched_revenue += for_pay
        total_cost += cost

    margin = matched_revenue - total_cost
    margin_pct = (margin / matched_revenue * 100) if matched_revenue else 0
    total_revenue = matched_revenue + unmatched_revenue

    print()
    print(f"Совпало по себестоимости: {matched} / {len(sales)}")
    if unmatched_examples:
        print(f"Примеры непойманных ключей (nmId-размер): {unmatched_examples}")
    print(f"Выручка всего (forPay, все строки): {total_revenue:.2f}")
    print(f"  из них выручка по совпавшим строкам: {matched_revenue:.2f}")
    print(f"  выручка по НЕсовпавшим строкам (маржа по ним не считалась): {unmatched_revenue:.2f}")
    print(f"Себестоимость (по совпавшим): {total_cost:.2f}")
    print(f"Маржа (только по совпавшим строкам, без учёта рекламы): {margin:.2f} ({margin_pct:.1f}% от их выручки)")


if __name__ == "__main__":
    main()
