/*************************************************
 * WB остатки на складах ПРОДАВЦА (FBS), 3 кабинета -> Лист1 matrix
 * -------------------------------------------------------------
 * Токены (лист KEY), категория "Маркетплейс":
 *   B2 - МАНИ
 *   B3 - МИРОС
 *   B4 - Бурков
 *
 * Номенклатура берётся с листа "Номенклатуры" (обновляется отдельным скриптом раз в сутки):
 *   A Идентификатор | B Артикул | C Категория | D Кабинет | E Название | F Описание
 *   G Дата создания | H Дата обновления | I chrtID | J Длина | K Ширина | L Высота
 *   M Вес брутто | N Технические размеры | O Баркод
 * Заголовки в строке 1, данные с A2. Колонки ищутся по заголовкам, откат - на буквы.
 *
 * Методы (только категория Маркетплейс):
 *   GET  https://marketplace-api.wildberries.ru/api/v3/warehouses
 *   POST https://marketplace-api.wildberries.ru/api/v3/stocks/{warehouseId}  body: {"skus":[...]}
 *
 * Выгрузка в Лист1 с B2:
 * КЭБ | Предмет | Артикул продавца | Артикул WB | Название | Размер вещи | Баркод | Итого | [Склады...]
 *
 * - Строка 1 и столбец A не трогаются
 * - Очищаем только область выгрузки от B2 до конца листа
 *************************************************/

const WB_FBS_CFG = {
  MP_HOST: 'https://marketplace-api.wildberries.ru',
  WAREHOUSES_PATH: '/api/v3/warehouses',
  STOCKS_PATH: '/api/v3/stocks/{warehouseId}',

  KEY_SHEET: 'KEY',

  // Кабинеты: имя должно совпадать со значением в колонке "Кабинет" листа Номенклатуры
  CABINETS: [
    { name: 'МАНИ',  tokenCell: 'B2' },
    { name: 'МИРОС', tokenCell: 'B3' },
    { name: 'Бурков', tokenCell: 'B4' }
  ],

  NOM_SHEET: 'Номенклатуры',
  NOM_HEADER_ROW: 1,
  NOM_FIRST_DATA_ROW: 2,

  // Ожидаемые заголовки -> запасная колонка (1 = A)
  NOM_COLS: {
    nmId:      { header: 'Идентификатор',        fallback: 1  },
    vendorCode:{ header: 'Артикул',              fallback: 2  },
    subject:   { header: 'Категория',            fallback: 3  },
    cabinet:   { header: 'Кабинет',              fallback: 4  },
    title:     { header: 'Название',             fallback: 5  },
    techSize:  { header: 'Технические размеры',  fallback: 14 },
    sku:       { header: 'Баркод',               fallback: 15 }
  },

  OUT_SHEET: 'Лист1',
  START_ROW: 2,
  START_COL: 2,

  SKUS_PER_REQUEST: 1000,   // max 1000 баркодов в запросе
  PAUSE_MP_MS: 250,         // 300 rpm -> 200 мс, берём с запасом
  MAX_RETRIES: 3,
  RETRY_PAUSE_MS: 3000,

  ONLY_WAREHOUSE_IDS: [],        // [] = все склады продавца
  ALWAYS_SUFFIX_CAB: false,      // true = всегда дописывать кабинет к имени склада
  HIDE_EMPTY_WAREHOUSES: false,  // true = скрыть колонки складов с нулевой суммой
  SKIP_ZERO_ROWS: true,          // не писать строки с нулём по всем складам
  GROUP_BY_CABINET: true,        // сортировка: сначала по кабинетам, потом по остатку
  FOREIGN_CELL_VALUE: '',        // что писать в колонке склада чужого кабинета

  TOTAL_COL_NAME: 'Итого на складах продавца'
};

/**
 * Запуск
 */
