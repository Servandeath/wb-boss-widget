// Popup дёргает backend API напрямую при каждом открытии - никакого
// фонового поллинга (см. корневой README "Как это устроено": расширение
// не знает ни про WB, ни про Google Sheets, только спрашивает свой API).
//
// Секреты (API-токен) - только в chrome.storage.session (см. README,
// "Безопасность"), не в chrome.storage.local. Если токен не задан,
// запрос уйдёт без Authorization - backend сам решит, требовать его
// или нет (см. backend/app/config.API_TOKEN).

const API_BASE = "http://127.0.0.1:8000";
// Финансы приходят из еженедельного отчёта о реализации - последний
// день с ними бывает на 7-10 дней раньше сегодняшнего, отсюда запас.
const DAYS_BACK = 14;

// Блоки popup. У каждого своя "последняя дата": заказы и остатки -
// почти в реальном времени, финансы - с задержкой отчёта WB. marker -
// метрика, по которой ищем последний день с данными блока. Полный
// список метрик - в докстрингах backend/app/metrics/*.py.
const SECTIONS = [
  {
    title: "Заказы",
    marker: "orders",
    metrics: [
      ["orders", "Заказано", "count"],
      ["orders_sum", "На сумму", "rub"],
      ["cancels", "Отмены", "count"],
      ["buyouts", "Выкуплено", "count"],
    ],
  },
  {
    title: "Остатки",
    marker: "stock",
    metrics: [
      ["stock", "На складах WB", "count"],
      ["stock_seller", "На своём складе", "count"],
      ["stock_to_client", "В пути к клиенту", "count"],
      ["stock_from_client", "Возвращаются", "count"],
    ],
  },
  {
    title: "Финансы",
    marker: "payout",
    metrics: [
      ["revenue", "Выручка", "rub"],
      ["logistics", "Логистика", "rub"],
      ["penalties", "Штрафы", "rub"],
      ["ad_spend", "Реклама", "rub"],
      ["payout", "К перечислению", "rub"],
      ["cost", "Себестоимость", "rub"],
      ["margin", "Маржа", "rub"],
    ],
  },
];

const NUMBER_FORMAT = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });

function formatValue(value, kind) {
  return NUMBER_FORMAT.format(value) + (kind === "rub" ? " ₽" : " шт.");
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function getApiToken() {
  try {
    const { apiToken } = await chrome.storage.session.get("apiToken");
    return apiToken || "";
  } catch (e) {
    return "";
  }
}

async function apiFetch(path) {
  const token = await getApiToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const resp = await fetch(`${API_BASE}${path}`, { headers });

  if (!resp.ok) {
    const err = new Error(`${path}: HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

// 401 - токена нет в session-хранилище (обычно после перезапуска Chrome)
// или он неверный: даём кнопку на options-страницу вместо голой ошибки.
function renderTokenRequired(statusEl) {
  statusEl.textContent = "Нужен API-токен (или текущий не подходит).";
  statusEl.classList.add("error");

  const btn = document.createElement("button");
  btn.className = "open-options";
  btn.textContent = "Ввести токен";
  btn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  statusEl.appendChild(btn);
}

function latestDateWith(metricsByDate, metric) {
  const dates = Object.keys(metricsByDate).filter((d) => metric in metricsByDate[d]).sort();
  return dates[dates.length - 1];
}

function renderSection(section, metricsByDate) {
  const date = latestDateWith(metricsByDate, section.marker);
  if (!date) return null;
  const values = metricsByDate[date];

  const el = document.createElement("div");
  el.className = "section";

  const titleEl = document.createElement("div");
  titleEl.className = "section-title";
  titleEl.textContent = `${section.title} · ${date}`;
  el.appendChild(titleEl);

  const metricsEl = document.createElement("div");
  metricsEl.className = "metrics";
  for (const [key, label, kind] of section.metrics) {
    if (!(key in values)) continue;

    const labelEl = document.createElement("div");
    labelEl.className = "metric-label";
    labelEl.textContent = label;
    metricsEl.appendChild(labelEl);

    const valueEl = document.createElement("div");
    valueEl.className = "metric-value";
    if (key === "margin") {
      valueEl.classList.add(values[key] >= 0 ? "positive" : "negative");
    }
    valueEl.textContent = formatValue(values[key], kind);
    metricsEl.appendChild(valueEl);
  }
  el.appendChild(metricsEl);

  if (section.marker === "payout" && values.units_without_cost) {
    const warnEl = document.createElement("div");
    warnEl.className = "no-data";
    warnEl.textContent = `Без себестоимости: ${values.units_without_cost} шт. - маржа завышена`;
    el.appendChild(warnEl);
  }
  return el;
}

function renderCabinet(cabinet, metricsByDate) {
  const el = document.createElement("div");
  el.className = "cabinet";

  const nameEl = document.createElement("div");
  nameEl.className = "cabinet-name";
  nameEl.textContent = cabinet.name;
  el.appendChild(nameEl);

  const sections = SECTIONS.map((s) => renderSection(s, metricsByDate)).filter(Boolean);
  if (!sections.length) {
    const noData = document.createElement("div");
    noData.className = "no-data";
    noData.textContent = "Нет данных за последние " + DAYS_BACK + " дней";
    el.appendChild(noData);
    return el;
  }

  sections.forEach((s) => el.appendChild(s));
  return el;
}

async function main() {
  const statusEl = document.getElementById("status");
  const cabinetsEl = document.getElementById("cabinets");

  statusEl.textContent = "Загрузка...";

  let cabinets;
  try {
    cabinets = await apiFetch("/cabinets");
  } catch (e) {
    if (e.status === 401) {
      renderTokenRequired(statusEl);
      return;
    }
    statusEl.textContent = "Backend недоступен (" + e.message + "). Проверь, что он запущен.";
    statusEl.classList.add("error");
    return;
  }

  statusEl.remove();

  const dateFrom = isoDateDaysAgo(DAYS_BACK);
  const dateTo = isoDateDaysAgo(0);

  for (const cabinet of cabinets) {
    try {
      const metricsByDate = await apiFetch(
        `/metrics/${cabinet.code}?date_from=${dateFrom}&date_to=${dateTo}`
      );
      cabinetsEl.appendChild(renderCabinet(cabinet, metricsByDate));
    } catch (e) {
      const errEl = document.createElement("div");
      errEl.className = "cabinet";
      errEl.textContent = `${cabinet.name}: ошибка (${e.message})`;
      cabinetsEl.appendChild(errEl);
    }
  }
}

main();
