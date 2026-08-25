/*************************************************
 * WB FBS — РЕДАКТИРОВАНИЕ ОСТАТКОВ ИЗ "Лист1"
 *
 * ЛОГИКА:
 *
 * 1. На листе "Лист1" уже есть выгрузка:
 *
 * КЭБ | Предмет | Артикул продавца | Артикул WB |
 * Название | Размер вещи | Баркод |
 * Итого на складах продавца | [Склады...]
 *
 * Заголовки находятся в строке 2.
 * Данные начинаются со строки 3.
 *
 * 2. На листе "Номенклатуры" есть:
 *
 * Идентификатор
 * Артикул
 * Категория
 * Кабинет
 * ...
 * chrtID
 * ...
 * Технические размеры
 * Баркод
 *
 * 3. Чтобы изменить остаток:
 *
 * - меняем число в ячейке нужного склада
 * - выделяем изменённые ячейки
 * - запускаем wbFbsUpdateSelectedStocks()
 *
 * Пустая ячейка = НЕ менять.
 * 0 = установить остаток 0.
 *
 * API:
 * PUT /api/v3/stocks/{warehouseId}
 *
 * {
 *   "stocks": [
 *     {
 *       "chrtId": 12345678,
 *       "amount": 10
 *     }
 *   ]
 * }
 *************************************************/


const WB_FBS_EDIT_CFG = {

  /* ================= API ================= */

  MP_HOST: 'https://marketplace-api.wildberries.ru',

  WAREHOUSES_PATH: '/api/v3/warehouses',

  STOCKS_PATH: '/api/v3/stocks/{warehouseId}',


  /* ================= ТОКЕНЫ ================= */

  KEY_SHEET: 'KEY',

  CABINETS: [

    {
      name: 'МАНИ',
      tokenCell: 'B2'
    },

    {
      name: 'МИРОС',
      tokenCell: 'B3'
    },

    {
      name: 'Мелуа',
      tokenCell: 'B4'
    }

  ],


  /* ================= НОМЕНКЛАТУРЫ ================= */

  NOM_SHEET: 'Номенклатуры',

  NOM_HEADER_ROW: 1,

  NOM_FIRST_DATA_ROW: 2,

  NOM_HEADER_CAB: 'Кабинет',

  NOM_HEADER_BARCODE: 'Баркод',

  NOM_HEADER_CHRTID: 'chrtID',

  NOM_HEADER_NMID: 'Идентификатор',

  NOM_HEADER_SIZE: 'Технические размеры',


  /* ================= ЛИСТ ОСТАТКОВ ================= */

  OUT_SHEET: 'Лист1',

  // В твоей текущей выгрузке заголовки записываются в строку 2
  OUT_HEADER_ROW: 2,

  // Первая строка товара
  OUT_FIRST_DATA_ROW: 3,


  /* ================= ЗАГОЛОВКИ ЛИСТ1 ================= */

  HEADER_CAB: 'КЭБ',

  HEADER_BARCODE: 'Баркод',

  HEADER_NMID: 'Артикул WB',

  HEADER_SIZE: 'Размер вещи',

  HEADER_TOTAL: 'Итого на складах продавца',


  /* ================= API LIMITS ================= */

  // WB принимает до 1000 chrtId за PUT
  MAX_STOCKS_PER_REQUEST: 1000,

  // лимит PUT — 300 rpm / 200 ms
  PAUSE_MS: 220,

  MAX_RETRIES: 3,

  RETRY_PAUSE_MS: 3000
};


/**
 * =========================================================
 * ОСНОВНАЯ ФУНКЦИЯ
 * =========================================================
 *
 * Выделяем изменённые ячейки остатков
 * и запускаем эту функцию.
 */
function wbFbsUpdateSelectedStocks() {

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const sheet = ss.getActiveSheet();


  if (sheet.getName() !== WB_FBS_EDIT_CFG.OUT_SHEET) {

    SpreadsheetApp.getUi().alert(
      'Откройте лист "' +
      WB_FBS_EDIT_CFG.OUT_SHEET +
      '" и выделите изменённые остатки.'
    );

    return;
  }


  const range = sheet.getActiveRange();


  if (!range) {

    SpreadsheetApp.getUi().alert(
      'Сначала выделите ячейки с остатками.'
    );

    return;
  }


  try {

    const result = wbFbsCollectSelectedChanges_(
      sheet,
      range
    );


    wbFbsShowResult_(result);


  } catch (e) {

    SpreadsheetApp
      .getUi()
      .alert(
        'WB FBS — ошибка',
        String(
          e && e.message
            ? e.message
            : e
        ),
        SpreadsheetApp.getUi().ButtonSet.OK
      );

  }
}


/**
 * =========================================================
 * ФУНКЦИЯ ДЛЯ КНОПКИ
 * =========================================================
 */
function wbFbsEditStocksButton() {

  wbFbsUpdateSelectedStocks();

}


/**
 * =========================================================
 * ОТПРАВИТЬ ВСЮ ТАБЛИЦУ
 * =========================================================
 *
 * Осторожно:
 * отправляет все заполненные остатки всех складов.
 *
 * Пустые ячейки пропускаются.
 */