function mainSellerStocksToList1() {
  Logger.log('=== START WB FBS stocks (3 cabinets) -> Лист1 (B2) ===');

  // 1. Номенклатура с листа
  const allRows = wbFbs_readNomenclature_();
  if (!allRows) return;
  Logger.log('Nomenclature rows (with barcode): ' + allRows.length);

  const warehouses = [];   // {cab, id, name}
  const stocks = {};       // stocks[cab][whId] = {sku: amount}
  const usedRows = [];

  // 2. По каждому кабинету
  for (var c = 0; c < WB_FBS_CFG.CABINETS.length; c++) {
    const cab = WB_FBS_CFG.CABINETS[c];
    const token = wbFbs_getToken_(cab.tokenCell);

    if (!token) {
      Logger.log('SKIP cabinet "' + cab.name + '": token cell ' + cab.tokenCell + ' is empty');
      continue;
    }

    const cabRows = allRows.filter(function(r) {
      return wbFbs_norm_(r.cabinet) === wbFbs_norm_(cab.name);
    });

    if (!cabRows.length) {
      Logger.log('SKIP cabinet "' + cab.name + '": no rows in ' + WB_FBS_CFG.NOM_SHEET);
      continue;
    }

    const cabWh = wbFbs_fetchWarehouses_(token);
    if (!cabWh || !cabWh.length) {
      Logger.log('SKIP cabinet "' + cab.name + '": warehouses not received');
      continue;
    }

    Logger.log('Cabinet "' + cab.name + '": rows=' + cabRows.length +
      ', warehouses=' + cabWh.map(function(w) { return w.name + '(' + w.id + ')'; }).join(', '));

    const skus = cabRows.map(function(r) { return r.sku; });
    stocks[cab.name] = {};

    for (var w = 0; w < cabWh.length; w++) {
      const wh = cabWh[w];
      warehouses.push({ cab: cab.name, id: wh.id, name: wh.name });

      const map = wbFbs_fetchStocksForWarehouse_(token, wh.id, skus);
      stocks[cab.name][wh.id] = map || {};

      var sum = 0;
      Object.keys(stocks[cab.name][wh.id]).forEach(function(k) { sum += stocks[cab.name][wh.id][k]; });
      Logger.log('  "' + wh.name + '" (' + wh.id + '): total qty = ' + sum);
    }

    for (var i = 0; i < cabRows.length; i++) usedRows.push(cabRows[i]);
  }

  if (!warehouses.length) {
    Logger.log('ERROR: no warehouses received for any cabinet');
    return;
  }

  // 3. Запись
  wbFbs_writeMatrix_(usedRows, warehouses, stocks);

  Logger.log('=== DONE WB FBS stocks (3 cabinets) ===');
}

/**
 * Чтение листа Номенклатуры
 */
function wbFbs_readNomenclature_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WB_FBS_CFG.NOM_SHEET);
  if (!sh) {
    Logger.log('ERROR: sheet not found: ' + WB_FBS_CFG.NOM_SHEET);
    return null;
  }

  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < WB_FBS_CFG.NOM_FIRST_DATA_ROW) {
    Logger.log('ERROR: no data in ' + WB_FBS_CFG.NOM_SHEET);
    return null;
  }

  const headers = sh.getRange(WB_FBS_CFG.NOM_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const idx = {};

  Object.keys(WB_FBS_CFG.NOM_COLS).forEach(function(key) {
    const cfg = WB_FBS_CFG.NOM_COLS[key];
    var found = -1;

    for (var i = 0; i < headers.length; i++) {
      if (wbFbs_norm_(headers[i]) === wbFbs_norm_(cfg.header)) { found = i; break; }
    }

    if (found === -1) {
      found = cfg.fallback - 1;
      Logger.log('Header "' + cfg.header + '" not found, fallback to column ' + cfg.fallback);
    }

    idx[key] = found;
  });

  const numRows = lastRow - WB_FBS_CFG.NOM_FIRST_DATA_ROW + 1;
  const values = sh.getRange(WB_FBS_CFG.NOM_FIRST_DATA_ROW, 1, numRows, lastCol).getValues();

  const out = [];
  const seen = {};

  for (var r = 0; r < values.length; r++) {
    const v = values[r];
    const sku = wbFbs_str_(v[idx.sku]);
    const cabinet = wbFbs_str_(v[idx.cabinet]);

    if (!sku || !cabinet) continue;

    const key = wbFbs_norm_(cabinet) + '||' + sku;
    if (seen[key]) continue;
    seen[key] = true;

    out.push({
      cabinet: cabinet,
      sku: sku,
      nmId: wbFbs_str_(v[idx.nmId]),
      vendorCode: wbFbs_str_(v[idx.vendorCode]),
      subject: wbFbs_str_(v[idx.subject]),
      title: wbFbs_str_(v[idx.title]),
      techSize: wbFbs_str_(v[idx.techSize])
    });
  }

  return out;
}

/**
 * GET /api/v3/warehouses
 */
function wbFbs_fetchWarehouses_(token) {
  const url = WB_FBS_CFG.MP_HOST + WB_FBS_CFG.WAREHOUSES_PATH;
  const resp = wbFbs_request_(url, token, 'get', null);
  if (!resp) return null;

  if (resp.code !== 200) {
    Logger.log('Warehouses HTTP ' + resp.code + ': ' + (resp.text || '').slice(0, 500));
    return null;
  }

  var list = resp.json;
  if (!Array.isArray(list)) {
    if (list && Array.isArray(list.data)) list = list.data;
    else return null;
  }

  const filterIds = WB_FBS_CFG.ONLY_WAREHOUSE_IDS || [];
  const out = [];

  for (var i = 0; i < list.length; i++) {
    const w = list[i] || {};
    const id = wbFbs_toNum_(wbFbs_pick_(w, ['id', 'warehouseId']), 0);
    if (!id) continue;
    if (filterIds.length && filterIds.indexOf(id) === -1) continue;

    out.push({
      id: id,
      name: wbFbs_str_(wbFbs_pick_(w, ['name', 'warehouseName'])) || ('Склад ' + id)
    });
  }

  return out;
}

