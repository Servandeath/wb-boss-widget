/*************************************************
 * WB SALES DETAILS BY PERIOD
 * Токен: KEY!B2
 * Даты периода: C1:D1 на активном листе
 * Заголовки: строка 2
 * Данные: с 3 строки
 * Запись: со столбца B
 *
 * НЕ ПЕРЕЗАПИСЫВАЕТ СТАРЫЕ ДАННЫЕ:
 * только дописывает новые строки
 *
 * БЕЗ использования:
 * - forPay
 * - finishedPrice
 * - priceWithDisc
 *
 * Формулы:
 * Цена со скидкой = totalPrice * (100 - discountPercent) / 100
 * Цена с СПП     = Цена со скидкой * (100 - spp) / 100
 *
 * Возвраты:
 * - К-во = -1
 * - totalPrice / Цена со скидкой / Цена с СПП = строго отрицательные
 *************************************************/

const WB_SALES_RAW = {
  KEY_SHEET: 'KEY',
  TOKEN_CELL: 'B2',

  API_URL: 'https://statistics-api.wildberries.ru/api/v1/supplier/sales',
  TIMEZONE: 'Europe/Moscow',

  HEADER_ROW: 2,
  DATA_START_ROW: 3,
  START_COL: 2, // B

  PAGE_SLEEP_MS: 2500,
  MAX_RETRIES_429: 8,
  MAX_PAGES: 200
};

function wbLoadSalesDetailsByPeriod() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getActiveSheet();
  const token = getWbToken_();

  const dateFromCell = sh.getRange('C1').getValue();
  const dateToCell = sh.getRange('D1').getValue();

  if (!dateFromCell || !dateToCell) {
    throw new Error('Укажи даты в C1 и D1');
  }

  const dateFrom = startOfDay_(new Date(dateFromCell));
  const dateTo = endOfDay_(new Date(dateToCell));

  if (isNaN(dateFrom.getTime()) || isNaN(dateTo.getTime())) {
    throw new Error('Неверные даты в C1:D1');
  }

  if (dateFrom > dateTo) {
    throw new Error('Дата начала больше даты конца');
  }

  writeHeaders_(sh);

  const apiRows = fetchAllSalesByLastChangeDate_(token, dateFrom);
  const existingKeys = getExistingKeys_(sh);

  const output = [];

  for (let i = 0; i < apiRows.length; i++) {
    const row = apiRows[i];

    const saleDate = parseDate_(row.date);
    if (!saleDate) continue;
    if (saleDate < dateFrom || saleDate > dateTo) continue;

    const qty = detectQty_(row); // 1 или -1

    const totalPriceAbs = Math.abs(toNumber_(row.totalPrice));
    const discountPercent = toNumber_(row.discountPercent);
    const spp = toNumber_(row.spp);

    const priceAfterDiscountAbs = Math.abs(
      calcPriceAfterDiscount_(totalPriceAbs, discountPercent)
    );

    const priceAfterSppAbs = Math.abs(
      calcPriceAfterSPP_(priceAfterDiscountAbs, spp)
    );

    const totalPrice = qty === -1 ? -totalPriceAbs : totalPriceAbs;
    const priceAfterDiscount = qty === -1 ? -priceAfterDiscountAbs : priceAfterDiscountAbs;
    const priceAfterSpp = qty === -1 ? -priceAfterSppAbs : priceAfterSppAbs;

    const rowKey = makeRowKey_(row, qty);
    if (existingKeys[rowKey]) continue;
    existingKeys[rowKey] = true;

    output.push([
      formatDateOnly_(saleDate),             // B  Дата
      String(row.subject || ''),             // C  Subject
      toNumberOrBlank_(row.nmId),            // D  nmId
      String(row.supplierArticle || ''),     // E  supplierArticle
      String(row.techSize || ''),            // F  techSize
      qty,                                   // G  К-во
      round2_(discountPercent),              // H  discountPercent
      round2_(spp),                          // I  spp
      round2_(totalPrice),                   // J  totalPrice
      round2_(priceAfterDiscount),           // K  Цена со скидкой
      round2_(priceAfterSpp),                // L  Цена с СПП
      qty === -1 ? 'Возврат' : 'Продажа'     // M  Тип
    ]);
  }

  output.sort(function(a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (String(a[3]) < String(b[3])) return -1;
    if (String(a[3]) > String(b[3])) return 1;
    return 0;
  });

  appendRows_(sh, output);
}

/*************************************************
 * FETCH ALL WITH SAFE RETRIES
 *************************************************/

function fetchAllSalesByLastChangeDate_(token, dateFrom) {
  let cursor = formatDateTimeForWb_(dateFrom);
  let all = [];
  let page = 0;

  while (page < WB_SALES_RAW.MAX_PAGES) {
    page++;

    const batch = fetchSalesBatchWithRetry_(token, cursor);

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    all = all.concat(batch);

    const last = batch[batch.length - 1];
    const lastChangeDate = last && last.lastChangeDate ? String(last.lastChangeDate) : '';

    if (!lastChangeDate) {
      break;
    }

    if (lastChangeDate === cursor) {
      break;
    }

    cursor = lastChangeDate;
    Utilities.sleep(WB_SALES_RAW.PAGE_SLEEP_MS);
  }

  return dedupeByNaturalKey_(all);
}

