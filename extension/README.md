# extension/

Chrome-расширение (Manifest V3). По принципу из корневого README:
расширение не знает ни про WB, ни про Google Sheets - только опрашивает
свой backend API и рисует цифры.

- `manifest.json` - popup, а не content-script оверлей (см. "Решено" ниже).
- `popup/` - popup-окно расширения: `popup.js` дёргает backend API
  напрямую при каждом открытии (без фонового поллинга - см. докстринг
  в начале файла), рисует метрики по кабинетам.

## Решено

- **Popup, не content-script оверлей.** Меньше permissions (не нужны
  `matches`/`host_permissions` на страницы WB), быстрее реализовать,
  данные всё равно актуальны только на момент открытия popup - постоянно
  висящий оверлей поверх страниц WB для MVP избыточен.
- **Backend API URL**: `http://127.0.0.1:8000` захардкожен в
  `popup/popup.js` (`API_BASE`) - совпадает с дефолтами
  `backend/app/config.API_HOST`/`API_PORT`. Если бэкенд слушает не
  localhost (другая машина в сети) - поменять константу и
  `host_permissions` в `manifest.json`.
- **API-токен**: если `backend/.env` задаёт `API_TOKEN`, расширение
  ждёт его в `chrome.storage.session` под ключом `apiToken` (не
  `chrome.storage.local` - см. корневой README, "Безопасность"). Способ
  положить токен туда (options-страница и т.п.) пока не реализован -
  вручную через DevTools консоль popup:
  `chrome.storage.session.set({apiToken: "..."})`.
