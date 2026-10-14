"""
Расчёт метрик из строк отчёта о реализации (compute_daily_metrics) и
чтение себестоимости из CSV - на синтетических строках в формате
finance-api, без сети и без реальных данных кабинетов.
"""

from app.ingestion.local_costs import load_cost_lookup
from app.metrics.margin import compute_daily_metrics

DAY = "2026-09-15"


def _row(oper, doc="Продажа", **fields):
    row = {"rrDate": DAY, "saleDt": "2026-06-30T00:00:00Z", "sellerOperName": oper, "docTypeName": doc}
    row.update(fields)
    return row


REPORT = [
    _row("Продажа", nmId=1, techSize="42", quantity=2, forPay="1000.50"),
    _row("Продажа", nmId=2, techSize="0", quantity=1, forPay="300"),
    _row("Возврат", doc="Возврат", nmId=1, techSize="42", quantity=1, forPay="500"),
    _row("Добровольная компенсация при возврате", quantity=1, forPay="40"),
    _row("Доставка", deliveryService="120.25"),
    _row("Хранение", paidStorage="30"),
    _row("Обработка товара", paidAcceptance="10"),
    _row("Штраф", penalty="99.75"),
    _row("Удержание", deduction="600", bonusTypeName="Оказание услуг «WB Продвижение», документ №1"),
    _row("Удержание", deduction="200", bonusTypeName="Оказание услуг «WB Медиа», документ №2"),
    _row("Удержание", deduction="50", bonusTypeName="Предоставление услуг по подписке «Джем», документ №3"),
    _row("Сумма баллов, удержанных за покупку товаров", cashbackAmount="120"),
    _row("Стоимость участия в программе лояльности", cashbackCommissionChange="12"),
    _row("Сумма баллов, удержанных за покупку товаров", doc="Возврат", cashbackAmount="120"),
    _row("Стоимость участия в программе лояльности", doc="Возврат", cashbackCommissionChange="12"),
    _row("Корректировка", additionalPayment="5"),
    # справочное поле - в "к перечислению" не входит
    _row("Возмещение издержек по перемещению и операционной обработке товара", quantity=3, rebillLogisticCost="11.22"),
]


def test_payout_follows_wb_formula():
    day = compute_daily_metrics(REPORT, {})[DAY]

    assert day["revenue"] == 1000.50 + 300 - 500 + 40
    assert day["logistics"] == 120.25
    assert day["storage"] == 30
    assert day["acceptance"] == 10
    assert day["penalties"] == 99.75
    assert day["ad_spend"] == 800
    assert day["deductions"] == 50
    assert day["loyalty"] == 0  # возврат баллов гасит удержание
    assert day["additional"] == 5
    assert day["payout"] == round(840.50 - 120.25 - 30 - 10 - 99.75 - 800 - 50 + 5, 2)


def test_cost_and_margin():
    day = compute_daily_metrics(REPORT, {"1-42": 200.0, "2-0": 100.0})[DAY]

    # 2 шт. по 200 + 1 шт. по 100 - возврат 1 шт. по 200
    assert day["cost"] == 300
    assert day["units_without_cost"] == 0
    assert day["margin"] == round(day["payout"] - 300, 2)


def test_units_without_cost_counted():
    day = compute_daily_metrics(REPORT, {"1-42": 200.0})[DAY]

    assert day["units_without_cost"] == 1  # nmId 2 нет в справочнике
    assert day["cost"] == 200


def test_day_is_rr_date_not_sale_date():
    assert list(compute_daily_metrics(REPORT, {})) == [DAY]


def test_load_cost_lookup_semicolon_and_decimal_comma(tmp_path):
    path = tmp_path / "costs.csv"
    path.write_text("﻿nm_id;tech_size;cost\n248314348;42;1 250,50\n100;0;349\n;;\n", encoding="utf-8")

    assert load_cost_lookup(path) == {"248314348-42": 1250.50, "100-0": 349.0}


def test_load_cost_lookup_comma_delimiter(tmp_path):
    path = tmp_path / "costs.csv"
    path.write_text("nm_id,tech_size,cost\n1,S,10.5\n", encoding="utf-8")

    assert load_cost_lookup(path) == {"1-S": 10.5}


def test_load_cost_lookup_missing_file(tmp_path):
    assert load_cost_lookup(tmp_path / "nope.csv") == {}
