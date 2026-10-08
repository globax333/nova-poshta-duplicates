/**
 * Перевірка дублікатів накладних Нової Пошти
 * ---------------------------------------------
 * Шукає випадки, коли оператори помилково створили 2+ однакових
 * відправлення (один отримувач, та сама вага/опис вантажу) протягом
 * останніх N днів.
 *
 * Запуск: node check-duplicates.js
 * Вимоги: Node.js 18+ (вбудований fetch)
 */

const fs = require("fs");

// ===================== НАЛАШТУВАННЯ =====================

const CONFIG = {
  // JWT-токен з браузерного запиту new.novaposhta.ua (Headers -> token).
  // Збережіть його в GitHub Secrets як NP_TOKEN. Не вписуйте токен прямо в код:
  // репозиторій може бути публічним, а JWT дає доступ до кабінету.
  token: process.env.NP_TOKEN || "ВАШ_ТОКЕН_СЮДИ",

  // DeviceCode з того ж браузерного запиту (Headers -> DeviceCode).
  // Збережіть його в GitHub Secrets як NP_DEVICE_CODE.
  deviceCode: process.env.NP_DEVICE_CODE || "ВАШ_DEVICE_CODE_СЮДИ",

  // 1 = сьогодні та вчора за київським часом.
  daysBack: 1,
  timeZone: "Europe/Kyiv",

  // Поріг "підозрілості" в годинах: якщо 2 накладні з однаковими
  // ознаками створені в межах цього інтервалу - вважаємо дублікатом
  suspiciousWindowHours: 72, // 3 доби

  apiUrl: "https://api.novaposhta.ua/v2.0/json/",

  // ===== Telegram =====
  telegram: {
    enabled: true, // false, якщо хочете вимкнути надсилання
    botToken: process.env.TG_BOT_TOKEN || "ВАШ_TELEGRAM_BOT_TOKEN",
    chatId: process.env.TG_CHAT_ID || "ВАШ_CHAT_ID",
  },

  // Куди зберігати HTML-звіт (відкривається у браузері)
  htmlReportPath: "duplicates-report.html",
};

// ===================== ДОПОМІЖНІ ФУНКЦІЇ =====================

