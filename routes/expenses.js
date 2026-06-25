import express from "express";
import multer from "multer";
import fs from "fs";
import Groq from "groq-sdk";
import { requireAuth } from "../middleware/auth.js";
import { appendExpenseRow, deleteExpenseRow, updateExpenseRow } from "../config/sheets.js";
import Expense from "../models/Expense.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const upload = multer({ dest: "uploads/" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Helper: Extract expense using Groq LLaMA (English + Tamil) ─────────────
// `lang` is the user's preferred language ("en" | "ta"). The model is asked
// to understand Tamil script AND Tanglish (Tamil typed in Latin letters),
// since voice transcription or typed input may come in either form
// regardless of the user's selected UI language.
async function extractExpenseFromText(text, lang = "en") {
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const systemPrompt =
    "You are an expense extraction assistant. You understand English, " +
    "Tamil (Tamil script), and Tanglish (Tamil written in Latin letters). " +
    "Always respond with ONLY a valid JSON object, no markdown, no explanation, no backticks.";

  const userPrompt = `Extract expense from this text, which may be in English, Tamil, or Tanglish: "${text}"
Today: ${today}
Return JSON: {"item":"Tea","category":"Food & Drink","amount":200,"date":"${today}","confidence":"high"}
- "item" and "category" must always be in ENGLISH, regardless of the input language, so they stay consistent in the spreadsheet.
- Categories (use exactly one): Food & Drink, Transport, Shopping, Bills, Entertainment, Health, Education, Other
- "amount" must be a plain number (no currency symbols, no commas).
If no expense is detected: {"error":"No expense detected"}`;

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.1,
    max_tokens: 150,
  });

  const raw = response.choices[0].message.content
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return JSON.parse(raw);
}

// ─── Helper: Parse DD/MM/YYYY date string ────────────────────────────────────
function parseDate(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split("/");
  if (!day || !month || !year) return null;
  return new Date(`${year}-${month}-${day}`);
}

// ─── Helper: Build analytics from expense documents ──────────────────────────
// Unchanged from before — only the input shape changed previously (Mongo
// documents instead of raw sheet rows); this logic is untouched by the
// preview/confirm split below.
function buildAnalytics(expenses) {
  const data = expenses.map((e) => ({
    date: e.date || "",
    item: e.item || "",
    category: e.category || "",
    amount: parseFloat(e.amount) || 0,
    originalText: e.originalText || "",
    loggedAt: e.loggedAt || "",
  }));

  const dailyMap = {};
  data.forEach(({ date, amount, category, item }) => {
    if (!date) return;
    if (!dailyMap[date]) dailyMap[date] = { total: 0, count: 0, breakdown: [] };
    dailyMap[date].total += amount;
    dailyMap[date].count += 1;
    dailyMap[date].breakdown.push({ item, amount, category });
  });

  const daily = Object.entries(dailyMap)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => {
      const da = parseDate(a.date);
      const db = parseDate(b.date);
      return db - da;
    });

  const monthlyMap = {};
  data.forEach(({ date, amount, category }) => {
    if (!date) return;
    const d = parseDate(date);
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-IN", { month: "long", year: "numeric" });
    if (!monthlyMap[key]) monthlyMap[key] = { key, label, total: 0, count: 0, categories: {} };
    monthlyMap[key].total += amount;
    monthlyMap[key].count += 1;
    monthlyMap[key].categories[category] = (monthlyMap[key].categories[category] || 0) + amount;
  });

  const monthly = Object.values(monthlyMap).sort((a, b) => b.key.localeCompare(a.key));

  const categoryMap = {};
  data.forEach(({ category, amount }) => {
    if (!category) return;
    categoryMap[category] = (categoryMap[category] || 0) + amount;
  });

  const categories = Object.entries(categoryMap)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  const now = new Date();
  const weeklyMap = {};
  data.forEach(({ date, amount }) => {
    const d = parseDate(date);
    if (!d) return;
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    const weekNum = Math.floor(diffDays / 7);
    if (weekNum > 3) return;
    const label = weekNum === 0 ? "This Week" : weekNum === 1 ? "Last Week" : `${weekNum} Weeks Ago`;
    if (!weeklyMap[weekNum]) weeklyMap[weekNum] = { week: weekNum, label, total: 0, count: 0 };
    weeklyMap[weekNum].total += amount;
    weeklyMap[weekNum].count += 1;
  });

  const weekly = Object.values(weeklyMap).sort((a, b) => a.week - b.week);

  const itemMap = {};
  data.forEach(({ item, amount }) => {
    const key = item.toLowerCase().trim();
    if (!itemMap[key]) itemMap[key] = { item, total: 0, count: 0 };
    itemMap[key].total += amount;
    itemMap[key].count += 1;
  });

  const topItems = Object.values(itemMap)
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const totalAmount = data.reduce((sum, r) => sum + r.amount, 0);
  const totalCount = data.length;
  const avgPerDay = daily.length > 0 ? totalAmount / daily.length : 0;
  const avgPerTransaction = totalCount > 0 ? totalAmount / totalCount : 0;

  const todayStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const todayTotal = dailyMap[todayStr]?.total || 0;
  const todayCount = dailyMap[todayStr]?.count || 0;

  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonthTotal = monthlyMap[thisMonthKey]?.total || 0;
  const thisMonthCount = monthlyMap[thisMonthKey]?.count || 0;

  const highestDay = daily.reduce((max, d) => (d.total > (max?.total || 0) ? d : max), null);

  return {
    summary: {
      totalAmount,
      totalCount,
      avgPerDay: Math.round(avgPerDay),
      avgPerTransaction: Math.round(avgPerTransaction),
      todayTotal,
      todayCount,
      thisMonthTotal,
      thisMonthCount,
      highestDay,
    },
    daily,
    weekly,
    monthly,
    categories,
    topItems,
    recentExpenses: data.slice(0, 10),
  };
}

