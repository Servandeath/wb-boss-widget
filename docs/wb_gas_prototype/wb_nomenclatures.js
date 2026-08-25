/********************************************************
 * WB Content Cards Sync for 4 cabinets
 * ВЕРСИЯ: 1 строка = 1 карточка + 1 размер + 1 баркод
 *
 * Кабинеты / токены:
 *   KEY!B2 = МАНИ
 *   KEY!B3 = МИРОС
 *   KEY!B4 = Бурков
 *   KEY!B5 = Буркова
 *
 * Листы:
 *   МАНИ / МИРОС / Бурков / Буркова
 *   Техлист_характеристик
 *
 * Логика:
 * - тянет карточки через /content/v2/get/cards/list
 * - если у карточки 7 размеров, будет минимум 7 строк
 * - если у размера несколько баркодов (sizes[].skus),
 *   строка дублируется на каждый баркод
 * - строка отличается размером, chrtID и баркодом
 * - характеристики идут после Видео и Фото 1-5
 * - в рабочие листы попадают только характеристики с галочкой в техлисте
 * - техлист автоматически отмечает характеристики, которые есть
 *   во всех категориях и во всех заполненных кабинетах
 ********************************************************/

const WB_CARDS = {
  API_URL: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
  KEY_SHEET: 'KEY',
  TOKEN_RANGE: 'B2:B5',
  TECHLIST_SHEET: 'Техлист_характеристик',

  CABINETS: [
    { name: 'МАНИ',    tokenRowIndex: 0 },
    { name: 'МИРОС',   tokenRowIndex: 1 },
    { name: 'Бурков',  tokenRowIndex: 2 },
    { name: 'Буркова', tokenRowIndex: 3 }
  ],

  PAGE_LIMIT: 100,
  SLEEP_MS: 700,

  MAX_RETRIES: 5,
  RETRY_BASE_SLEEP_MS: 3000,

  MAX_PHOTOS: 5,

  PROPS_PREFIX: 'WB_CARDS_CURSOR_SIZE_ROWS_'
};

const WB_FIXED_HEADERS = [
  'Идентификатор',
  'Артикул',
  'Категория',
  'Кабинет',
  'Название',
  'Описание',
  'Дата создания',
  'Дата обновления',
  'chrtID',
  'Длина',
  'Ширина',
  'Высота',
  'Вес брутто',
  'Технические размеры',
  'Баркод',
  'Видео',
  'Фото 1',
  'Фото 2',
  'Фото 3',
  'Фото 4',
  'Фото 5'
];

const WB_TECHLIST_HEADERS = [
  'Выгружать',
  'Характеристика',
  'Авто: есть во всех категориях и кабинетах',
  'Категорий с характеристикой',
  'Всего категорий',
  'Кабинетов с характеристикой',
  'Всего кабинетов',
  'Карточек с характеристикой',
  'Всего карточек',
  'Категории',
  'Кабинеты'
];

/**
 * Меню в Google Таблице
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('WB карточки')
    .addItem('Обновить все кабинеты', 'wbSyncAllCabinets')
    .addItem('Полная перезагрузка + обновить техлист', 'wbFullReloadAllCabinets')
    .addItem('Обновить только техлист характеристик', 'wbRefreshTechListAllCabinets')
    .addSeparator()
    .addItem('Обновить МАНИ', 'wbSyncMANI')
    .addItem('Обновить МИРОС', 'wbSyncMIROS')
    .addItem('Обновить Бурков', 'wbSyncBurkov')
    .addItem('Обновить Буркова', 'wbSyncBurkova')
    .addSeparator()
    .addItem('Сбросить все курсоры', 'wbResetAllCursors')
    .addItem('Поставить триггер раз в 4 часа', 'wbSetEvery4HoursTrigger')
    .addToUi();
}

/**
 * Обычное обновление всех кабинетов по курсору.
 * Использует уже созданный техлист.
 */