function formatDateForApi(date, endOfDay = false) {
  const pad = (n) => String(n).padStart(2, "0");
  const time = endOfDay ? "23:59:59" : "00:00:00";
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ${time}`;
}

function buildDateRange(daysBack, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CONFIG.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const { year, month, day } = Object.fromEntries(
    parts.map(({ type, value }) => [type, value])
  );
  // UTC тут потрібен лише для арифметики календарних дат, без впливу часової зони сервера.
  const to = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - daysBack);
  return {
    // DateFrom - початок дня N днів тому
    DateFrom: formatDateForApi(from, false),
    // DateTo - КІНЕЦЬ сьогоднішнього дня (23:59:59),
    // інакше API відсікає всі накладні, створені сьогодні після півночі
    DateTo: formatDateForApi(to, true),
  };
}

function formatReportPeriod({ DateFrom, DateTo }) {
  return `${DateFrom.slice(0, 10)} - ${DateTo.slice(0, 10)} (Київ)`;
}

function getKyivHour(date) {
  return Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
}

function getScheduledWaitMs(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: CONFIG.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const { hour, minute, second } = Object.fromEntries(
    parts.map(({ type, value }) => [type, Number(value)])
  );
  // Максимум шість годин очікування; старі запуски після півночі пропускаємо.
  if (hour < 11) return null;
  const elapsed = ((hour * 60 + minute) * 60 + second) * 1000 + date.getUTCMilliseconds();
  return Math.max(0, 17 * 3600000 - elapsed);
}

async function waitForScheduledReport(
  clock = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
) {
  while (true) {
    const delay = getScheduledWaitMs(clock());
    if (delay === null) {
      console.log("Занадто ранній або застарілий плановий запуск пропущено.");
      return false;
    }
    if (delay === 0) return true;

    console.log(`Завдання готове. Чекаємо до 17:00 за Києвом (${Math.ceil(delay / 60000)} хв).`);
    await sleep(delay);
  }
}

async function shouldRunScheduledCheck(now = new Date()) {
  if (process.env.GITHUB_EVENT_NAME !== "schedule") return true;

  if (getKyivHour(now) < 17) {
    console.log("Плановий запуск до 17:00 за Києвом пропущено.");
    return false;
  }

  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repository || !token) {
    console.warn("Історія GitHub Actions недоступна; перевірку буде виконано.");
    return true;
  }

  try {
    const githubApi = async (path) => {
      const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      return response.json();
    };

    const json = await githubApi("/actions/workflows/check-duplicates.yml/runs?status=success&per_page=100");
    if (!Array.isArray(json.workflow_runs)) {
      throw new Error("GitHub не повернув список запусків");
    }

    const today = buildDateRange(0, now).DateTo.slice(0, 10);
    for (const run of json.workflow_runs) {
      if (
        String(run.id) === process.env.GITHUB_RUN_ID ||
        run.status !== "completed" || run.conclusion !== "success" ||
        !["schedule", "workflow_dispatch"].includes(run.event)
      ) continue;

      const finished = new Date(run.updated_at);
      if (!Number.isFinite(finished.getTime()) ||
          buildDateRange(0, finished).DateTo.slice(0, 10) !== today ||
          getKyivHour(finished) < 17) continue;

      // Ранній запуск починається до 17:00. Артефакт підтверджує фактичне надсилання звіту.
      const { artifacts } = await githubApi(`/actions/runs/${run.id}/artifacts?per_page=100`);
      if (!Array.isArray(artifacts)) throw new Error("GitHub не повернув список звітів");
      const alreadySent = artifacts.some((artifact) => {
        const created = new Date(artifact.created_at);
        return artifact.name === "duplicates-report" &&
          Number.isFinite(created.getTime()) &&
          buildDateRange(0, created).DateTo.slice(0, 10) === today &&
          getKyivHour(created) >= 17;
      });
      if (alreadySent) {
        console.log("Звіт за сьогодні після 17:00 уже надіслано; резервну перевірку пропущено.");
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`Не вдалося перевірити історію запусків: ${error.message}. Перевірку буде виконано.`);
    return true;
  }
}

function isConfigured(value, placeholder) {
  return Boolean(value && value !== placeholder);
}

function assertNovaPoshtaAuthConfigured() {
  const hasToken = isConfigured(CONFIG.token, "ВАШ_ТОКЕН_СЮДИ");
  const hasDeviceCode = isConfigured(CONFIG.deviceCode, "ВАШ_DEVICE_CODE_СЮДИ");

  if (hasToken && hasDeviceCode) return;

  throw new Error(
    "Не задано NP_TOKEN або NP_DEVICE_CODE. Візьміть їх зі свіжого браузерного request на new.novaposhta.ua і додайте в GitHub Secrets."
  );
}

function buildNovaPoshtaHeaders() {
  return {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "uk-UA,uk;q=0.9,ru-UA;q=0.8,ru;q=0.7,en-US;q=0.6,en;q=0.5",
    "Content-Type": "application/json",
    DeviceCode: CONFIG.deviceCode,
    Origin: "https://new.novaposhta.ua",
    Referer: "https://new.novaposhta.ua/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    "sec-ch-ua": '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    token: CONFIG.token,
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Нова Пошта повернула не JSON-відповідь. HTTP ${response.status}. Початок відповіді: ${text.slice(
        0,
        300
      )}`
    );
  }
}

// ===================== ОТРИМАННЯ НАКЛАДНИХ =====================

