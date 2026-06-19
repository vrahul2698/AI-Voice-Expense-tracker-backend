import { google } from "googleapis";
import dotenv from "dotenv";
dotenv.config();

export function getOAuthClient(accessToken, refreshToken) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL
  );
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return oauth2Client;
}

// ─── Parse DD/MM/YYYY ─────────────────────────────────────────────────────────
function parseDate(dateStr) {
  if (!dateStr) return null;
  const [day, month, year] = dateStr.split("/");
  if (!day || !month || !year) return null;
  return new Date(`${year}-${month}-${day}`);
}

// ─── Find which tab has the expense data ─────────────────────────────────────
async function findExpensesTab(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  console.log("Existing tabs:", titles);

  // Priority: Expenses > Sheet1 > first tab
  if (titles.includes("Expenses")) return "Expenses";
  if (titles.includes("Sheet1")) return "Sheet1";
  return titles[0];
}

// ─── Ensure Summary tab exists ────────────────────────────────────────────────
async function ensureSummaryTab(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const titles = meta.data.sheets.map((s) => s.properties.title);

  if (!titles.includes("Summary")) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: "Summary" } } }] },
    });
    console.log("✅ Summary tab created");
  }
}

// ─── Build summary data from raw rows ────────────────────────────────────────
function buildSummaryData(rows) {
  // Skip header row, filter valid rows
  const data = rows.slice(1).map((row) => ({
    date: row[0] || "",
    item: row[1] || "",
    category: row[2] || "",
    amount: parseFloat(row[3]) || 0,
  })).filter((r) => r.amount > 0 && r.date);

  console.log(`Building summary from ${data.length} expense rows`);

  const now = new Date();
  const todayStr = now.toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric",
  });
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const todayTotal = data.filter((r) => r.date === todayStr).reduce((s, r) => s + r.amount, 0);
  const allTimeTotal = data.reduce((s, r) => s + r.amount, 0);

  // This week
  const startOfWeek = new Date(now);
  const day = now.getDay();
  startOfWeek.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  startOfWeek.setHours(0, 0, 0, 0);
  const weekTotal = data.filter((r) => {
    const d = parseDate(r.date);
    return d && d >= startOfWeek;
  }).reduce((s, r) => s + r.amount, 0);

  // This month
  const monthTotal = data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === thisMonthKey;
  }).reduce((s, r) => s + r.amount, 0);

  // Last month
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthTotal = data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === lastMonthKey;
  }).reduce((s, r) => s + r.amount, 0);

  // Category breakdown this month
  const categoryMap = {};
  data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === thisMonthKey;
  }).forEach(({ category, amount }) => {
    if (category) categoryMap[category] = (categoryMap[category] || 0) + amount;
  });
  const categories = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);

  // Top items all time
  const itemMap = {};
  data.forEach(({ item, amount }) => {
    if (!item) return;
    const key = item.toLowerCase().trim();
    if (!itemMap[key]) itemMap[key] = { item, total: 0, count: 0 };
    itemMap[key].total += amount;
    itemMap[key].count += 1;
  });
  const topItems = Object.values(itemMap).sort((a, b) => b.total - a.total).slice(0, 5);

  // Daily totals this month
  const dailyMap = {};
  data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === thisMonthKey;
  }).forEach(({ date, amount }) => {
    dailyMap[date] = (dailyMap[date] || 0) + amount;
  });
  const dailyEntries = Object.entries(dailyMap)
    .sort((a, b) => (parseDate(b[0]) || 0) - (parseDate(a[0]) || 0))
    .slice(0, 10);

  // Monthly history
  const monthlyMap = {};
  data.forEach(({ date, amount }) => {
    const d = parseDate(date);
    if (!d) return;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-IN", { month: "long", year: "numeric" });
    if (!monthlyMap[key]) monthlyMap[key] = { label, total: 0, count: 0 };
    monthlyMap[key].total += amount;
    monthlyMap[key].count += 1;
  });
  const monthlyHistory = Object.entries(monthlyMap)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6);

  return {
    todayTotal, weekTotal, monthTotal, lastMonthTotal, allTimeTotal,
    totalCount: data.length, categories, topItems, dailyEntries, monthlyHistory,
    updatedAt: now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    thisMonthLabel: now.toLocaleString("en-IN", { month: "long", year: "numeric" }),
  };
}