function wbSyncAllCabinets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getCabinetConfigs_(ss);

  const selectedChars = getSelectedCharacteristicsFromTechList_(ss);

  if (!selectedChars.length) {
    toast_('WB карточки', 'Техлист пустой. Запускаю полную перезагрузку.');
    wbFullReloadAllCabinets();
    return;
  }

  configs.forEach(cfg => {
    try {
      if (!cfg.token) {
        Logger.log('Пропуск [' + cfg.name + ']: пустой токен');
        return;
      }

      toast_('WB карточки', 'Старт: ' + cfg.name);
      wbSyncOneCabinet_(ss, cfg, selectedChars, false);
      toast_('WB карточки', 'Готово: ' + cfg.name);
    } catch (e) {
      Logger.log('ОШИБКА [' + cfg.name + ']: ' + (e && e.stack ? e.stack : e));
      toast_('WB карточки', 'Ошибка: ' + cfg.name + '. Смотри логи.');
    }
  });
}

/**
 * Полная перезагрузка всех кабинетов.
 */
function wbFullReloadAllCabinets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getCabinetConfigs_(ss).filter(cfg => cfg.token);

  const cardsByCabinet = {};
  const cursorsByCabinet = {};

  configs.forEach(cfg => {
    try {
      toast_('WB карточки', 'Полная загрузка: ' + cfg.name);

      const result = fetchAllCardsForCabinet_(cfg, null);

      cardsByCabinet[cfg.name] = result.cards || [];
      cursorsByCabinet[cfg.name] = result.lastCursor || null;

      Logger.log('[' + cfg.name + '] Полная загрузка карточек: ' + cardsByCabinet[cfg.name].length);
    } catch (e) {
      Logger.log('ОШИБКА полной загрузки [' + cfg.name + ']: ' + (e && e.stack ? e.stack : e));
      cardsByCabinet[cfg.name] = [];
    }
  });

  buildOrUpdateTechList_(ss, cardsByCabinet);

  const selectedChars = getSelectedCharacteristicsFromTechList_(ss);

  configs.forEach(cfg => {
    try {
      writeCabinetSheet_(ss, cfg.name, cardsByCabinet[cfg.name] || [], selectedChars, true);

      const cursor = cursorsByCabinet[cfg.name];
      if (cursor && cursor.updatedAt && cursor.nmID) {
        saveCursor_(cfg.name, cursor);
      }

      toast_('WB карточки', 'Лист обновлен: ' + cfg.name);
    } catch (e) {
      Logger.log('ОШИБКА записи [' + cfg.name + ']: ' + (e && e.stack ? e.stack : e));
    }
  });

  toast_('WB карточки', 'Полная перезагрузка завершена');
}

/**
 * Только обновить техлист характеристик.
 */
function wbRefreshTechListAllCabinets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getCabinetConfigs_(ss).filter(cfg => cfg.token);

  const cardsByCabinet = {};

  configs.forEach(cfg => {
    try {
      toast_('WB карточки', 'Сканирую характеристики: ' + cfg.name);

      const result = fetchAllCardsForCabinet_(cfg, null);
      cardsByCabinet[cfg.name] = result.cards || [];
    } catch (e) {
      Logger.log('ОШИБКА техлиста [' + cfg.name + ']: ' + (e && e.stack ? e.stack : e));
      cardsByCabinet[cfg.name] = [];
    }
  });

  buildOrUpdateTechList_(ss, cardsByCabinet);

  toast_('WB карточки', 'Техлист характеристик обновлен');
}

/**
 * Ручные запуски одного кабинета
 */
function wbSyncMANI() {
  wbSyncSingleByName_('МАНИ');
}

function wbSyncMIROS() {
  wbSyncSingleByName_('МИРОС');
}

function wbSyncBurkov() {
  wbSyncSingleByName_('Бурков');
}

function wbSyncBurkova() {
  wbSyncSingleByName_('Буркова');
}