function fetchSalesBatchWithRetry_(token, cursor) {
  let attempt = 0;

  while (true) {
    attempt++;

    const result = fetchSalesBatchRaw_(token, cursor);
    const code = result.code;
    const headers = normalizeHeaders_(result.headers);
    const text = result.text;

    if (code === 200) {
      const json = JSON.parse(text);
      if (!Array.isArray(json)) {
        throw new Error('Некорректный ответ WB API');
      }
      return json;
    }

    if (code === 429) {
      if (attempt > WB_SALES_RAW.MAX_RETRIES_429) {
        throw new Error('WB API 429: превышен лимит повторов. Последний ответ: ' + text);
      }

      const retrySec = toInt_(headers['x-ratelimit-retry']);
      const resetSec = toInt_(headers['x-ratelimit-reset']);

      let waitMs = 0;

      if (retrySec > 0) {
        waitMs = retrySec * 1000 + 500;
      } else if (resetSec > 0) {
        waitMs = resetSec * 1000 + 1000;
      } else {
        waitMs = Math.min(30000, attempt * 4000);
      }

      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error('WB API error ' + code + ': ' + text);
  }
}

function fetchSalesBatchRaw_(token, cursor) {
  const url =
    WB_SALES_RAW.API_URL +
    '?dateFrom=' + encodeURIComponent(cursor) +
    '&flag=0';

  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: {
      'Authorization': token
    }
  });

  return {
    code: resp.getResponseCode(),
    text: resp.getContentText(),
    headers: resp.getAllHeaders()
  };
}

/*************************************************
 * OUTPUT
 *************************************************/

function writeHeaders_(sh) {
  const headers = [[
    'Дата',
    'Subject',
    'nmId',
    'supplierArticle',
    'techSize',
    'К-во',
    'discountPercent',
    'spp',
    'totalPrice',
    'Цена со скидкой',
    'Цена с СПП',
    'Тип'
  ]];

  sh.getRange(
    WB_SALES_RAW.HEADER_ROW,
    WB_SALES_RAW.START_COL,
    1,
    headers[0].length
  ).setValues(headers);
}

function appendRows_(sh, rows) {
  if (!rows || !rows.length) return;

  const startRow = Math.max(sh.getLastRow() + 1, WB_SALES_RAW.DATA_START_ROW);

  sh.getRange(
    startRow,
    WB_SALES_RAW.START_COL,
    rows.length,
    rows[0].length
  ).setValues(rows);
}

function getExistingKeys_(sh) {
  const keys = {};
  const lastRow = sh.getLastRow();

  if (lastRow < WB_SALES_RAW.DATA_START_ROW) return keys;

  const numRows = lastRow - WB_SALES_RAW.DATA_START_ROW + 1;
  const numCols = 12; // B:M

  const values = sh.getRange(
    WB_SALES_RAW.DATA_START_ROW,
    WB_SALES_RAW.START_COL,
    numRows,
    numCols
  ).getValues();

  for (let i = 0; i < values.length; i++) {
    const r = values[i];

    const key = [
      String(r[0] || ''), // Дата
      String(r[2] || ''), // nmId
      String(r[3] || ''), // supplierArticle
      String(r[4] || ''), // techSize
      String(r[5] || '')  // К-во
    ].join('||');

    if (key !== '||||') {
      keys[key] = true;
    }
  }

  return keys;
}

/*************************************************
 * HELPERS
 *************************************************/

function getWbToken_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const keySheet = ss.getSheetByName(WB_SALES_RAW.KEY_SHEET);
  if (!keySheet) throw new Error('Лист KEY не найден');

  const token = String(keySheet.getRange(WB_SALES_RAW.TOKEN_CELL).getValue()).trim();
  if (!token) throw new Error('Пустой токен в KEY!B2');

  return token;
}

function startOfDay_(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay_(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function parseDate_(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateOnly_(d) {
  return Utilities.formatDate(d, WB_SALES_RAW.TIMEZONE, 'yyyy-MM-dd');
}

function formatDateTimeForWb_(d) {
  return Utilities.formatDate(d, WB_SALES_RAW.TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss");
}

function toNumber_(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function toNumberOrBlank_(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? String(v) : n;
}

function toInt_(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? 0 : n;
}

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function calcPriceAfterDiscount_(totalPrice, discountPercent) {
  return totalPrice * (100 - discountPercent) / 100;
}

function calcPriceAfterSPP_(priceAfterDiscount, spp) {
  return priceAfterDiscount * (100 - spp) / 100;
}

function detectQty_(row) {
  const saleID = String(row.saleID || '').trim().toUpperCase();
  const orderType = String(row.orderType || '').trim().toLowerCase();
  const isReturn = String(row.isReturn || '').trim().toLowerCase();
  const docType = String(row.docTypeName || '').trim().toLowerCase();

  if (saleID.indexOf('R') === 0) return -1;
  if (orderType.indexOf('return') >= 0) return -1;
  if (isReturn === 'true') return -1;
  if (docType.indexOf('возврат') >= 0) return -1;

  return 1;
}

function normalizeHeaders_(headers) {
  const out = {};
  if (!headers) return out;

  for (const k in headers) {
    out[String(k).toLowerCase()] = headers[k];
  }
  return out;
}

function makeRowKey_(row, qty) {
  const d = parseDate_(row.date);
  const day = d ? formatDateOnly_(d) : String(row.date || '');

  return [
    day,
    String(row.nmId || ''),
    String(row.supplierArticle || ''),
    String(row.techSize || ''),
    String(qty || ''),
    String(row.saleID || ''),
    String(row.srid || '')
  ].join('||');
}

function dedupeByNaturalKey_(rows) {
  const seen = {};
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    const key = [
      String(r.srid || ''),
      String(r.saleID || ''),
      String(r.date || ''),
      String(r.lastChangeDate || ''),
      String(r.nmId || ''),
      String(r.supplierArticle || ''),
      String(r.techSize || '')
    ].join('||');

    if (seen[key]) continue;
    seen[key] = true;
    out.push(r);
  }

  return out;
}