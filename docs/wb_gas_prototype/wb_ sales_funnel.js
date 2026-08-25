/************ CONFIG ************/
const CONFIG = {
  // Листы
  MAIN_SHEET: 'Лист1',
  KEY_SHEET: 'KEY',

  // Где что лежит
  API_KEY_CELL: 'B2',
  NMIDS_RANGE: 'C2:C',
  UNLOADED_RANGE: 'D2:D',

  // Основной endpoint (Variant A)
  API_URL_HISTORY: 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products/history',

  // Архивный endpoint (для старых дат)
  API_URL_PRODUCTS: 'https://seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products',

  TIMEZONE: 'Europe/Moscow',

  // Лимиты history
  HISTORY_BATCH_SIZE: 20,                 // WB max 20 для /history (иначе 400 too many nmIds)
  MAX_BATCHES_PER_RUN: 8,                // чтобы не упираться в лимит времени Apps Script
  SLEEP_BETWEEN_BATCH_MS: 10000,         // 10 сек между батчами (плюс backoff при 429)

  // 429 retries
  MAX_RETRIES_429: 6,
  RETRY_429_BASE_MS: 10000,              // 10s, 20s, 30s...

  // Логи
  LOG_ONLY_ERRORS: true,                 // true = логируем только ошибки + финальный итог

  // Опционально: пропускать строки с 0 заказов (но тогда “полнота” по nmId будет страдать)
  SKIP_ZERO_ORDERS: false
};

/************ PUBLIC: MAIN ENTRY (Variant A) ************/
function loadWBAnalytics_VariantA() {
  const ss = SpreadsheetApp.getActive();
  const sheet = mustGetSheet_(ss, CONFIG.MAIN_SHEET);
  const keySheet = mustGetSheet_(ss, CONFIG.KEY_SHEET);

  const apiKey = String(keySheet.getRange(CONFIG.API_KEY_CELL).getValue() || '').trim();
  if (!apiKey) throw new Error('KEY!B2 пуст — вставь токен Analytics.');

  const period = getPeriodFromSheet_(sheet); // yyyy-MM-dd
  logInfo_(`📅 Период: ${period.start} → ${period.end}`);

  ensureHeader_(sheet);

  // 1) Берём незагруженные из KEY!D2:D если есть, иначе KEY!C2:C
  const nmIdsFromD = getNmIdsFromRange_(keySheet, CONFIG.UNLOADED_RANGE);
  const nmIdsSource = nmIdsFromD.length ? nmIdsFromD : getNmIdsFromRange_(keySheet, CONFIG.NMIDS_RANGE);

  if (!nmIdsSource.length) {
    logInfo_('⚠️ nmIds пусты (KEY!C2:C и KEY!D2:D).');
    return;
  }

  // Уже записанные (за эту дату) — чтобы НЕ дублировать и чтобы понимать “что осталось”
  const existingSet = getExistingKeysForDate_(sheet, period.start); // key = date|nmId
  const alreadyLoadedNmIds = new Set();
  existingSet.forEach(k => {
    const parts = k.split('|');
    alreadyLoadedNmIds.add(Number(parts[1]));
  });

  const nmIdsToLoad = nmIdsSource.filter(id => !alreadyLoadedNmIds.has(id));

  logInfo_(`🧾 nmIds вход: ${nmIdsSource.length}, уже есть: ${alreadyLoadedNmIds.size}, осталось: ${nmIdsToLoad.length}`);

  if (!nmIdsToLoad.length) {
    clearRange_(keySheet, CONFIG.UNLOADED_RANGE);     // только D2:D
    removeRetryTrigger_();
    logInfo_('✅ Всё уже загружено.');
    return;
  }

  // Готовим батчи
  const batches = chunk_(nmIdsToLoad, CONFIG.HISTORY_BATCH_SIZE);

  // Ограничиваем число батчей за один запуск, чтобы не умирать по времени
  const batchesThisRun = batches.slice(0, CONFIG.MAX_BATCHES_PER_RUN);

  const processedNmIds = new Set(); // что точно обработали в этом запуске (успешный 200)
  const failedNmIds = [];           // что не смогли (ошибка/429 после всех попыток)

  for (let b = 0; b < batchesThisRun.length; b++) {
    const batch = batchesThisRun[b];

    const res = fetchHistoryBatch_(apiKey, batch, period);
    if (res.ok) {
      // пишем
      const wrote = writeHistoryRows_(sheet, res.data, period.start, existingSet);
      // отмечаем обработанные nmIds (даже если строка не записалась из-за дубля)
      (res.processedNmIds || []).forEach(id => processedNmIds.add(id));
      // пауза между батчами
      Utilities.sleep(CONFIG.SLEEP_BETWEEN_BATCH_MS);
    } else {
      failedNmIds.push(...batch);
      // пауза тоже делаем, чтобы не долбить API
      Utilities.sleep(CONFIG.SLEEP_BETWEEN_BATCH_MS);
    }
  }

  // Остаток = (не обработали в этом запуске) + (ошибочные батчи)
  const stillMissing = nmIdsToLoad.filter(id => !processedNmIds.has(id));
  const unloaded = uniq_(stillMissing.concat(failedNmIds));

  // Записываем незагруженные в KEY!D2:D (и только туда), ключ не трогаем
  writeUnloaded_(keySheet, unloaded);

  if (unloaded.length) {
    logInfo_(`🔁 Осталось ${unloaded.length} nmId — будет дозагрузка (trigger).`);
    ensureRetryTrigger_();
  } else {
    logInfo_('✅ Полная выгрузка завершена.');
    clearRange_(keySheet, CONFIG.UNLOADED_RANGE);
    removeRetryTrigger_();
  }
}