function wbSyncSingleByName_(cabinetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configs = getCabinetConfigs_(ss);
  const cfg = configs.find(x => x.name === cabinetName);

  if (!cfg) {
    throw new Error('Конфиг кабинета не найден: ' + cabinetName);
  }

  const selectedChars = getSelectedCharacteristicsFromTechList_(ss);

  if (!selectedChars.length) {
    throw new Error('Техлист пустой. Сначала запусти wbFullReloadAllCabinets или wbRefreshTechListAllCabinets.');
  }

  wbSyncOneCabinet_(ss, cfg, selectedChars, false);
}

/**
 * Обновление одного кабинета
 */
function wbSyncOneCabinet_(ss, cfg, selectedChars, fullReload) {
  if (!cfg.token) {
    Logger.log('Пропуск [' + cfg.name + ']: пустой токен');
    return;
  }

  const savedCursor = fullReload ? null : getSavedCursor_(cfg.name);
  const result = fetchAllCardsForCabinet_(cfg, savedCursor);
  const cards = result.cards || [];

  if (!cards.length) {
    Logger.log('[' + cfg.name + '] Нет новых/изменённых карточек');
    return;
  }

  writeCabinetSheet_(ss, cfg.name, cards, selectedChars, fullReload);

  if (result.lastCursor && result.lastCursor.updatedAt && result.lastCursor.nmID) {
    saveCursor_(cfg.name, result.lastCursor);
  }
}

/**
 * Получение всех карточек кабинета.
 */
function fetchAllCardsForCabinet_(cfg, savedCursor) {
  const allCards = [];
  let lastCursor = null;

  const body = {
    settings: {
      sort: {
        ascending: true
      },
      cursor: {
        limit: WB_CARDS.PAGE_LIMIT
      },
      filter: {
        withPhoto: -1
      }
    }
  };

  if (savedCursor && savedCursor.updatedAt && savedCursor.nmID) {
    body.settings.cursor.updatedAt = savedCursor.updatedAt;
    body.settings.cursor.nmID = savedCursor.nmID;
  }

  let page = 0;

  while (true) {
    const data = fetchCardsPageWithRetry_(cfg, body);

    const cards = Array.isArray(data.cards) ? data.cards : [];
    const cursor = data.cursor || {};

    if (!cards.length) {
      break;
    }

    allCards.push.apply(allCards, cards);

    lastCursor = {
      updatedAt: cursor.updatedAt || '',
      nmID: cursor.nmID || ''
    };

    page++;

    Logger.log('[' + cfg.name + '] Страница ' + page + ': ' + cards.length + ' карточек');

    const total = Number(cursor.total || 0);

    if (total < WB_CARDS.PAGE_LIMIT) {
      break;
    }

    if (!cursor.updatedAt || !cursor.nmID) {
      break;
    }

    body.settings.cursor.updatedAt = cursor.updatedAt;
    body.settings.cursor.nmID = cursor.nmID;

    Utilities.sleep(WB_CARDS.SLEEP_MS);
  }

  return {
    cards: allCards,
    lastCursor: lastCursor
  };
}

function fetchCardsPageWithRetry_(cfg, body) {
  let lastErrorText = '';

  for (let attempt = 1; attempt <= WB_CARDS.MAX_RETRIES; attempt++) {
    const resp = UrlFetchApp.fetch(WB_CARDS.API_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: {
        Authorization: cfg.token
      },
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code === 200) {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error('JSON parse error [' + cfg.name + ']: ' + e + ' | body=' + text);
      }
    }

    lastErrorText = 'HTTP ' + code + ' [' + cfg.name + ']: ' + text;

    if (code === 429 || code === 500 || code === 502 || code === 503 || code === 504) {
      const sleepMs = WB_CARDS.RETRY_BASE_SLEEP_MS * attempt;

      Logger.log(
        lastErrorText +
        ' | retry ' +
        attempt +
        '/' +
        WB_CARDS.MAX_RETRIES +
        ' через ' +
        sleepMs +
        ' мс'
      );

      Utilities.sleep(sleepMs);
      continue;
    }

    throw new Error(lastErrorText);
  }

  throw new Error(lastErrorText || ('Не удалось получить страницу карточек [' + cfg.name + ']'));
}