function wbFbsUpdateAllFilledStocks() {

  const ss =
    SpreadsheetApp.getActiveSpreadsheet();


  const sheet =
    ss.getSheetByName(
      WB_FBS_EDIT_CFG.OUT_SHEET
    );


  if (!sheet) {

    SpreadsheetApp
      .getUi()
      .alert(
        'Лист "' +
        WB_FBS_EDIT_CFG.OUT_SHEET +
        '" не найден.'
      );

    return;
  }


  const ui =
    SpreadsheetApp.getUi();


  const answer =
    ui.alert(
      'Обновить ВСЕ остатки?',
      'Будут отправлены все заполненные числовые значения из колонок складов.\n\n' +
      'Пустые ячейки будут пропущены.\n' +
      '0 будет отправлен как нулевой остаток.',
      ui.ButtonSet.YES_NO
    );


  if (answer !== ui.Button.YES) {

    return;

  }


  const lastRow =
    sheet.getLastRow();


  const lastCol =
    sheet.getLastColumn();


  if (
    lastRow <
    WB_FBS_EDIT_CFG.OUT_FIRST_DATA_ROW
  ) {

    ui.alert(
      'На листе нет строк с товарами.'
    );

    return;
  }


  const range =
    sheet.getRange(
      WB_FBS_EDIT_CFG.OUT_FIRST_DATA_ROW,
      1,
      lastRow -
        WB_FBS_EDIT_CFG.OUT_FIRST_DATA_ROW +
        1,
      lastCol
    );


  try {

    const result =
      wbFbsCollectSelectedChanges_(
        sheet,
        range
      );


    wbFbsShowResult_(result);


  } catch (e) {

    ui.alert(
      'WB FBS — ошибка',
      String(
        e && e.message
          ? e.message
          : e
      ),
      ui.ButtonSet.OK
    );

  }
}


/**
 * =========================================================
 * СОБИРАЕМ ИЗМЕНЕНИЯ
 * =========================================================
 */
function wbFbsCollectSelectedChanges_(
  sheet,
  selectedRange
) {

  /*
   * 1. Определяем колонки Лист1
   */
  const headerInfo =
    wbFbsGetOutputHeaders_(sheet);


  /*
   * 2. Читаем Номенклатуры
   * и строим соответствия:
   *
   * кабинет + barcode -> chrtId
   */
  const nomMap =
    wbFbsBuildChrtIdMap_();


  /*
   * 3. Получаем актуальные склады WB
   */
  const warehouses =
    wbFbsLoadAllWarehouses_();


  /*
   * 4. Связываем колонки таблицы
   * с реальными warehouseId
   */
  const warehouseByCol =
    wbFbsBuildWarehouseColumnMap_(
      headerInfo,
      warehouses
    );


  /*
   * Не берём строки выше первой строки данных
   */
  const selection =
    wbFbsIntersectRange_(
      selectedRange,
      WB_FBS_EDIT_CFG.OUT_FIRST_DATA_ROW,
      1,
      sheet.getLastRow(),
      sheet.getLastColumn()
    );


  if (!selection) {

    return {

      sentItems: 0,

      sentRequests: 0,

      skipped: 0,

      errors: [
        'Выделение не содержит строк с товарами.'
      ]

    };

  }


  /*
   * Значения выделения
   */
  const values =
    selection.getValues();


  const startRow =
    selection.getRow();


  const startCol =
    selection.getColumn();


  /*
   * Нам нужны метаданные всей строки:
   *
   * кабинет
   * баркод
   * nmId
   * размер
   */
  const rowMeta =
    sheet
      .getRange(
        startRow,
        1,
        values.length,
        sheet.getLastColumn()
      )
      .getDisplayValues();


  /*
   * Группы:
   *
   * cabinet + warehouseId
   *
   * =>
   *
   * [
   *   chrtId,
   *   amount
   * ]
   */
  const groups = {};


  const errors = [];


  let skipped = 0;


  /*
   * =====================================================
   * ПРОХОДИМ ПО ВЫДЕЛЕННЫМ ЯЧЕЙКАМ
   * =====================================================
   */
  for (
    let r = 0;
    r < values.length;
    r++
  ) {

    const sheetRow =
      startRow + r;


    const meta =
      rowMeta[r];


    /*
     * Кабинет
     */
    const cabinet =
      wbFbsStr_(
        meta[
          headerInfo.colCab - 1
        ]
      );


    if (!cabinet) {

      skipped++;

      continue;
    }


    /*
     * Баркод
     */
    const barcode =
      wbFbsStr_(
        meta[
          headerInfo.colBarcode - 1
        ]
      );


    /*
     * Артикул WB
     */
    const nmId =
      wbFbsStr_(
        meta[
          headerInfo.colNmId - 1
        ]
      );


    /*
     * Размер
     */
    const size =
      wbFbsStr_(
        meta[
          headerInfo.colSize - 1
        ]
      );


    /*
     * Находим chrtID
     */
    const chrtId =
      wbFbsResolveChrtId_(
        nomMap,
        cabinet,
        barcode,
        nmId,
        size
      );


    /*
     * Теперь перебираем ячейки строки
     */
    for (
      let c = 0;
      c < values[r].length;
      c++
    ) {

      const sheetCol =
        startCol + c;


      /*
       * Проверяем:
       * является ли эта колонка складом
       */
      const warehouse =
        warehouseByCol[sheetCol];


      /*
       * Например пользователь выделил:
       *
       * Артикул
       * Название
       * Итого
       *
       * Их просто игнорируем.
       */
      if (!warehouse) {

        continue;

      }


      /*
       * Склад должен принадлежать
       * тому же кабинету.
       */
      if (
        wbFbsNorm_(
          warehouse.cab
        ) !==
        wbFbsNorm_(
          cabinet
        )
      ) {

        continue;

      }


      /*
       * Значение остатка
       */
      const raw =
        values[r][c];


      /*
       * Пустая ячейка =
       * ничего не менять.
       */
      if (
        raw === '' ||
        raw === null
      ) {

        skipped++;

        continue;

      }


      /*
       * Проверяем количество
       */
      const amountResult =
        wbFbsParseAmount_(raw);


      if (!amountResult.ok) {

        errors.push(
          'Строка ' +
          sheetRow +
          ', склад "' +
          warehouse.name +
          '": ' +
          amountResult.error
        );

        continue;

      }


      /*
       * Если chrtId не нашли —
       * НЕ отправляем ничего.
       */
      if (!chrtId) {

        errors.push(
          'Строка ' +
          sheetRow +
          ': не найден chrtID. ' +
          'Кабинет="' +
          cabinet +
          '", баркод="' +
          barcode +
          '", WB="' +
          nmId +
          '", размер="' +
          size +
          '".'
        );

        continue;

      }


      /*
       * Ключ:
       *
       * кабинет + warehouseId
       */
      const groupKey =
        wbFbsNorm_(
          warehouse.cab
        ) +
        '||' +
        String(
          warehouse.id
        );


      if (!groups[groupKey]) {

        groups[groupKey] = {

          cab:
            warehouse.cab,

          warehouseId:
            warehouse.id,

          warehouseName:
            warehouse.name,

          itemsByChrtId: {}

        };

      }


      /*
       * Если один и тот же chrtId
       * попался дважды —
       * последнее значение побеждает.
       */
      groups[groupKey]
        .itemsByChrtId[
          String(chrtId)
        ] = {

          chrtId:
            Number(chrtId),

          amount:
            amountResult.value,

          row:
            sheetRow

        };

    }

  }


  /*
   * =====================================================
   * ВАЖНО
   *
   * Если есть хоть одна ошибка подготовки —
   * ничего не отправляем.
   *
   * Это защита от частичной случайной отправки.
   * =====================================================
   */
  if (errors.length) {

    return {

      sentItems: 0,

      sentRequests: 0,

      skipped:
        skipped,

      errors:
        errors

    };

  }


  /*
   * Отправляем в WB
   */
  const result =
    wbFbsSendGroups_(
      groups
    );


  result.skipped =
    skipped;


  /*
   * После успешной отправки
   * пересчитываем колонку Итого
   */
  if (
    !result.errors.length &&
    result.sentItems > 0
  ) {

    wbFbsRecalcTotals_(
      sheet,
      headerInfo,
      warehouseByCol,
      selection
    );

  }


  return result;

}


