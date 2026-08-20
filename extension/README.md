# extension/

Chrome-расширение (Manifest V3). По принципу из корневого README:
расширение не знает ни про WB, ни про Google Sheets - только опрашивает
свой backend API и рисует цифры.

- `manifest.json` - минимальный скелет, permissions пока только `storage`.
- `background/service_worker.js` - опрос backend API, запись в
  `chrome.storage.session`.
- `content/` - отрисовка виджета.

## Не решено

- Виджет - это content script поверх страниц WB, отдельный overlay или
  popup расширения? От этого зависят `matches` в manifest и
  `host_permissions`.
- URL backend API (пока предполагается локальный адрес рабочей сети,
  см. корневой README, раздел "Безопасность").

Решения по этим пунктам стоит зафиксировать в `docs/adr/` перед тем, как
писать реальную логику.
