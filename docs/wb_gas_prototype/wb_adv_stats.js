/**
 * WB ADS — кампании + агрегированная статистика по дням
 *
 * ЛОГИКА:
 * 1 строка = 1 ID кампании + 1 дата
 *
 * Названия кампаний — GET /api/advert/v2/adverts (работающий эндпоинт)
 * nmId + nmName      — из ответа fullstats (days[].apps[].nms[])
 *                      отдельный запрос не нужен, данные уже есть
 *
 * ЛИСТЫ:
 * 1) "Список кампаний"
 * 2) "Статистика кампаний"
 *
 * НА ЛИСТЕ "Статистика кампаний":
 * C1 = дата начала
 * D1 = дата конца
 *
 * ОСНОВНЫЕ ФУНКЦИИ:
 * 1) wbLoadCampaignsAndStats()  — обновить кампании + загрузить статистику
 * 2) wbRefreshCampaignsList()   — только обновить список кампаний
 */

var WBADS = {
  KEY_SHEET_NAME: 'KEY',
  KEY_CELL: 'B2',

  CAMPAIGNS_SHEET_NAME: 'Список кампаний',
  STATS_SHEET_NAME: 'Статистика кампаний',

  DATE_FROM_CELL: 'C1',
  DATE_TO_CELL: 'D1',

  CAMPAIGNS_HEADER_ROW: 1,
  CAMPAIGNS_DATA_START_ROW: 2,

  STATS_DATE_ROW: 1,
  STATS_HEADER_ROW: 2,
  STATS_DATA_START_ROW: 3,

  NAMES_BATCH_SIZE: 50,
  STATS_BATCH_SIZE: 50,
  FULLSTATS_PAUSE_MS: 21000,

  MOSCOW_TZ: 'Europe/Moscow'
};

// =========================================================
// ОСНОВНЫЕ ФУНКЦИИ
// =========================================================

function wbLoadCampaignsAndStats() {
  Logger.log('=== WB ADS: КАМПАНИИ + СТАТИСТИКА ===');

  var campaigns = fetchCampaignsList_();
  if (!campaigns.length) {
    Logger.log('Кампании не получены');
    return;
  }

  upsertCampaignsSheet_(campaigns);

  var dateRange = getDateRangeFromSheet_();
  Logger.log('Период статистики: ' + dateRange.beginDate + ' ... ' + dateRange.endDate);

  var statsRows = fetchCampaignStatsByDateRange_(campaigns, dateRange.beginDate, dateRange.endDate);
  Logger.log('Строк статистики собрано: ' + statsRows.length);

  replaceStatsRowsForPeriod_(statsRows, dateRange.beginDate, dateRange.endDate);

  Logger.log('=== ГОТОВО ===');
}

function wbRefreshCampaignsList() {
  Logger.log('=== WB ADS: ОБНОВЛЕНИЕ СПИСКА КАМПАНИЙ ===');

  var campaigns = fetchCampaignsList_();
  if (!campaigns.length) {
    Logger.log('Кампании не получены');
    return;
  }

  upsertCampaignsSheet_(campaigns);
  Logger.log('=== ГОТОВО ===');
}

// =========================================================
// КАМПАНИИ
// =========================================================