/**
 * =========================================================
 * ОТПРАВКА В WB
 * =========================================================
 */
function wbFbsSendGroups_(groups) {

  let sentItems =
    0;


  let sentRequests =
    0;


  const errors =
    [];


  const keys =
    Object.keys(groups);


  /*
   * Каждая группа =
   *
   * один кабинет
   * один склад
   */
  for (
    let g = 0;
    g < keys.length;
    g++
  ) {

    const group =
      groups[keys[g]];


    /*
     * Получаем токен
     */
    const token =
      wbFbsGetTokenForCabinet_(
        group.cab
      );


    if (!token) {

      errors.push(
        'Нет токена для кабинета "' +
        group.cab +
        '".'
      );

      continue;

    }


    /*
     * Формируем массив WB
     */
    const items =
      Object
        .keys(
          group.itemsByChrtId
        )
        .map(
          function(key) {

            const item =
              group
                .itemsByChrtId[
                  key
                ];


            return {

              chrtId:
                item.chrtId,

              amount:
                item.amount

            };

          }
        );


    /*
     * Максимум 1000 позиций
     * на запрос.
     */
    const chunks =
      wbFbsChunk_(
        items,
        WB_FBS_EDIT_CFG
          .MAX_STOCKS_PER_REQUEST
      );


    /*
     * Отправляем пачки
     */
    for (
      let i = 0;
      i < chunks.length;
      i++
    ) {

      const url =
        WB_FBS_EDIT_CFG
          .MP_HOST +

        WB_FBS_EDIT_CFG
          .STOCKS_PATH
          .replace(
            '{warehouseId}',
            encodeURIComponent(
              group.warehouseId
            )
          );


      const payload = {

        stocks:
          chunks[i]

      };


      const resp =
        wbFbsRequest_(
          url,
          token,
          'put',
          payload
        );


      sentRequests++;


      /*
       * Вообще нет ответа
       */
      if (!resp) {

        errors.push(
          'Нет ответа WB: ' +
          group.cab +
          ' / ' +
          group.warehouseName +
          ' / пачка ' +
          (i + 1)
        );

        continue;

      }


      /*
       * 204 =
       * успешно
       */
      if (
        resp.code === 204
      ) {

        sentItems +=
          chunks[i].length;

      } else {

        errors.push(
          wbFbsFormatApiError_(
            resp,
            group.cab,
            group.warehouseName,
            i + 1
          )
        );

      }


      Utilities.sleep(
        WB_FBS_EDIT_CFG.PAUSE_MS
      );

    }

  }


  return {

    sentItems:
      sentItems,

    sentRequests:
      sentRequests,

    skipped: 0,

    errors:
      errors

  };

}