/************ PUBLIC: ARCHIVE (старые даты) ************/
/**
 * Для старых дат (когда /history отвечает 400 "excess limit on days").
 * Endpoint: POST /api/analytics/v3/sales-funnel/products
 * По документации: до 365 дней и nmIds до 1000 за запрос + limit/offset. :contentReference[oaicite:1]{index=1}
 */
function loadWBAnalytics_ArchiveProducts() {
  const ss = SpreadsheetApp.getActive();
  const sheet = mustGetSheet_(ss, CONFIG.MAIN_SHEET);
  const keySheet = mustGetSheet_(ss, CONFIG.KEY_SHEET);

  const apiKey = String(keySheet.getRange(CONFIG.API_KEY_CELL).getValue() || '').trim();
  if (!apiKey) throw new Error('KEY!B2 пуст — вставь токен Analytics.');

  const period = getPeriodFromSheet_(sheet); // yyyy-MM-dd (обычно один день)
  logInfo_(`📅 Архивный период: ${period.start} → ${period.end}`);

  ensureHeader_(sheet);

  // Берём nmIds из KEY!C2:C (для архива обычно достаточно)
  const nmIds = getNmIdsFromRange_(keySheet, CONFIG.NMIDS_RANGE);
  if (!nmIds.length) throw new Error('KEY!C2:C пуст (nmIds).');

  // Для /products нужен pastPeriod (раньше selected), иначе ловили 400.
  const past = shiftDate_(period.start, -1); // -1 день

  const payloadBase = {
    selectedPeriod: { start: period.start, end: period.end },
    pastPeriod: { start: past, end: past },
    nmIds: nmIds,               // можно [] чтобы “все товары”, но тогда нужна пагинация по всему каталогу
    brandNames: [],
    subjectIds: [],
    tagIds: [],
    skipDeletedNm: true,
    orderBy: { field: 'openCard', mode: 'asc' },
    limit: 1000,
    offset: 0
  };

  // Пагинация (на всякий случай): пока возвращаются продукты
  const existingSet = getExistingKeysForDate_(sheet, period.start);
  let offset = 0;
  let totalWrote = 0;

  while (true) {
    const payload = Object.assign({}, payloadBase, { offset: offset });

    const resp = fetchJson_(CONFIG.API_URL_PRODUCTS, apiKey, payload);
    if (!resp.ok) throw new Error(`Archive /products HTTP ${resp.code}: ${resp.text}`);

    const json = resp.json || {};
    const products = (((json.data || {}).products) || []);

    if (!products.length) break;

    totalWrote += writeProductsRows_(sheet, products, period.start, existingSet);

    // Если вернулось меньше лимита — конец
    if (products.length < payloadBase.limit) break;

    offset += payloadBase.limit;

    // лимит у /products очень жёсткий: 3 req/min per seller (см. doc). :contentReference[oaicite:2]{index=2}
    Utilities.sleep(21000); // ~1 запрос / 21 сек, чтобы меньше ловить 429
  }

  logInfo_(`✅ Архивная выгрузка завершена. Записано строк: ${totalWrote}`);
}

