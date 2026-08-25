const WB_KEY_SHEET_NAME = 'Key';
const START_ROW = 2;
const TOKEN_COL = 2;
const PING_SLEEP_MS = 350;
const CACHE_PREFIX = 'WB_KEY_PING_';

const WB_SCOPES = {
  1: ['Content', 'https://content-api.wildberries.ru/ping'],
  2: ['Analytics', 'https://seller-analytics-api.wildberries.ru/ping'],
  3: ['Prices and discounts', 'https://discounts-prices-api.wildberries.ru/ping'],
  4: ['Marketplace', 'https://marketplace-api.wildberries.ru/ping'],
  5: ['Statistics', 'https://statistics-api.wildberries.ru/ping'],
  6: ['Promotion', 'https://advert-api.wildberries.ru/ping'],
  7: ['Feedbacks and Questions', 'https://feedbacks-api.wildberries.ru/ping'],
  9: ['Buyers chat', 'https://buyer-chat-api.wildberries.ru/ping'],
  10: ['Supplies', 'https://supplies-api.wildberries.ru/ping'],
  11: ['Buyers returns', 'https://returns-api.wildberries.ru/ping'],
  12: ['Documents', 'https://documents-api.wildberries.ru/ping'],
  13: ['Finance', 'https://finance-api.wildberries.ru/ping'],
  16: ['Users', 'https://user-management-api.wildberries.ru/ping'],
  30: ['Read only', null]
};

const WB_TYPES = {
  1: 'Base',
  2: 'Test',
  3: 'Personal',
  4: 'Service'
};

const HEADERS = [[
  'Статус',
  'Тип токена',
  'Срок действия',
  'Осталось дней',
  'ID кабинета',
  'Token ID',
  'Права',
  'Read only',
  'Test',
  'For',
  's bitmask',
  'Ping API'
]];



function decodeAllKeys() {
  runKeyCheck_(true);
}

function decodeAllKeysFast() {
  runKeyCheck_(false);
}

function runKeyCheck_(doPing) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(WB_KEY_SHEET_NAME);
  if (!sh) return SpreadsheetApp.getUi().alert('Не найден лист: ' + WB_KEY_SHEET_NAME);

  const lastRow = sh.getLastRow();
  if (lastRow < START_ROW) return;

  const t0 = Date.now();
  const rows = lastRow - START_ROW + 1;
  const cols = HEADERS[0].length;

  setStatus_(sh, '⏳ Проверка ключей WB...');
  ss.toast('Проверяю ключи WB...', 'Управление ключами', 5);

  if (JSON.stringify(sh.getRange(1, 3, 1, cols).getValues()) !== JSON.stringify(HEADERS)) {
    sh.getRange(1, 3, 1, cols).setValues(HEADERS);
  }

  const tokens = sh.getRange(START_ROW, TOKEN_COL, rows, 1).getValues();
  const oldData = sh.getRange(START_ROW, 3, rows, cols).getValues();

  const out = [];
  const colors = [];

  let total = 0;
  let active = 0;
  let expired = 0;
  let errors = 0;
  let freshPing = 0;
  let cachePing = 0;
  let savedPing = 0;

  tokens.forEach((r, i) => {
    const token = String(r[0] || '').trim();
    const oldPing = String((oldData[i] || [])[11] || '').trim();

    if (!token) {
      out.push(['', '', '', '', '', '', '', '', '', '', '', oldPing]);
      colors.push([null]);
      return;
    }

    total++;

    try {
      const p = decodeJwt_(token);
      const now = Math.floor(Date.now() / 1000);
      const exp = Number(p.exp || 0);
      const ok = exp > now;
      const bitmask = Number(p.s || 0);
      const scopes = getScopes_(bitmask);

      ok ? active++ : expired++;

      let ping = oldPing || 'Не проверялся';

      if (ok && doPing) {
        const pingData = getPing_(token, scopes);
        ping = pingData.value;
        pingData.cached ? cachePing++ : freshPing++;
      } else {
        savedPing++;
      }

      out.push([
        ok ? '✅ Активен' : '❌ Просрочен',
        WB_TYPES[p.acc] || p.acc || '',
        exp ? 'до ' + Utilities.formatDate(new Date(exp * 1000), Session.getScriptTimeZone(), 'dd.MM.yyyy') : '',
        exp ? Math.floor((exp - now) / 86400) : '',
       p.oid || p.sid || '',
        p.id || '',
        scopes.map(s => s.name).join(', '),
        hasBit_(bitmask, 30) ? 'Да' : 'Нет',
        p.t === true ? 'Да' : 'Нет',
        p.for || '',
        bitmask,
        ping
      ]);

      colors.push([ok ? '#d9ead3' : '#f4cccc']);

    } catch (e) {
      errors++;
      out.push(['❌ Ошибка декодирования', '', '', '', '', '', '', '', '', '', '', oldPing]);
      colors.push(['#f4cccc']);
    }
  });

  let writeStatus = 'изменений нет, таблица не перезаписывалась';

  if (JSON.stringify(oldData) !== JSON.stringify(out)) {
    sh.getRange(START_ROW, 3, rows, cols).setValues(out);
    sh.getRange(START_ROW, 3, rows, 1).setBackgrounds(colors);
    writeStatus = 'данные обновлены';
  }

  const msg =
    `✅ Готово: ключей ${total}, активных ${active}, просроченных ${expired}, ошибок ${errors}, ` +
    `ping новый ${freshPing}, ping из кэша ${cachePing}, ping сохранён ${savedPing}. ` +
    `${writeStatus}. ${Math.round((Date.now() - t0) / 1000)} сек.`;

  setStatus_(sh, msg);
  ss.toast(msg, 'Управление ключами', 8);
}

