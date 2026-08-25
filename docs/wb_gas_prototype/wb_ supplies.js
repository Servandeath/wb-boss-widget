function main() {
  Logger.log("Старт выгрузки поставок WB (потоварно)...");

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  var keySheet = ss.getSheetByName("KEY");

  if (!keySheet) throw new Error("Лист KEY не найден");

  var token = String(keySheet.getRange("B2").getValue()).trim();
  if (!token) throw new Error("Нет токена в KEY!B2");

  var rawDateFrom = sheet.getRange("C1").getValue();
  var rawDateTo = sheet.getRange("D1").getValue();

  var dateFrom = parseSheetDate_(rawDateFrom);
  var dateTo = parseSheetDate_(rawDateTo);

  if (!dateFrom) throw new Error("Некорректная дата в C1");
  if (!dateTo) throw new Error("Некорректная дата в D1");
  if (dateFrom > dateTo) throw new Error("Дата от больше даты до");

  var tz = "Europe/Moscow";
  var fromStr = Utilities.formatDate(dateFrom, tz, "yyyy-MM-dd");
  var toStr = Utilities.formatDate(dateTo, tz, "yyyy-MM-dd");

  Logger.log("Период: " + fromStr + " - " + toStr);

  var statusIds = [4, 5]; // на приемке + принято

  setHeaders_(sheet);
  clearDataKeepHeader_(sheet);

  var supplies = fetchAllSupplies_(token, fromStr, toStr, statusIds);
  Logger.log("Поставок найдено: " + supplies.length);

  var allRows = [];

  for (var i = 0; i < supplies.length; i++) {
    var s = supplies[i];

    var goods = [];

    if (s.supplyID) {
      goods = fetchAllSupplyGoods_(token, s.supplyID, false);
    } else if (s.preorderID) {
      goods = fetchAllSupplyGoods_(token, s.preorderID, true);
    }

    if (!goods.length) {
      allRows.push(buildRow_(s, null));
    } else {
      for (var g = 0; g < goods.length; g++) {
        allRows.push(buildRow_(s, goods[g]));
      }
    }

    if (i % 10 === 0) Utilities.sleep(200); // защита от лимита
  }

  if (allRows.length) {
    sheet.getRange(3, 1, allRows.length, allRows[0].length).setValues(allRows);
  }

  Logger.log("Готово. Строк: " + allRows.length);
}

/* ========================= API ========================= */

function fetchAllSupplies_(token, fromStr, toStr, statusIds) {
  var url = "https://supplies-api.wildberries.ru/api/v1/supplies";
  var limit = 1000;
  var offset = 0;
  var result = [];

  while (true) {
    var fullUrl = url + "?limit=" + limit + "&offset=" + offset;

    var payload = {
      dates: [{
        from: fromStr,
        till: toStr,
        type: "factDate"
      }],
      statusIDs: statusIds
    };

    var response = wbFetch_(fullUrl, {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error("Ошибка поставок: " + response.getContentText());
    }

    var data = JSON.parse(response.getContentText());
    if (!data.length) break;

    result = result.concat(data);

    if (data.length < limit) break;

    offset += limit;
    Utilities.sleep(200);
  }

  return result;
}

function fetchAllSupplyGoods_(token, id, isPreorderID) {
  var limit = 1000;
  var offset = 0;
  var result = [];

  while (true) {
    var url =
      "https://supplies-api.wildberries.ru/api/v1/supplies/" +
      id +
      "/goods?limit=" + limit +
      "&offset=" + offset +
      "&isPreorderID=" + (isPreorderID ? "true" : "false");

    var response = wbFetch_(url, {
      method: "get",
      headers: { Authorization: token },
      muteHttpExceptions: true
    });

    var code = response.getResponseCode();
    if (code !== 200) {
      throw new Error("Ошибка товаров поставки " + id + ": " + response.getContentText());
    }

    var data = JSON.parse(response.getContentText());
    if (!data.length) break;

    result = result.concat(data);

    if (data.length < limit) break;

    offset += limit;
    Utilities.sleep(200);
  }

  return result;
}

/* ========================= DATA ========================= */

function buildRow_(s, g) {
  g = g || {};

  return [
    s.supplyID || "",
    s.preorderID || "",
    statusName_(s.statusID),
    s.statusID || "",
    s.createDate || "",
    s.supplyDate || "",
    s.factDate || "",
    s.updatedDate || "",
    s.phone || "",
    g.nmID || "",
    g.vendorCode || "",
    g.barcode || "",
    g.techSize || "",
    g.color || "",
    g.quantity || "",
    g.acceptedQuantity || "",
    g.unloadingQuantity || "",
    g.readyForSaleQuantity || "",
    g.supplierBoxAmount || "",
    g.needKiz === true ? "true" : "",
    g.tnved || ""
  ];
}

/* ========================= UI ========================= */

function setHeaders_(sheet) {
  var headers = [[
    "supplyID","preorderID","Статус","statusID",
    "Дата создания","План","Факт","Обновление","Телефон",
    "nmID","Артикул","Баркод","Размер","Цвет",
    "Кол-во","Принято","На разгрузке","Готово к продаже",
    "Короб","КИЗ","ТНВЭД"
  ]];

  sheet.getRange(2, 1, 1, headers[0].length).setValues(headers);
}

function clearDataKeepHeader_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow >= 3) {
    sheet.getRange(3, 1, lastRow - 2, 25).clearContent();
  }
}

/* ========================= UTILS ========================= */

function statusName_(id) {
  return {
    4: "На приемке",
    5: "Принято"
  }[id] || "";
}

function parseSheetDate_(v) {
  if (v instanceof Date) return v;
  var d = new Date(v);
  return isNaN(d) ? null : d;
}

function wbFetch_(url, options) {
  var max = 6;

  for (var i = 1; i <= max; i++) {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();

    if (code === 200) return res;

    if (code === 429 || code >= 500) {
      Utilities.sleep(1500 * i);
      continue;
    }

    return res;
  }

  throw new Error("WB fetch failed: " + url);
}