/*************************************************
 * WB — Push Prices & Discounts (CHECKED ROWS) + ONE-LINE LOG + NOTICE
 *
 * Reads rows where checkbox in column B = TRUE
 * Sends to WB: POST /api/v2/upload/task
 * Logs ONE ROW per nmID to WB_PRICES_LOG:
 *   A: Date | B: NM | C: Price | D: Discount | E: Status (single line)
 *
 * Status example:
 *  "UPLOADED uploadID=123 | OK"
 *  "UPLOADED uploadID=123 | ERROR: ..."
 *  "UPLOADED uploadID=123 | PROCESSING"
 *  "ALREADY SET | цена и скидка уже установлены"
 *************************************************/

const WB_PUSH2_CFG = {
  KEY_SHEET: 'KEY',
  TOKEN_CELL: 'B2',

  SRC_SHEET: 'WB_PRICES_RAW',
  DATA_START_ROW: 4,
  STATUS_CELL: 'R1',

  LOG_SHEET: 'WB_PRICES_LOG',
  LOG_HEADERS: ['Дата', 'NM', 'цена', 'скидка', 'статус'],

  API_BASE: 'https://discounts-prices-api.wildberries.ru',
  ENDPOINT_UPLOAD: '/api/v2/upload/task',
  ENDPOINT_BUFFER_STATE: '/api/v2/buffer/tasks',
  ENDPOINT_HISTORY_STATE: '/api/v2/history/tasks',
  ENDPOINT_HISTORY_GOODS: '/api/v2/history/goods/task',

  MAX_PER_UPLOAD: 1000,

  POLL_TRIES: 5,
  POLL_SLEEP_MS: 2500,
  MIN_GAP_MS: 650,

  NOTICE_SECONDS: 6,

  LOCK_WAIT_MS: 30000,

  RETRY_429_MAX_TRIES: 8,
  RETRY_5XX_MAX_TRIES: 5,
  RETRY_BASE_SLEEP_MS: 1200,
  RETRY_SUCCESS_PAUSE_MS: 350
};

// Column indices (1-based)
const WB_PUSH2_COL = {
  CHECK: 2,          // B
  NMID: 5,           // E
  PRICE: 7,          // G
  NEW_PRICE: 8,      // H
  DISCOUNT: 9,       // I
  NEW_DISCOUNT: 10   // J
};

/**
 * Main function
 */