/**
 * Запись рабочего листа кабинета.
 */
function writeCabinetSheet_(ss, cabinetName, cards, selectedChars, replaceAll) {
  const sheet = getOrCreateSheet_(ss, cabinetName);
  const headers = getOutputHeaders_(selectedChars);

  let rowsByKey = {};
  let rowOrder = [];

  if (!replaceAll) {
    const existing = readExistingTable_(sheet);
    rowsByKey = existing.rowsByKey;
    rowOrder = existing.rowOrder;
  }

  cards.forEach(card => {
    const nmID = String(card.nmID || '').trim();

    if (!nmID) {
      return;
    }

    // Если карточка обновилась, удаляем все старые строки этого nmID,
    // потому что размеры и баркоды могли измениться или добавиться.
    rowOrder = removeExistingRowsForNmId_(rowsByKey, rowOrder, nmID);

    const rowObjects = buildRowObjectsForCard_(card, cabinetName, selectedChars);

    rowObjects.forEach(rowObj => {
      const rowKey = makeSizeRowKeyFromObj_(rowObj);

      if (!rowsByKey[rowKey]) {
        rowOrder.push(rowKey);
      }

      rowsByKey[rowKey] = rowObj;
    });
  });

  const outputRows = rowOrder
    .filter(rowKey => rowsByKey[rowKey])
    .map(rowKey => headers.map(h => valueOrBlank_(rowsByKey[rowKey][h])));

  writeTable_(sheet, headers, outputRows);
  formatCabinetSheet_(sheet, headers, outputRows.length);
}

/**
 * Создаем строки карточки.
 * Размеры x баркоды.
 * Если у карточки 7 размеров и у одного из них 2 баркода — вернет 8 строк.
 */
function buildRowObjectsForCard_(prod, cabinetName, selectedChars) {
  const sizes = Array.isArray(prod.sizes) && prod.sizes.length
    ? prod.sizes
    : [{}];

  const rows = [];

  sizes.forEach(sizeObjRaw => {
    const sizeObj = sizeObjRaw || {};
    const barcodes = getSizeBarcodes_(sizeObj);

    barcodes.forEach(barcode => {
      rows.push(buildRowObjectForSize_(prod, cabinetName, selectedChars, sizeObj, barcode));
    });
  });

  return rows;
}

/**
 * Баркоды одного размера.
 * Всегда возвращает минимум один элемент, чтобы размер без баркода
 * не пропал из таблицы.
 */
function getSizeBarcodes_(sizeObj) {
  const raw = Array.isArray(sizeObj.skus) ? sizeObj.skus : [];

  const list = [];
  const seen = {};

  raw.forEach(sku => {
    const s = cleanText_(sku);

    if (!s || seen[s]) {
      return;
    }

    seen[s] = true;
    list.push(s);
  });

  return list.length ? list : [''];
}

/**
 * Строка карточки по одному размеру и одному баркоду.
 */
