/*************************************************
 * WB warehouse_remains -> Sheet1 matrix
 * -------------------------------------------------------------
 * Токен: KEY!B2 (Analytics token)
 *
 * Выгрузка в Sheet1, начиная с B2.
 * Формат:
 * B2:  КЭБ | Предмет | Артикул продавца | Артикул WB | Размер вещи | В пути... | ... | [Склады...] | Остальные
 * Далее строки:
 * МАНИ | ...
 * МАНИ | ...
 *
 * - Склады фиксированы (в заданном порядке)
 * - Неизвестные склады суммируются в колонку "Остальные" (в конце)
 * - Строка 1 и столбец A не трогаются
 * - Очищаем только область выгрузки от B2 до конца листа
 *************************************************/

const WB_STOCKS_CFG = {
  HOST: 'https://seller-analytics-api.wildberries.ru',
  CREATE_PATH: '/api/v1/warehouse_remains',
  STATUS_PATH: '/api/v1/warehouse_remains/tasks/{task_id}/status',
  DOWNLOAD_PATH: '/api/v1/warehouse_remains/tasks/{task_id}/download',

  KEY_SHEET: 'KEY',
  TOKEN_CELL: 'B2',

  OUT_SHEET: 'Лист1',      // как ты просишь
  START_ROW: 2,            // B2
  START_COL: 2,

  CAB_NAME: 'МАНИ',        // значение в каждой строке колонки "КЭБ"

  LOCALE: 'ru',

  // Группировки (нужны предмет/артикулы/размер)
  groupByBrand: false,
  groupBySubject: true,
  groupBySa: true,
  groupByNm: true,
  groupByBarcode: false,
  groupBySize: true,

  filterPics: 0,
  filterVolume: 0,

  MAX_STATUS_POLLS: 30,
  STATUS_POLL_INTERVAL_MS: 6000,

  OTHERS_COL_NAME: 'Остальные',

  // Фиксированный порядок складов
  WAREHOUSES_FIXED: [
    'Котовск',
    'Невинномысск',
    'Владимир',
    'Самара (Новосемейкино)',
    'Тула',
    'Краснодар',
    'СПБ Шушары',
    'Электросталь',
    'Екатеринбург - Перспективная 14',
    'Рязань (Тюшевское)',
    'Коледино',
    'Сарапул',
    'Казань',
    'Воронеж',
    'Волгоград',
    'Пенза',
    'Новосибирск',
    'Астана Карагандинское шоссе',
    'Актобе',
    'Владивосток',
    'Атакент',
    'Белая дача',
    'Санкт-Петербург Уткина Заводь',
    'Ташкент 2',
    'Обухово',
    'СЦ Барнаул',
    'Подольск',
    'Чашниково',
    'Истра'
  ]
};

const WB_STOCKS_SPECIAL = {
  TO_CLIENTS: 'В пути до получателей',
  TO_WB_RETURNS: 'В пути возвраты на склад WB',
  TOTAL_AT_WAREHOUSES: 'Всего находится на складах'
};

/**
 * Запуск
 */
function mainWarehouseRemainsToList1() {
  Logger.log('=== START WB warehouse_remains -> Лист1 (B2) ===');

  const token = wbStocks_getTokenFromKey_();
  if (!token) {
    Logger.log(`ERROR: token not found in ${WB_STOCKS_CFG.KEY_SHEET}!${WB_STOCKS_CFG.TOKEN_CELL}`);
    return;
  }

  const taskId = wbStocks_createTask_(token);
  if (!taskId) {
    Logger.log('ERROR: create task failed');
    return;
  }
  Logger.log('Task ID: ' + taskId);

  if (!wbStocks_waitReady_(token, taskId)) {
    Logger.log('ERROR: task not ready in time');
    return;
  }

  const payload = wbStocks_download_(token, taskId);
  if (!payload) {
    Logger.log('ERROR: download failed');
    return;
  }

  const items = wbStocks_normalizeItems_(payload);
  if (!Array.isArray(items)) {
    Logger.log('ERROR: unexpected download format: ' + wbStocks_safeJsonSlice_(payload, 2000));
    return;
  }

  Logger.log('Downloaded items: ' + items.length);

  wbStocks_writeMatrix_(items);

  Logger.log('=== DONE WB warehouse_remains -> Лист1 (B2) ===');
}