/************ API: HISTORY ************/
function fetchHistoryBatch_(apiKey, nmIds, period) {
  const payload = {
    selectedPeriod: { start: period.start, end: period.end },
    nmIds: nmIds,
    aggregationLevel: 'day',
    skipDeletedNm: true
  };

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES_429; attempt++) {
    const resp = UrlFetchApp.fetch(CONFIG.API_URL_HISTORY, {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code === 200) {
      const data = safeJsonParse_(text);
      // history возвращает массив
      const arr = Array.isArray(data) ? data : [];
      const processed = arr.map(x => Number((x.product || {}).nmId)).filter(Boolean);

      return { ok: true, data: arr, processedNmIds: processed };
    }

    if (code === 429) {
      if (!CONFIG.LOG_ONLY_ERRORS) Logger.log(`⏳ 429 — backoff attempt ${attempt}/${CONFIG.MAX_RETRIES_429}`);
      Utilities.sleep(CONFIG.RETRY_429_BASE_MS * attempt);
      continue;
    }

    // Если это “excess limit on days” — явно говорим использовать /products
    if (code === 400 && text && text.indexOf('excess limit on days') !== -1) {
      throw new Error(
        'WB /history не отдаёт настолько старую дату (excess limit on days). ' +
        'Для старых дат используй функцию loadWBAnalytics_ArchiveProducts() (endpoint /products).'
      );
    }

    logError_(`❌ HISTORY HTTP ${code}: ${text}`);
    return { ok: false, code: code, text: text };
  }

  logError_('❌ HISTORY: 429 after max retries');
  return { ok: false };
}

/************ API: GENERIC JSON ************/
function fetchJson_(url, apiKey, payloadObj) {
  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES_429; attempt++) {
    const resp = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      payload: JSON.stringify(payloadObj),
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code === 200) {
      return { ok: true, code: 200, text: text, json: safeJsonParse_(text) };
    }
    if (code === 429) {
      Utilities.sleep(CONFIG.RETRY_429_BASE_MS * attempt);
      continue;
    }
    return { ok: false, code: code, text: text, json: safeJsonParse_(text) };
  }
  return { ok: false, code: 429, text: '429 after retries' };
}

/************ WRITE: HEADERS ************/
function ensureHeader_(sheet) {
  // Ничего не удаляем. Если строка 2 пустая — ставим заголовки.
  const headerRow = 2;
  const values = sheet.getRange(headerRow, 1, 1, 9).getValues()[0];
  const isEmpty = values.every(v => String(v || '').trim() === '');

  if (isEmpty) {
    sheet.getRange(headerRow, 1, 1, 9).setValues([[
      'Дата',
      'nmId',
      'Артикул продавца',
      'Бренд',
      'Категория (предмет)',
      'Просмотры карточки',
      'Добавления в корзину',
      'Заказы',
      'Сумма заказов, ₽'
    ]]);
  }
}

