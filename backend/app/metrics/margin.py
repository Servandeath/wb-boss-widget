"""
Расчёт revenue/cost/ad_spend/margin по дням из отчёта о реализации WB
(см. [[margin-formula-agreement]] в памяти) и запись в SQLite (узкий
формат cabinet/date/metric/value).

Упрощение против канонической формулы "ГлавСвод" (см. [[ref-fin-otchet-sheet]]):
считаем только строки supplier_oper_name == "Продажа" - логистика/хранение/
штрафы/возвраты отдельными строками отчёта пока не учитываются, реальная
маржа будет несколько ниже. См. backend/scripts/poc_margin_v2.py, откуда
это перенесено.
"""

from collections import defaultdict

from app.config import Cabinet
from app.ingestion.cost_sheets import load_ad_spend_by_date, load_cost_lookup
from app.ingestion.wb_client import get_realization_report
from app.storage.db import get_connection, upsert_metric


def compute_and_store_margin(cabinet: Cabinet, date_from, date_to) -> dict[str, dict[str, float]]:
    """
    Один запрос к reportDetailByPeriod (жёсткий rate limit - не звать в
    цикле по датам, только на весь period целиком) + два к Google Sheets.
    Возвращает {date: {metric: value}} - то же, что записано в SQLite.
    """
    report_rows = get_realization_report(cabinet.token, date_from, date_to)
    sale_rows = [r for r in report_rows if r.get("supplier_oper_name") == "Продажа"]

    cost_lookup = load_cost_lookup()
    ad_spend_by_date = load_ad_spend_by_date(cabinet.name)

    revenue_by_date: dict[str, float] = defaultdict(float)
    cost_by_date: dict[str, float] = defaultdict(float)
    dates_seen: set[str] = set()

    for row in sale_rows:
        sale_date = str(row.get("sale_dt", ""))[:10]
        if not sale_date:
            continue
        dates_seen.add(sale_date)

        nm_id = str(row.get("nm_id", ""))
        tech_size = str(row.get("ts_name", "")).strip()
        for_pay = float(row.get("ppvz_for_pay", 0) or 0)

        revenue_by_date[sale_date] += for_pay

        unit_cost = cost_lookup.get(f"{nm_id}-{tech_size}")
        if unit_cost is not None:
            cost_by_date[sale_date] += unit_cost

    # Реклама льётся каждый день независимо от того, были ли в этот день
    # продажи - берём даты и из продаж, и из самого рекламного отчёта
    # в пределах запрошенного периода.
    all_dates = dates_seen | {
        d for d in ad_spend_by_date if date_from.strftime("%Y-%m-%d") <= d <= date_to.strftime("%Y-%m-%d")
    }

    result: dict[str, dict[str, float]] = {}
    conn = get_connection()

    try:
        for date in sorted(all_dates):
            revenue = revenue_by_date.get(date, 0.0)
            cost = cost_by_date.get(date, 0.0)
            ad_spend = ad_spend_by_date.get(date, 0.0)
            margin = revenue - cost - ad_spend

            metrics = {
                "revenue": revenue,
                "cost": cost,
                "ad_spend": ad_spend,
                "margin": margin,
            }
            result[date] = metrics

            for metric, value in metrics.items():
                upsert_metric(conn, cabinet.code, date, metric, value)

        conn.commit()
    finally:
        conn.close()

    return result