/**
 * Создать задачу
 */
function wbStocks_createTask_(token) {
  const query = {
    locale: WB_STOCKS_CFG.LOCALE,
    groupByBrand: WB_STOCKS_CFG.groupByBrand,
    groupBySubject: WB_STOCKS_CFG.groupBySubject,
    groupBySa: WB_STOCKS_CFG.groupBySa,
    groupByNm: WB_STOCKS_CFG.groupByNm,
    groupByBarcode: WB_STOCKS_CFG.groupByBarcode,
    groupBySize: WB_STOCKS_CFG.groupBySize,
    filterPics: WB_STOCKS_CFG.filterPics,
    filterVolume: WB_STOCKS_CFG.filterVolume
  };

  const url = WB_STOCKS_CFG.HOST + WB_STOCKS_CFG.CREATE_PATH + '?' + wbStocks_toQueryString_(query);
  Logger.log('Create URL: ' + url);

  const resp = wbStocks_getJson_(url, token);
  if (!resp) return null;

  Logger.log('Create HTTP: ' + resp.code);

  if (resp.code !== 200) {
    Logger.log('Create response: ' + (resp.text || ''));
    return null;
  }

  const j = resp.json || {};
  const taskId =
    (j.data && j.data.taskId) ||
    j.taskId ||
    (j.result && j.result.taskId) ||
    null;

  return taskId ? String(taskId) : null;
}

/**
 * Ждать готовность
 */
function wbStocks_waitReady_(token, taskId) {
  const url = WB_STOCKS_CFG.HOST + WB_STOCKS_CFG.STATUS_PATH.replace('{task_id}', encodeURIComponent(taskId));

  for (var i = 1; i <= WB_STOCKS_CFG.MAX_STATUS_POLLS; i++) {
    const resp = wbStocks_getJson_(url, token);
    if (!resp) return false;

    Logger.log('Status poll #' + i + ', HTTP ' + resp.code);

    if (resp.code === 200) {
      const status = wbStocks_extractStatus_(resp.json);
      Logger.log('Task status: ' + status);

      if (status === 'done' || status === 'completed' || status === 'success') return true;
      if (status === 'error' || status === 'failed' || status === 'cancelled') {
        Logger.log('Task failed: ' + (resp.text || ''));
        return false;
      }
    } else if (resp.code === 429) {
      Logger.log('Status rate limit (429)');
    } else {
      Logger.log('Status response: ' + (resp.text || ''));
    }

    Utilities.sleep(WB_STOCKS_CFG.STATUS_POLL_INTERVAL_MS);
  }

  return false;
}

/**
 * Скачать
 */
function wbStocks_download_(token, taskId) {
  const url = WB_STOCKS_CFG.HOST + WB_STOCKS_CFG.DOWNLOAD_PATH.replace('{task_id}', encodeURIComponent(taskId));
  const resp = wbStocks_getJson_(url, token);
  if (!resp) return null;

  Logger.log('Download HTTP: ' + resp.code);

  if (resp.code !== 200) {
    Logger.log('Download response: ' + (resp.text || ''));
    return null;
  }

  return resp.json;
}

/**
 * Нормализация download
 */
function wbStocks_normalizeItems_(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;

  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.result && Array.isArray(payload.result)) return payload.result;
  if (payload.result && Array.isArray(payload.result.items)) return payload.result.items;

  return null;
}

/**
 * Запись матрицы в Лист1 с B2:
 * КЭБ + поля + фикс. склады + Остальные(в конце)
 */
