const WB_FAST = {
  KEY_SHEET: 'KEY',
  TOKEN_CELL: 'B2',

  OUT_SHEET: 'WB_PRICES_RAW',
  DATA_START_ROW: 4,
  STATUS_CELL: 'I1',

  API_BASE: 'https://discounts-prices-api.wildberries.ru',
  ENDPOINT: '/api/v2/list/goods/filter',
  LIMIT: 1000,

  LOCK_WAIT_MS: 30000,
  MIN_GAP_MS: 700,

  RETRY_429_MAX_TRIES: 8,
  RETRY_5XX_MAX_TRIES: 5,
  RETRY_BASE_SLEEP_MS: 1200,
  RETRY_SUCCESS_PAUSE_MS: 350,

  NOTICE_SECONDS: 6
};

const WB_COL = {
  CHECK: 2,         // B
  NMID: 5,          // E
  VENDOR: 6,        // F
  PRICE: 7,         // G
  NEW_PRICE: 8,     // H
  DISCOUNT: 9,      // I
  NEW_DISCOUNT: 10, // J
  PRICE_AFTER: 11   // K
};

function WB_ON_OPEN_PRICES() {
  // намеренно ничего не делаем на onOpen
  return;
}

function WB_GET_PRICES_ALL_FAST() {
  const lock = LockService.getScriptLock();
  lock.waitLock(WB_FAST.LOCK_WAIT_MS);

  let sh = null;

  try {
    const ss = SpreadsheetApp.getActive();
    const token = getToken_();
    sh = getOrCreateSheet_(ss, WB_FAST.OUT_SHEET);

    sh.getRange(WB_FAST.STATUS_CELL).setValue('Загрузка');

    const { count: existingCount, nmIdToIndex } = buildExistingNmIdRowMap_(sh);

    let fkMatrix = null;
    if (existingCount > 0) {
      fkMatrix = sh
        .getRange(WB_FAST.DATA_START_ROW, WB_COL.VENDOR, existingCount, 6) // F:K
        .getValues();
    }

    let offset = 0;
    let totalFetched = 0;
    let updatedRows = 0;
    const appendBuffer = [];

    let isFirstRequest = true;

    while (true) {
      if (!isFirstRequest) {
        Utilities.sleep(WB_FAST.MIN_GAP_MS);
      }
      isFirstRequest = false;

      const goods = fetchGoodsPage_(token, offset, WB_FAST.LIMIT, sh);
      const n = goods.length;
      if (n === 0) break;

      totalFetched += n;

      for (let i = 0; i < n; i++) {
        const g = goods[i];

        const nmId = (g.nmID !== undefined) ? g.nmID : (g.nmId ?? '');
        if (nmId === '' || nmId === null || nmId === undefined) continue;

        const nmKey = String(nmId).trim();
        if (!nmKey) continue;

        const vendorCode = g.vendorCode ?? '';
        const price = pickBasePriceRub_(g);
        const discount = num_(g.discount);

        const newPrice = price;
        const newDiscount = discount;
        const priceAfter = calcAfter_(price, discount);

        if (nmIdToIndex.has(nmKey)) {
          if (fkMatrix) {
            const idx = nmIdToIndex.get(nmKey);
            if (idx >= 0) {
              fkMatrix[idx][0] = vendorCode;   // F
              fkMatrix[idx][1] = price;        // G
              fkMatrix[idx][2] = newPrice;     // H
              fkMatrix[idx][3] = discount;     // I
              fkMatrix[idx][4] = newDiscount;  // J
              fkMatrix[idx][5] = priceAfter;   // K
              updatedRows++;
            }
          }
        } else {
          appendBuffer.push([
            nmKey,       // E
            vendorCode,  // F
            price,       // G
            newPrice,    // H
            discount,    // I
            newDiscount, // J
            priceAfter   // K
          ]);
          nmIdToIndex.set(nmKey, -1);
        }
      }

      offset += n;

      sh.getRange(WB_FAST.STATUS_CELL).setValue(
        'Загрузка: offset=' + offset + ', получено=' + totalFetched
      );

      if (n < WB_FAST.LIMIT) break;
    }

    if (existingCount > 0 && fkMatrix) {
      sh.getRange(WB_FAST.DATA_START_ROW, WB_COL.VENDOR, existingCount, 6).setValues(fkMatrix);
    }

    if (appendBuffer.length > 0) {
      const appendStartRow = getAppendStartRow_(sh);

      sh.getRange(appendStartRow, WB_COL.NMID, appendBuffer.length, 7) // E:K
        .setValues(appendBuffer);

      setCheckboxValidation_(sh, appendStartRow, appendBuffer.length);
      sh.getRange(appendStartRow, WB_COL.CHECK, appendBuffer.length, 1)
        .setValues(new Array(appendBuffer.length).fill([false]));
    }

    sh.getRange(WB_FAST.STATUS_CELL).setValue('Готово');

    Logger.log(
      'WB_GET_PRICES_ALL_FAST done. fetched=%s updated=%s appended=%s',
      totalFetched, updatedRows, appendBuffer.length
    );

    WB_FAST_notify_(
      'WB цены',
      'Загрузка завершена' +
      '\nПолучено: ' + totalFetched +
      '\nОбновлено: ' + updatedRows +
      '\nДобавлено: ' + appendBuffer.length,
      WB_FAST.NOTICE_SECONDS
    );

  } catch (e) {
    if (sh) {
      sh.getRange(WB_FAST.STATUS_CELL).setValue('Ошибка');
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

function buildExistingNmIdRowMap_(sh) {
  const lastRow = sh.getLastRow();
  if (lastRow < WB_FAST.DATA_START_ROW) return { count: 0, nmIdToIndex: new Map() };

  const count = lastRow - WB_FAST.DATA_START_ROW + 1;
  const vals = sh.getRange(WB_FAST.DATA_START_ROW, WB_COL.NMID, count, 1).getValues();

  const nmIdToIndex = new Map();
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i][0];
    if (v === '' || v === null || v === undefined) continue;
    const key = String(v).trim();
    if (!key) continue;
    if (!nmIdToIndex.has(key)) nmIdToIndex.set(key, i);
  }

  return { count, nmIdToIndex };
}

function getAppendStartRow_(sh) {
  const lastRow = sh.getLastRow();
  return Math.max(lastRow + 1, WB_FAST.DATA_START_ROW);
}

function setCheckboxValidation_(sh, startRow, numRows) {
  if (!numRows || numRows <= 0) return;
  const rng = sh.getRange(startRow, WB_COL.CHECK, numRows, 1);
  const rule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  rng.setDataValidation(rule);
}

function fetchGoodsPage_(token, offset, limit, sh) {
  const url = WB_FAST.API_BASE + WB_FAST.ENDPOINT + '?limit=' + limit + '&offset=' + offset;

  const resp = wbFetchWithRetry_(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: token }
  }, 'list/goods/filter offset=' + offset, sh);

  const code = resp.getResponseCode();
  const text = resp.getContentText();

  if (code !== 200) {
    throw new Error('WB API HTTP ' + code + ': ' + text);
  }

  const json = JSON.parse(text);
  return (json && json.data && Array.isArray(json.data.listGoods)) ? json.data.listGoods : [];
}