function WB_PUSH_PRICES_CHECKED_WITH_LOG() {
  const lock = LockService.getScriptLock();
  lock.waitLock(WB_PUSH2_CFG.LOCK_WAIT_MS);

  let sh = null;

  try {
    const ss = SpreadsheetApp.getActive();
    const token = WB_PUSH2_getToken_();

    sh = ss.getSheetByName(WB_PUSH2_CFG.SRC_SHEET);
    if (!sh) throw new Error('Лист ' + WB_PUSH2_CFG.SRC_SHEET + ' не найден');

    // Статус в R1 сразу при запуске
    sh.getRange(WB_PUSH2_CFG.STATUS_CELL).setValue('Загрузка');

    const logSh = WB_PUSH2_getOrCreateLogSheet_(ss);

    const lastRow = sh.getLastRow();
    if (lastRow < WB_PUSH2_CFG.DATA_START_ROW) {
      sh.getRange(WB_PUSH2_CFG.STATUS_CELL).setValue('Готово');
      WB_PUSH2_notify_('WB цены', 'Нет данных для отправки.', WB_PUSH2_CFG.NOTICE_SECONDS);
      return;
    }

    const numRows = lastRow - WB_PUSH2_CFG.DATA_START_ROW + 1;

    // Read B..J (CHECK..NEW_DISCOUNT)
    const startCol = WB_PUSH2_COL.CHECK; // B
    const endCol = WB_PUSH2_COL.NEW_DISCOUNT; // J
    const width = endCol - startCol + 1;

    const vals = sh.getRange(WB_PUSH2_CFG.DATA_START_ROW, startCol, numRows, width).getValues();

    const picked = [];
    const logRows = [];
    const rowsToUncheck = [];

    const now = new Date();

    for (let i = 0; i < vals.length; i++) {
      const sheetRow = WB_PUSH2_CFG.DATA_START_ROW + i;
      const r = vals[i];

      const isChecked = (r[0] === true);
      if (!isChecked) continue;

      const nmRaw = r[WB_PUSH2_COL.NMID - startCol];
      const nmKey = String(nmRaw ?? '').trim();
      const nmID = parseInt(nmKey, 10);

      if (!nmKey || isNaN(nmID) || nmID <= 0) {
        logRows.push([now, nmKey || '', '', '', 'SKIP: некорректный nmID в E']);
        continue;
      }

      const priceOld = r[WB_PUSH2_COL.PRICE - startCol];
      const priceNew = r[WB_PUSH2_COL.NEW_PRICE - startCol];
      const discOld  = r[WB_PUSH2_COL.DISCOUNT - startCol];
      const discNew  = r[WB_PUSH2_COL.NEW_DISCOUNT - startCol];

      const price = WB_PUSH2_pickInt_(priceNew, priceOld);
      const discount = WB_PUSH2_pickNum_(discNew, discOld);

      if (price === '') {
        logRows.push([now, nmID, '', (discount === '' ? '' : discount), 'SKIP: пустая цена (H и G пустые/не числа)']);
        continue;
      }
      if (discount === '') {
        logRows.push([now, nmID, price, '', 'SKIP: пустая скидка (J и I пустые/не числа)']);
        continue;
      }

      const p = Number(price);
      const d = Number(discount);

      if (!isFinite(p) || p <= 0) {
        logRows.push([now, nmID, price, discount, 'SKIP: некорректная цена']);
        continue;
      }
      if (!isFinite(d) || d < 0 || d > 100) {
        logRows.push([now, nmID, price, discount, 'SKIP: скидка вне 0..100']);
        continue;
      }

      picked.push({ row: sheetRow, nmID, price: Math.round(p), discount: d });
    }

    if (picked.length === 0) {
      if (logRows.length) WB_PUSH2_appendLog_(logSh, logRows);
      sh.getRange(WB_PUSH2_CFG.STATUS_CELL).setValue('Готово');
      WB_PUSH2_notify_('WB цены', 'Нет валидных отмеченных строк. Смотри журнал: ' + WB_PUSH2_CFG.LOG_SHEET, WB_PUSH2_CFG.NOTICE_SECONDS);
      return;
    }

    const chunks = WB_PUSH2_chunk_(picked, WB_PUSH2_CFG.MAX_PER_UPLOAD);

    const uploadIds = [];
    let wbErrors = 0;
    let processing = 0;

    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];

      const payload = {
        data: chunk.map(x => ({
          nmID: x.nmID,
          price: x.price,
          discount: x.discount
        }))
      };

      Utilities.sleep(WB_PUSH2_CFG.MIN_GAP_MS);
      const upload = WB_PUSH2_wbUploadTask_(token, payload);

      if (upload.alreadySet) {
        if (chunk.length === 1) {
          const x = chunk[0];
          rowsToUncheck.push(x.row);
          logRows.push([new Date(), x.nmID, x.price, x.discount, 'ALREADY SET | цена и скидка уже установлены']);
        } else {
          for (let i = 0; i < chunk.length; i++) {
            const x = chunk[i];
            const res = WB_PUSH2_processSingleItem_(token, x, uploadIds);

            if (res.uncheck) rowsToUncheck.push(x.row);
            if (res.processing) processing += 1;
            if (res.wbError) wbErrors += 1;

            logRows.push([new Date(), x.nmID, x.price, x.discount, res.status]);
          }
        }
        continue;
      }

      const uploadID = upload.id;
      uploadIds.push(uploadID);

      const state = WB_PUSH2_wbWaitProcessed_(token, uploadID);

      if (!state) {
        processing += chunk.length;
        for (let i = 0; i < chunk.length; i++) {
          const x = chunk[i];
          logRows.push([new Date(), x.nmID, x.price, x.discount, 'UPLOADED uploadID=' + uploadID + ' | PROCESSING']);
        }
        continue;
      }

      const st = Number(state.status);

      if (st === 3) {
        rowsToUncheck.push(...chunk.map(x => x.row));
        for (let i = 0; i < chunk.length; i++) {
          const x = chunk[i];
          logRows.push([new Date(), x.nmID, x.price, x.discount, 'UPLOADED uploadID=' + uploadID + ' | OK']);
        }
        continue;
      }

      if (st === 5 || st === 6) {
        const detail = WB_PUSH2_wbGetProcessedDetails_(token, uploadID);

        const errByNm = new Map();
        if (detail && Array.isArray(detail.historyGoods)) {
          for (let i = 0; i < detail.historyGoods.length; i++) {
            const g = detail.historyGoods[i];
            const nm = String(g.nmID ?? '').trim();
            const et = String(g.errorText ?? '').trim();
            if (nm) errByNm.set(nm, et || 'WB error (без текста)');
          }
        }

        for (let i = 0; i < chunk.length; i++) {
          const x = chunk[i];
          const key = String(x.nmID);

          if (errByNm.has(key)) {
            wbErrors += 1;
            logRows.push([new Date(), x.nmID, x.price, x.discount,
              'UPLOADED uploadID=' + uploadID + ' | ERROR: ' + WB_PUSH2_cut_(errByNm.get(key), 220)
            ]);
          } else {
            rowsToUncheck.push(x.row);
            logRows.push([new Date(), x.nmID, x.price, x.discount, 'UPLOADED uploadID=' + uploadID + ' | OK']);
          }
        }
        continue;
      }

      for (let i = 0; i < chunk.length; i++) {
        const x = chunk[i];
        logRows.push([new Date(), x.nmID, x.price, x.discount, 'UPLOADED uploadID=' + uploadID + ' | STATUS=' + st]);
      }
    }

    if (logRows.length) WB_PUSH2_appendLog_(logSh, logRows);

    if (rowsToUncheck.length) {
      WB_PUSH2_uncheckRows_(sh, rowsToUncheck, WB_PUSH2_COL.CHECK);
    }

    sh.getRange(WB_PUSH2_CFG.STATUS_CELL).setValue('Готово');

    WB_PUSH2_notify_(
      'WB цены',
      'Отправлено: ' + picked.length +
      '\nuploadID: ' + (uploadIds.length ? uploadIds.join(', ') : '—') +
      '\nOK / ALREADY SET (снято чекбоксов): ' + rowsToUncheck.length +
      '\nОшибок WB: ' + wbErrors +
      '\nЕщё обрабатывается: ' + processing +
      '\nЖурнал: ' + WB_PUSH2_CFG.LOG_SHEET,
      WB_PUSH2_CFG.NOTICE_SECONDS
    );

  } catch (e) {
    if (sh) {
      sh.getRange(WB_PUSH2_CFG.STATUS_CELL).setValue('Ошибка');
    }
    throw e;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Обработка одной позиции отдельно
 */
function WB_PUSH2_processSingleItem_(token, item, uploadIds) {
  Utilities.sleep(WB_PUSH2_CFG.MIN_GAP_MS);

  const upload = WB_PUSH2_wbUploadTask_(token, {
    data: [{
      nmID: item.nmID,
      price: item.price,
      discount: item.discount
    }]
  });

  if (upload.alreadySet) {
    return {
      uncheck: true,
      processing: false,
      wbError: false,
      status: 'ALREADY SET | цена и скидка уже установлены'
    };
  }

  const uploadID = upload.id;
  uploadIds.push(uploadID);

  const state = WB_PUSH2_wbWaitProcessed_(token, uploadID);

  if (!state) {
    return {
      uncheck: false,
      processing: true,
      wbError: false,
      status: 'UPLOADED uploadID=' + uploadID + ' | PROCESSING'
    };
  }

  const st = Number(state.status);

  if (st === 3) {
    return {
      uncheck: true,
      processing: false,
      wbError: false,
      status: 'UPLOADED uploadID=' + uploadID + ' | OK'
    };
  }

  if (st === 5 || st === 6) {
    const detail = WB_PUSH2_wbGetProcessedDetails_(token, uploadID);

    let errText = '';
    if (detail && Array.isArray(detail.historyGoods)) {
      for (let i = 0; i < detail.historyGoods.length; i++) {
        const g = detail.historyGoods[i];
        if (String(g.nmID) === String(item.nmID)) {
          errText = String(g.errorText || '').trim();
          break;
        }
      }
    }

    if (errText) {
      return {
        uncheck: false,
        processing: false,
        wbError: true,
        status: 'UPLOADED uploadID=' + uploadID + ' | ERROR: ' + WB_PUSH2_cut_(errText, 220)
      };
    }

    return {
      uncheck: true,
      processing: false,
      wbError: false,
      status: 'UPLOADED uploadID=' + uploadID + ' | OK'
    };
  }

  return {
    uncheck: false,
    processing: false,
    wbError: false,
    status: 'UPLOADED uploadID=' + uploadID + ' | STATUS=' + st
  };
}

/* ------------------ Notice ------------------ */

function WB_PUSH2_notify_(title, message, seconds) {
  const sec = Math.max(2, Number(seconds) || 5);
  const ss = SpreadsheetApp.getActive();

  // запасной вариант — toast
  try {
    ss.toast(message, title, sec);
  } catch (e) {}

  // основное окно
  try {
    const html = HtmlService.createHtmlOutput(
      '<div style="font-family:Arial, sans-serif; padding:14px 16px; width:360px;">' +
        '<div style="font-size:14px; font-weight:700; margin-bottom:8px;">' + WB_PUSH2_escapeHtml_(title) + '</div>' +
        '<pre style="white-space:pre-wrap; font-size:12px; margin:0; line-height:1.35;">' + WB_PUSH2_escapeHtml_(message) + '</pre>' +
        '<div style="margin-top:10px; font-size:11px; opacity:0.75;">Закроется автоматически через ' + sec + ' сек.</div>' +
        '<script>setTimeout(function(){google.script.host.close();}, ' + (sec * 1000) + ');</script>' +
      '</div>'
    ).setTitle(title);

    SpreadsheetApp.getUi().showModelessDialog(html, title);
  } catch (e) {
    // если UI недоступен — просто молча остаёмся с toast
  }
}

function WB_PUSH2_escapeHtml_(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ------------------ Token & sheets ------------------ */

function WB_PUSH2_getToken_() {
  const ss = SpreadsheetApp.getActive();
  const keySh = ss.getSheetByName(WB_PUSH2_CFG.KEY_SHEET);
  if (!keySh) throw new Error('Лист KEY не найден');

  const token = String(keySh.getRange(WB_PUSH2_CFG.TOKEN_CELL).getValue()).trim();
  if (!token) throw new Error('KEY!' + WB_PUSH2_CFG.TOKEN_CELL + ' пустой (токен не задан)');
  return token;
}

function WB_PUSH2_getOrCreateLogSheet_(ss) {
  let sh = ss.getSheetByName(WB_PUSH2_CFG.LOG_SHEET);
  if (!sh) sh = ss.insertSheet(WB_PUSH2_CFG.LOG_SHEET);

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, WB_PUSH2_CFG.LOG_HEADERS.length).setValues([WB_PUSH2_CFG.LOG_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function WB_PUSH2_appendLog_(logSh, rows) {
  if (!rows || !rows.length) return;
  const startRow = logSh.getLastRow() + 1;
  logSh.getRange(startRow, 1, rows.length, WB_PUSH2_CFG.LOG_HEADERS.length).setValues(rows);
}

/* ------------------ WB API ------------------ */

function WB_PUSH2_wbUploadTask_(token, payloadObj) {
  const url = WB_PUSH2_CFG.API_BASE + WB_PUSH2_CFG.ENDPOINT_UPLOAD;

  const resp = WB_PUSH2_fetchWithRetry_(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: { Authorization: token },
    payload: JSON.stringify(payloadObj)
  }, 'upload/task');

  const code = resp.getResponseCode();
  const text = resp.getContentText();
  const json = WB_PUSH2_safeJson_(text);
  const errorText = String(json?.errorText || text || '').trim();

  if (code === 400 && /already set/i.test(errorText)) {
    return {
      id: null,
      alreadySet: true,
      alreadyExists: false
    };
  }

  if (code !== 200 && code !== 208) {
    throw new Error('WB upload/task error HTTP ' + code + ': ' + text);
  }
  if (json && json.error) {
    throw new Error('WB upload/task error: ' + (json.errorText || text));
  }

  const id = json?.data?.id;
  if (id === undefined || id === null) {
    throw new Error('WB upload/task: не найден data.id в ответе: ' + text);
  }

  return {
    id: Number(id),
    alreadySet: false,
    alreadyExists: Boolean(json?.data?.alreadyExists)
  };
}

function WB_PUSH2_wbWaitProcessed_(token, uploadID) {
  for (let i = 0; i < WB_PUSH2_CFG.POLL_TRIES; i++) {
    Utilities.sleep(WB_PUSH2_CFG.POLL_SLEEP_MS);

    Utilities.sleep(WB_PUSH2_CFG.MIN_GAP_MS);
    const hist = WB_PUSH2_wbGetState_(token, WB_PUSH2_CFG.ENDPOINT_HISTORY_STATE, uploadID);
    if (hist && hist.status !== undefined && hist.status !== null) {
      const st = Number(hist.status);
      if (st === 3 || st === 4 || st === 5 || st === 6) return hist;
    }

    Utilities.sleep(WB_PUSH2_CFG.MIN_GAP_MS);
    const buf = WB_PUSH2_wbGetState_(token, WB_PUSH2_CFG.ENDPOINT_BUFFER_STATE, uploadID);
    if (buf && Number(buf.status) === 1) continue;
  }
  return null;
}

function WB_PUSH2_wbGetState_(token, endpoint, uploadID) {
  const url = WB_PUSH2_CFG.API_BASE + endpoint + '?uploadID=' + encodeURIComponent(uploadID);

  const resp = WB_PUSH2_fetchWithRetry_(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: token }
  }, 'state ' + endpoint);

  const code = resp.getResponseCode();
  if (code !== 200) return null;

  const json = WB_PUSH2_safeJson_(resp.getContentText());
  if (!json || json.error) return null;
  return json.data || null;
}

function WB_PUSH2_wbGetProcessedDetails_(token, uploadID) {
  const url = WB_PUSH2_CFG.API_BASE + WB_PUSH2_CFG.ENDPOINT_HISTORY_GOODS +
    '?uploadID=' + encodeURIComponent(uploadID) +
    '&limit=1000&offset=0';

  const resp = WB_PUSH2_fetchWithRetry_(url, {
    method: 'get',
    muteHttpExceptions: true,
    headers: { Authorization: token }
  }, 'history/goods/task');

  if (resp.getResponseCode() !== 200) return null;
  const json = WB_PUSH2_safeJson_(resp.getContentText());
  return json?.data || null;
}

/* ------------------ HTTP retry / ratelimit ------------------ */

function WB_PUSH2_fetchWithRetry_(url, options, label) {
  const max429 = WB_PUSH2_CFG.RETRY_429_MAX_TRIES;
  const max5xx = WB_PUSH2_CFG.RETRY_5XX_MAX_TRIES;
  const baseSleep = WB_PUSH2_CFG.RETRY_BASE_SLEEP_MS;

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
      '[WB %s] code=%s, remaining=%s, retry=%s, reset=%s, body=%s',
      label || 'request',
      code,
      remaining,
      retryHeader,
      reset,
      WB_PUSH2_cut_(text, 500)
    );

    if (code !== 429 && !(code >= 500 && code <= 504)) {
      Utilities.sleep(WB_PUSH2_CFG.RETRY_SUCCESS_PAUSE_MS);
      return resp;
    }

    if (code === 429) {
      tries429++;
      if (tries429 > max429) {
        throw new Error('WB 429: превышен лимит повторов в ' + (label || 'request') + ': ' + text);
      }

      let sleepMs = 0;
      const retrySec = Number(retryHeader);

      if (isFinite(retrySec) && retrySec > 0) {
        sleepMs = retrySec * 1000 + 500;
      } else {
        sleepMs = baseSleep * Math.pow(2, tries429 - 1);
      }

      sleepMs = Math.min(sleepMs, 60000);
      Logger.log('[WB %s] 429 retry #%s, sleep=%s ms', label || 'request', tries429, sleepMs);
      Utilities.sleep(sleepMs);
      continue;
    }

    if (code >= 500 && code <= 504) {
      tries5xx++;
      if (tries5xx > max5xx) {
        throw new Error('WB ' + code + ': превышен лимит повторов в ' + (label || 'request') + ': ' + text);
      }

      const sleepMs = Math.min(baseSleep * Math.pow(2, tries5xx - 1), 30000);
      Logger.log('[WB %s] %s retry #%s, sleep=%s ms', label || 'request', code, tries5xx, sleepMs);
      Utilities.sleep(sleepMs);
      continue;
    }
  }
}