function buildRowObjectForSize_(prod, cabinetName, selectedChars, sizeObj, barcode) {
  const obj = {};
  const d = prod.dimensions || {};

  obj['Идентификатор'] = prod.nmID || '';
  obj['Артикул'] = prod.vendorCode || '';
  obj['Категория'] = prod.subjectName || '';
  obj['Кабинет'] = cabinetName;
  obj['Название'] = prod.title || '';
  obj['Описание'] = prod.description || '';
  obj['Дата создания'] = prod.createdAt || '';
  obj['Дата обновления'] = prod.updatedAt || '';

  obj['chrtID'] = sizeObj.chrtID != null ? sizeObj.chrtID : '';

  obj['Длина'] = d.length != null ? d.length : '';
  obj['Ширина'] = d.width != null ? d.width : '';
  obj['Высота'] = d.height != null ? d.height : '';
  obj['Вес брутто'] = d.weightBrutto != null ? d.weightBrutto : '';

  obj['Технические размеры'] = sizeObj.techSize || '';

  // Баркод пишем текстом, иначе Таблицы превратят его в число
  // и потеряют ведущие нули / уйдут в экспоненту.
  obj['Баркод'] = barcode ? "'" + barcode : '';

  const videoUrl = getVideoUrl_(prod.video);

  obj['Видео'] = videoUrl
    ? '=HYPERLINK("' + escapeFormulaString_(videoUrl) + '";"🎥")'
    : '';

  const photoUrls = getPhotoUrls_(prod.photos);

  for (let i = 1; i <= WB_CARDS.MAX_PHOTOS; i++) {
    const url = photoUrls[i - 1] || '';

    obj['Фото ' + i] = url
      ? '=IMAGE("' + escapeFormulaString_(url) + '")'
      : '';
  }

  const charMap = getCardCharacteristicsMap_(prod);

  selectedChars.forEach(name => {
    obj[name] = charMap[name] || '';
  });

  return obj;
}

/**
 * Удаляем из существующей таблицы все строки конкретного nmID.
 */
function removeExistingRowsForNmId_(rowsByKey, rowOrder, nmID) {
  const newOrder = [];

  rowOrder.forEach(rowKey => {
    const rowObj = rowsByKey[rowKey];

    if (!rowObj) {
      return;
    }

    const currentNmID = String(rowObj['Идентификатор'] || '').trim();

    if (currentNmID === String(nmID).trim()) {
      delete rowsByKey[rowKey];
    } else {
      newOrder.push(rowKey);
    }
  });

  return newOrder;
}

/**
 * Ключ строки:
 * nmID + chrtID + технический размер + баркод.
 */
function makeSizeRowKeyFromObj_(obj) {
  const nmID = cleanText_(obj['Идентификатор']);
  const chrtID = cleanText_(obj['chrtID']);
  const techSize = cleanText_(obj['Технические размеры']);
  const barcode = normalizeBarcodeKey_(obj['Баркод']);

  return [nmID, chrtID, techSize, barcode].join('||');
}

/**
 * Убираем ведущий апостроф текстового формата,
 * чтобы ключи строк из листа и из API совпадали.
 */
