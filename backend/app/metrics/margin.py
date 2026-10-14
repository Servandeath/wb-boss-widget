"""
Метрики по дням из отчёта о реализации WB (finance-api, см.
app/ingestion/wb_client.py) + себестоимость из локального CSV
(app/ingestion/local_costs.py). Google Sheets больше не нужны: реклама,
оплаченная с баланса WB, уже есть в отчёте как удержания "WB Продвижение"
/ "WB Медиа".

Формула "к перечислению" сверена с итогом WB (bankPaymentSum из
/sales-reports/list) - на полных отчётах МАНИ совпадает до копейки:

    payout = revenue - logistics - storage - acceptance - penalties
             - ad_spend - deductions + additional - loyalty

    revenue     ±forPay (знак "-" у строк с docTypeName "Возврат")
    logistics   deliveryService
    storage     paidStorage
    acceptance  paidAcceptance
    penalties   penalty
    ad_spend    deduction, где bonusTypeName - "WB Продвижение"/"WB Медиа"
    deductions  остальные deduction (подписка "Джем", витрина, утилизация...)
    additional  additionalPayment
    loyalty     ±(cashbackAmount + cashbackCommissionChange) - баллы и
                комиссия программы лояльности, у "Возврат" со знаком "-"

    cost   = ±себестоимость × quantity по строкам "Продажа"/"Возврат"
    margin = payout - cost

День - rrDate строки (дата операции в отчёте), а не saleDt. WB фильтрует
строки по rrDate, поэтому любой день внутри запрошенного периода
приходит целиком, и повторная загрузка перекрывающегося окна не затирает
день частичной суммой. По saleDt так нельзя: у возвратов и удержаний он
бывает на месяцы раньше периода (видели 2026-06-30 в отчёте за сентябрь).
Удержания WB выставляет документами раз в несколько дней, поэтому
ad_spend/deductions по дням "ступенчатые" - на неделе сходится, по дню нет.

rebillLogisticCost в формулу не входит - он не участвует в
bankPaymentSum (справочное поле WB, проверено сверкой).
"""

from collections import defaultdict

from app.config import Cabinet
from app.ingestion.local_costs import cost_key, load_cost_lookup
from app.ingestion.wb_client import get_realization_report
from app.storage.db import get_connection, upsert_metric

AD_DEDUCTION_MARKERS = ("WB Продвижение", "WB Медиа")
GOODS_OPERATIONS = ("Продажа", "Возврат")

EXPENSE_METRICS = ("logistics", "storage", "acceptance", "penalties", "ad_spend", "deductions", "loyalty")
STORED_METRICS = (
    "revenue", *EXPENSE_METRICS, "additional", "payout", "cost", "margin", "units_without_cost",
)


def _num(row: dict, field: str) -> float:
    """Денежные поля finance-api приходят строками ("367.5"), часть - числами."""
    value = row.get(field)
    return float(value) if value not in (None, "") else 0.0


def _is_ad_deduction(row: dict) -> bool:
    bonus = row.get("bonusTypeName") or ""
    return any(marker in bonus for marker in AD_DEDUCTION_MARKERS)


def compute_daily_metrics(report_rows: list[dict], cost_lookup: dict[str, float]) -> dict[str, dict[str, float]]:
    """
    Чистая функция без сети и БД: строки отчёта -> {date: {metric: value}}.
    units_without_cost - сколько проданных единиц не нашлось в costs.csv
    (их себестоимость посчитана как 0, маржа по ним завышена).
    """
    days: dict[str, dict[str, float]] = defaultdict(lambda: defaultdict(float))

    for row in report_rows:
        date = str(row.get("rrDate") or "")[:10]
        if not date:
            continue

        sign = -1 if row.get("docTypeName") == "Возврат" else 1
        day = days[date]

        day["revenue"] += sign * _num(row, "forPay")
        day["logistics"] += _num(row, "deliveryService")
        day["storage"] += _num(row, "paidStorage")
        day["acceptance"] += _num(row, "paidAcceptance")
        day["penalties"] += _num(row, "penalty")
        day["additional"] += _num(row, "additionalPayment")
        day["loyalty"] += sign * (_num(row, "cashbackAmount") + _num(row, "cashbackCommissionChange"))

        deduction = _num(row, "deduction")
        if deduction:
            day["ad_spend" if _is_ad_deduction(row) else "deductions"] += deduction

        if row.get("sellerOperName") in GOODS_OPERATIONS:
            quantity = _num(row, "quantity")
            unit_cost = cost_lookup.get(cost_key(row.get("nmId", ""), row.get("techSize", "")))
            if unit_cost is None:
                day["units_without_cost"] += sign * quantity
            else:
                day["cost"] += sign * unit_cost * quantity

    result = {}
    for date in sorted(days):
        day = days[date]
        payout = day["revenue"] - sum(day[m] for m in EXPENSE_METRICS) + day["additional"]
        metrics = {m: round(day[m], 2) for m in STORED_METRICS if m not in ("payout", "margin")}
        metrics["payout"] = round(payout, 2)
        metrics["margin"] = round(payout - day["cost"], 2)
        result[date] = metrics

    return result


def compute_and_store_margin(cabinet: Cabinet, date_from, date_to) -> dict[str, dict[str, float]]:
    """
    Отчёт о реализации за весь период целиком (finance-api, лимит
    1 запрос/минуту - не звать в цикле по датам) -> метрики -> SQLite.
    Возвращает {date: {metric: value}} - то же, что записано.
    """
    report_rows = get_realization_report(cabinet.token, date_from, date_to)
    result = compute_daily_metrics(report_rows, load_cost_lookup())

    conn = get_connection()
    try:
        for date, metrics in result.items():
            for metric, value in metrics.items():
                upsert_metric(conn, cabinet.code, date, metric, value)
        conn.commit()
    finally:
        conn.close()

    return result