/**
 * =========================================================
 * СТРОИМ КАРТУ chrtID
 * =========================================================
 *
 * Основной поиск:
 *
 * кабинет + barcode
 *
 * Резервный:
 *
 * кабинет + nmId + размер
 */
function wbFbsBuildChrtIdMap_() {

  const ss =
    SpreadsheetApp.getActiveSpreadsheet();


  const sh =
    ss.getSheetByName(
      WB_FBS_EDIT_CFG.NOM_SHEET
    );


  if (!sh) {

    throw new Error(
      'Лист "' +
      WB_FBS_EDIT_CFG.NOM_SHEET +
      '" не найден.'
    );

  }


  const lastRow =
    sh.getLastRow();


  const lastCol =
    sh.getLastColumn();


  if (
    lastRow <
    WB_FBS_EDIT_CFG.NOM_FIRST_DATA_ROW
  ) {

    throw new Error(
      'На листе "' +
      WB_FBS_EDIT_CFG.NOM_SHEET +
      '" нет данных.'
    );

  }


  /*
   * Читаем заголовки
   */
  const headers =
    sh
      .getRange(
        WB_FBS_EDIT_CFG.NOM_HEADER_ROW,
        1,
        1,
        lastCol
      )
      .getDisplayValues()[0];


  /*
   * Ищем нужные колонки
   */
  const idxCab =
    wbFbsFindHeaderIndex_(
      headers,
      WB_FBS_EDIT_CFG.NOM_HEADER_CAB
    );


  const idxBarcode =
    wbFbsFindHeaderIndex_(
      headers,
      WB_FBS_EDIT_CFG.NOM_HEADER_BARCODE
    );


  const idxChrt =
    wbFbsFindHeaderIndex_(
      headers,
      WB_FBS_EDIT_CFG.NOM_HEADER_CHRTID
    );


  const idxNm =
    wbFbsFindHeaderIndex_(
      headers,
      WB_FBS_EDIT_CFG.NOM_HEADER_NMID
    );


  const idxSize =
    wbFbsFindHeaderIndex_(
      headers,
      WB_FBS_EDIT_CFG.NOM_HEADER_SIZE
    );


  /*
   * Минимально обязательные поля
   */
  if (
    idxCab < 0 ||
    idxBarcode < 0 ||
    idxChrt < 0
  ) {

    throw new Error(
      'На листе "' +
      WB_FBS_EDIT_CFG.NOM_SHEET +
      '" нужны заголовки:\n\n' +

      '"' +
      WB_FBS_EDIT_CFG.NOM_HEADER_CAB +
      '"\n' +

      '"' +
      WB_FBS_EDIT_CFG.NOM_HEADER_BARCODE +
      '"\n' +

      '"' +
      WB_FBS_EDIT_CFG.NOM_HEADER_CHRTID +
      '"'
    );

  }


  /*
   * Читаем все товары
   */
  const rows =
    sh
      .getRange(
        WB_FBS_EDIT_CFG.NOM_FIRST_DATA_ROW,
        1,
        lastRow -
          WB_FBS_EDIT_CFG.NOM_FIRST_DATA_ROW +
          1,
        lastCol
      )
      .getDisplayValues();


  const byBarcode =
    {};


  const byNmSize =
    {};


  for (
    let r = 0;
    r < rows.length;
    r++
  ) {

    const row =
      rows[r];


    const cab =
      wbFbsStr_(
        row[idxCab]
      );


    const barcode =
      wbFbsStr_(
        row[idxBarcode]
      );


    const chrtId =
      wbFbsStr_(
        row[idxChrt]
      );


    const nmId =
      idxNm >= 0
        ? wbFbsStr_(
            row[idxNm]
          )
        : '';


    const size =
      idxSize >= 0
        ? wbFbsStr_(
            row[idxSize]
          )
        : '';


    /*
     * Без кабинета/chrtID
     * запись бесполезна.
     */
    if (
      !cab ||
      !chrtId
    ) {

      continue;

    }


    /*
     * chrtID должен быть числом
     */
    if (
      !/^\d+$/.test(
        chrtId
      )
    ) {

      continue;

    }


    /*
     * Основной словарь:
     *
     * кабинет + barcode
     */
    if (barcode) {

      byBarcode[
        wbFbsNorm_(cab) +
        '||' +
        barcode
      ] =
        chrtId;

    }


    /*
     * Резерв:
     *
     * кабинет + nmId + размер
     */
    if (
      nmId ||
      size
    ) {

      byNmSize[
        wbFbsNorm_(cab) +
        '||' +
        nmId +
        '||' +
        wbFbsNorm_(size)
      ] =
        chrtId;

    }

  }


  return {

    byBarcode:
      byBarcode,

    byNmSize:
      byNmSize

  };

}