function wbFetchWithRetry_(url, options, label, sh) {
  const max429 = WB_FAST.RETRY_429_MAX_TRIES;
  const max5xx = WB_FAST.RETRY_5XX_MAX_TRIES;
  const baseSleep = WB_FAST.RETRY_BASE_SLEEP_MS;

  let tries429 = 0;
  let tries5xx = 0;

  while (true) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    const headers = resp.getHeaders ? resp.getHeaders() : {};
    const text = resp.getContentText();

    const retryHeader =
      headers['X-Ratelimit-Retry'] ||
      headers['x-ratelimit-retry'] ||
      headers['X-RateLimit-Retry'] ||
      headers['x-ratelimit-Retry'];

    const remaining =
      headers['X-Ratelimit-Remaining'] ||
      headers['x-ratelimit-remaining'] ||
      '';

    const reset =
      headers['X-Ratelimit-Reset'] ||
      headers['x-ratelimit-reset'] ||
      '';

    Logger.log(
      '[WB %s] code=%s remaining=%s retry=%s reset=%s body=%s',
      label || 'request',
      code,
      remaining,
      retryHeader,
      reset,
      cut_(text, 500)
    );

    if (code !== 429 && !(code >= 500 && code <= 504)) {
      if (WB_FAST.RETRY_SUCCESS_PAUSE_MS > 0) {
        Utilities.sleep(WB_FAST.RETRY_SUCCESS_PAUSE_MS);
      }
      return resp;
    }

    if (code === 429) {
      tries429++;
      if (tries429 > max429) {
        throw new Error('WB 429: exceeded retry limit in ' + (label || 'request') + ': ' + text);
      }

      let sleepMs = 0;
      const retrySec = Number(retryHeader);

      if (isFinite(retrySec) && retrySec > 0) {
        sleepMs = retrySec * 1000 + 500;
      } else {
        sleepMs = baseSleep * Math.pow(2, tries429 - 1);
      }

      if (sh) {
        sh.getRange(WB_FAST.STATUS_CELL).setValue(
          '429, ждём ' + Math.ceil(sleepMs / 1000) + ' сек'
        );
      }

      Logger.log('[WB %s] 429 retry #%s, sleep=%s ms', label || 'request', tries429, sleepMs);
      Utilities.sleep(sleepMs);
      continue;
    }

    if (code >= 500 && code <= 504) {
      tries5xx++;
      if (tries5xx > max5xx) {
        throw new Error('WB ' + code + ': exceeded retry limit in ' + (label || 'request') + ': ' + text);
      }

      const sleepMs = Math.min(baseSleep * Math.pow(2, tries5xx - 1), 30000);

      if (sh) {
        sh.getRange(WB_FAST.STATUS_CELL).setValue(
          code + ', повтор через ' + Math.ceil(sleepMs / 1000) + ' сек'
        );
      }

      Logger.log('[WB %s] %s retry #%s, sleep=%s ms', label || 'request', code, tries5xx, sleepMs);
      Utilities.sleep(sleepMs);
      continue;
    }
  }
}