/************ WRITE: HISTORY ROWS ************/
function writeHistoryRows_(sheet, dataArr, dateStr, existingSet) {
  if (!Array.isArray(dataArr) || !dataArr.length) return 0;

  const rows = [];

  dataArr.forEach(item => {
    const product = item.product || {};
    const h = (item.history && item.history[0]) ? item.history[0] : null;
    if (!h) return;

    if (CONFIG.SKIP_ZERO_ORDERS && (!h.orderCount || h.orderCount === 0)) return;

    const nmId = Number(product.nmId || 0);
    if (!nmId) return;

    const key = `${dateStr}|${nmId}`;
    if (existingSet.has(key)) return; // не дублируем

    rows.push([
      dateStr,
      nmId,
      product.vendorCode || '',
      product.brandName || '',
      product.subjectName || '',
      Number(h.openCount || 0),
      Number(h.cartCount || 0),
      Number(h.orderCount || 0),
      Number(h.orderSum || 0)
    ]);

    existingSet.add(key);
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  }
  return rows.length;
}

/************ WRITE: PRODUCTS ROWS (ARCHIVE) ************/
function writeProductsRows_(sheet, productsArr, dateStr, existingSet) {
  if (!Array.isArray(productsArr) || !productsArr.length) return 0;

  const rows = [];

  productsArr.forEach(p => {
    const product = (p.product || {});
    const stat = ((p.statistic || {}).selected) || {}; // выбранный период
    const nmId = Number(product.nmId || 0);
    if (!nmId) return;

    // Если период = один день, берём итоговые метрики из selected
    const key = `${dateStr}|${nmId}`;
    if (existingSet.has(key)) return;

    if (CONFIG.SKIP_ZERO_ORDERS && (!stat.orderCount || stat.orderCount === 0)) return;

    rows.push([
      dateStr,
      nmId,
      product.vendorCode || '',
      product.brandName || '',
      product.subjectName || '',
      Number(stat.openCount || 0),
      Number(stat.cartCount || 0),
      Number(stat.orderCount || 0),
      Number(stat.orderSum || 0)
    ]);

    existingSet.add(key);
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 9).setValues(rows);
  }
  return rows.length;
}

/************ PROGRESS (KEY!D2:D) ************/
function writeUnloaded_(keySheet, nmIds) {
  // ВАЖНО: чистим только D2:D, НЕ ТРОГАЕМ ключи
  clearRange_(keySheet, CONFIG.UNLOADED_RANGE);

  if (!nmIds || !nmIds.length) return;

  const col = keySheet.getRange(CONFIG.UNLOADED_RANGE).getColumn();
  const startRow = 2;
  const values = nmIds.map(id => [id]);
  keySheet.getRange(startRow, col, values.length, 1).setValues(values);
}

/************ EXISTING KEYS ************/
function getExistingKeysForDate_(sheet, dateStr) {
  const set = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) return set;

  const data = sheet.getRange(3, 1, lastRow - 2, 2).getValues(); // A:date, B:nmId
  data.forEach(r => {
    const d = String(r[0] || '').trim();
    const nm = Number(r[1] || 0);
    if (d === dateStr && nm) set.add(`${dateStr}|${nm}`);
  });

  return set;
}

/************ DATES: железобетонно ************/
function getPeriodFromSheet_(sheet) {
  const c = sheet.getRange('C1');
  const d = sheet.getRange('D1');

  const start = normalizeAnyDate_(c);
  const end = normalizeAnyDate_(d);

  return { start: start, end: end };
}