function wbStocks_writeMatrix_(items) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WB_STOCKS_CFG.OUT_SHEET);
  if (!sheet) sheet = ss.insertSheet(WB_STOCKS_CFG.OUT_SHEET);

  const fixedSet = {};
  for (var f = 0; f < WB_STOCKS_CFG.WAREHOUSES_FIXED.length; f++) {
    fixedSet[WB_STOCKS_CFG.WAREHOUSES_FIXED[f]] = true;
  }

  const rowMap = {};
  const othersWarehouseTotals = {}; // лог

  for (var i = 0; i < items.length; i++) {
    const item = items[i] || {};

    const subject = String(wbStocks_pick_(item, ['subjectName', 'subject']) || '').trim();
    const supplierArticle = String(wbStocks_pick_(item, ['vendorCode', 'sa', 'supplierArticle']) || '').trim();
    const nmId = String(wbStocks_pick_(item, ['nmId']) || '').trim();
    const techSize = String(wbStocks_pick_(item, ['techSize', 'size']) || '').trim();

    const key = [subject, supplierArticle, nmId, techSize].join('||');

    if (!rowMap[key]) {
      const base = {
        'КЭБ': WB_STOCKS_CFG.CAB_NAME,
        'Предмет': subject,
        'Артикул продавца': supplierArticle,
        'Артикул WB': nmId,
        'Размер вещи': techSize,
        'В пути до получателей': 0,
        'В пути возвраты на склад WB': 0,
        'Всего находится на складах': 0,
        __wh: {},
        __sumStocks: 0
      };

      for (var w = 0; w < WB_STOCKS_CFG.WAREHOUSES_FIXED.length; w++) {
        base.__wh[WB_STOCKS_CFG.WAREHOUSES_FIXED[w]] = 0;
      }
      base.__wh[WB_STOCKS_CFG.OTHERS_COL_NAME] = 0;

      rowMap[key] = base;
    }

    const row = rowMap[key];
    const warehouses = Array.isArray(item.warehouses) ? item.warehouses : [];

    for (var j = 0; j < warehouses.length; j++) {
      const wh = warehouses[j] || {};
      const whName = String(wbStocks_pick_(wh, ['warehouseName', 'name']) || '').trim();
      const qty = wbStocks_toNum_(wbStocks_pick_(wh, ['quantity', 'qty']), 0);

      if (!whName) continue;

      // служебные
      if (whName === WB_STOCKS_SPECIAL.TO_CLIENTS) {
        row['В пути до получателей'] += qty;
        continue;
      }
      if (whName === WB_STOCKS_SPECIAL.TO_WB_RETURNS) {
        row['В пути возвраты на склад WB'] += qty;
        continue;
      }
      if (whName === WB_STOCKS_SPECIAL.TOTAL_AT_WAREHOUSES) {
        row['Всего находится на складах'] += qty;
        continue;
      }

      // склады
      if (fixedSet[whName]) {
        row.__wh[whName] += qty;
      } else {
        row.__wh[WB_STOCKS_CFG.OTHERS_COL_NAME] += qty;
        othersWarehouseTotals[whName] = (othersWarehouseTotals[whName] || 0) + qty;
      }

      row.__sumStocks += qty;
    }
  }

  const warehouseHeaders = WB_STOCKS_CFG.WAREHOUSES_FIXED.concat([WB_STOCKS_CFG.OTHERS_COL_NAME]);
  const headers = [
    'КЭБ',
    'Предмет',
    'Артикул продавца',
    'Артикул WB',
    'Размер вещи',
    'В пути до получателей',
    'В пути возвраты на склад WB',
    'Всего находится на складах'
  ].concat(warehouseHeaders);

  const keys = Object.keys(rowMap);

  // Сортировка строк по убыванию суммарного остатка по складам
  keys.sort(function(a, b) {
    const ra = rowMap[a];
    const rb = rowMap[b];

    const diff = (rb.__sumStocks || 0) - (ra.__sumStocks || 0);
    if (diff !== 0) return diff;

    const sa = String(ra['Артикул продавца'] || '');
    const sb = String(rb['Артикул продавца'] || '');
    if (sa < sb) return -1;
    if (sa > sb) return 1;

    const ta = String(ra['Размер вещи'] || '');
    const tb = String(rb['Размер вещи'] || '');
    if (ta < tb) return -1;
    if (ta > tb) return 1;

    const na = String(ra['Артикул WB'] || '');
    const nb = String(rb['Артикул WB'] || '');
    if (na < nb) return -1;
    if (na > nb) return 1;

    return 0;
  });

  const out = [headers];

  for (var r = 0; r < keys.length; r++) {
    const ro = rowMap[keys[r]];

    const rowArr = [
      ro['КЭБ'] || '',
      ro['Предмет'] || '',
      ro['Артикул продавца'] || '',
      ro['Артикул WB'] || '',
      ro['Размер вещи'] || '',
      wbStocks_toNum_(ro['В пути до получателей'], 0),
      wbStocks_toNum_(ro['В пути возвраты на склад WB'], 0),
      wbStocks_toNum_(ro['Всего находится на складах'], 0)
    ];

    for (var c = 0; c < warehouseHeaders.length; c++) {
      const wn = warehouseHeaders[c];
      rowArr.push(wbStocks_toNum_(ro.__wh[wn], 0));
    }

    out.push(rowArr);
  }

  // Очищаем только область выгрузки с B2
  wbStocks_clearFrom_(sheet, WB_STOCKS_CFG.START_ROW, WB_STOCKS_CFG.START_COL);

  // Пишем в B2
  sheet.getRange(WB_STOCKS_CFG.START_ROW, WB_STOCKS_CFG.START_COL, out.length, out[0].length).setValues(out);

  // Лог: какие склады ушли в "Остальные"
  const othersNames = Object.keys(othersWarehouseTotals);
  if (othersNames.length) {
    othersNames.sort(function(a, b) { return othersWarehouseTotals[b] - othersWarehouseTotals[a]; });
    Logger.log('Warehouses aggregated into "Остальные": ' + othersNames.join(' | '));
    Logger.log('Top 10 "Остальные": ' +
      othersNames.slice(0, 10).map(function(n) { return n + ' (' + othersWarehouseTotals[n] + ')'; }).join(' | ')
    );
  } else {
    Logger.log('No unknown warehouses. "Остальные" = 0 for all rows.');
  }

  Logger.log('Rows written (excluding header): ' + (out.length - 1));
  Logger.log('Columns written: ' + out[0].length);
}

