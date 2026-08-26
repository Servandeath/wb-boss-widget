// Popup дёргает backend API напрямую при каждом открытии - никакого
// фонового поллинга (см. корневой README "Как это устроено": расширение
// не знает ни про WB, ни про Google Sheets, только спрашивает свой API).
//
// Секреты (API-токен) - только в chrome.storage.session (см. README,
// "Безопасность"), не в chrome.storage.local. Если токен не задан,
// запрос уйдёт без Authorization - backend сам решит, требовать его
// или нет (см. backend/app/config.API_TOKEN).

const API_BASE = "http://127.0.0.1:8000";
const DAYS_BACK = 7;

const METRIC_LABELS = {
  revenue: "Выручка",
  cost: "Себестоимость",
  ad_spend: "Реклама",
  margin: "Маржа",
};

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value) + " ₽";
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
    throw new Error(`${path}: HTTP ${resp.status}`);
  }
  return resp.json();
}

function renderCabinet(cabinet, metricsByDate) {
  const dates = Object.keys(metricsByDate).sort();
  const latestDate = dates[dates.length - 1];

  const el = document.createElement("div");
  el.className = "cabinet";

  const nameEl = document.createElement("div");
  nameEl.className = "cabinet-name";
  nameEl.textContent = cabinet.name;
  el.appendChild(nameEl);

  if (!latestDate) {
    const noData = document.createElement("div");
    noData.className = "no-data";
    noData.textContent = "Нет данных за последние " + DAYS_BACK + " дней";
    el.appendChild(noData);
    return el;
  }

  const dateEl = document.createElement("div");
  dateEl.className = "cabinet-date";
  dateEl.textContent = "за " + latestDate;
  el.appendChild(dateEl);

  const metricsEl = document.createElement("div");
  metricsEl.className = "metrics";

  const values = metricsByDate[latestDate];
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
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
    valueEl.textContent = formatRub(values[key]);
    metricsEl.appendChild(valueEl);
  }

  el.appendChild(metricsEl);
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
