"""
Загрузка backend/.env и сборка конфига по кабинетам.

Один кабинет WB - один общий токен (все нужные категории доступа выданы
на один токен в личном кабинете WB) и ноль или несколько cost-таблиц
(себестоимость и прочее, временно - пока нет своей системы).
"""

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

_SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9-_]+)")


def extract_spreadsheet_id(url: str) -> str:
    """URL Google Sheets -> ID таблицы. Пустая строка, если url пуст/не распознан."""
    match = _SPREADSHEET_ID_RE.search(url)
    return match.group(1) if match else ""


@dataclass
class Cabinet:
    code: str  # латиницей, id для env-переменных: MANI
    name: str  # как в Sheets/виджете: МАНИ
    token: str = ""
    cost_sheet_urls: list[str] = field(default_factory=list)
    """Свои cost-таблицы кабинета (COST_SHEET_URL_<CODE>_N) + общие для
    всех кабинетов (COST_SHEET_URL_ALL_N), в этом порядке."""


def _load_cabinets() -> list[Cabinet]:
    codes = [c.strip() for c in os.environ.get("WB_CABINETS", "").split(",") if c.strip()]
    global_urls = _load_numbered_env("COST_SHEET_URL_ALL")
    cabinets = []

    for code in codes:
        name = os.environ.get(f"WB_CABINET_{code}_NAME", code)
        token = os.environ.get(f"WB_TOKEN_{code}", "")
        cost_sheet_urls = _load_numbered_env(f"COST_SHEET_URL_{code}") + global_urls

        cabinets.append(Cabinet(code=code, name=name, token=token, cost_sheet_urls=cost_sheet_urls))

    return cabinets


def _load_numbered_env(prefix: str) -> list[str]:
    """Собирает <prefix>_1, <prefix>_2, ... по порядку, пока не встретит пропуск."""
    values = []
    i = 1
    while True:
        value = os.environ.get(f"{prefix}_{i}", "")
        if not value:
            break
        values.append(value)
        i += 1
    return values


CABINETS: list[Cabinet] = _load_cabinets()

GOOGLE_SHEETS_CREDENTIALS_FILE = os.environ.get(
    "GOOGLE_SHEETS_CREDENTIALS_FILE", str(BACKEND_DIR / "credentials.json")
)
GOOGLE_SHEETS_SPREADSHEET_ID = os.environ.get("GOOGLE_SHEETS_SPREADSHEET_ID", "")

# API для расширения (см. корневой README, раздел "Безопасность"):
# биндится на внутренний адрес рабочей сети (не 0.0.0.0), плюс токен поверх.
API_HOST = os.environ.get("API_HOST", "127.0.0.1")
API_PORT = int(os.environ.get("API_PORT", "8000"))
API_TOKEN = os.environ.get("API_TOKEN", "")

# Именные cost-таблицы (см. .env.example) - код читает из них конкретные
# вкладки по имени, поэтому не через позиционный COST_SHEET_URL_ALL_N.
STOCK_SHEET_ID = extract_spreadsheet_id(os.environ.get("STOCK_SHEET_URL", ""))
FIN_REPORT_SHEET_ID = extract_spreadsheet_id(os.environ.get("FIN_REPORT_SHEET_URL", ""))
ADS_AGGREGATOR_SHEET_ID = extract_spreadsheet_id(os.environ.get("ADS_AGGREGATOR_SHEET_URL", ""))


def get_cabinet(code: str) -> Cabinet:
    for cabinet in CABINETS:
        if cabinet.code == code:
            return cabinet
    raise KeyError(f"Кабинет '{code}' не найден в WB_CABINETS ({BACKEND_DIR / '.env'})")