// ─── Write Summary tab ────────────────────────────────────────────────────────
async function updateSummarySheet(sheets, spreadsheetId, summaryData) {
  const {
    todayTotal, weekTotal, monthTotal, lastMonthTotal, allTimeTotal,
    totalCount, categories, topItems, dailyEntries, monthlyHistory,
    updatedAt, thisMonthLabel,
  } = summaryData;

  const fmt = (n) => `Rs. ${Number(n).toLocaleString("en-IN")}`;

  const rows = [
    ["VOICELOG — EXPENSE SUMMARY", "", ""],
    [`Last updated: ${updatedAt}`, "", ""],
    ["", "", ""],
    ["QUICK TOTALS", "", ""],
    ["Period", "Amount", ""],
    ["Today", fmt(todayTotal), ""],
    ["This Week", fmt(weekTotal), ""],
    [`This Month (${thisMonthLabel})`, fmt(monthTotal), ""],
    ["Last Month", fmt(lastMonthTotal), ""],
    ["All Time", fmt(allTimeTotal), `${totalCount} transactions`],
    ["", "", ""],
    ["CATEGORY BREAKDOWN — This Month", "", ""],
    ["Category", "Amount", "% of Month"],
    ...(categories.length > 0
      ? categories.map(([cat, amt]) => [
          cat,
          fmt(amt),
          monthTotal > 0 ? `${((amt / monthTotal) * 100).toFixed(1)}%` : "0%",
        ])
      : [["No expenses this month", "", ""]]),
    ["", "", ""],
    ["TOP ITEMS — All Time", "", ""],
    ["Item", "Total Spent", "Times Logged"],
    ...(topItems.length > 0
      ? topItems.map((i) => [i.item, fmt(i.total), `${i.count}x`])
      : [["No data yet", "", ""]]),
    ["", "", ""],
    ["DAILY TOTALS — This Month", "", ""],
    ["Date", "Amount", ""],
    ...(dailyEntries.length > 0
      ? dailyEntries.map(([date, amt]) => [date, fmt(amt), ""])
      : [["No expenses this month", "", ""]]),
    ["", "", ""],
    ["MONTHLY HISTORY", "", ""],
    ["Month", "Total Spent", "Transactions"],
    ...(monthlyHistory.length > 0
      ? monthlyHistory.map(([, v]) => [v.label, fmt(v.total), `${v.count} entries`])
      : [["No data yet", "", ""]]),
  ];

  // Clear old content first
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: "Summary!A1:D100",
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Summary!A1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  console.log("✅ Summary tab updated");
}

// ─── Create user sheet on signup ──────────────────────────────────────────────
export async function createUserSheet(accessToken, refreshToken, userName) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const spreadsheet = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `${userName}'s Expenses – VoiceLog` },
      sheets: [
        { properties: { title: "Expenses" } },
        { properties: { title: "Summary" } },
      ],
    },
  });

  const sheetId = spreadsheet.data.spreadsheetId;
  const sheetUrl = spreadsheet.data.spreadsheetUrl;
  console.log("✅ Spreadsheet created:", sheetId);

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: "Expenses!A1:F1",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [["Date", "Item", "Category", "Amount (Rs)", "Original Text", "Logged At"]],
    },
  });

  // Write empty summary
  await updateSummarySheet(sheets, sheetId, buildSummaryData([
    ["Date", "Item", "Category", "Amount (Rs)", "Original Text", "Logged At"],
  ]));

  console.log("✅ Headers + Summary ready");
  return { sheetId, sheetUrl };
}

// ─── Append expense + refresh summary ────────────────────────────────────────
export async function appendExpenseRow(accessToken, refreshToken, sheetId, data) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  // Find correct tab (Sheet1 or Expenses)
  const expensesTab = await findExpensesTab(sheets, sheetId);
  console.log(`Using tab: ${expensesTab}`);

  // Ensure Summary tab exists
  await ensureSummaryTab(sheets, sheetId);

  const row = [
    data.date,
    data.item,
    data.category,
    data.amount,
    data.originalText,
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  ];

  // Append to expense tab
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });

  // Read ALL rows from expense tab to build summary
  const allRows = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
  });

  const summaryData = buildSummaryData(allRows.data.values || []);
  await updateSummarySheet(sheets, sheetId, summaryData);

  return row;
}

// ─── Get all expense rows ─────────────────────────────────────────────────────
export async function getSheetRows(accessToken, refreshToken, sheetId) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const expensesTab = await findExpensesTab(sheets, sheetId);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
  });

  return response.data.values || [];
}
