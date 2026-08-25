function fetchDataAndInsertIntoSheet() {
  // Получаем API ключ из листа "KEY" ячейки B2
  var apiKey = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("KEY").getRange("B2").getValue();

  // Получаем даты ОТ и ДО из ячеек B2 и C2
  var fromDate = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getRange('B2').getValue();
  var toDate = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getRange('C2').getValue();

  // Преобразуем даты в нужный формат (год-месяц-день)
  fromDate = Utilities.formatDate(fromDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  toDate = Utilities.formatDate(toDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');

  // URL для получения данных
  var apiUrl = 'https://advert-api.wildberries.ru/adv/v1/upd?from=' + fromDate + '&to=' + toDate;

  // Создаем заголовки для запроса
  var headers = {
    'Authorization': 'Bearer ' + apiKey
  };

  try {
    // Выполняем GET-запрос
    var response = UrlFetchApp.fetch(apiUrl, {
      headers: headers,
      method: 'get'
    });

    // Получаем данные ответа
    var responseData = JSON.parse(response.getContentText());

    // Открываем Google таблицу по ID
    var spreadsheetId = '1l4uXL9v4bFz-8Ug70Kv1X3qVYiww_0yr1dk8qrk7teY'; // замените YOUR_SPREADSHEET_ID на ID вашей таблицы
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);

    // Выбираем лист для вставки данных (первый лист в данном случае)
    var sheet = spreadsheet.getActiveSheet();

    // Очищаем лист начиная с 4 строки и от A до J
    sheet.getRange(4, 1, sheet.getMaxRows() - 3, 10).clearContent(); // 10 - количество столбцов от A до J

    // Вставляем заголовки столбцов в третью строку
    var headers = [
      'Номер документа',
      'Дата списания',
      'Время списания',
      'Выставленная сумма',
      'Идентификатор кампании',
      'Название кампании',
      'Тип кампании',
      'Источник списания',
      'Статус кампании'
    ];
    sheet.getRange(3, 1, 1, headers.length).setValues([headers]);

    // Получаем данные, уже присутствующие в таблице
    var existingData = sheet.getDataRange().getValues();

    // Формируем массив для вставки новых данных
    var newData = [];
    for (var i = 0; i < responseData.length; i++) {
      var isDuplicate = false;
      // Проверяем, есть ли данные в таблице
      for (var j = 0; j < existingData.length; j++) {
        // Сравниваем каждую запись в ответе с существующими данными
        if (responseData[i].updNum === existingData[j][0]) {
          isDuplicate = true;
          break;
        }
      }
      // Если запись не найдена в таблице, добавляем ее в массив новых данных
      if (!isDuplicate) {
        newData.push([
          responseData[i].updNum,
          Utilities.formatDate(new Date(responseData[i].updTime), Session.getScriptTimeZone(), 'dd.MM.yyyy'),
          new Date(responseData[i].updTime).toLocaleTimeString(),
          responseData[i].updSum,
          responseData[i].advertId,
          responseData[i].campName,
          responseData[i].advertType,
          responseData[i].paymentType,
          responseData[i].advertStatus
        ]);
      }
    }

    // Вставляем новые данные в таблицу начиная с 4-й строки
    if (newData.length > 0) {
      var startRow = 4; // Начинаем с 4-й строки

      sheet.getRange(startRow, 1, newData.length, newData[0].length).setValues(newData);
    } else {
      Logger.log('Новых данных не найдено');
    }

  } catch (error) {
    Logger.log('Ошибка при выполнении запроса: ' + error);
  }
}