/**
 * =========================================================
 * НАЙТИ chrtID
 * =========================================================
 */
function wbFbsResolveChrtId_(
  map,
  cabinet,
  barcode,
  nmId,
  size
) {

  const cab =
    wbFbsNorm_(
      cabinet
    );


  /*
   * Сначала по баркоду
   */
  if (barcode) {

    const result =
      map.byBarcode[
        cab +
        '||' +
        barcode
      ];


    if (result) {

      return result;

    }

  }


  /*
   * Резервный поиск
   */
  const result =
    map.byNmSize[
      cab +
      '||' +
      nmId +
      '||' +
      wbFbsNorm_(size)
    ];


  return result || '';

}


/**
 * =========================================================
 * ПОЛУЧАЕМ ВСЕ СКЛАДЫ WB
 * =========================================================
 */
function wbFbsLoadAllWarehouses_() {

  const out =
    [];


  /*
   * По каждому кабинету
   */
  for (
    let i = 0;
    i <
    WB_FBS_EDIT_CFG.CABINETS.length;
    i++
  ) {

    const cab =
      WB_FBS_EDIT_CFG.CABINETS[i];


    const token =
      wbFbsGetToken_(
        cab.tokenCell
      );


    /*
     * Если кабинет без токена —
     * пропускаем.
     */
    if (!token) {

      continue;

    }


    const url =
      WB_FBS_EDIT_CFG.MP_HOST +
      WB_FBS_EDIT_CFG.WAREHOUSES_PATH;


    const resp =
      wbFbsRequest_(
        url,
        token,
        'get',
        null
      );


    if (
      !resp ||
      resp.code !== 200
    ) {

      throw new Error(
        'Не удалось получить склады кабинета "' +
        cab.name +
        '". HTTP ' +
        (
          resp
            ? resp.code
            : 'NO_RESPONSE'
        ) +
        '. ' +
        (
          resp
            ? resp.text
            : ''
        )
      );

    }


    let list =
      resp.json;


    /*
     * На всякий случай поддерживаем
     * вариант data:[]
     */
    if (
      !Array.isArray(list) &&
      list &&
      Array.isArray(list.data)
    ) {

      list =
        list.data;

    }


    if (
      !Array.isArray(list)
    ) {

      list =
        [];

    }


    for (
      let w = 0;
      w < list.length;
      w++
    ) {

      const warehouse =
        list[w] || {};


      const id =
        warehouse.id !== undefined
          ? warehouse.id
          : warehouse.warehouseId;


      const name =
        wbFbsStr_(
          warehouse.name !== undefined
            ? warehouse.name
            : warehouse.warehouseName
        );


      if (
        id === undefined ||
        id === null ||
        !name
      ) {

        continue;

      }


      out.push({

        cab:
          cab.name,

        id:
          id,

        name:
          name

      });

    }


    Utilities.sleep(
      WB_FBS_EDIT_CFG.PAUSE_MS
    );

  }


  if (!out.length) {

    throw new Error(
      'WB не вернул ни одного склада продавца.'
    );

  }


  return out;

}


/**
 * =========================================================
 * СВЯЗЫВАЕМ ЗАГОЛОВОК СКЛАДА С warehouseId
 * =========================================================
 *
 * Повторяем принцип твоего текущего
 * скрипта выгрузки.
 *
 * Если название склада уникально:
 *
 * Москва
 *
 * Если одинаковое у нескольких кабинетов:
 *
 * Москва (МАНИ)
 * Москва (МИРОС)
 */
function wbFbsBuildWarehouseColumnMap_(
  headerInfo,
  warehouses
) {

  /*
   * Считаем одинаковые имена
   */
  const nameCount =
    {};


  warehouses.forEach(
    function(warehouse) {

      nameCount[
        warehouse.name
      ] =
        (
          nameCount[
            warehouse.name
          ] || 0
        ) + 1;

    }
  );


  const usedHeaders =
    {};


  const expected =
    [];


  /*
   * Формируем ожидаемый заголовок
   */
  warehouses.forEach(
    function(warehouse) {

      let header =
        warehouse.name;


      /*
       * Если одинаковые имена —
       * добавляем кабинет
       */
      if (
        nameCount[
          warehouse.name
        ] > 1
      ) {

        header =
          warehouse.name +
          ' (' +
          warehouse.cab +
          ')';

      }


      /*
       * Теоретическая защита
       * от полного дубля
       */
      if (
        usedHeaders[header]
      ) {

        header =
          header +
          ' [' +
          warehouse.id +
          ']';

      }


      usedHeaders[header] =
        true;


      expected.push({

        header:
          header,

        cab:
          warehouse.cab,

        id:
          warehouse.id,

        name:
          warehouse.name

      });

    }
  );


  /*
   * Быстрый словарь:
   *
   * название колонки ->
   * warehouse
   */
  const byNormalizedHeader =
    {};


  expected.forEach(
    function(item) {

      byNormalizedHeader[
        wbFbsNorm_(
          item.header
        )
      ] =
        item;

    }
  );


  /*
   * Реальная колонка листа ->
   * warehouse
   */
  const map =
    {};


  for (
    let col = 1;
    col < headerInfo.headers.length;
    col++
  ) {

    const header =
      wbFbsNorm_(
        headerInfo.headers[col]
      );


    const warehouse =
      byNormalizedHeader[
        header
      ];


    if (warehouse) {

      map[col] =
        warehouse;

    }

  }


  /*
   * Если вообще ничего
   * не сопоставилось
   */
  if (
    !Object.keys(map).length
  ) {

    throw new Error(
      'Не удалось сопоставить колонки складов на листе "' +
      WB_FBS_EDIT_CFG.OUT_SHEET +
      '" с актуальными складами WB.\n\n' +
      'Сначала обнови выгрузку остатков.'
    );

  }


  return map;

}


