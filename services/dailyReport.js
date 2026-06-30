import axios from "axios";
import Expense from "../models/Expense.js";

// ─────────────────────────────────────────────────────────────────────────
// META WHATSAPP CLOUD API — replaces the WhatScale proxy entirely.
//
// SETUP REQUIRED (one-time, in Meta Business Suite / developers.facebook.com):
//   1. Create a Meta App (type: Business) → add the WhatsApp product.
//   2. Note your Phone Number ID and generate a permanent System User token
//      (Business Settings → System Users → generate token with
//      whatsapp_business_messaging permission — this one doesn't expire,
//      unlike the default 24-hour test token).
//   3. Add WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN to your .env.
//   4. Create + get approval for TWO message templates in WhatsApp Manager
//      → Message Templates (Utility category, since these are scheduled
//      reminders, not marketing):
//        - "expense_reminder_en" / "expense_reminder_ta" — body text e.g.
//          "You haven't logged any expenses today yet. Take a moment to
//          add today's spending." (no variables needed)
//        - "expense_summary_en" / "expense_summary_ta" — body text with
//          ONE variable, e.g. "Here's today's expense summary:\n\n{{1}}"
//          (the {{1}} gets filled with the formatted line-by-line summary)
//   5. Until templates are approved, you can test with free-form text
//      messages (type: "text") ONLY to numbers that have messaged your
//      test number first within the last 24 hours — useful for development,
//      but won't work for unattended scheduled sends to real users.
//
// Template names below assume the naming above; rename via the
// TEMPLATE_NAMES map if you name yours differently in WhatsApp Manager.
// ─────────────────────────────────────────────────────────────────────────

const GRAPH_API_VERSION = "v23.0";
const WHATSAPP_API_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const TEMPLATE_NAMES = {
  reminder: { en: "expense_reminder_en", ta: "expense_reminder_ta" },
  summary: { en: "expense_summary_en", ta: "expense_summary_ta" },
};

// Category names are always stored in English (see extractExpenseFromText),
// so a small lookup table is enough to localize them for the Tamil messages —
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

function todayStr() {
  return new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });
}

// ─── Shared sender — sends an approved template message via Cloud API ──────
// `bodyParams` is an array of plain strings filled into the template's
// {{1}}, {{2}}, ... placeholders in order. Pass [] for templates with no
// variables (like the reminder).
async function sendWhatsAppTemplate(user, templateKey, bodyParams = []) {
  if (!user.whatsappNumber) {
    console.log(`Skipping WhatsApp send for ${user.email} — no whatsappNumber set.`);
    return;
  }

  const lang = user.language === "ta" ? "ta" : "en";
  const templateName = TEMPLATE_NAMES[templateKey][lang];

  // Meta's template language codes use full locale tags. "en" maps to
  // "en_US" by default in WhatsApp Manager unless you specifically created
  // the template under a different English locale — adjust here if needed.
  const languageCode = lang === "ta" ? "ta" : "en_US";

  const payload = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: user.whatsappNumber,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0 && {
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({ type: "text", text })),
          },
        ],
      }),
    },
  };

  try {
    await axios.post(WHATSAPP_API_URL, payload, {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log(`WhatsApp template "${templateName}" sent to ${user.email} (${user.whatsappNumber})`);
  } catch (err) {
    console.log("WHATSAPP API ERROR STATUS:", err.response?.status);
    console.log("WHATSAPP API ERROR BODY:", JSON.stringify(err.response?.data));
    console.log("REQUEST WAS:", {
      to: user.whatsappNumber,
      template: templateName,
      languageCode,
      phoneNumberIdPresent: !!process.env.WHATSAPP_PHONE_NUMBER_ID,
      tokenPresent: !!process.env.WHATSAPP_ACCESS_TOKEN,
    });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 7 PM — "log your expenses" reminder. Skips anyone who already logged at
// least one expense today, since the point is to nudge people who haven't,
// not to pester someone who's already used the app. No body variables —
// the template text itself is the full message.
// ─────────────────────────────────────────────────────────────────────────
export async function sendReminderForUser(user) {
  if (!user.remindersEnabled || !user.whatsappNumber) return;

  const today = todayStr();
  const count = await Expense.countDocuments({ userId: user._id, date: today });

  if (count > 0) {
    console.log(`Skipping reminder for ${user.email} — already logged ${count} expense(s) today.`);
    return;
  }

  await sendWhatsAppTemplate(user, "reminder");
}

// ─────────────────────────────────────────────────────────────────────────
// 9 PM — full daily summary of everything logged today. The summary
// template has ONE body variable ({{1}}) which gets the whole formatted
// block of lines + total, built the same way as before.
// ─────────────────────────────────────────────────────────────────────────
function buildTodaySummary(expenses) {
  const todayEntries = expenses.map((e) => ({
    item: e.item || "",
    category: e.category || "",
    amount: parseFloat(e.amount) || 0,
  }));
  const total = todayEntries.reduce((sum, e) => sum + e.amount, 0);
  return { todayEntries, total };
}

function formatSummaryBody({ todayEntries, total }, lang = "en") {
  if (lang === "ta") {
    if (todayEntries.length === 0) {
      return "இன்று செலவுகள் எதுவும் பதிவு செய்யப்படவில்லை. 🎉";
    }
    const lines = todayEntries
      .map((e) => `• ${e.item} — ₹${e.amount} (${CATEGORY_TA[e.category] || e.category})`)
      .join("\n");
    return `${lines}\n\nமொத்தம்: ₹${total} (${todayEntries.length} பரிவர்த்தனை(கள்))`;
  }

  if (todayEntries.length === 0) {
    return "No expenses logged today. 🎉";
  }
  const lines = todayEntries
    .map((e) => `• ${e.item} — ₹${e.amount} (${e.category})`)
    .join("\n");
  return `${lines}\n\nTotal: ₹${total} (${todayEntries.length} transaction(s))`;
}

export async function sendDailySummaryForUser(user) {
  if (!user.summaryEnabled || !user.whatsappNumber) return;

  const date = todayStr();
  const todayExpenses = await Expense.find({ userId: user._id, date }).lean();

  // Unlike the reminder, the summary always sends — even on a zero-expense
  // day — since "nothing logged today" is itself useful information at 9 PM.
  const summary = buildTodaySummary(todayExpenses);
  const bodyText = formatSummaryBody(summary, user.language || "en");Dashb

  // WhatsApp template variables can't contain newlines in some template
  // configurations — if Meta rejects multi-line {{1}} values for your
  // approved template, the fallback is to flatten lines with " | " instead.
  // Test this against your actual approved template once it's live.
  await sendWhatsAppTemplate(user, "summary", [bodyText]);
}

// ─── Backward-compatible alias ───────────────────────────────────────────
export const sendDailyReportForUser = sendDailySummaryForUser;