function fetchCampaignsList_() {
  var apiKey = getApiKey_();
  var url = 'https://advert-api.wildberries.ru/adv/v1/promotion/count';

  var resp = fetchWithBackoff_(url, {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    throw new Error('Ошибка promotion/count: ' + resp.getResponseCode() + ' | ' + resp.getContentText());
  }

  var parsed = JSON.parse(resp.getContentText());
  var adverts = parsed.adverts || [];
  if (!adverts.length) return [];

  var campaigns = [];
  var advertIds = [];

  adverts.forEach(function(group) {
    (group.advert_list || []).forEach(function(ad) {
      var advertId = Number(ad.advertId || 0);
      if (!advertId) return;

      advertIds.push(advertId);

      campaigns.push({
        advertId:   advertId,
        typeCode:   Number(group.type   || 0),
        typeText:   getCampaignTypeText_(group.type),
        statusCode: Number(group.status || 0),
        statusText: getCampaignStatusText_(group.status),
        count:      Number(group.count  || 0),
        name:       '',
        nmId:       '',
        nmName:     '',
        changeTime: ad.changeTime || ''
      });
    });
  });

  // Получаем названия кампаний через оригинальный работающий GET
  var namesMap = fetchCampaignNames_(apiKey, advertIds);

  campaigns.forEach(function(c) {
    c.name = namesMap[c.advertId] || 'Без названия';
    // nmId и nmName будут заполнены позже из ответа fullstats
  });

  Logger.log('Кампаний получено: ' + campaigns.length);
  return campaigns;
}

/**
 * Загружает названия кампаний.
 * GET /api/advert/v2/adverts?ids=... — эндпоинт, который гарантированно работает.
 * Возвращает map { advertId: name }.
 */
function fetchCampaignNames_(apiKey, advertIds) {
  var out = {};
  if (!advertIds.length) return out;

  for (var i = 0; i < advertIds.length; i += WBADS.NAMES_BATCH_SIZE) {
    var batch = advertIds.slice(i, i + WBADS.NAMES_BATCH_SIZE);

    var url = 'https://advert-api.wildberries.ru/api/advert/v2/adverts?ids='
              + encodeURIComponent(batch.join(','));

    var resp = fetchWithBackoff_(url, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      muteHttpExceptions: true
    });

    var code = resp.getResponseCode();
    var body = resp.getContentText();

    if (code !== 200) {
      Logger.log('Ошибка adverts names: ' + code + ' | ' + body.substring(0, 200));
      Utilities.sleep(500);
      continue;
    }

    try {
      var parsed = JSON.parse(body);
      // Ответ может быть массивом напрямую или объектом { adverts: [...] }
      var list = Array.isArray(parsed) ? parsed : (parsed.adverts || []);

      list.forEach(function(item) {
        var id = Number(item.advertId || item.id || 0);
        if (!id) return;

        var name = '';
        if      (item.name)                           name = item.name;
        else if (item.settings && item.settings.name) name = item.settings.name;

        out[id] = name || 'Без названия';
      });

    } catch (e) {
      Logger.log('Ошибка парсинга adverts names: ' + e);
    }

    Utilities.sleep(500);
  }

  return out;
}

function upsertCampaignsSheet_(campaigns) {
  var sh = getOrCreateSheetByName_(WBADS.CAMPAIGNS_SHEET_NAME);
  ensureCampaignsHeader_(sh);

  var lastRow = sh.getLastRow();
  var existingMap = {};

  if (lastRow >= WBADS.CAMPAIGNS_DATA_START_ROW) {
    var numRows = lastRow - WBADS.CAMPAIGNS_DATA_START_ROW + 1;
    var data = sh.getRange(WBADS.CAMPAIGNS_DATA_START_ROW, 1, numRows, 6).getValues();

    for (var i = 0; i < data.length; i++) {
      var advertId = Number(data[i][3] || 0);
      if (advertId) {
        existingMap[advertId] = WBADS.CAMPAIGNS_DATA_START_ROW + i;
      }
    }
  }

  var updates = [];
  var appends = [];

  campaigns.forEach(function(c) {
    var rowValues = [
      c.typeText,
      c.statusText,
      c.count,
      c.advertId,
      c.name,
      c.changeTime
    ];

    if (existingMap[c.advertId]) {
      updates.push({ row: existingMap[c.advertId], values: rowValues });
    } else {
      appends.push(rowValues);
    }
  });

  updates.forEach(function(item) {
    sh.getRange(item.row, 1, 1, 6).setValues([item.values]);
  });

  if (appends.length) {
    var startRow = Math.max(sh.getLastRow() + 1, WBADS.CAMPAIGNS_DATA_START_ROW);
    sh.getRange(startRow, 1, appends.length, 6).setValues(appends);
  }

  Logger.log('Обновлено кампаний: ' + updates.length);
  Logger.log('Добавлено новых кампаний: ' + appends.length);
}

// =========================================================
// СТАТИСТИКА
// =========================================================

