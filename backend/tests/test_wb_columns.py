"""
Настоящие unit-тесты для маппинга колонок WB (в отличие от разведочных
скриптов в backend/scripts/, эти не ходят в сеть и проверяют утверждения
через assert).

Запуск: pytest backend/tests
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.mapping.wb_columns import build_column_index, normalize_header  # noqa: E402


def test_normalize_header_strips_nbsp():
    assert normalize_header("\xa0Заказы") == "Заказы"


def test_normalize_header_strips_surrounding_spaces():
    assert normalize_header("  Дата  ") == "Дата"


def test_build_column_index_maps_known_columns_by_canonical_name():
    header = ["Дата", "NM ID", "Заказы"]
    column_map = {"Дата": "date", "NM ID": "sku", "Заказы": "orders_count"}

    index = build_column_index(header, column_map)

    assert index == {"date": 0, "sku": 1, "orders_count": 2}


def test_build_column_index_handles_nbsp_in_real_header_row():
    header = ["Дата", "\xa0Заказы"]
    column_map = {"Дата": "date", "Заказы": "orders_count"}

    index = build_column_index(header, column_map)

    assert index == {"date": 0, "orders_count": 1}


def test_build_column_index_skips_missing_columns_instead_of_failing(capsys):
    header = ["Дата"]
    column_map = {"Дата": "date", "Заказы": "orders_count"}

    index = build_column_index(header, column_map)

    assert index == {"date": 0}
    assert "orders_count" not in index
    assert "не найдена в таблице" in capsys.readouterr().out
