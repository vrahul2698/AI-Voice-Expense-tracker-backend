import express from "express";
import multer from "multer";
import fs from "fs";
import Groq from "groq-sdk";
import { requireAuth } from "../middleware/auth.js";
import { appendExpenseRow, getSheetRows } from "../config/sheets.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const upload = multer({ dest: "uploads/" });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Helper: Extract expense using Groq LLaMA ────────────────────────────────
async function extractExpenseFromText(text) {
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "You are an expense extraction assistant. Always respond with ONLY a valid JSON object, no markdown, no explanation, no backticks.",
      },
      {
        role: "user",
        content: `Extract expense from: "${text}"
Today: ${today}
Return JSON: {"item":"Tea","category":"Food & Drink","amount":200,"date":"${today}","confidence":"high"}
Categories: Food & Drink, Transport, Shopping, Bills, Entertainment, Health, Education, Other
If no expense: {"error":"No expense detected"}`,
      },
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

// ─── Helper: Build analytics from sheet rows ─────────────────────────────────
function buildAnalytics(rows) {
  // Skip header row
  const data = rows.slice(1).map((row) => ({
    date: row[0] || "",
    item: row[1] || "",
    category: row[2] || "",
    amount: parseFloat(row[3]) || 0,
    originalText: row[4] || "",
    loggedAt: row[5] || "",
  }));

  // ── Daily totals ──────────────────────────────────────────────────────────
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
      return db - da; // newest first
    });

  // ── Monthly totals ────────────────────────────────────────────────────────
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

  // ── Category totals (all time) ────────────────────────────────────────────
  const categoryMap = {};
  data.forEach(({ category, amount }) => {
    if (!category) return;
    categoryMap[category] = (categoryMap[category] || 0) + amount;
  });

  const categories = Object.entries(categoryMap)
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);

  // ── Weekly totals (last 4 weeks) ──────────────────────────────────────────
  const now = new Date();
  const weeklyMap = {};
  data.forEach(({ date, amount }) => {
    const d = parseDate(date);
    if (!d) return;
    const diffDays = Math.floor((now - d) / (1000 * 60 * 60 * 24));
    const weekNum = Math.floor(diffDays / 7);
    if (weekNum > 3) return; // only last 4 weeks
    const label = weekNum === 0 ? "This Week" : weekNum === 1 ? "Last Week" : `${weekNum} Weeks Ago`;
    if (!weeklyMap[weekNum]) weeklyMap[weekNum] = { week: weekNum, label, total: 0, count: 0 };
    weeklyMap[weekNum].total += amount;
    weeklyMap[weekNum].count += 1;
  });

  const weekly = Object.values(weeklyMap).sort((a, b) => a.week - b.week);

  // ── Top spending items ─────────────────────────────────────────────────────
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

  // ── Summary stats ─────────────────────────────────────────────────────────
  const totalAmount = data.reduce((sum, r) => sum + r.amount, 0);
  const totalCount = data.length;
  const avgPerDay = daily.length > 0 ? totalAmount / daily.length : 0;
  const avgPerTransaction = totalCount > 0 ? totalAmount / totalCount : 0;

  // Today's total
  const todayStr = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const todayTotal = dailyMap[todayStr]?.total || 0;
  const todayCount = dailyMap[todayStr]?.count || 0;

  // This month's total
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const thisMonthTotal = monthlyMap[thisMonthKey]?.total || 0;
  const thisMonthCount = monthlyMap[thisMonthKey]?.count || 0;

  // Highest spending day
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
    recentExpenses: data.slice(0, 10), // last 10 raw entries
  };
}

// ─── POST /api/expenses/audio ─────────────────────────────────────────────────
router.post("/audio", requireAuth, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file" });
  const audioPath = req.file.path;

  try {
    if (!req.user.sheetId) {
      return res.status(400).json({ error: "No Google Sheet linked. Please reconnect your Google account." });
    }

    const transcription = await groq.audio.transcriptions.create({
      file: new File([fs.readFileSync(audioPath)], "audio.webm", { type: "audio/webm" }),
      model: "whisper-large-v3",
      language: "en",
    });

    const spokenText = transcription.text;
    console.log(`[${req.user.email}] Transcribed: ${spokenText}`);

    const extracted = await extractExpenseFromText(spokenText);

    if (extracted.error) {
      return res.json({ success: false, transcription: spokenText, message: "Could not detect an expense." });
    }

    const row = await appendExpenseRow(
      req.user.accessToken,
      req.user.refreshToken,
      req.user.sheetId,
      { ...extracted, originalText: spokenText }
    );

    req.user.totalExpenses += 1;
    req.user.totalAmount += Number(extracted.amount) || 0;
    await req.user.save();

    res.json({ success: true, transcription: spokenText, expense: extracted, sheetRow: row });
  } catch (err) {
    console.error("Audio error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    fs.unlink(audioPath, () => {});
  }
});

// ─── POST /api/expenses/text ──────────────────────────────────────────────────
router.post("/text", requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  if (!req.user.sheetId) return res.status(400).json({ error: "No Google Sheet linked." });

  try {
    const extracted = await extractExpenseFromText(text);

    if (extracted.error) {
      return res.json({ success: false, transcription: text, message: "Could not detect an expense." });
    }

    const row = await appendExpenseRow(
      req.user.accessToken,
      req.user.refreshToken,
      req.user.sheetId,
      { ...extracted, originalText: text }
    );

    req.user.totalExpenses += 1;
    req.user.totalAmount += Number(extracted.amount) || 0;
    await req.user.save();

    res.json({ success: true, transcription: text, expense: extracted, sheetRow: row });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses ── raw rows ────────────────────────────────────────────
router.get("/", requireAuth, async (req, res) => {
  if (!req.user.sheetId) return res.json({ rows: [] });

  try {
    const rows = await getSheetRows(req.user.accessToken, req.user.refreshToken, req.user.sheetId);
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics ── full analytics ───────────────────────────
router.get("/analytics", requireAuth, async (req, res) => {
  if (!req.user.sheetId) {
    return res.json({ success: true, analytics: null, message: "No sheet linked" });
  }

  try {
    const rows = await getSheetRows(req.user.accessToken, req.user.refreshToken, req.user.sheetId);

    if (!rows || rows.length <= 1) {
      return res.json({ success: true, analytics: null, message: "No expenses yet" });
    }

    const analytics = buildAnalytics(rows);
    res.json({ success: true, analytics });
  } catch (err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics/daily ── just daily breakdown ───────────────
router.get("/analytics/daily", requireAuth, async (req, res) => {
  if (!req.user.sheetId) return res.json({ success: true, daily: [] });

  try {
    const rows = await getSheetRows(req.user.accessToken, req.user.refreshToken, req.user.sheetId);
    const { daily } = buildAnalytics(rows);

    // Optional: filter by ?month=2026-05
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
  if (!req.user.sheetId) return res.json({ success: true, monthly: [] });

  try {
    const rows = await getSheetRows(req.user.accessToken, req.user.refreshToken, req.user.sheetId);
    const { monthly } = buildAnalytics(rows);
    res.json({ success: true, monthly });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/expenses/analytics/categories ── category breakdown ─────────────
router.get("/analytics/categories", requireAuth, async (req, res) => {
  if (!req.user.sheetId) return res.json({ success: true, categories: [] });

  try {
    const rows = await getSheetRows(req.user.accessToken, req.user.refreshToken, req.user.sheetId);
    const { categories, topItems } = buildAnalytics(rows);
    res.json({ success: true, categories, topItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