function fetchCampaignStatsByDateRange_(campaigns, beginDate, endDate) {
  var apiKey = getApiKey_();

  var allowedStatuses = { 9: true, 11: true };
  var activeCampaigns = campaigns.filter(function(c) {
    return allowedStatuses[c.statusCode];
  });

  if (!activeCampaigns.length) {
    Logger.log('Нет активных кампаний для статистики');
    return [];
  }

  Logger.log('Активных кампаний: ' + activeCampaigns.length);

  var metaMap = {};
  activeCampaigns.forEach(function(c) {
    metaMap[c.advertId] = c;
  });

  var allRows   = [];
  var uniqueMap = {};

  for (var i = 0; i < activeCampaigns.length; i += WBADS.STATS_BATCH_SIZE) {
    var batch = activeCampaigns.slice(i, i + WBADS.STATS_BATCH_SIZE);
    var ids   = batch.map(function(c) { return c.advertId; });

    var url = 'https://advert-api.wildberries.ru/adv/v3/fullstats'
      + '?ids='       + encodeURIComponent(ids.join(','))
      + '&beginDate=' + encodeURIComponent(beginDate)
      + '&endDate='   + encodeURIComponent(endDate);

    Logger.log('Пакет fullstats: ' + (Math.floor(i / WBADS.STATS_BATCH_SIZE) + 1));

    var resp = fetchWithBackoff_(url, {
      method: 'get',
      headers: { 'Authorization': 'Bearer ' + apiKey },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Ошибка fullstats: ' + resp.getResponseCode() + ' | ' + resp.getContentText());
      if (i + WBADS.STATS_BATCH_SIZE < activeCampaigns.length) {
        Utilities.sleep(WBADS.FULLSTATS_PAUSE_MS);
      }
      continue;
    }

    try {
      var result = JSON.parse(resp.getContentText());
      if (!Array.isArray(result)) {
        Logger.log('fullstats вернул не массив');
        if (i + WBADS.STATS_BATCH_SIZE < activeCampaigns.length) {
          Utilities.sleep(WBADS.FULLSTATS_PAUSE_MS);
        }
        continue;
      }

      result.forEach(function(campaign) {
        var campaignId = Number(campaign.advertId || campaign.id || 0);
        var meta = metaMap[campaignId];
        if (!campaignId || !meta) return;

        // nmId и nmName берём из fullstats один раз на кампанию.
        // Путь: days[].apps[].nms[].nmId — подтверждено документацией WB.
        // Никаких дополнительных API-запросов не нужно.
        if (!meta.nmId) {
          extractNmIdFromFullstats_(campaign, meta);
        }

        (campaign.days || []).forEach(function(day) {
          var dayDate = normalizeDate_(day.date);
          if (!dayDate) return;

          var key = campaignId + '|' + dayDate;
          if (uniqueMap[key]) return;
          uniqueMap[key] = true;

          allRows.push([
            campaignId,
            meta.name,
            meta.typeText,
            dayDate,
            Number(day.views  || 0),
            Number(day.clicks || 0),
            round2_(day.ctr),
            round2_(day.cpc),
            round2_(day.sum),
            Number(day.atbs   || 0),
            Number(day.orders || 0),
            round2_(day.cr),
            Number(day.shks   || 0),
            round2_(day.sum_price),
            meta.nmName,
            meta.nmId
          ]);
        });
      });

    } catch (e) {
      Logger.log('Ошибка обработки fullstats: ' + e);
    }

    if (i + WBADS.STATS_BATCH_SIZE < activeCampaigns.length) {
      Utilities.sleep(WBADS.FULLSTATS_PAUSE_MS);
    }
  }

  allRows.sort(function(a, b) {
    if (a[3] !== b[3]) return a[3] < b[3] ? -1 : 1;
    return a[0] - b[0];
  });

  return allRows;
}

/**
 * Извлекает nmId и nmName из объекта кампании fullstats.
 *
 * Структура ответа WB fullstats (подтверждено документацией):
 *
 *   Основной путь:
 *     campaign.days[d].apps[a].nms[n].nmId
 *     campaign.days[d].apps[a].nms[n].name
 *
 *   Запасные пути (на случай изменений API):
 *     campaign.days[d].nm[n].nmId
 *     campaign.nms[n].nmId
 *
 * Записывает результат в meta.nmId и meta.nmName.
 * Вызывается один раз на кампанию — при первом найденном nmId выходит.
 */
function extractNmIdFromFullstats_(campaign, meta) {
  var days = campaign.days || [];

  for (var d = 0; d < days.length; d++) {
    var day  = days[d];
    var apps = day.apps || [];

    // Путь 1: days[].apps[].nms[]
    for (var a = 0; a < apps.length; a++) {
      var nms = apps[a].nms || [];
      for (var n = 0; n < nms.length; n++) {
        var id1 = Number(nms[n].nmId || nms[n].nm || 0);
        if (id1) {
          meta.nmId   = id1;
          meta.nmName = String(nms[n].name || '');
          return;
        }
      }
    }

    // Путь 2: days[].nm[]
    var nm = day.nm || [];
    for (var k = 0; k < nm.length; k++) {
      var id2 = Number(nm[k].nmId || nm[k].nm || 0);
      if (id2) {
        meta.nmId   = id2;
        meta.nmName = String(nm[k].name || '');
        return;
      }
    }
  }

  // Путь 3: campaign.nms[] (верхний уровень)
  var topNms = campaign.nms || [];
  for (var t = 0; t < topNms.length; t++) {
    var id3 = Number(topNms[t].nmId || topNms[t].nm || 0);
    if (id3) {
      meta.nmId   = id3;
      meta.nmName = String(topNms[t].name || '');
      return;
    }
  }
}

function replaceStatsRowsForPeriod_(statsRows, beginDate, endDate) {
  var sh = getOrCreateSheetByName_(WBADS.STATS_SHEET_NAME);
  ensureStatsHeader_(sh);

  var lastRow = sh.getLastRow();
  var kept = [];

  if (lastRow >= WBADS.STATS_DATA_START_ROW) {
    var numRows = lastRow - WBADS.STATS_DATA_START_ROW + 1;
    var data = sh.getRange(WBADS.STATS_DATA_START_ROW, 1, numRows, 16).getValues();

    data.forEach(function(r) {
      var rowDate = normalizeDate_(r[3]);
      if (!rowDate) return;

      if (rowDate < beginDate || rowDate > endDate) {
        kept.push([
          r[0],  r[1],  r[2],  r[3],
          r[4],  r[5],  r[6],  r[7],
          r[8],  r[9],  r[10], r[11],
          r[12], r[13], r[14], r[15]
        ]);
      }
    });

    sh.getRange(WBADS.STATS_DATA_START_ROW, 1, numRows, 16).clearContent();
  }

  var finalRows = kept.concat(statsRows);

  if (finalRows.length) {
    sh.getRange(WBADS.STATS_DATA_START_ROW, 1, finalRows.length, 16).setValues(finalRows);
  }

  formatStatsSheet_(sh);
  Logger.log('Статистика за период перезаписана');
}

// =========================================================
// ЛИСТЫ / ДАТЫ / API
// =========================================================

function getOrCreateSheetByName_(sheetName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(String(sheetName));
  if (!sh) {
    sh = ss.insertSheet(String(sheetName));
  }
  return sh;
}

function getDateRangeFromSheet_() {
  var sh = getOrCreateSheetByName_(WBADS.STATS_SHEET_NAME);

  var dateFrom = sh.getRange(WBADS.DATE_FROM_CELL).getValue();
  var dateTo   = sh.getRange(WBADS.DATE_TO_CELL).getValue();

  if (!dateFrom || !dateTo) {
    throw new Error(
      'Заполни даты в листе "' + WBADS.STATS_SHEET_NAME + '" в ячейках ' +
      WBADS.DATE_FROM_CELL + ' и ' + WBADS.DATE_TO_CELL
    );
  }

  var beginDate = formatSheetDate_(dateFrom);
  var endDate   = formatSheetDate_(dateTo);

  if (beginDate > endDate) {
    throw new Error('Дата начала больше даты конца');
  }

  return {
    beginDate: beginDate,
    endDate:   endDate
  };
}

function getApiKey_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(WBADS.KEY_SHEET_NAME);
  if (!sh) {
    throw new Error('Не найден лист "' + WBADS.KEY_SHEET_NAME + '"');
  }

  var key = String(sh.getRange(WBADS.KEY_CELL).getValue()).trim();
  if (!key) {
    throw new Error('Пустой API ключ в ' + WBADS.KEY_SHEET_NAME + '!' + WBADS.KEY_CELL);
  }

  return key;
}