// ─── Helper: save to Mongo, respond, then sync to Sheets in the background ───
// Used ONLY by /confirm now — the user has already seen and approved the
// parsed result, so this is the single place that actually persists data.
async function saveExpenseAndSync(req, res, extracted, originalText, lang) {
  console.log(req.user._id, extracted, originalText);
  const expense = await Expense.create({
    userId: req.user._id,
    item: extracted.item,
    category: extracted.category,
    amount: Number(extracted.amount) || 0,
    date: extracted.date,
    originalText,
    language: lang === "ta" ? "ta" : "en",
  });

  req.user.totalExpenses += 1;
  req.user.totalAmount += Number(extracted.amount) || 0;
  await req.user.save();
  console.log("MONGO SAVE SUCCESS:", expense._id);

  res.json({ success: true, transcription: originalText, expense: { ...extracted, _id: expense._id } });

  appendExpenseRow(req.user.accessToken, req.user.refreshToken, req.user.sheetId, {
    ...extracted,
    originalText,
  })
    .then(({ rowNumber, sheetGid }) =>
      Expense.findByIdAndUpdate(expense._id, { sheetRowSynced: true, sheetRowNumber: rowNumber, sheetGid })
    )
    .catch((err) =>
      console.error(`Sheet sync failed for expense ${expense._id}:`, err.message)
    );
}

// ─── POST /api/expenses/audio/preview ────────────────────────────────────────
// Transcribes + extracts ONLY. Nothing is written to Mongo or Sheets here —
// this lets the frontend show "did I get this right?" before anything sticks.
router.post("/audio/preview", requireAuth, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file" });
  const audioPath = req.file.path;

  try {
    if (!req.user.sheetId) {
      return res.status(400).json({ error: "No Google Sheet linked. Please reconnect your Google account." });
    }

    const lang = req.body.lang || req.user.language || "en";

    const transcription = await groq.audio.transcriptions.create({
      file: new File([fs.readFileSync(audioPath)], "audio.webm", { type: "audio/webm" }),
      model: "whisper-large-v3",
      language: lang === "ta" ? "ta" : "en",
    });

    const spokenText = transcription.text;
    console.log(`[${req.user.email}] Transcribed (${lang}): ${spokenText}`);

    const extracted = await extractExpenseFromText(spokenText, lang);

    if (extracted.error) {
      return res.json({ success: false, transcription: spokenText, message: "Could not detect an expense." });
    }

    res.json({ success: true, transcription: spokenText, expense: extracted, lang });
  } catch (err) {
    console.error("Audio preview error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(audioPath, () => {});
  }
});