async function fetchAllOutgoingDocuments(dateRange = buildDateRange(CONFIG.daysBack)) {
  assertNovaPoshtaAuthConfigured();

  const { DateFrom, DateTo } = dateRange;
  let allDocs = [];
  let page = 1;
  const limit = 100;

  while (true) {
    if (page === 1) {
      console.log("Авторизація: token + DeviceCode з браузерного запиту new.novaposhta.ua");
      console.log(`Період перевірки: ${DateFrom} - ${DateTo} (Київ)`);
    }

    const body = {
      system: "PA 3.0",
      modelName: "InternetDocument",
      calledMethod: "getOutgoingDocumentsByPhone",
      methodProperties: {
        DateFrom,
        DateTo,
        Page: page,
        Limit: limit,
        SearchByCounterparties: null,
        iCounterparties: null,
      },
    };

    const response = await fetch(CONFIG.apiUrl, {
      method: "POST",
      headers: buildNovaPoshtaHeaders(),
      body: JSON.stringify(body),
    });

    const json = await parseJsonResponse(response);

    if (!json.success) {
      const errText = (json.errors || json.translatedErrors || []).join(", ");
      console.error("Помилка API:", errText);

      // Якщо це схоже на проблему авторизації - попереджаємо в Telegram
      const isAuthError =
        errText.includes("User is undefined") ||
        errText.includes("Користувач не визначений") ||
        /api key|token/i.test(errText) ||
        response.status === 401;

      if (!isAuthError && CONFIG.telegram.enabled) {
        await sendTelegramMessage(
          `🔴 <b>Помилка перевірки дублікатів</b>\n\nAPI Нової Пошти повернув помилку: ${escapeHtml(errText)}`
        );
      }

      if (isAuthError && CONFIG.telegram.enabled) {
        await sendTelegramMessage(
          `🔴 <b>Помилка авторизації Нової Пошти</b>\n\nJWT-token / DeviceCode з браузерного request не діють або застаріли. Відкрийте new.novaposhta.ua, візьміть зі свіжого запиту headers <b>token</b> і <b>DeviceCode</b>, потім оновіть GitHub Secrets <b>NP_TOKEN</b> та <b>NP_DEVICE_CODE</b>.\n\nПомилка API: ${escapeHtml(
            errText
          )}`
        );
      }
      // Зупиняємо весь запуск, щоб не надсилати хибний звіт "0 накладних, дублікатів немає"
      throw new Error(`Помилка API Нової Пошти: ${errText}`);
    }

    const docs = json.data?.[0]?.result || [];
    allDocs = allDocs.concat(docs);

    const totalCount = json.info?.totalCount || 0;
    if (page * limit >= totalCount || docs.length === 0) break;
    page++;
  }

  return allDocs;
}

// ===================== ЛОГІКА ПОШУКУ ДУБЛІКАТІВ =====================

function buildDuplicateKey(doc) {
  // Групуємо ТІЛЬКИ за телефоном отримувача - це головна, стабільна ознака.
  // Вага/місто/опис вантажу можуть відрізнятись через людські помилки
  // при введенні (одруківки, різне написання міста тощо), тому їх більше
  // не використовуємо як умову для групування, а лише показуємо в звіті,
  // щоб оператор сам оцінив схожість.
  return doc.PhoneRecipient;
}

// Статуси, які означають "накладна вже неактивна" - їх не рахуємо
// як дублікат, бо оператор, скоріш за все, сам скасував помилкову накладну
// 102 - Відмова від отримання (відправником створено повернення)
// 103 - Відмова від отримання
// 2   - Видалено
const CANCELLED_STATUS_CODES = ["102", "103", "2"];

function findDuplicates(documents) {
  // Виключаємо повернення/переадресації - це не "нові" відправлення оператора
  // Виключаємо скасовані/відмовлені - вони вже "оброблені" вручну
  const realShipments = documents.filter((d) => {
    const isRealShipment = !d.OwnerDocumentType || d.OwnerDocumentType === "";
    const isNotCancelled =
      !CANCELLED_STATUS_CODES.includes(d.TrackingStatusCode) &&
      !d.DeletionMark;
    return isRealShipment && isNotCancelled;
  });

  const groups = {};
  for (const doc of realShipments) {
    const key = buildDuplicateKey(doc);
    if (!groups[key]) groups[key] = [];
    groups[key].push(doc);
  }

  const duplicatePairs = [];

  for (const key in groups) {
    const group = groups[key];
    if (group.length < 2) continue;

    group.sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));

    for (let i = 1; i < group.length; i++) {
      const prev = group[i - 1];
      const curr = group[i];
      const hoursDiff =
        (new Date(curr.DateTime) - new Date(prev.DateTime)) / 36e5;

      if (hoursDiff <= CONFIG.suspiciousWindowHours) {
        duplicatePairs.push({
          recipient: curr.RecipientFullName,
          phone: curr.PhoneRecipient,
          city: curr.CityRecipientDescription,
          cargo: curr.CargoDescription,
          weight: curr.DocumentWeight,
          // Порівняння для наочності в звіті - НЕ впливає на те, чи пара
          // потрапила в список (це вже вирішив сам факт групування за телефоном)
          cityMatches:
            prev.CityRecipientDescription === curr.CityRecipientDescription,
          weightMatches: prev.DocumentWeight === curr.DocumentWeight,
          cargoMatches: prev.CargoDescription === curr.CargoDescription,
          prevCity: prev.CityRecipientDescription,
          prevWeight: prev.DocumentWeight,
          prevCargo: prev.CargoDescription,
          original: { number: prev.Number, dateTime: prev.DateTime },
          duplicate: { number: curr.Number, dateTime: curr.DateTime },
          hoursApart: Number(hoursDiff.toFixed(1)),
          npFlaggedAsDuplicate:
            curr.IsPossibilityDuplicate || prev.IsPossibilityDuplicate,
        });
      }
    }
  }

  return duplicatePairs;
}