function fetchWithBackoff_(url, options) {
  var delay      = 1000;
  var maxRetries = 5;

  for (var i = 0; i < maxRetries; i++) {
    var resp = UrlFetchApp.fetch(url, options);
    var code = resp.getResponseCode();

    if (code !== 429) return resp;

    Logger.log('429, попытка ' + (i + 1) + ', пауза ' + delay + ' мс');
    Utilities.sleep(delay);
    delay = Math.min(delay * 2, 10000);
  }

  return UrlFetchApp.fetch(url, options);
}

// =========================================================
// HEADER / FORMAT / MAP
// =========================================================

function ensureCampaignsHeader_(sheet) {
  if (sheet.getRange(WBADS.CAMPAIGNS_HEADER_ROW, 1).getValue() === '') {
    sheet.getRange(WBADS.CAMPAIGNS_HEADER_ROW, 1, 1, 6).setValues([[
      'Тип', 'Статус', 'Количество', 'ID РК', 'Название кампании', 'Время изменения'
    ]]);
  }
}

function ensureStatsHeader_(sheet) {
  var header = [[
    'ID кампании',
    'Название кампании',
    'Тип кампании',
    'Дата',
    'Просмотры',
    'Клики',
    'CTR',
    'CPC',
    'Затраты',
    'В корзину',
    'Заказы',
    'CR',
    'Количество',
    'Сумма заказов',
    'Название товара',
    'nmId'
  ]];

  var existingHeader = sheet.getRange(WBADS.STATS_HEADER_ROW, 1, 1, 16).getValues()[0];
  var hasAnyHeader = existingHeader.some(function(v) { return String(v).trim() !== ''; });

  if (!hasAnyHeader) {
    sheet.getRange(WBADS.STATS_HEADER_ROW, 1, 1, 16).setValues(header);
  }
}

function formatStatsSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < WBADS.STATS_DATA_START_ROW) return;

  var numRows = lastRow - WBADS.STATS_DATA_START_ROW + 1;

  sheet.getRange(WBADS.STATS_DATA_START_ROW, 4,  numRows, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(WBADS.STATS_DATA_START_ROW, 7,  numRows, 3).setNumberFormat('0.00');
  sheet.getRange(WBADS.STATS_DATA_START_ROW, 12, numRows, 1).setNumberFormat('0.00');
  sheet.getRange(WBADS.STATS_DATA_START_ROW, 14, numRows, 1).setNumberFormat('0.00');
}

function formatSheetDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, WBADS.MOSCOW_TZ, 'yyyy-MM-dd');
  }

  var s = String(value).trim().replace(/\./g, '-').replace(/\//g, '-');

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  var m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];

  throw new Error('Не удалось распознать дату: ' + value);
}

function normalizeDate_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, WBADS.MOSCOW_TZ, 'yyyy-MM-dd');
  }
  return String(value).split('T')[0];
}

function round2_(value) {
  var n = Number(value || 0);
  return Math.round(n * 100) / 100;
}

function getCampaignTypeText_(type) {
  var map = {
    4: 'Аукцион',
    5: 'Автоматическая',
    6: 'Поиск + Каталог',
    7: 'Автоматическая',
    8: 'Поиск',
    9: 'Рекомендации'
  };
  return map[type] || 'Тип ' + type;
}

function getCampaignStatusText_(status) {
  var map = {
    4: 'Готова к запуску',
    7: 'Завершена',
    8: 'Отказ',
    9: 'Идут показы',
    11: 'Пауза'
  };
  return map[status] || 'Статус ' + status;
}