/**
 * POST /api/v3/stocks/{warehouseId} пачками
 */
function wbFbs_fetchStocksForWarehouse_(token, warehouseId, skus) {
  const url = WB_FBS_CFG.MP_HOST + WB_FBS_CFG.STOCKS_PATH.replace('{warehouseId}', encodeURIComponent(warehouseId));
  const chunks = wbFbs_chunk_(skus, WB_FBS_CFG.SKUS_PER_REQUEST);
  const map = {};

  for (var i = 0; i < chunks.length; i++) {
    const resp = wbFbs_request_(url, token, 'post', { skus: chunks[i] });

    if (!resp) { Utilities.sleep(WB_FBS_CFG.PAUSE_MP_MS); continue; }

    if (resp.code !== 200) {
      Logger.log('  Stocks HTTP ' + resp.code + ' (wh ' + warehouseId + ', chunk ' + (i + 1) + '): ' +
        (resp.text || '').slice(0, 300));
      Utilities.sleep(WB_FBS_CFG.PAUSE_MP_MS);
      continue;
    }

    const j = resp.json || {};
    const arr = Array.isArray(j.stocks) ? j.stocks : [];

    for (var n = 0; n < arr.length; n++) {
      const st = arr[n] || {};
      const sku = wbFbs_str_(wbFbs_pick_(st, ['sku', 'barcode']));
      if (!sku) continue;
      map[sku] = (map[sku] || 0) + wbFbs_toNum_(wbFbs_pick_(st, ['amount', 'quantity']), 0);
    }

    Utilities.sleep(WB_FBS_CFG.PAUSE_MP_MS);
  }

  return map;
}

/**
 * Запись матрицы в Лист1 с B2
 */
function wbFbs_writeMatrix_(rows, warehouses, stocks) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WB_FBS_CFG.OUT_SHEET);
  if (!sheet) sheet = ss.insertSheet(WB_FBS_CFG.OUT_SHEET);

  // Суммы по складам
  const whSums = {};
  for (var w = 0; w < warehouses.length; w++) {
    const wh = warehouses[w];
    const m = (stocks[wh.cab] || {})[wh.id] || {};
    var sum = 0;
    Object.keys(m).forEach(function(k) { sum += m[k]; });
    whSums[wh.cab + '||' + wh.id] = sum;
  }

  const activeWh = warehouses.filter(function(wh) {
    return WB_FBS_CFG.HIDE_EMPTY_WAREHOUSES ? whSums[wh.cab + '||' + wh.id] > 0 : true;
  });

  // Заголовки складов: кабинет дописываем при совпадении имён
  const nameCount = {};
  activeWh.forEach(function(wh) { nameCount[wh.name] = (nameCount[wh.name] || 0) + 1; });

  const usedHeaders = {};
  const whHeaders = activeWh.map(function(wh) {
    var h = wh.name;
    if (WB_FBS_CFG.ALWAYS_SUFFIX_CAB || nameCount[wh.name] > 1) h = wh.name + ' (' + wh.cab + ')';
    if (usedHeaders[h]) h = h + ' [' + wh.id + ']';
    usedHeaders[h] = true;
    return h;
  });

  const headers = [
    'КЭБ',
    'Предмет',
    'Артикул продавца',
    'Артикул WB',
    'Название',
    'Размер вещи',
    'Баркод',
    WB_FBS_CFG.TOTAL_COL_NAME
  ].concat(whHeaders);

  // Порядок кабинетов для группировки
  const cabOrder = {};
  for (var ci = 0; ci < WB_FBS_CFG.CABINETS.length; ci++) {
    cabOrder[wbFbs_norm_(WB_FBS_CFG.CABINETS[ci].name)] = ci;
  }

  const dataRows = [];

  for (var r = 0; r < rows.length; r++) {
    const row = rows[r];
    const cells = [];
    var total = 0;

    for (var q = 0; q < activeWh.length; q++) {
      const wh = activeWh[q];

      if (wbFbs_norm_(wh.cab) !== wbFbs_norm_(row.cabinet)) {
        cells.push(WB_FBS_CFG.FOREIGN_CELL_VALUE);
        continue;
      }

      const m = (stocks[wh.cab] || {})[wh.id] || {};
      const qty = wbFbs_toNum_(m[row.sku], 0);
      cells.push(qty);
      total += qty;
    }

    if (WB_FBS_CFG.SKIP_ZERO_ROWS && total === 0) continue;

    dataRows.push({
      cabIdx: cabOrder[wbFbs_norm_(row.cabinet)] !== undefined ? cabOrder[wbFbs_norm_(row.cabinet)] : 999,
      total: total,
      vendorCode: row.vendorCode,
      techSize: row.techSize,
      nmId: row.nmId,
      arr: [
        row.cabinet,
        row.subject,
        row.vendorCode,
        row.nmId,
        row.title,
        row.techSize,
        row.sku,
        total
      ].concat(cells)
    });
  }

  dataRows.sort(function(a, b) {
    if (WB_FBS_CFG.GROUP_BY_CABINET && a.cabIdx !== b.cabIdx) return a.cabIdx - b.cabIdx;

    const diff = b.total - a.total;
    if (diff !== 0) return diff;

    if (a.vendorCode < b.vendorCode) return -1;
    if (a.vendorCode > b.vendorCode) return 1;
    if (a.techSize < b.techSize) return -1;
    if (a.techSize > b.techSize) return 1;
    if (a.nmId < b.nmId) return -1;
    if (a.nmId > b.nmId) return 1;
    return 0;
  });

  const out = [headers];
  for (var d = 0; d < dataRows.length; d++) out.push(dataRows[d].arr);

  wbFbs_clearFrom_(sheet, WB_FBS_CFG.START_ROW, WB_FBS_CFG.START_COL);
  sheet.getRange(WB_FBS_CFG.START_ROW, WB_FBS_CFG.START_COL, out.length, out[0].length).setValues(out);

  Logger.log('Rows written (excluding header): ' + (out.length - 1));
  Logger.log('Columns written: ' + out[0].length);
  if (WB_FBS_CFG.SKIP_ZERO_ROWS) Logger.log('Skipped zero rows: ' + (rows.length - (out.length - 1)));
}