function getPing_(token, scopes) {
  const key = CACHE_PREFIX + today_() + '_' + hash_(token);
  const props = PropertiesService.getDocumentProperties();
  const cached = props.getProperty(key);

  if (cached) return { value: cached, cached: true };

  const pingScopes = scopes.filter(s => s.url);
  if (!pingScopes.length) return { value: 'Нет разделов для ping', cached: false };

  const results = pingScopes.map((s, i) => {
    if (i) Utilities.sleep(PING_SLEEP_MS);
    return pingOne_(token, s);
  });

  const value = reducePing_(results);
  props.setProperty(key, value);
  return { value, cached: false };
}

function pingOne_(token, scope) {
  try {
    const code = UrlFetchApp.fetch(scope.url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Authorization: token }
    }).getResponseCode();

    if (code === 200) return 200;
    if (code === 401) return 401;
    if (code === 403) return 403;
    if (code === 429) return 429;
    return code;

  } catch (e) {
    return 'ERR';
  }
}

function reducePing_(codes) {
  if (codes.includes(200)) return '✅ OK';
  if (codes.includes(401)) return '❌ 401';
  if (codes.includes(429)) return '⚠️ 429';
  if (codes.includes(403)) return '⚠️ 403';
  return '❌ Ошибка';
}

function getScopes_(mask) {
  return Object.keys(WB_SCOPES)
    .map(Number)
    .filter(bit => hasBit_(mask, bit))
    .map(bit => ({
      bit,
      name: WB_SCOPES[bit][0],
      url: WB_SCOPES[bit][1]
    }));
}

function hasBit_(mask, bit) {
  return (mask & Math.pow(2, bit)) !== 0;
}

function decodeJwt_(jwt) {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Некорректный JWT');

  let b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';

  return JSON.parse(
    Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString('UTF-8')
  );
}

function clearWbKeyCache() {
  const props = PropertiesService.getDocumentProperties();
  const all = props.getProperties();

  Object.keys(all).forEach(k => {
    if (k.indexOf(CACHE_PREFIX) === 0) props.deleteProperty(k);
  });

  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WB_KEY_SHEET_NAME);
  if (sh) setStatus_(sh, '🧹 Кэш ping очищен');

  SpreadsheetApp.getActiveSpreadsheet().toast('Кэш ping очищен', 'Управление ключами', 5);
}

function setStatus_(sh, text) {
  sh.getRange('A1').setValue(text);
  SpreadsheetApp.flush();
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function hash_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(b => ('0' + ((b < 0 ? b + 256 : b).toString(16))).slice(-2))
    .join('');
}