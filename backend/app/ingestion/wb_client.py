"""
Прямые вызовы WB API в обход GAS/Sheets (GAS упирается в квоты Google).

get_sales() - миграция docs/wb_gas_prototype/wb_ sales.js: тот же эндпоинт
statistics-api/supplier/sales, та же логика повторов на 429 (уважаем
X-Ratelimit-Retry, иначе экспоненциальный backoff).

get_realization_report() - официальный "Отчёт о реализации" (тот же
источник, что и вкладка "Выгрузка" в таблице из [[ref-fin-otchet-sheet]] /
docs/adr - реальная комиссия/логистика/хранение/штрафы/эквайринг, а не
только forPay). С 2026 года это finance-api
POST /api/finance/v1/sales-reports/detailed, токен категории "Финансы".
Старый statistics-api GET /api/v5/supplier/reportDetailByPeriod WB
отключил - отвечает 404 "This method is deprecated" (release notes WB,
id=498). Поля в новом методе в camelCase (sellerOperName, saleDt, nmId,
techSize, forPay), денежные - строками.

Пагинация отчёта о реализации - штатный курсор rrdId до ответа 204, с
паузой между страницами: лимит 1 запрос/минуту на кабинет. Для
supplier/sales пагинация по lastChangeDate по-прежнему не реализована -
один запрос за раз.
"""

import time

import requests

STATS_SALES_URL = "https://statistics-api.wildberries.ru/api/v1/supplier/sales"
REALIZATION_REPORT_URL = "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed"
REALIZATION_REPORTS_LIST_URL = "https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list"
REALIZATION_REPORT_PAGE_PAUSE_S = 61  # лимит метода: 1 запрос/минуту
MAX_RETRIES_429 = 8
REQUEST_TIMEOUT_S = 30


def _request_with_retry(method: str, url: str, token: str, params: dict | None = None,
                        json_body: dict | None = None) -> list[dict]:
    headers = {"Authorization": token}

    attempt = 0
    while True:
        attempt += 1
        resp = requests.request(
            method, url, params=params, json=json_body, headers=headers, timeout=REQUEST_TIMEOUT_S
        )

        if resp.status_code == 200:
            return resp.json()

        # 204 - штатный конец пагинации у finance-api (и "нет данных за период")
        if resp.status_code == 204:
            return []

        if resp.status_code == 429:
            if attempt > MAX_RETRIES_429:
                raise RuntimeError(f"WB API 429: превышен лимит повторов. Ответ: {resp.text}")

            retry_after = resp.headers.get("X-Ratelimit-Retry")
            wait_s = int(retry_after) + 1 if retry_after else min(30, attempt * 4)
            time.sleep(wait_s)
            continue

        raise RuntimeError(f"WB API error {resp.status_code}: {resp.text}")


def _get_with_retry(url: str, token: str, params: dict) -> list[dict]:
    return _request_with_retry("GET", url, token, params=params)


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


def get_realization_report(token: str, date_from, date_to, period: str = "weekly",
                           limit: int = 100000) -> list[dict]:
    """
    Весь отчёт о реализации за период - все страницы по курсору rrdId.
    date_from/date_to - date или datetime (берём только дату, время МСК
    по умолчанию у WB). period - "weekly" (как у старого
    reportDetailByPeriod по умолчанию) или "daily".

    Между страницами ждём REALIZATION_REPORT_PAGE_PAUSE_S - на большом
    периоде загрузка идёт минутами, это нормально.
    """
    body = {
        "dateFrom": date_from.strftime("%Y-%m-%d"),
        "dateTo": date_to.strftime("%Y-%m-%d"),
        "period": period,
        "limit": limit,
        "rrdId": 0,
    }

    rows: list[dict] = []
    while True:
        page = _request_with_retry("POST", REALIZATION_REPORT_URL, token, json_body=body)
        if not page:
            return rows

        rows.extend(page)
        if len(page) < limit:
            return rows

        body["rrdId"] = page[-1]["rrdId"]
        time.sleep(REALIZATION_REPORT_PAGE_PAUSE_S)


def get_realization_reports_list(token: str, date_from, date_to, period: str = "weekly") -> list[dict]:
    """
    Список отчётов о реализации за период с итогами WB по каждому
    (forPaySum, deliveryServiceSum, ..., bankPaymentSum - "Итого к оплате").
    Нужен для сверки нашей формулы с официальными итогами. Тот же лимит
    1 запрос/минуту; до 1000 отчётов за запрос - пагинация не нужна.
    """
    body = {
        "dateFrom": date_from.strftime("%Y-%m-%d"),
        "dateTo": date_to.strftime("%Y-%m-%d"),
        "period": period,
        "limit": 1000,
    }
    return _request_with_retry("POST", REALIZATION_REPORTS_LIST_URL, token, json_body=body)