// ===================== ЗВІТ =====================

function printReport(duplicates, totalChecked) {
  console.log(`\nПеревірено накладних: ${totalChecked}`);
  console.log(`Знайдено підозрілих пар дублікатів: ${duplicates.length}\n`);

  if (duplicates.length === 0) {
    console.log("Дублікатів не знайдено. ✅");
    return;
  }

  duplicates.forEach((dup, i) => {
    console.log(`--- Дублікат #${i + 1} ---`);
    console.log(`Отримувач: ${dup.recipient} (${dup.phone})`);
    console.log(
      `Місто: ${dup.prevCity} → ${dup.city}${dup.cityMatches ? "" : "  ⚠️ РІЗНЕ"}`
    );
    console.log(
      `Вага: ${dup.prevWeight} кг → ${dup.weight} кг${
        dup.weightMatches ? "" : "  ⚠️ РІЗНА"
      }`
    );
    console.log(
      `Вантаж: ${dup.prevCargo} → ${dup.cargo}${
        dup.cargoMatches ? "" : "  ⚠️ РІЗНИЙ"
      }`
    );
    console.log(
      `Оригінал:  №${dup.original.number}  (${dup.original.dateTime})`
    );
    console.log(
      `Дублікат:  №${dup.duplicate.number}  (${dup.duplicate.dateTime})`
    );
    console.log(`Різниця в часі: ${dup.hoursApart} год.`);
    console.log(
      `Позначено НП як дублікат: ${dup.npFlaggedAsDuplicate ? "так" : "ні"}`
    );
    console.log("");
  });
}

// ===================== TELEGRAM =====================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTelegramMessage(duplicates, totalChecked, dateRange = buildDateRange(CONFIG.daysBack)) {
  const today = dateRange.DateTo.slice(0, 10);
  const period = formatReportPeriod(dateRange);

  if (duplicates.length === 0) {
    return `✅ <b>Перевірка дублікатів (${today})</b>\n\nПеріод: ${period}\nПеревірено накладних: ${totalChecked}\nДублікатів не знайдено.`;
  }

  let msg = `⚠️ <b>Перевірка дублікатів (${today})</b>\n\n`;
  msg += `Період: ${period}\n`;
  msg += `Перевірено накладних: ${totalChecked}\n`;
  msg += `Знайдено підозрілих пар: <b>${duplicates.length}</b>\n\n`;

  duplicates.slice(0, 15).forEach((dup, i) => {
    msg += `<b>${i + 1}. ${escapeHtml(dup.recipient)}</b> (${escapeHtml(
      dup.phone
    )})\n`;

    if (dup.cityMatches) {
      msg += `   Місто: ${escapeHtml(dup.city)}\n`;
    } else {
      msg += `   Місто: ${escapeHtml(dup.prevCity)} → ${escapeHtml(
        dup.city
      )} ⚠️\n`;
    }

    if (dup.weightMatches) {
      msg += `   Вага: ${dup.weight} кг`;
    } else {
      msg += `   Вага: ${dup.prevWeight} → ${dup.weight} кг ⚠️`;
    }

    if (!dup.cargoMatches) {
      msg += ` | Вантаж різний ⚠️`;
    }
    msg += `\n`;

    msg += `   №${dup.original.number} → №${dup.duplicate.number} (різниця ${dup.hoursApart} год.)\n\n`;
  });

  if (duplicates.length > 15) {
    msg += `... та ще ${duplicates.length - 15} пар. Повний список у HTML-звіті.`;
  }

  return msg;
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.telegram.chatId,
      text,
      parse_mode: "HTML",
    }),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) {
    throw new Error(`Помилка надсилання в Telegram: ${json.description || `HTTP ${response.status}`}`);
  }
  console.log("Звіт надіслано в Telegram. ✅");
}

