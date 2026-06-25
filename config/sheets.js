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

  const startOfWeek = new Date(now);
  const day = now.getDay();
  startOfWeek.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  startOfWeek.setHours(0, 0, 0, 0);
  const weekTotal = data.filter((r) => {
    const d = parseDate(r.date);
    return d && d >= startOfWeek;
  }).reduce((s, r) => s + r.amount, 0);

  const monthTotal = data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === thisMonthKey;
  }).reduce((s, r) => s + r.amount, 0);

  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthTotal = data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === lastMonthKey;
  }).reduce((s, r) => s + r.amount, 0);

  const categoryMap = {};
  data.filter((r) => {
    const d = parseDate(r.date);
    if (!d) return false;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}` === thisMonthKey;
  }).forEach(({ category, amount }) => {
    if (category) categoryMap[category] = (categoryMap[category] || 0) + amount;
  });
  const categories = Object.entries(categoryMap).sort((a, b) => b[1] - a[1]);

  const itemMap = {};
  data.forEach(({ item, amount }) => {
    if (!item) return;
    const key = item.toLowerCase().trim();
    if (!itemMap[key]) itemMap[key] = { item, total: 0, count: 0 };
    itemMap[key].total += amount;
    itemMap[key].count += 1;
  });
  const topItems = Object.values(itemMap).sort((a, b) => b.total - a.total).slice(0, 5);

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
// IMPORTANT for the OAuth scope change in auth.js: this function creates the
// spreadsheet via sheets.spreadsheets.create(). A file created through the
// Sheets API while the app holds the "drive.file" grant is automatically
// accessible to the app afterward — that's the whole point of drive.file.
// No code change needed here for the scope change to work.
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

  await updateSummarySheet(sheets, sheetId, buildSummaryData([
    ["Date", "Item", "Category", "Amount (Rs)", "Original Text", "Logged At"],
  ]));

  console.log("✅ Headers + Summary ready");
  return { sheetId, sheetUrl };
}

// ─── Append expense + refresh summary ────────────────────────────────────────
// Returns { row, rowNumber, sheetGid } so the caller (saveExpenseAndSync) can
// store rowNumber/sheetGid on the Mongo document — needed later to delete or
// patch this exact row in the spreadsheet.
export async function appendExpenseRow(accessToken, refreshToken, sheetId, data) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  const expensesTab = await findExpensesTab(sheets, sheetId);
  console.log(`Using tab: ${expensesTab}`);

  await ensureSummaryTab(sheets, sheetId);

  const row = [
    data.date,
    data.item,
    data.category,
    data.amount,
    data.originalText,
    new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
  ];

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  // The API returns the range it actually wrote to, e.g. "Expenses!A42:F42" —
  // parse the row number out of that so we can target this row later.
  const updatedRange = appendRes.data.updates?.updatedRange || "";
  const rowMatch = updatedRange.match(/![A-Z]+(\d+):/);
  const rowNumber = rowMatch ? parseInt(rowMatch[1], 10) : null;

  // sheetGid is the numeric tab id batchUpdate needs (not the tab name).
  const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetId });
  const tabMeta = meta.data.sheets.find((s) => s.properties.title === expensesTab);
  const sheetGid = tabMeta ? tabMeta.properties.sheetId : null;

  const allRows = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
  });

  const summaryData = buildSummaryData(allRows.data.values || []);
  await updateSummarySheet(sheets, sheetId, summaryData);

  return { row, rowNumber, sheetGid, tabName: expensesTab };
}

// ─── Delete a specific row from the Expenses tab + refresh summary ──────────
// IMPORTANT: deleting a row shifts every row below it up by one. The caller
// (expenses.js) MUST re-sync sheetRowNumber for all other synced expenses
// belonging to this user after calling this — see resyncRowNumbersAfterDelete
// below, or the next delete/edit will target the wrong row.
export async function deleteExpenseRow(accessToken, refreshToken, sheetId, sheetGid, rowNumber) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  if (sheetGid == null || rowNumber == null) {
    throw new Error("Missing sheetGid or rowNumber — cannot locate row to delete.");
  }

  // deleteDimension uses 0-indexed, half-open ranges: to delete spreadsheet
  // row N (1-indexed, as shown in the UI), startIndex is N-1 and endIndex is N.
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetGid,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });

  console.log(`✅ Deleted row ${rowNumber} from sheet ${sheetId}`);

  // Refresh the Summary tab so totals reflect the deletion immediately.
  const expensesTab = await findExpensesTab(sheets, sheetId);
  const allRows = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
  });
  const summaryData = buildSummaryData(allRows.data.values || []);
  await updateSummarySheet(sheets, sheetId, summaryData);
}

// ─── Update a specific row's values in place + refresh summary ──────────────
export async function updateExpenseRow(accessToken, refreshToken, sheetId, sheetGid, rowNumber, data) {
  const auth = getOAuthClient(accessToken, refreshToken);
  const sheets = google.sheets({ version: "v4", auth });

  if (rowNumber == null) {
    throw new Error("Missing rowNumber — cannot locate row to update.");
  }

  const expensesTab = await findExpensesTab(sheets, sheetId);

  // Only overwrite Date/Item/Category/Amount (columns A:D) — leave the
  // original transcript and logged-at timestamp (E:F) untouched, since
  // those describe how/when it was originally captured, not its current value.
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A${rowNumber}:D${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[data.date, data.item, data.category, data.amount]] },
  });

  console.log(`✅ Updated row ${rowNumber} in sheet ${sheetId}`);

  const allRows = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `${expensesTab}!A:F`,
  });
  const summaryData = buildSummaryData(allRows.data.values || []);
  await updateSummarySheet(sheets, sheetId, summaryData);
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