/**
 * Очищает контент начиная с (startRow, startCol) до конца листа
 * Не трогает строку 1 и столбец A
 */
function wbStocks_clearFrom_(sheet, startRow, startCol) {
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();
  const numRows = maxRows - startRow + 1;
  const numCols = maxCols - startCol + 1;
  if (numRows <= 0 || numCols <= 0) return;
  sheet.getRange(startRow, startCol, numRows, numCols).clearContent();
}

/**
 * GET JSON
 */
function wbStocks_getJson_(url, token) {
  const options = {
    method: 'get',
    headers: {
      'Authorization': String(token).trim(),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    const text = response.getContentText();

    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (e) {}

    return { code: code, text: text, json: json };
  } catch (e) {
    Logger.log('UrlFetch exception: ' + (e && e.stack ? e.stack : e));
    return null;
  }
}

/**
 * Токен из KEY!B2
 */
function wbStocks_getTokenFromKey_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WB_STOCKS_CFG.KEY_SHEET);
  if (!sh) {
    Logger.log('Sheet not found: ' + WB_STOCKS_CFG.KEY_SHEET);
    return '';
  }
  const token = sh.getRange(WB_STOCKS_CFG.TOKEN_CELL).getDisplayValue();
  return token ? String(token).trim() : '';
}

/**
 * Статус задачи
 */
function wbStocks_extractStatus_(json) {
  if (!json || typeof json !== 'object') return '';
  return String(
    (json.data && json.data.status) ||
    json.status ||
    (json.result && json.result.status) ||
    ''
  ).toLowerCase();
}

/**
 * Pick helper
 */
function wbStocks_pick_(obj, keys) {
  if (!obj || !keys || !keys.length) return '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && obj[k] !== undefined) {
      return obj[k];
    }
  }
  return '';
}

/**
 * Query string
 */
function wbStocks_toQueryString_(obj) {
  const parts = [];
  Object.keys(obj).forEach(function(key) {
    const val = obj[key];
    if (val === null || val === undefined || val === '') return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(val)));
  });
  return parts.join('&');
}

/**
 * Number safe
 */
function wbStocks_toNum_(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}

/**
 * Safe JSON for logs
 */
function wbStocks_safeJsonSlice_(obj, maxLen) {
  try {
    return JSON.stringify(obj).slice(0, maxLen || 1000);
  } catch (e) {
    return String(obj).slice(0, maxLen || 1000);
  }
}