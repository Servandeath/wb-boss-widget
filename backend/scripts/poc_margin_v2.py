"""
PoC v2: маржа по официальному отчёту о реализации (reportDetailByPeriod),
а не по supplier/sales - плюс реклама.

маржа ~= ppvz_for_pay (сумма к перечислению продавцу по строке отчёта,
          уже сеть WB-комиссии/эквайринга/логистики/хранения/штрафов
          для этой конкретной продажи)
         - Себес (таблица "Ультра", по ключу nmId-размер)
         - Реклама (таблица "ВСЕ" в "Реклама общий", сумма по nmId)

Упрощение против настоящей формулы "ГлавСвод": там revenue и вычеты
собираются построчно из отдельных колонок (в отчёте есть строки без
привязки к конкретной продаже - чистая логистика/хранение/штраф отдельной
строкой), здесь для скорости берём только строки supplier_oper_name ==
"Продажа" и готовый ppvz_for_pay. Точная репликация ГлавСвод - в
настоящем metrics/, не в этом PoC.

ОДИН запрос к reportDetailByPeriod (жёсткий rate limit, см.
backend/app/ingestion/wb_client.py) + два запроса к Google Sheets
(Ультра, ВСЕ). Только чтение. Запускать вручную:

    python backend/scripts/poc_margin_v2.py [КОД_КАБИНЕТА] [дней_назад]
"""

import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import get_cabinet  # noqa: E402
from app.ingestion.wb_client import get_realization_report  # noqa: E402
from app.sheets_client import get_service  # noqa: E402

ULTRA_SPREADSHEET_ID = "1QZN-M2Q7OYhC8b5uHW2ZDx84PR1zoDxavLo2EKGtHA8"
ULTRA_SHEET_NAME = "Ультра"
ULTRA_KEY_COL = 3  # "NM ID-Размер"
ULTRA_COST_COL = 17  # "Себес"

ADS_SPREADSHEET_ID = "187H8ckzzzlsLzjpQ0gyPQHWbwf7pPyRZJ3tcO4yse-E"
ADS_SHEET_NAME = "ВСЕ"
ADS_NMID_COL = 2  # "NmID"
ADS_CAB_COL = 6  # "Кэб"
ADS_SPEND_COL = 15  # "Сумма ЗатратРК"


def load_cost_lookup() -> dict[str, float]:
    service = get_service()
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


def load_ad_spend_by_nm(cabinet_name: str) -> dict[str, float]:
    service = get_service()
    metadata = service.spreadsheets().get(spreadsheetId=ADS_SPREADSHEET_ID).execute()
    row_count = next(
        s["properties"]["gridProperties"]["rowCount"]
        for s in metadata["sheets"]
        if s["properties"]["title"] == ADS_SHEET_NAME
    )

    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=ADS_SPREADSHEET_ID, range=f"{ADS_SHEET_NAME}!A3:P{row_count}")
        .execute()
    )

    spend_by_nm: dict[str, float] = defaultdict(float)
    for row in result.get("values", []):
        if len(row) <= max(ADS_NMID_COL, ADS_CAB_COL, ADS_SPEND_COL):
            continue
        if str(row[ADS_CAB_COL]).strip() != cabinet_name:
            continue
        nm_id = str(row[ADS_NMID_COL]).strip()
        spend_raw = str(row[ADS_SPEND_COL]).strip()
        if not nm_id or not spend_raw:
            continue
        try:
            spend_by_nm[nm_id] += float(spend_raw.replace(",", "."))
        except ValueError:
            continue
    return dict(spend_by_nm)


def main():
    code = sys.argv[1] if len(sys.argv) > 1 else "MANI"
    days_back = int(sys.argv[2]) if len(sys.argv) > 2 else 7

    cabinet = get_cabinet(code)
    if not cabinet.token:
        raise SystemExit(f"Нет токена для кабинета {code} в backend/.env")

    date_to = datetime.now()
    date_from = date_to - timedelta(days=days_back)

    print(f"Кабинет: {cabinet.name} ({cabinet.code}), период: {date_from.date()} - {date_to.date()}")

    print("Гружу отчёт о реализации из WB API (один запрос)...")
    report_rows = get_realization_report(cabinet.token, date_from, date_to)
    sale_rows = [r for r in report_rows if r.get("supplier_oper_name") == "Продажа"]
    print(f"Строк всего: {len(report_rows)}, из них 'Продажа': {len(sale_rows)}")

    print("Гружу себестоимость из 'Ультра'...")
    cost_lookup = load_cost_lookup()
    print(f"Строк себестоимости: {len(cost_lookup)}")

    print(f"Гружу расход на рекламу из 'ВСЕ' для кабинета {cabinet.name}...")
    ad_spend_by_nm = load_ad_spend_by_nm(cabinet.name)
    print(f"nmId с рекламным расходом: {len(ad_spend_by_nm)}")

    matched = 0
    revenue = 0.0
    cost = 0.0
    nm_ids_seen = set()
    unmatched_examples = []

    for row in sale_rows:
        nm_id = str(row.get("nm_id", ""))
        tech_size = str(row.get("ts_name", "")).strip()
        for_pay = float(row.get("ppvz_for_pay", 0) or 0)

        nm_ids_seen.add(nm_id)
        revenue += for_pay

        key = f"{nm_id}-{tech_size}"
        unit_cost = cost_lookup.get(key)
        if unit_cost is None:
            if len(unmatched_examples) < 5:
                unmatched_examples.append(key)
            continue

        matched += 1
        cost += unit_cost

    ad_spend = sum(ad_spend_by_nm.get(nm_id, 0.0) for nm_id in nm_ids_seen)

    margin = revenue - cost - ad_spend
    margin_pct = (margin / revenue * 100) if revenue else 0

    print()
    print(f"Совпало по себестоимости: {matched} / {len(sale_rows)}")
    if unmatched_examples:
        print(f"Примеры непойманных ключей: {unmatched_examples}")
    print(f"Выручка (ppvz_for_pay, все 'Продажа'): {revenue:.2f}")
    print(f"Себестоимость (только совпавшие): {cost:.2f}")
    print(f"Реклама (сумма по nmId из отчёта, весь доступный период 'ВСЕ'): {ad_spend:.2f}")
    print(f"Маржа: {margin:.2f} ({margin_pct:.1f}% от выручки)")


if __name__ == "__main__":
    main()
