// ─── app.js — cron section ─────────────────────────────────────────────────
// This replaces the single "* * * * *" cron block from before. Two separate
// jobs now run at fixed times in Asia/Kolkata: a 7 PM reminder for anyone
// who hasn't logged anything yet today, and a 9 PM full summary for everyone
// who has WhatsApp + summaries enabled.

import cron from "node-cron";
import User from "./models/User.js";
import { sendReminderForUser, sendDailySummaryForUser } from "./dailyReport.js";

app.use("/auth", authRoutes);
app.use("/api/expenses", expenseRoutes);
app.get("/health", (req, res) => res.json({ status: "ok", version: "2.1.0" }));

// ─── 7:00 PM IST — "you haven't logged anything today" reminder ────────────
cron.schedule(
  "0 19 * * *",
  async () => {
    console.log("Running 7 PM expense reminder job...");
    try {
      const users = await User.find({
        sheetId: { $exists: true, $ne: null },
        whatsappNumber: { $exists: true, $ne: null },
        remindersEnabled: true,
      });

      for (const user of users) {
        try {
          await sendReminderForUser(user);
        } catch (err) {
          console.error(`Reminder failed for ${user.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error("7 PM reminder cron error:", err.message);
    }
  },
  { timezone: "Asia/Kolkata" }
);

// ─── 9:00 PM IST — full daily summary ───────────────────────────────────────
cron.schedule(
  "0 21 * * *",
  async () => {
    console.log("Running 9 PM daily summary job...");
    try {
      const users = await User.find({
        sheetId: { $exists: true, $ne: null },
        whatsappNumber: { $exists: true, $ne: null },
        summaryEnabled: true,
      });

      for (const user of users) {
        try {
          await sendDailySummaryForUser(user);
        } catch (err) {
          console.error(`Summary failed for ${user.email}:`, err.message);
        }
      }
    } catch (err) {
      console.error("9 PM summary cron error:", err.message);
    }
  },
  { timezone: "Asia/Kolkata" }
);