function normalizeAnyDate_(range) {
  // 1) если это Date (в т.ч. формула =СЕГОДНЯ()-1) — getValue() вернёт Date
  const v = range.getValue();
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  // 2) пробуем displayValue (например "24.12.2025")
  const s = String(range.getDisplayValue() || '').trim();
  if (!s) throw new Error('Пустая дата в ' + range.getA1Notation());

  // вырезаем время если есть
  const cleaned = s.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?.*$/, '').trim();

  // dd.MM.yyyy
  let m = cleaned.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return Utilities.formatDate(dt, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  // yyyy-MM-dd
  m = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Utilities.formatDate(dt, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  // fallback
  const dt2 = new Date(cleaned);
  if (!isNaN(dt2.getTime())) {
    return Utilities.formatDate(dt2, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }

  throw new Error(`Невозможно распознать дату в ${range.getA1Notation()}: "${s}"`);
}

function shiftDate_(yyyy_mm_dd, deltaDays) {
  const parts = yyyy_mm_dd.split('-').map(Number);
  const dt = new Date(parts[0], parts[1] - 1, parts[2]);
  dt.setDate(dt.getDate() + deltaDays);
  return Utilities.formatDate(dt, CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

/************ NMIDS ************/
function getNmIdsFromRange_(sheet, a1) {
  const vals = sheet.getRange(a1).getValues().flat();
  return vals
    .map(v => String(v || '').trim())
    .filter(s => s !== '')
    .map(s => Number(s))
    .filter(n => Number.isFinite(n) && n > 0);
}

/************ TRIGGERS ************/
function setupDailyTrigger() {
  // Удалим старые daily-триггеры этой же функции, чтобы не плодить
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'loadWBAnalytics_VariantA' && t.getEventType && String(t.getEventType()) === 'CLOCK') {
      // не удаляем retry, удаляем только те, что не everyMinutes(15) - простая эвристика не доступна напрямую
      // поэтому удаляем ВСЕ триггеры на loadWBAnalytics_VariantA, а потом создадим заново daily+retry по необходимости
      ScriptApp.deleteTrigger(t);
    }
  });

  // Daily 08:00 MSK
  ScriptApp.newTrigger('loadWBAnalytics_VariantA')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .inTimezone(CONFIG.TIMEZONE)
    .create();

  // retry НЕ создаём тут принудительно — он создаётся автоматически, если есть незагруженные
  Logger.log('✅ Daily trigger создан: каждый день в 08:00 (Europe/Moscow).');
}

function ensureRetryTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some(t => t.getHandlerFunction() === 'loadWBAnalytics_VariantA' && String(t.getEventType()) === 'CLOCK');
  if (exists) return;

  ScriptApp.newTrigger('loadWBAnalytics_VariantA')
    .timeBased()
    .everyMinutes(15)
    .create();
}

function removeRetryTrigger_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'loadWBAnalytics_VariantA' && String(t.getEventType()) === 'CLOCK') {
      // удаляем все time-based на эту функцию (и daily, и retry) — но daily нам нужен.
      // поэтому: удалять здесь НЕ будем. Вместо этого сделаем отдельную “очистку retry” на уровне логики:
      // retry будет “лишним” только если D пуст, но daily нужен.
      // => оставим как есть, иначе можно случайно снести daily.
    }
  });
}

/**
 * Если хочешь “чисто” управлять daily+retry:
 * 1) запускай setupDailyTrigger() один раз вручную
 * 2) retry будет создаваться/не создаваться по наличию незагруженных
 * Важно: Apps Script не даёт отличить daily от retry по API, поэтому мы daily не трогаем автоматически.
 * Если нужно — напишу версию с хранением triggerId в Properties.
 */
function removeAllTimeTriggersForVariantA_MANUAL() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'loadWBAnalytics_VariantA') ScriptApp.deleteTrigger(t);
  });
  Logger.log('🧹 Удалены все триггеры loadWBAnalytics_VariantA.');
}