function WB_FAST_notify_(title, message, seconds) {
  const sec = Math.max(2, Number(seconds) || 5);
  const ss = SpreadsheetApp.getActive();

  try {
    ss.toast(message, title, sec);
  } catch (e) {}
}

function getToken_() {
  const ss = SpreadsheetApp.getActive();
  const keySh = ss.getSheetByName(WB_FAST.KEY_SHEET);
  if (!keySh) throw new Error('KEY sheet not found');
  const token = String(keySh.getRange(WB_FAST.TOKEN_CELL).getValue()).trim();
  if (!token) throw new Error('KEY!B2 token is empty');
  return token;
}

function getOrCreateSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function pickBasePriceRub_(g) {
  if (g && Array.isArray(g.sizes) && g.sizes.length) {
    for (let i = 0; i < g.sizes.length; i++) {
      const p = Number(g.sizes[i].price);
      if (!isNaN(p) && p > 0) return Math.round(p);
    }
  }
  return '';
}

function num_(v) {
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function calcAfter_(priceRub, discountPct) {
  const p = Number(priceRub);
  const d = Number(discountPct);
  if (isNaN(p) || isNaN(d)) return '';
  return Math.round(p * (1 - d / 100));
}

function cut_(s, maxLen) {
  const t = String(s || '');
  return (t.length <= maxLen) ? t : (t.slice(0, maxLen - 1) + '…');
}