/* ------------------ Helpers ------------------ */

function WB_PUSH2_pickInt_(a, b) {
  const x = WB_PUSH2_toNumberOrEmpty_(a);
  if (x !== '') return Math.round(x);
  const y = WB_PUSH2_toNumberOrEmpty_(b);
  return (y === '') ? '' : Math.round(y);
}

function WB_PUSH2_pickNum_(a, b) {
  const x = WB_PUSH2_toNumberOrEmpty_(a);
  if (x !== '') return x;
  return WB_PUSH2_toNumberOrEmpty_(b);
}

function WB_PUSH2_toNumberOrEmpty_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

function WB_PUSH2_safeJson_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function WB_PUSH2_chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function WB_PUSH2_cut_(s, maxLen) {
  const t = String(s || '');
  return (t.length <= maxLen) ? t : (t.slice(0, maxLen - 1) + '…');
}

function WB_PUSH2_uncheckRows_(sh, rows, col) {
  const sorted = rows
    .map(r => Number(r))
    .filter(r => isFinite(r))
    .sort((a, b) => a - b);

  let start = null;
  let prev = null;

  function flush_(a, b) {
    const len = b - a + 1;
    sh.getRange(a, col, len, 1).setValues(new Array(len).fill([false]));
  }

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (start === null) { start = r; prev = r; continue; }
    if (r === prev + 1) { prev = r; continue; }
    flush_(start, prev);
    start = r; prev = r;
  }
  if (start !== null) flush_(start, prev);
}