function normalizeBarcodeKey_(v) {
  return cleanText_(v).replace(/^'/, '');
}

/**
 * Создание / обновление техлиста характеристик
 */
function buildOrUpdateTechList_(ss, cardsByCabinet) {
  const sheet = getOrCreateSheet_(ss, WB_CARDS.TECHLIST_SHEET);

  const previousSelection = readPreviousTechListSelection_(sheet);
  const stats = collectCharacteristicStats_(cardsByCabinet);

  const existingOrder = readPreviousTechListOrder_(sheet);
  const orderMap = {};

  existingOrder.forEach((name, index) => {
    orderMap[name] = index;
  });

  const names = Object.keys(stats.byName);

  names.sort((a, b) => {
    const ai = orderMap[a];
    const bi = orderMap[b];

    const aKnown = ai !== undefined;
    const bKnown = bi !== undefined;

    if (aKnown && bKnown) return ai - bi;
    if (aKnown) return -1;
    if (bKnown) return 1;

    const aa = isAutoMainCharacteristic_(stats.byName[a], stats);
    const bb = isAutoMainCharacteristic_(stats.byName[b], stats);

    if (aa !== bb) return aa ? -1 : 1;

    return a.localeCompare(b, 'ru');
  });

  const rows = names.map(name => {
    const st = stats.byName[name];
    const autoMain = isAutoMainCharacteristic_(st, stats);

    const selected = previousSelection.hasOwnProperty(name)
      ? previousSelection[name]
      : autoMain;

    return [
      Boolean(selected),
      name,
      autoMain ? 'Да' : 'Нет',
      st.categories.size,
      stats.totalCategories,
      st.cabinets.size,
      stats.totalCabinets,
      st.cardsCount,
      stats.totalCards,
      Array.from(st.categories).sort().join(', '),
      Array.from(st.cabinets).sort().join(', ')
    ];
  });

  writeTable_(sheet, WB_TECHLIST_HEADERS, rows);
  formatTechListSheet_(sheet, rows.length);
}

function collectCharacteristicStats_(cardsByCabinet) {
  const byName = {};
  const allCategories = {};
  const allCabinets = {};

  let totalCards = 0;

  Object.keys(cardsByCabinet || {}).forEach(cabinetName => {
    const cards = cardsByCabinet[cabinetName] || [];

    if (cards.length) {
      allCabinets[cabinetName] = true;
    }

    cards.forEach(card => {
      totalCards++;

      const category = cleanText_(card.subjectName) || 'Без категории';
      allCategories[category] = true;

      const charMap = getCardCharacteristicsMap_(card);

      Object.keys(charMap).forEach(name => {
        if (!byName[name]) {
          byName[name] = {
            categories: new Set(),
            cabinets: new Set(),
            cardsCount: 0
          };
        }

        byName[name].categories.add(category);
        byName[name].cabinets.add(cabinetName);
        byName[name].cardsCount++;
      });
    });
  });

  return {
    byName: byName,
    totalCategories: Object.keys(allCategories).length,
    totalCabinets: Object.keys(allCabinets).length,
    totalCards: totalCards
  };
}

function isAutoMainCharacteristic_(st, stats) {
  if (!st) return false;
  if (!stats.totalCategories || !stats.totalCabinets) return false;

  return (
    st.categories.size === stats.totalCategories &&
    st.cabinets.size === stats.totalCabinets
  );
}

/**
 * Берем характеристики с галочкой из техлиста
 */
function getSelectedCharacteristicsFromTechList_(ss) {
  const sheet = ss.getSheetByName(WB_CARDS.TECHLIST_SHEET);

  if (!sheet) {
    return [];
  }

  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const out = [];

  values.forEach(row => {
    const selected = isTruthy_(row[0]);
    const name = cleanText_(row[1]);

    if (selected && name) {
      out.push(name);
    }
  });

  return out;
}

function readPreviousTechListSelection_(sheet) {
  const map = {};
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return map;
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

  values.forEach(row => {
    const name = cleanText_(row[1]);

    if (!name) {
      return;
    }

    map[name] = isTruthy_(row[0]);
  });

  return map;
}

function readPreviousTechListOrder_(sheet) {
  const out = [];
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return out;
  }

  const values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();

  values.forEach(row => {
    const name = cleanText_(row[0]);

    if (name) {
      out.push(name);
    }
  });

  return out;
}

/**
 * Карта характеристик конкретной карточки
 */
function getCardCharacteristicsMap_(prod) {
  const map = {};
  const characteristics = Array.isArray(prod.characteristics)
    ? prod.characteristics
    : [];

  characteristics.forEach(ch => {
    const name = cleanText_(ch && ch.name);

    if (!name) {
      return;
    }

    const value = formatCharacteristicValue_(ch.value);

    if (value === '') {
      return;
    }

    if (map[name]) {
      map[name] = joinUniqueText_([map[name], value], ', ');
    } else {
      map[name] = value;
    }
  });

  return map;
}

function getOutputHeaders_(selectedChars) {
  const headers = WB_FIXED_HEADERS.slice();
  const seen = {};

  headers.forEach(h => {
    seen[h] = true;
  });

  (selectedChars || []).forEach(name => {
    name = cleanText_(name);

    if (!name || seen[name]) {
      return;
    }

    seen[name] = true;
    headers.push(name);
  });

  return headers;
}