/**
 * =========================================================
 * ЧИТАЕМ ЗАГОЛОВКИ Лист1
 * =========================================================
 */
function wbFbsGetOutputHeaders_(
  sheet
) {

  const lastCol =
    sheet.getLastColumn();


  const values =
    sheet
      .getRange(
        WB_FBS_EDIT_CFG.OUT_HEADER_ROW,
        1,
        1,
        lastCol
      )
      .getDisplayValues()[0];


  /*
   * Делаем массив,
   * индекс которого совпадает
   * с номером колонки Google Sheets.
   *
   * headers[2] = B
   */
  const headers =
    [''];


  for (
    let i = 0;
    i < values.length;
    i++
  ) {

    headers[
      i + 1
    ] =
      wbFbsStr_(
        values[i]
      );

  }


  const colCab =
    wbFbsFindHeaderColumn_(
      headers,
      WB_FBS_EDIT_CFG.HEADER_CAB
    );


  const colBarcode =
    wbFbsFindHeaderColumn_(
      headers,
      WB_FBS_EDIT_CFG.HEADER_BARCODE
    );


  const colNmId =
    wbFbsFindHeaderColumn_(
      headers,
      WB_FBS_EDIT_CFG.HEADER_NMID
    );


  const colSize =
    wbFbsFindHeaderColumn_(
      headers,
      WB_FBS_EDIT_CFG.HEADER_SIZE
    );


  const colTotal =
    wbFbsFindHeaderColumn_(
      headers,
      WB_FBS_EDIT_CFG.HEADER_TOTAL
    );


  /*
   * Проверяем обязательные заголовки
   */
  if (
    !colCab ||
    !colBarcode ||
    !colNmId ||
    !colSize
  ) {

    throw new Error(
      'На строке ' +
      WB_FBS_EDIT_CFG.OUT_HEADER_ROW +
      ' листа "' +
      WB_FBS_EDIT_CFG.OUT_SHEET +
      '" не найдены обязательные заголовки:\n\n' +

      WB_FBS_EDIT_CFG.HEADER_CAB +
      '\n' +

      WB_FBS_EDIT_CFG.HEADER_BARCODE +
      '\n' +

      WB_FBS_EDIT_CFG.HEADER_NMID +
      '\n' +

      WB_FBS_EDIT_CFG.HEADER_SIZE
    );

  }


  return {

    headers:
      headers,

    colCab:
      colCab,

    colBarcode:
      colBarcode,

    colNmId:
      colNmId,

    colSize:
      colSize,

    colTotal:
      colTotal

  };

}


/**
 * =========================================================
 * ПЕРЕСЧИТАТЬ "ИТОГО"
 * =========================================================
 */
function wbFbsRecalcTotals_(
  sheet,
  headerInfo,
  warehouseByCol,
  selection
) {

  /*
   * Если колонки Итого нет —
   * просто ничего не делаем.
   */
  if (!headerInfo.colTotal) {

    return;

  }


  const firstRow =
    selection.getRow();


  const numRows =
    selection.getNumRows();


  const lastCol =
    sheet.getLastColumn();


  /*
   * Реальные числовые значения
   */
  const rawRows =
    sheet
      .getRange(
        firstRow,
        1,
        numRows,
        lastCol
      )
      .getValues();


  /*
   * Текстовые значения
   * для кабинета
   */
  const displayRows =
    sheet
      .getRange(
        firstRow,
        1,
        numRows,
        lastCol
      )
      .getDisplayValues();


  const warehouseCols =
    Object
      .keys(
        warehouseByCol
      )
      .map(Number);


  const totals =
    [];


  for (
    let r = 0;
    r < numRows;
    r++
  ) {

    const cab =
      wbFbsNorm_(
        displayRows[r][
          headerInfo.colCab - 1
        ]
      );


    let total =
      0;


    /*
     * Суммируем только склады
     * этого кабинета.
     */
    if (cab) {

      for (
        let i = 0;
        i < warehouseCols.length;
        i++
      ) {

        const col =
          warehouseCols[i];


        const warehouse =
          warehouseByCol[col];


        if (
          wbFbsNorm_(
            warehouse.cab
          ) !== cab
        ) {

          continue;

        }


        const raw =
          rawRows[r][
            col - 1
          ];


        /*
         * Пустые/нечисловые
         * значения не учитываем.
         */
        if (
          raw === '' ||
          raw === null
        ) {

          continue;

        }


        const parsed =
          wbFbsParseAmount_(raw);


        if (parsed.ok) {

          total +=
            parsed.value;

        }

      }

    }


    totals.push(
      [total]
    );

  }


  sheet
    .getRange(
      firstRow,
      headerInfo.colTotal,
      numRows,
      1
    )
    .setValues(
      totals
    );

}


