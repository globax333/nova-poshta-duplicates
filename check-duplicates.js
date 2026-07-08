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
  // JWT-токен з кабінету new.novaposhta.ua (Headers -> token)
  // Береться зі змінної середовища NP_TOKEN (GitHub Secrets) або,
  // якщо запускаєте локально, впишіть значення прямо тут замість process.env.NP_TOKEN
  token: process.env.NP_TOKEN || "ВАШ_ТОКЕН_СЮДИ",

  // DeviceCode з того ж запиту (Headers -> DeviceCode)
  deviceCode: process.env.NP_DEVICE_CODE || "ВАШ_DEVICE_CODE_СЮДИ",

  // За скільки днів назад перевіряти (2 = сьогодні + 2 попередні дні,
  // тобто якщо сьогодні 02.07, перевіряються 30.06, 01.07, 02.07)
  daysBack: 2,

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
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${time}`;
}

function buildDateRange(daysBack) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - daysBack);
  return {
    // DateFrom - початок дня N днів тому
    DateFrom: formatDateForApi(from, false),
    // DateTo - КІНЕЦЬ сьогоднішнього дня (23:59:59),
    // інакше API відсікає всі накладні, створені сьогодні після півночі
    DateTo: formatDateForApi(to, true),
  };
}

// ===================== ОТРИМАННЯ НАКЛАДНИХ =====================

async function fetchAllOutgoingDocuments() {
  const { DateFrom, DateTo } = buildDateRange(CONFIG.daysBack);
  let allDocs = [];
  let page = 1;
  const limit = 100;

  while (true) {
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
      headers: {
        "Content-Type": "application/json",
        token: CONFIG.token,
        DeviceCode: CONFIG.deviceCode,
        Referer: "https://new.novaposhta.ua/",
      },
      body: JSON.stringify(body),
    });

    const json = await response.json();

    if (!json.success) {
      const errText = (json.errors || json.translatedErrors || []).join(", ");
      console.error("Помилка API:", errText);

      // Якщо це схоже на проблему авторизації - попереджаємо в Telegram
      const isAuthError =
        errText.includes("User is undefined") ||
        errText.includes("Користувач не визначений") ||
        response.status === 401;

      if (isAuthError && CONFIG.telegram.enabled) {
        await sendTelegramMessage(
          `🔴 <b>Помилка авторизації Нової Пошти</b>\n\nToken/DeviceCode більше не діють. Потрібно оновити їх вручну через DevTools (new.novaposhta.ua).\n\nПомилка API: ${escapeHtml(
            errText
          )}`
        );
      }
      break;
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

function buildTelegramMessage(duplicates, totalChecked) {
  const today = new Date().toLocaleDateString("uk-UA");

  if (duplicates.length === 0) {
    return `✅ <b>Перевірка дублікатів (${today})</b>\n\nПеревірено накладних: ${totalChecked}\nДублікатів не знайдено.`;
  }

  let msg = `⚠️ <b>Перевірка дублікатів (${today})</b>\n\n`;
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
  if (!json.ok) {
    console.error("Помилка надсилання в Telegram:", json.description);
  } else {
    console.log("Звіт надіслано в Telegram. ✅");
  }
}

// ===================== HTML-ЗВІТ =====================

function generateHtmlReport(duplicates, totalChecked) {
  const today = new Date().toLocaleString("uk-UA");

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

(async function main() {
  console.log("Завантаження накладних...");
  const documents = await fetchAllOutgoingDocuments();
  console.log(`Отримано ${documents.length} накладних.`);

  const duplicates = findDuplicates(documents);
  printReport(duplicates, documents.length);

  generateHtmlReport(duplicates, documents.length);

  if (CONFIG.telegram.enabled) {
    const message = buildTelegramMessage(duplicates, documents.length);
    await sendTelegramMessage(message);
  }
})();