/**
 * Чтение существующего рабочего листа.
 */
function readExistingTable_(sheet) {
  const result = {
    rowsByKey: {},
    rowOrder: []
  };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  if (lastRow < 2 || lastCol < 1) {
    return result;
  }

  const headers = sheet
    .getRange(1, 1, 1, lastCol)
    .getValues()[0]
    .map(cleanText_);

  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const formulas = sheet.getRange(2, 1, lastRow - 1, lastCol).getFormulas();

  for (let r = 0; r < values.length; r++) {
    const obj = {};

    for (let c = 0; c < headers.length; c++) {
      const h = headers[c];

      if (!h) {
        continue;
      }

      obj[h] = formulas[r][c] || values[r][c];
    }

    const nmID = String(obj['Идентификатор'] || '').trim();

    if (!nmID) {
      continue;
    }

    const rowKey = makeSizeRowKeyFromObj_(obj);

    if (!result.rowsByKey[rowKey]) {
      result.rowOrder.push(rowKey);
    }

    result.rowsByKey[rowKey] = obj;
  }

  return result;
}

/**
 * Полная запись таблицы.
 */
function writeTable_(sheet, headers, rows) {
  ensureSheetSize_(sheet, Math.max(rows.length + 1, 1), headers.length);

  const clearRows = Math.max(sheet.getLastRow(), 1);
  const clearCols = Math.max(sheet.getLastColumn(), headers.length);

  sheet.getRange(1, 1, clearRows, clearCols).clearContent();

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function formatCabinetSheet_(sheet, headers, dataRows) {
  const lastCol = headers.length;

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold');

  sheet
    .getRange(1, 1, Math.max(dataRows + 1, 1), lastCol)
    .setVerticalAlignment('top');

  try {
    sheet.autoResizeColumns(1, Math.min(lastCol, 21));
  } catch (e) {}

  const barcodeCol = headers.indexOf('Баркод') + 1;

  if (barcodeCol > 0 && dataRows > 0) {
    sheet
      .getRange(2, barcodeCol, dataRows, 1)
      .setNumberFormat('@')
      .setHorizontalAlignment('left');
  }

  if (barcodeCol > 0) {
    sheet.setColumnWidth(barcodeCol, 140);
  }

  const firstPhotoCol = headers.indexOf('Фото 1') + 1;

  if (firstPhotoCol > 0) {
    sheet.setColumnWidths(firstPhotoCol, WB_CARDS.MAX_PHOTOS, 120);
  }

  const videoCol = headers.indexOf('Видео') + 1;

  if (videoCol > 0) {
    sheet.setColumnWidth(videoCol, 70);
  }
}

function formatTechListSheet_(sheet, dataRows) {
  const lastCol = WB_TECHLIST_HEADERS.length;

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, lastCol).setFontWeight('bold');

  if (dataRows > 0) {
    sheet.getRange(2, 1, dataRows, 1).insertCheckboxes();

    sheet
      .getRange(2, 1, dataRows, lastCol)
      .setVerticalAlignment('top');

    sheet.getRange(2, 10, dataRows, 2).setWrap(true);
  }

  try {
    sheet.autoResizeColumns(1, lastCol);
  } catch (e) {}

  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(10, 350);
  sheet.setColumnWidth(11, 220);
}

/**
 * Конфиги кабинетов из KEY!B2:B5
 */