/**
 * =========================================================
 * РЕЗУЛЬТАТ
 * =========================================================
 */
function wbFbsShowResult_(result) {

  const ui =
    SpreadsheetApp.getUi();


  const ss =
    SpreadsheetApp.getActiveSpreadsheet();


  /*
   * Если есть ошибки
   */
  if (
    result.errors &&
    result.errors.length
  ) {

    const shown =
      result.errors.slice(
        0,
        12
      );


    let text =
      'Остатки не отправлены или отправлены частично.\n\n' +
      shown.join(
        '\n\n'
      );


    if (
      result.errors.length >
      shown.length
    ) {

      text +=
        '\n\nИ ещё ошибок: ' +
        (
          result.errors.length -
          shown.length
        );

    }


    text +=
      '\n\nУспешно отправлено позиций: ' +
      result.sentItems;


    ui.alert(
      'WB FBS — есть ошибки',
      text,
      ui.ButtonSet.OK
    );


    return;

  }


  /*
   * Ничего не нашли
   */
  if (!result.sentItems) {

    ui.alert(
      'Нечего отправлять',

      'В выделении нет заполненных числовых ячеек складов нужного кабинета.\n\n' +
      'Пустая ячейка = пропуск.\n' +
      '0 = установить остаток 0.',

      ui.ButtonSet.OK
    );


    return;

  }


  /*
   * Успех
   */
  ss.toast(

    'WB обновил остатки: ' +
    result.sentItems +
    ' позиций. Запросов: ' +
    result.sentRequests,

    'WB FBS',

    8

  );

}


/**
 * =========================================================
 * ПРОВЕРКА ОСТАТКА
 * =========================================================
 */
function wbFbsParseAmount_(value) {

  /*
   * Пусто
   */
  if (
    value === '' ||
    value === null ||
    value === undefined
  ) {

    return {

      ok: false,

      error:
        'пустое значение'

    };

  }


  let number;


  /*
   * Если Google Sheets уже
   * вернул число
   */
  if (
    typeof value === 'number'
  ) {

    number =
      value;

  } else {

    /*
     * На случай:
     *
     * "10"
     * "10,0"
     */
    const string =
      String(value)
        .trim()
        .replace(
          ',',
          '.'
        );


    if (
      !/^\d+(?:\.\d+)?$/.test(
        string
      )
    ) {

      return {

        ok: false,

        error:
          'остаток должен быть числом 0 или больше'

      };

    }


    number =
      Number(string);

  }


  /*
   * Не число / отрицательное
   */
  if (
    !Number.isFinite(number) ||
    number < 0
  ) {

    return {

      ok: false,

      error:
        'остаток должен быть числом 0 или больше'

    };

  }


  /*
   * Остаток только целый
   */
  if (
    Math.floor(number) !== number
  ) {

    return {

      ok: false,

      error:
        'остаток должен быть целым числом'

    };

  }


  return {

    ok: true,

    value:
      number

  };

}


/**
 * =========================================================
 * API ERROR
 * =========================================================
 */
function wbFbsFormatApiError_(
  resp,
  cab,
  warehouseName,
  chunkNo
) {

  let detail =
    wbFbsStr_(
      resp.text
    );


  if (
    detail.length > 700
  ) {

    detail =
      detail.slice(
        0,
        700
      ) +
      '...';

  }


  let hint =
    '';


  /*
   * 406
   */
  if (
    resp.code === 406
  ) {

    hint =
      ' Обновление остатков временно заблокировано WB для склада.';

  }


  /*
   * 409
   */
  else if (
    resp.code === 409
  ) {

    hint =
      ' WB отклонил обновление. Смотри тело ответа.';

  }


  /*
   * 401 / 403
   */
  else if (
    resp.code === 401 ||
    resp.code === 403
  ) {

    hint =
      ' Проверь токен категории «Маркетплейс».';

  }


  /*
   * 404
   */
  else if (
    resp.code === 404
  ) {

    hint =
      ' Проверь warehouseId и актуальность складов.';

  }


  /*
   * 429
   */
  else if (
    resp.code === 429
  ) {

    hint =
      ' Превышен лимит запросов WB.';

  }


  return (
    'HTTP ' +
    resp.code +
    ': ' +
    cab +
    ' / ' +
    warehouseName +
    ' / пачка ' +
    chunkNo +
    '.' +
    hint +
    (
      detail
        ? '\n' + detail
        : ''
    )
  );

}


/**
 * =========================================================
 * HTTP REQUEST
 * =========================================================
 */
