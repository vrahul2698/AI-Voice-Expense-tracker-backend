import axios from "axios";
import { getSheetRows } from "../config/sheets.js";

function parseDate(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split("/");
  if (!day || !month || !year) return null;
  return new Date(`${year}-${month}-${day}`);
}

function buildTodaySummary(rows) {
  const data = rows.slice(1).map((row) => ({
    date: row[0] || "",
    item: row[1] || "",
    category: row[2] || "",
    amount: parseFloat(row[3]) || 0,
  }));

  const todayStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });

  const todayEntries = data.filter((d) => d.date === todayStr);
  const total = todayEntries.reduce((sum, e) => sum + e.amount, 0);

  return { todayStr, todayEntries, total };
}

function formatMessage({ todayStr, todayEntries, total }) {
  if (todayEntries.length === 0) {
    return `📊 *Daily Expense Report — ${todayStr}*\n\nNo expenses logged today. 🎉`;
  }

  const lines = todayEntries
    .map((e) => `• ${e.item} — ₹${e.amount} (${e.category})`)
    .join("\n");

  return `📊 *Daily Expense Report — ${todayStr}*\n\n${lines}\n\n*Total: ₹${total}*\n_${todayEntries.length} transaction(s) today_`;
}

export async function sendDailyReportForUser(user) {
  if (!user.sheetId) return;

  const rows = await getSheetRows(user.accessToken, user.refreshToken, user.sheetId);
  if (!rows || rows.length <= 1) return;

  const summary = buildTodaySummary(rows);
  const message = formatMessage(summary);

  try {
    await axios.post(
      "https://proxy.whatsscale.com/api/sendText",
      {
        session: process.env.WHATSCALE_SESSION,
        chatId: process.env.RECIPIENT_PHONE,
        text: message,
      },
      { headers: { "X-Api-Key": process.env.WHATSCALE_API_KEY } }
    );
    console.log(`Daily report sent for ${user.email}`);
  } catch (err) {
    console.log("WHATSCALE ERROR STATUS:", err.response?.status);
    console.log("WHATSCALE ERROR BODY:", JSON.stringify(err.response?.data));
    console.log("REQUEST WAS:", {
      session: process.env.WHATSCALE_SESSION,
      chatId: process.env.RECIPIENT_PHONE,
      keyPresent: !!process.env.WHATSCALE_API_KEY,
      keyFirstChars: process.env.WHATSCALE_API_KEY?.slice(0, 6),
    });
    throw err;
  }
}