// ===================== HTML-ЗВІТ =====================

function generateHtmlReport(duplicates, totalChecked, dateRange = buildDateRange(CONFIG.daysBack)) {
  const today = new Date().toLocaleString("uk-UA", { timeZone: CONFIG.timeZone });
  const period = formatReportPeriod(dateRange);

  const rows = duplicates
    .map(
      (dup, i) => `
      <tr class="${dup.npFlaggedAsDuplicate ? "flagged" : ""}">
        <td>${i + 1}</td>
        <td>${escapeHtml(dup.recipient)}</td>
        <td>${escapeHtml(dup.phone)}</td>
        <td class="${dup.cityMatches ? "" : "mismatch"}">
          ${
            dup.cityMatches
              ? escapeHtml(dup.city)
              : `${escapeHtml(dup.prevCity)} → ${escapeHtml(dup.city)}`
          }
        </td>
        <td class="${dup.cargoMatches ? "" : "mismatch"}">
          ${
            dup.cargoMatches
              ? escapeHtml(dup.cargo)
              : `${escapeHtml(dup.prevCargo)} → ${escapeHtml(dup.cargo)}`
          }
        </td>
        <td class="${dup.weightMatches ? "" : "mismatch"}">
          ${
            dup.weightMatches
              ? dup.weight
              : `${dup.prevWeight} → ${dup.weight}`
          }
        </td>
        <td>№${dup.original.number}<br><small>${dup.original.dateTime}</small></td>
        <td>№${dup.duplicate.number}<br><small>${dup.duplicate.dateTime}</small></td>
        <td>${dup.hoursApart} год.</td>
        <td>${dup.npFlaggedAsDuplicate ? "⚠️ так" : "ні"}</td>
      </tr>`
    )
    .join("");

  const html = `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<title>Звіт дублікатів - Optovichok</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; background: #f7f7f8; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .summary { background: white; border-radius: 8px; padding: 16px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .summary b { color: #b02a37; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background: #fafafa; font-weight: 600; }
  tr.flagged { background: #fff4e5; }
  td.mismatch { color: #b02a37; font-weight: 600; }
  small { color: #888; }
  .empty { padding: 40px; text-align: center; color: #4caf50; font-size: 18px; background: white; border-radius: 8px; }
</style>
</head>
<body>
  <h1>Звіт перевірки дублікатів накладних</h1>
  <div class="summary">
    Дата перевірки: ${today}<br>
    Період: ${period}<br>
    Перевірено накладних: ${totalChecked}<br>
    Знайдено підозрілих пар: <b>${duplicates.length}</b>
  </div>
  ${
    duplicates.length === 0
      ? `<div class="empty">✅ Дублікатів не знайдено</div>`
      : `<table>
    <thead><tr>
      <th>#</th><th>Отримувач</th><th>Телефон</th><th>Місто</th>
      <th>Вантаж</th><th>Вага</th><th>Оригінал</th><th>Дублікат</th>
      <th>Різниця</th><th>НП позначив</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`
  }
</body>
</html>`;

  fs.writeFileSync(CONFIG.htmlReportPath, html, "utf-8");
  console.log(`HTML-звіт збережено: ${CONFIG.htmlReportPath}`);
}

// ===================== ЗАПУСК =====================

if (require.main === module) {
  run().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDateRange,
  buildTelegramMessage,
  fetchAllOutgoingDocuments,
  findDuplicates,
  getScheduledWaitMs,
  sendTelegramMessage,
  shouldRunScheduledCheck,
  waitForScheduledReport,
};

async function run() {
  if (process.env.GITHUB_EVENT_NAME === "schedule" && !(await waitForScheduledReport())) return;
  if (!(await shouldRunScheduledCheck())) return;

  console.log("Завантаження накладних...");
  const dateRange = buildDateRange(CONFIG.daysBack);
  const documents = await fetchAllOutgoingDocuments(dateRange);
  console.log(`Отримано ${documents.length} накладних.`);

  const duplicates = findDuplicates(documents);
  printReport(duplicates, documents.length);

  generateHtmlReport(duplicates, documents.length, dateRange);

  if (CONFIG.telegram.enabled) {
    const message = buildTelegramMessage(duplicates, documents.length, dateRange);
    await sendTelegramMessage(message);
  }
}