function wbFbsRequest_(
  url,
  token,
  method,
  payload
) {

  const options = {

    method:
      method || 'get',

    headers: {

      Authorization:
        String(token).trim(),

      Accept:
        'application/json'

    },

    muteHttpExceptions:
      true

  };


  /*
   * JSON body
   */
  if (
    payload !== null &&
    payload !== undefined
  ) {

    options.contentType =
      'application/json';


    options.payload =
      JSON.stringify(
        payload
      );

  }


  /*
   * RETRY
   */
  for (
    let attempt = 1;
    attempt <=
    WB_FBS_EDIT_CFG.MAX_RETRIES;
    attempt++
  ) {

    try {

      const response =
        UrlFetchApp.fetch(
          url,
          options
        );


      const code =
        response.getResponseCode();


      const text =
        response.getContentText();


      let json =
        null;


      try {

        json =
          text
            ? JSON.parse(text)
            : null;

      } catch (e) {

        json =
          null;

      }


      /*
       * Повторяем:
       *
       * 429
       * 500+
       */
      if (
        (
          code === 429 ||
          code >= 500
        ) &&
        attempt <
        WB_FBS_EDIT_CFG.MAX_RETRIES
      ) {

        Utilities.sleep(
          WB_FBS_EDIT_CFG
            .RETRY_PAUSE_MS *
          attempt
        );


        continue;

      }


      return {

        code:
          code,

        text:
          text,

        json:
          json

      };


    } catch (e) {


      if (
        attempt <
        WB_FBS_EDIT_CFG.MAX_RETRIES
      ) {

        Utilities.sleep(
          WB_FBS_EDIT_CFG
            .RETRY_PAUSE_MS *
          attempt
        );


        continue;

      }


      return null;

    }

  }


  return null;

}


/**
 * =========================================================
 * ТОКЕН КАБИНЕТА
 * =========================================================
 */
function wbFbsGetTokenForCabinet_(
  cabinetName
) {

  const norm =
    wbFbsNorm_(
      cabinetName
    );


  for (
    let i = 0;
    i <
    WB_FBS_EDIT_CFG.CABINETS.length;
    i++
  ) {

    const cab =
      WB_FBS_EDIT_CFG.CABINETS[i];


    if (
      wbFbsNorm_(
        cab.name
      ) === norm
    ) {

      return wbFbsGetToken_(
        cab.tokenCell
      );

    }

  }


  return '';

}


/**
 * =========================================================
 * ПРОЧИТАТЬ ТОКЕН
 * =========================================================
 */
function wbFbsGetToken_(cell) {

  const ss =
    SpreadsheetApp.getActiveSpreadsheet();


  const sh =
    ss.getSheetByName(
      WB_FBS_EDIT_CFG.KEY_SHEET
    );


  if (!sh) {

    throw new Error(
      'Лист "' +
      WB_FBS_EDIT_CFG.KEY_SHEET +
      '" не найден.'
    );

  }


  return String(
    sh
      .getRange(cell)
      .getDisplayValue() ||
    ''
  ).trim();

}


/**
 * =========================================================
 * ПЕРЕСЕЧЕНИЕ ДИАПАЗОНА
 * =========================================================
 */
function wbFbsIntersectRange_(
  range,
  minRow,
  minCol,
  maxRow,
  maxCol
) {

  const r1 =
    Math.max(
      range.getRow(),
      minRow
    );


  const c1 =
    Math.max(
      range.getColumn(),
      minCol
    );


  const r2 =
    Math.min(
      range.getLastRow(),
      maxRow
    );


  const c2 =
    Math.min(
      range.getLastColumn(),
      maxCol
    );


  if (
    r1 > r2 ||
    c1 > c2
  ) {

    return null;

  }


  return range
    .getSheet()
    .getRange(
      r1,
      c1,
      r2 - r1 + 1,
      c2 - c1 + 1
    );

}


/**
 * =========================================================
 * НАЙТИ ЗАГОЛОВОК — INDEX 0-based
 * =========================================================
 */
function wbFbsFindHeaderIndex_(
  headers,
  target
) {

  const norm =
    wbFbsNorm_(
      target
    );


  for (
    let i = 0;
    i < headers.length;
    i++
  ) {

    if (
      wbFbsNorm_(
        headers[i]
      ) === norm
    ) {

      return i;

    }

  }


  return -1;

}


/**
 * =========================================================
 * НАЙТИ НОМЕР КОЛОНКИ GOOGLE SHEETS
 * =========================================================
 */
function wbFbsFindHeaderColumn_(
  headers,
  target
) {

  const norm =
    wbFbsNorm_(
      target
    );


  for (
    let col = 1;
    col < headers.length;
    col++
  ) {

    if (
      wbFbsNorm_(
        headers[col]
      ) === norm
    ) {

      return col;

    }

  }


  return 0;

}


/**
 * =========================================================
 * РАЗБИТЬ МАССИВ НА ПАЧКИ
 * =========================================================
 */
function wbFbsChunk_(
  array,
  size
) {

  const out =
    [];


  for (
    let i = 0;
    i < array.length;
    i += size
  ) {

    out.push(
      array.slice(
        i,
        i + size
      )
    );

  }


  return out;

}


/**
 * =========================================================
 * SAFE STRING
 * =========================================================
 */
function wbFbsStr_(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return '';

  }


  return String(
    value
  ).trim();

}


/**
 * =========================================================
 * NORMALIZE
 * =========================================================
 */
function wbFbsNorm_(value) {

  return String(
    value === null ||
    value === undefined
      ? ''
      : value
  )

    .replace(
      /\u00A0/g,
      ' '
    )

    .trim()

    .toLowerCase();

}