// ─── POST /api/expenses/text/preview ─────────────────────────────────────────
router.post("/text/preview", requireAuth, async (req, res) => {
  const { text, lang: bodyLang } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  if (!req.user.sheetId) return res.status(400).json({ error: "No Google Sheet linked." });

  const lang = bodyLang || req.user.language || "en";

  try {
    const extracted = await extractExpenseFromText(text, lang);

    if (extracted.error) {
      return res.json({ success: false, transcription: text, message: "Could not detect an expense." });
    }

    res.json({ success: true, transcription: text, expense: extracted, lang });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/expenses/confirm ───────────────────────────────────────────────
// The user has reviewed (and possibly edited) the previewed expense. This is
// the ONLY route that writes to Mongo + Sheets for voice/text capture.
router.post("/confirm", requireAuth, async (req, res) => {
  const { expense, transcription, lang } = req.body;

  if (!expense || !expense.item || !expense.amount || !expense.category || !expense.date) {
    return res.status(400).json({ error: "Incomplete expense — item, amount, category, and date are required." });
  }
  if (!req.user.sheetId) return res.status(400).json({ error: "No Google Sheet linked." });

  try {
    await saveExpenseAndSync(req, res, expense, transcription || "", lang);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses ── raw rows ────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  try {
    const expenses = await Expense.find({ userId: req.user._id })
      .sort({ date: -1, loggedAt: -1 })
      .limit(100)
      .lean();

    res.json({ success: true, expenses });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/expenses/:id ── edit a previously confirmed expense ─────────
// Needed now that History is no longer view-only — lets the user fix a
// mistake after the fact without deleting and re-recording.
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const { item, category, amount, date } = req.body;
    const expense = await Expense.findOne({ _id: req.params.id, userId: req.user._id });
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    const prevAmount = expense.amount;

    if (item !== undefined) expense.item = item;
    if (category !== undefined) expense.category = category;
    if (date !== undefined) expense.date = date;
    if (amount !== undefined) expense.amount = Number(amount) || 0;

    await expense.save();

    if (amount !== undefined) {
      req.user.totalAmount += expense.amount - prevAmount;
      await req.user.save();
    }

    // Respond immediately — same "Mongo first, Sheets second" pattern as
    // confirm. Failures here are logged, not surfaced, since Mongo remains
    // the source of truth for in-app totals/history.
    res.json({ success: true, expense });

    if (expense.sheetRowSynced && expense.sheetRowNumber != null) {
      updateExpenseRow(
        req.user.accessToken,
        req.user.refreshToken,
        req.user.sheetId,
        expense.sheetGid,
        expense.sheetRowNumber,
        { date: expense.date, item: expense.item, category: expense.category, amount: expense.amount }
      ).catch((err) =>
        console.error(`Sheet row update failed for expense ${expense._id}:`, err.message)
      );
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/expenses/:id ─────────────────────────────────────────────────
// Deletes from BOTH Mongo and the Google Sheet. Order matters: we delete
// from Sheets first — if that fails, we still remove from Mongo (Mongo is
// the source of truth for the app) but warn the user their Sheet may be
// out of sync, rather than silently leaving a stale row forever.
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const expense = await Expense.findOne({ _id: req.params.id, userId: req.user._id });
    if (!expense) return res.status(404).json({ error: "Expense not found" });

    let sheetDeleteFailed = false;

    if (expense.sheetRowSynced && expense.sheetRowNumber != null && expense.sheetGid != null) {
      try {
        await deleteExpenseRow(
          req.user.accessToken,
          req.user.refreshToken,
          req.user.sheetId,
          expense.sheetGid,
          expense.sheetRowNumber
        );

        // Deleting this row shifted every row below it up by one in the
        // sheet. Reflect that in Mongo so future deletes/edits on those
        // other expenses still target the correct row.
        await Expense.updateMany(
          {
            userId: req.user._id,
            sheetGid: expense.sheetGid,
            sheetRowNumber: { $gt: expense.sheetRowNumber },
          },
          { $inc: { sheetRowNumber: -1 } }
        );
      } catch (sheetErr) {
        console.error(`Sheet row delete failed for expense ${expense._id}:`, sheetErr.message);
        sheetDeleteFailed = true;
      }
    } else {
      // Either it was never synced (e.g. Sheets append failed earlier) or
      // we don't have a row reference for it — nothing to delete in Sheets.
      console.log(`Expense ${expense._id} has no sheet row reference — skipping Sheets delete.`);
    }

    req.user.totalExpenses = Math.max(0, req.user.totalExpenses - 1);
    req.user.totalAmount = Math.max(0, req.user.totalAmount - expense.amount);
    await req.user.save();

    await expense.deleteOne();

    res.json({
      success: true,
      sheetWarning: sheetDeleteFailed
        ? "Removed from your records, but the row may still be visible in your Google Sheet. It will not affect future totals."
        : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics ── full analytics ───────────────────────────
router.get("/analytics", requireAuth, async (req, res) => {
  try {
    const expenses = await Expense.find({ userId: req.user._id }).lean();

    if (!expenses.length) {
      return res.json({ success: true, analytics: null, message: "No expenses yet" });
    }

    const analytics = buildAnalytics(expenses);
    res.json({ success: true, analytics });
  } catch (err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics/daily ── just daily breakdown ───────────────
router.get("/analytics/daily", requireAuth, async (req, res) => {
  try {
    const expenses = await Expense.find({ userId: req.user._id }).lean();
    const { daily } = buildAnalytics(expenses);

    const { month } = req.query;
    const filtered = month ? daily.filter((d) => {
      const parsed = parseDate(d.date);
      if (!parsed) return false;
      const key = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}`;
      return key === month;
    }) : daily;

    res.json({ success: true, daily: filtered });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics/monthly ── monthly breakdown ────────────────
router.get("/analytics/monthly", requireAuth, async (req, res) => {
  try {
    const expenses = await Expense.find({ userId: req.user._id }).lean();
    const { monthly } = buildAnalytics(expenses);
    res.json({ success: true, monthly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics/categories ── category breakdown ─────────────
router.get("/analytics/categories", requireAuth, async (req, res) => {
  try {
    const expenses = await Expense.find({ userId: req.user._id }).lean();
    const { categories, topItems } = buildAnalytics(expenses);
    res.json({ success: true, categories, topItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
