import axios from "axios";
import Expense from "../models/Expense.js";

function buildTodaySummary(expenses, todayStr) {
  const todayEntries = expenses.map((e) => ({
    item: e.item || "",
    category: e.category || "",
    amount: parseFloat(e.amount) || 0,
  }));

  const total = todayEntries.reduce((sum, e) => sum + e.amount, 0);

  return { todayStr, todayEntries, total };
}

// Category names are always stored in English (see extractExpenseFromText),
// so a small lookup table is enough to localize them for the Tamil report —
// no translation API call needed.
const CATEGORY_TA = {
  "Food & Drink": "உணவு",
  Transport: "போக்குவரத்து",
  Shopping: "ஷாப்பிங்",
  Bills: "பில்கள்",
  Entertainment: "பொழுதுபோக்கு",
  Health: "சுகாதாரம்",
  Education: "கல்வி",
  Other: "மற்றவை",
};

function formatMessage({ todayStr, todayEntries, total }, lang = "en") {
  if (lang === "ta") {
    if (todayEntries.length === 0) {
      return `📊 *தினசரி செலவு அறிக்கை — ${todayStr}*\n\nஇன்று செலவுகள் எதுவும் பதிவு செய்யப்படவில்லை. 🎉`;
    }

    const lines = todayEntries
      .map((e) => `• ${e.item} — ₹${e.amount} (${CATEGORY_TA[e.category] || e.category})`)
      .join("\n");

    return `📊 *தினசரி செலவு அறிக்கை — ${todayStr}*\n\n${lines}\n\n*மொத்தம்: ₹${total}*\n_இன்று ${todayEntries.length} பரிவர்த்தனை(கள்)_`;
  }

  if (todayEntries.length === 0) {
    return `📊 *Daily Expense Report — ${todayStr}*\n\nNo expenses logged today. 🎉`;
  }

  const lines = todayEntries
    .map((e) => `• ${e.item} — ₹${e.amount} (${e.category})`)
    .join("\n");

  return `📊 *Daily Expense Report — ${todayStr}*\n\n${lines}\n\n*Total: ₹${total}*\n_${todayEntries.length} transaction(s) today_`;
}

export async function sendDailyReportForUser(user) {
  const todayStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });

  const todayExpenses = await Expense.find({ userId: user._id, date: todayStr }).lean();

  if (!todayExpenses.length) return;

  const summary = buildTodaySummary(todayExpenses, todayStr);
  const message = formatMessage(summary, user.language || "en");

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
    console.log(`Daily report sent for ${user.email} (${user.language || "en"})`);
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