function getCabinetConfigs_(ss) {
  const keySheet = ss.getSheetByName(WB_CARDS.KEY_SHEET);

  if (!keySheet) {
    throw new Error('Не найден лист: ' + WB_CARDS.KEY_SHEET);
  }

  const tokenValues = keySheet
    .getRange(WB_CARDS.TOKEN_RANGE)
    .getValues()
    .flat();

  return WB_CARDS.CABINETS.map(c => ({
    name: c.name,
    token: String(tokenValues[c.tokenRowIndex] || '').trim()
  }));
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

/**
 * Курсоры
 */
function getSavedCursor_(cabinetName) {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(WB_CARDS.PROPS_PREFIX + cabinetName);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function saveCursor_(cabinetName, cursor) {
  PropertiesService.getScriptProperties().setProperty(
    WB_CARDS.PROPS_PREFIX + cabinetName,
    JSON.stringify({
      updatedAt: cursor.updatedAt,
      nmID: cursor.nmID
    })
  );
}

function wbResetCursorMANI() {
  resetCursorByName_('МАНИ');
}

function wbResetCursorMIROS() {
  resetCursorByName_('МИРОС');
}

function wbResetCursorBurkov() {
  resetCursorByName_('Бурков');
}

function wbResetCursorBurkova() {
  resetCursorByName_('Буркова');
}

function wbResetAllCursors() {
  WB_CARDS.CABINETS.forEach(c => resetCursorByName_(c.name));
  toast_('WB карточки', 'Все курсоры сброшены');
}

function resetCursorByName_(cabinetName) {
  PropertiesService
    .getScriptProperties()
    .deleteProperty(WB_CARDS.PROPS_PREFIX + cabinetName);

  Logger.log('Сброшен курсор: ' + cabinetName);
}

/**
 * Триггер раз в 4 часа
 */
function wbSetEvery4HoursTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'wbSyncAllCabinets')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('wbSyncAllCabinets')
    .timeBased()
    .everyHours(4)
    .create();

  toast_('WB карточки', 'Триггер wbSyncAllCabinets поставлен раз в 4 часа');
}

/**
 * Вспомогательные функции
 */
function ensureSheetSize_(sheet, neededRows, neededCols) {
  const maxRows = sheet.getMaxRows();
  const maxCols = sheet.getMaxColumns();

  if (maxRows < neededRows) {
    sheet.insertRowsAfter(maxRows, neededRows - maxRows);
  }

  if (maxCols < neededCols) {
    sheet.insertColumnsAfter(maxCols, neededCols - maxCols);
  }
}

function formatCharacteristicValue_(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (Array.isArray(value)) {
    return joinUniqueText_(value.map(formatOneValue_), ', ');
  }

  return formatOneValue_(value);
}

function formatOneValue_(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  return String(value).trim();
}

function getVideoUrl_(video) {
  if (!video) {
    return '';
  }

  if (typeof video === 'string') {
    return video;
  }

  if (typeof video === 'object') {
    return video.url || video.link || video.src || '';
  }

  return '';
}

function getPhotoUrls_(photos) {
  if (!Array.isArray(photos)) {
    return [];
  }

  return photos
    .map(p => {
      if (!p) {
        return '';
      }

      if (typeof p === 'string') {
        return p;
      }

      return (
        p.big ||
        p.full ||
        p.c516x688 ||
        p.c246x328 ||
        p.tm ||
        p.square ||
        p.url ||
        ''
      );
    })
    .filter(Boolean)
    .slice(0, WB_CARDS.MAX_PHOTOS);
}

function joinUniqueText_(arr, separator) {
  const seen = {};
  const out = [];

  (arr || []).forEach(v => {
    if (v === undefined || v === null) {
      return;
    }

    const s = String(v).trim();

    if (!s || seen[s]) {
      return;
    }

    seen[s] = true;
    out.push(s);
  });

  return out.join(separator || ', ');
}

function cleanText_(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function valueOrBlank_(v) {
  if (v === undefined || v === null) {
    return '';
  }

  return v;
}

function isTruthy_(v) {
  if (v === true) {
    return true;
  }

  const s = String(v || '').trim().toLowerCase();

  return (
    s === 'true' ||
    s === 'да' ||
    s === 'yes' ||
    s === '1' ||
    s === 'истина'
  );
}

function escapeFormulaString_(s) {
  return String(s || '').replace(/"/g, '""');
}

function toast_(title, message) {
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(message, title, 5);
  } catch (e) {}
}