// Options-страница: единственное место, где API-токен попадает в
// расширение. Пишем в chrome.storage.session, не в local (см. корневой
// README, "Безопасность") - после перезапуска Chrome токен надо ввести
// заново, но уже здесь, а не через DevTools-консоль.
//
// После сохранения сразу проверяем токен запросом к /cabinets: /health
// не годится - он открыт и без токена (см. backend/app/api/main.py).

const API_BASE = "http://127.0.0.1:8000";

const form = document.getElementById("token-form");
const tokenInput = document.getElementById("token");
const clearBtn = document.getElementById("clear");
const statusEl = document.getElementById("status");

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function checkToken(token) {
  let resp;
  try {
    resp = await fetch(`${API_BASE}/cabinets`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    setStatus("Токен сохранён, но backend недоступен - проверка не выполнена.", "error");
    return;
  }

  if (resp.ok) {
    setStatus("Токен сохранён и принят backend'ом.", "ok");
  } else if (resp.status === 401) {
    setStatus("Токен сохранён, но backend его не принял (HTTP 401).", "error");
  } else {
    setStatus(`Токен сохранён, backend ответил HTTP ${resp.status}.`, "error");
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const token = tokenInput.value.trim();
  if (!token) {
    setStatus("Пустой токен - нечего сохранять.", "error");
    return;
  }

  await chrome.storage.session.set({ apiToken: token });
  tokenInput.value = "";
  setStatus("Проверка...");
  await checkToken(token);
});

clearBtn.addEventListener("click", async () => {
  await chrome.storage.session.remove("apiToken");
  tokenInput.value = "";
  setStatus("Токен удалён.");
});

async function init() {
  const { apiToken } = await chrome.storage.session.get("apiToken");
  setStatus(apiToken ? "Токен задан на эту сессию браузера." : "Токен не задан.");
}

init();