/************ UTILS ************/
function chunk_(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function uniq_(arr) {
  const s = new Set();
  const out = [];
  (arr || []).forEach(v => {
    const n = Number(v);
    if (!n || s.has(n)) return;
    s.add(n);
    out.push(n);
  });
  return out;
}

function safeJsonParse_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

function mustGetSheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Лист "${name}" не найден.`);
  return sh;
}

function clearRange_(sheet, a1) {
  sheet.getRange(a1).clearContent();
}

function logInfo_(msg) {
  if (CONFIG.LOG_ONLY_ERRORS) return;
  Logger.log(msg);
}

function logError_(msg) {
  Logger.log(msg);
}
/************ DEBUG CONFIG ************/
const DEBUG_CFG = {
  DEBUG_SHEET: 'DEBUG_JSON',     // сюда пишем сырой JSON + сводку
  MAX_NMIDS_DEBUG: 40,           // сколько nmId максимум гонять в дебаге (чтобы не раздувать)
  BATCH_SIZE: 20,                // WB limit 20 для /history
  LOG_RAW_TEXT_LIMIT: 3000,      // сколько символов сырого ответа логировать в Logger
  WRITE_FULL_JSON_TO_SHEET: true,// писать ли полный json в лист
  ONE_REQUEST_PER_NMID: false    // true = отдельный запрос на каждый nmId (дольше, но идеальная диагностика)
};

/************ DEBUG ENTRY ************/
function debugWBHistory() {
  const ss = SpreadsheetApp.getActive();
  const main = mustGetSheet_(ss, CONFIG.MAIN_SHEET);
  const keySheet = mustGetSheet_(ss, CONFIG.KEY_SHEET);

  const apiKey = String(keySheet.getRange(CONFIG.API_KEY_CELL).getValue() || '').trim();
  if (!apiKey) throw new Error('KEY!B2 пуст — вставь токен Analytics.');

  const period = getPeriodFromSheet_(main); // yyyy-MM-dd
  Logger.log(`🧪 DEBUG /history период: ${period.start} → ${period.end}`);

  const nmIdsAll = getNmIdsFromRange_(keySheet, CONFIG.NMIDS_RANGE);
  if (!nmIdsAll.length) throw new Error('KEY!C2:C пуст (nmIds).');

  const nmIds = nmIdsAll.slice(0, DEBUG_CFG.MAX_NMIDS_DEBUG);
  Logger.log(`🧪 DEBUG nmIds: ${nmIds.length} (из ${nmIdsAll.length}), mode one-by-one=${DEBUG_CFG.ONE_REQUEST_PER_NMID}`);

  const debugSheet = ensureDebugSheet_(ss, DEBUG_CFG.DEBUG_SHEET);
  ensureDebugHeader_(debugSheet);

  // В режиме ONE_REQUEST_PER_NMID делаем запрос на каждый nmId отдельно
  if (DEBUG_CFG.ONE_REQUEST_PER_NMID) {
    for (let i = 0; i < nmIds.length; i++) {
      const id = nmIds[i];
      const batch = [id];
      debugFetchAndWrite_(debugSheet, apiKey, batch, period);
      Utilities.sleep(1200); // маленькая пауза, чтобы не долбить API
    }
    return;
  }

  // Иначе — батчами по 20
  const batches = chunk_(nmIds, DEBUG_CFG.BATCH_SIZE);
  for (let b = 0; b < batches.length; b++) {
    debugFetchAndWrite_(debugSheet, apiKey, batches[b], period);
    Utilities.sleep(1200);
  }
}

/************ DEBUG: FETCH + WRITE ************/
function debugFetchAndWrite_(debugSheet, apiKey, nmIdsBatch, period) {
  const payload = {
    selectedPeriod: { start: period.start, end: period.end },
    nmIds: nmIdsBatch,
    aggregationLevel: 'day',
    skipDeletedNm: true
  };

  Logger.log(`\n================= DEBUG BATCH =================`);
  Logger.log(`nmIds: ${nmIdsBatch.join(', ')}`);
  Logger.log(`payload: ${JSON.stringify(payload)}`);

  const resp = UrlFetchApp.fetch(CONFIG.API_URL_HISTORY, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const text = resp.getContentText() || '';

  Logger.log(`HTTP ${code}`);
  Logger.log(`raw(text, first ${DEBUG_CFG.LOG_RAW_TEXT_LIMIT} chars):\n${text.slice(0, DEBUG_CFG.LOG_RAW_TEXT_LIMIT)}`);

  const json = safeJsonParse_(text);

  // 1) пишем в лист “сырое”
  if (DEBUG_CFG.WRITE_FULL_JSON_TO_SHEET) {
    debugSheet.appendRow([
      new Date(),
      period.start,
      period.end,
      nmIdsBatch.join(','),
      code,
      '',                 // vendorCodes (заполним ниже)
      '',                 // orders_sum
      '',                 // orders_by_nm
      '',                 // notes
      JSON.stringify(payload),
      text                // RAW RESPONSE (как есть)
    ]);
  }

  // 2) дополнительно строим сводку по каждому nmId и пишем отдельными строками
  if (code !== 200 || !Array.isArray(json)) {
    debugSheet.appendRow([
      new Date(),
      period.start,
      period.end,
      nmIdsBatch.join(','),
      code,
      '',
      '',
      '',
      `NOT OK: code=${code}, parsedArray=${Array.isArray(json)}`,
      '',
      ''
    ]);
    return;
  }

  // Соберём: по каждому nmId — суммы по всем дням history[]
  const byNm = {};
  json.forEach(item => {
    const p = item.product || {};
    const nmId = Number(p.nmId || 0);
    if (!nmId) return;

    const hist = Array.isArray(item.history) ? item.history : [];
    const agg = hist.reduce((acc, h) => {
      acc.open += Number(h.openCount || 0);
      acc.cart += Number(h.cartCount || 0);
      acc.orders += Number(h.orderCount || 0);
      acc.sum += Number(h.orderSum || 0);
      acc.days += 1;
      return acc;
    }, { open:0, cart:0, orders:0, sum:0, days:0 });

    byNm[nmId] = {
      nmId,
      vendorCode: p.vendorCode || '',
      brandName: p.brandName || '',
      subjectName: p.subjectName || '',
      days: agg.days,
      open: agg.open,
      cart: agg.cart,
      orders: agg.orders,
      sum: agg.sum,
      historyRaw: hist
    };
  });

  const nmIdsReturned = Object.keys(byNm).map(Number);
  const nmIdsMissing = nmIdsBatch.filter(id => !byNm[id]);

  // Если WB вернул не все nmIds — тоже важно
  const noteMissing = nmIdsMissing.length ? `MISSING nmIds in response: ${nmIdsMissing.join(',')}` : '';

  // Пишем сводные строки
  nmIdsReturned.forEach(nmId => {
    const r = byNm[nmId];
    debugSheet.appendRow([
      new Date(),
      period.start,
      period.end,
      nmId,
      200,
      r.vendorCode,
      r.orders,                                      // orders_sum
      `open=${r.open}; cart=${r.cart}; sum=${r.sum}; days=${r.days}`,
      noteMissing,
      '',                                            // request json (не дублируем)
      JSON.stringify(r.historyRaw)                    // history raw per nmId
    ]);
  });

  // Если кто-то не вернулся — отдельной строкой
  if (nmIdsMissing.length) {
    debugSheet.appendRow([
      new Date(),
      period.start,
      period.end,
      nmIdsMissing.join(','),
      200,
      '',
      '',
      '',
      `⚠️ WB не вернул часть nmIds (см. список)`,
      '',
      ''
    ]);
  }
}

/************ DEBUG SHEET HELPERS ************/
function ensureDebugSheet_(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function ensureDebugHeader_(sheet) {
  const headerRow = 1;
  const vals = sheet.getRange(headerRow, 1, 1, 11).getValues()[0];
  const empty = vals.every(v => String(v || '').trim() === '');
  if (!empty) return;

  sheet.getRange(headerRow, 1, 1, 11).setValues([[
    'ts',
    'period_start',
    'period_end',
    'nmId_or_batch',
    'http_code',
    'vendorCode',
    'orders_sum',
    'metrics_summary',
    'notes',
    'request_json',
    'response_raw_or_history_raw'
  ]]);
}

/************ EXISTING UTILS (используем твои) ************/
// chunk_, safeJsonParse_, mustGetSheet_, getPeriodFromSheet_, getNmIdsFromRange_
// (оставь как у тебя)

