"""
Общая инициализация клиента Google Sheets API.

Раньше каждый скрипт в backend/ сам грузил credentials.json и создавал
service - код дублировался в четырёх местах. Теперь это делается один раз
здесь, а остальной код просто зовёт get_service().
"""

from pathlib import Path

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# backend/app/sheets_client.py -> parents[1] == backend/
BACKEND_DIR = Path(__file__).resolve().parents[1]
CREDENTIALS_FILE = BACKEND_DIR / "credentials.json"

# Таблица с показателями кабинетов Wildberries.
# Когда кабинетов/источников станет больше одного - вынести в конфиг.
SPREADSHEET_ID = "1CXqoIij9ZkFi9PnBDRShsjoJu9vGwgn4hJUuvtwVhLE"


def get_service():
    """Авторизованный клиент Sheets API v4 (права только на чтение)."""
    creds = Credentials.from_service_account_file(CREDENTIALS_FILE, scopes=SCOPES)
    return build("sheets", "v4", credentials=creds)
