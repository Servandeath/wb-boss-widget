# backend/

Соответствие папок шагам пайплайна из корневого README ("Как это устроено"):

- `app/sheets_client.py` - общая авторизация и клиент Google Sheets API
  (раньше дублировалась в каждом скрипте).
- `app/ingestion/` - чтение листов таблицы, кэширование архивных месяцев.
- `app/mapping/` - словари "заголовок WB -> каноническое имя поля".
  Для нового источника (Ozon, Lamoda, ...) сюда добавляется свой модуль,
  остальной код не меняется.
- `app/metrics/` - расчёт метрик в узкий формат `cabinet/date/metric/value`.
  Пока не реализовано.
- `app/storage/` - запись/чтение SQLite. Пока не реализовано.
- `app/api/` - FastAPI-сервер для расширения. Пока не реализовано.
- `scripts/` - разведочные скрипты для ручной проверки (`python
  backend/scripts/probe_*.py`). Ходят в реальный Google Sheets API,
  не являются автоматическими тестами.
- `tests/` - настоящие unit-тесты (`pytest backend/tests`), без сети.
- `cache/` - кэш архивных листов (в .gitignore, не код).
- `credentials.json` - service account ключ (в .gitignore, никогда не
  коммитится).

## Установка

```
pip install -r backend/requirements.txt
```

## Тесты

```
pytest backend/tests
```
