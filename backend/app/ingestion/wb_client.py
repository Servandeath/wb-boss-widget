"""
Прямые вызовы WB API в обход GAS/Sheets (GAS упирается в квоты Google).

get_sales() - миграция docs/wb_gas_prototype/wb_ sales.js: тот же эндпоинт
statistics-api/supplier/sales, та же логика повторов на 429 (уважаем
X-Ratelimit-Retry, иначе экспоненциальный backoff).

Пагинация по lastChangeDate (как в GAS-скрипте, чтобы выгрузить весь период)
здесь намеренно не реализована - это только клиент для одного запроса,
разведка/probe. Пагинацию добавляем, когда переходим к реальной загрузке
в SQLite.
"""

import time

import requests

STATS_SALES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales"
MAX_RETRIES_429 = 8
REQUEST_TIMEOUT_S = 30


def get_sales(token: str, date_from) -> list[dict]:
    """
    Один запрос без пагинации. date_from - datetime, WB отдаёт все строки
    с lastChangeDate >= date_from (может быть больше одной "страницы" -
    WB сам ограничивает объём ответа, для пагинации см. докстринг модуля).
    """
    params = {
        "dateFrom": date_from.strftime("%Y-%m-%dT%H:%M:%S"),
        "flag": 0,
    }
    headers = {"Authorization": token}

    attempt = 0
    while True:
        attempt += 1
        resp = requests.get(
            STATS_SALES_URL, params=params, headers=headers, timeout=REQUEST_TIMEOUT_S
        )

        if resp.status_code == 200:
            return resp.json()

        if resp.status_code == 429:
            if attempt > MAX_RETRIES_429:
                raise RuntimeError(f"WB API 429: превышен лимит повторов. Ответ: {resp.text}")

            retry_after = resp.headers.get("X-Ratelimit-Retry")
            wait_s = int(retry_after) + 1 if retry_after else min(30, attempt * 4)
            time.sleep(wait_s)
            continue

        raise RuntimeError(f"WB API error {resp.status_code}: {resp.text}")
