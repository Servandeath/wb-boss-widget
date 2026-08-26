"""
Прямые вызовы WB API в обход GAS/Sheets (GAS упирается в квоты Google).

get_sales() - миграция docs/wb_gas_prototype/wb_ sales.js: тот же эндпоинт
statistics-api/supplier/sales, та же логика повторов на 429 (уважаем
X-Ratelimit-Retry, иначе экспоненциальный backoff).

get_realization_report() - официальный еженедельный "Отчёт о реализации"
(тот же источник, что и вкладка "Выгрузка" в таблице из
[[ref-fin-otchet-sheet]] / docs/adr - реальная комиссия/логистика/хранение/
штрафы/эквайринг, а не только forPay). Тот же домен statistics-api, та же
категория токена, что и get_sales - отдельного токена не нужно.

Пагинация по lastChangeDate/rrdid (как в GAS-скрипте для sales, и штатный
курсор rrdid для reportDetailByPeriod) здесь намеренно не реализована - это
клиент для одного запроса за раз, разведка/probe. Пагинацию добавляем,
когда переходим к реальной загрузке в SQLite - и для
reportDetailByPeriod ОСОБЕННО осторожно: у него исторически гораздо более
жёсткий rate limit (порядка 1 запрос/минуту), чем у supplier/sales.
"""

import time

import requests

STATS_SALES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales"
REALIZATION_REPORT_URL = "https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod"
MAX_RETRIES_429 = 8
REQUEST_TIMEOUT_S = 30


def _get_with_retry(url: str, token: str, params: dict) -> list[dict]:
    headers = {"Authorization": token}

    attempt = 0
    while True:
        attempt += 1
        resp = requests.get(url, params=params, headers=headers, timeout=REQUEST_TIMEOUT_S)

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
    return _get_with_retry(STATS_SALES_URL, token, params)


def get_realization_report(token: str, date_from, date_to, rrdid: int = 0, limit: int = 100000) -> list[dict]:
    """
    Одна страница официального отчёта о реализации. date_from/date_to -
    date или datetime (берём только дату). rrdid - курсор пагинации:
    0 для первой страницы, дальше - rrd_id последней строки предыдущей
    страницы (см. докстринг модуля про пагинацию - здесь не реализована).
    """
    params = {
        "dateFrom": date_from.strftime("%Y-%m-%d"),
        "dateTo": date_to.strftime("%Y-%m-%d"),
        "rrdid": rrdid,
        "limit": limit,
    }
    return _get_with_retry(REALIZATION_REPORT_URL, token, params)