/**
 * Очищает контент начиная с (startRow, startCol) до конца листа
 */
function wbFbs_clearFrom_(sheet, startRow, startCol) {
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();
  const numRows = maxRows - startRow + 1;
  const numCols = maxCols - startCol + 1;
  if (numRows <= 0 || numCols <= 0) return;
  sheet.getRange(startRow, startCol, numRows, numCols).clearContent();
}

/**
 * HTTP запрос с ретраями на 429/5xx
 */
function wbFbs_request_(url, token, method, payload) {
  const options = {
    method: method || 'get',
    headers: {
      'Authorization': String(token).trim(),
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  };

  if (payload) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  for (var attempt = 1; attempt <= WB_FBS_CFG.MAX_RETRIES; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const text = response.getContentText();

      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}

      if ((code === 429 || code >= 500) && attempt < WB_FBS_CFG.MAX_RETRIES) {
        Logger.log('Retry ' + attempt + ' after HTTP ' + code);
        Utilities.sleep(WB_FBS_CFG.RETRY_PAUSE_MS * attempt);
        continue;
      }

      return { code: code, text: text, json: json };
    } catch (e) {
      Logger.log('UrlFetch exception (attempt ' + attempt + '): ' + (e && e.stack ? e.stack : e));
      if (attempt < WB_FBS_CFG.MAX_RETRIES) {
        Utilities.sleep(WB_FBS_CFG.RETRY_PAUSE_MS * attempt);
        continue;
      }
      return null;
    }
  }

  return null;
}

/**
 * Токен из KEY
 */
function wbFbs_getToken_(cell) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WB_FBS_CFG.KEY_SHEET);
  if (!sh) {
    Logger.log('Sheet not found: ' + WB_FBS_CFG.KEY_SHEET);
    return '';
  }
  return String(sh.getRange(cell).getDisplayValue() || '').trim();
}

/**
 * Разбивка массива на пачки
 */
function wbFbs_chunk_(arr, size) {
  const out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Pick helper
 */
function wbFbs_pick_(obj, keys) {
  if (!obj || !keys || !keys.length) return '';
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] !== null && obj[k] !== undefined) return obj[k];
  }
  return '';
}

/**
 * Строка без экспоненты для длинных чисел (баркоды, nmID)
 */
function wbFbs_str_(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Math.abs(value) >= 1e21) return value.toFixed(0);
    return String(value);
  }
  return String(value).trim();
}

/**
 * Нормализация для сравнения (кабинеты, заголовки)
 */
function wbFbs_norm_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\u00A0/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Number safe
 */
function wbFbs_toNum_(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return isNaN(n) ? fallback : n;
}