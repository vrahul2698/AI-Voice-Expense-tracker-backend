import express from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import { createUserSheet } from "../config/sheets.js";

const router = express.Router();

// ─── Start Google OAuth ───────────────────────────────────────────────────────
// NOTE ON SCOPES: "spreadsheets" was dropped. It's a SENSITIVE scope that
// triggers Google's app-verification review. This app only ever creates its
// own spreadsheet per user (see createUserSheet) and only ever writes to
// that same spreadsheet afterward (see appendExpenseRow) — it never reads or
// writes a spreadsheet the user picked themselves. That's exactly the case
// "drive.file" covers: access limited to files the app itself created.
// drive.file is a NON-sensitive scope, so dropping "spreadsheets" means this
// app can go live without Google's sensitive-scope verification process.
//
// If a future feature needs to read/write a spreadsheet the user already
// owns (not one the app created), this scope decision needs revisiting.
router.get(
  "/google",
  passport.authenticate("google", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/drive.file",
    ],
    accessType: "offline",
    prompt: "consent", // Forces refresh token every time
  })
);

// ─── Google OAuth Callback ────────────────────────────────────────────────────
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: `${process.env.CLIENT_URL}/login?error=auth_failed` }),
  (req, res) => {
    const token = jwt.sign({ userId: req.user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });
    res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`);
  }
);

// ─── Get current user ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  const {
    _id, name, email, avatar, sheetId, sheetUrl, totalExpenses, totalAmount,
    language, whatsappNumber, remindersEnabled, summaryEnabled, createdAt,
  } = req.user;
  res.json({
    _id, name, email, avatar, sheetId, sheetUrl, totalExpenses, totalAmount,
    language, whatsappNumber, remindersEnabled, summaryEnabled, createdAt,
  });
});

// ─── Update language preference (English / Tamil) ────────────────────────────
router.patch("/language", requireAuth, async (req, res) => {
  const { language } = req.body;
  if (!["en", "ta"].includes(language)) {
    return res.status(400).json({ error: "language must be 'en' or 'ta'" });
  }

  req.user.language = language;
  await req.user.save();
  res.json({ success: true, language: req.user.language });
});

// ─── Update WhatsApp number + reminder/summary toggles ───────────────────────
// whatsappNumber must be digits only, with country code, no "+" or spaces
// (e.g. "919876543210") — this is what gets turned into "<number>@c.us" for
// WhatScale. Pass null/"" to clear it and turn off both messages.
router.patch("/whatsapp", requireAuth, async (req, res) => {
  const { whatsappNumber, remindersEnabled, summaryEnabled } = req.body;

  if (whatsappNumber !== undefined) {
    if (whatsappNumber === null || whatsappNumber === "") {
      req.user.whatsappNumber = null;
    } else if (!/^\d{10,15}$/.test(whatsappNumber)) {
      return res.status(400).json({ error: "whatsappNumber must be digits only with country code, e.g. 919876543210" });
    } else {
      req.user.whatsappNumber = whatsappNumber;
    }
  }

  if (remindersEnabled !== undefined) req.user.remindersEnabled = !!remindersEnabled;
  if (summaryEnabled !== undefined) req.user.summaryEnabled = !!summaryEnabled;

  await req.user.save();
  res.json({
    success: true,
    whatsappNumber: req.user.whatsappNumber,
    remindersEnabled: req.user.remindersEnabled,
    summaryEnabled: req.user.summaryEnabled,
  });
});

// ─── Retry sheet creation (if it failed at signup) ───────────────────────────
router.post("/create-sheet", requireAuth, async (req, res) => {
  try {
    if (req.user.sheetId) {
      return res.json({ sheetId: req.user.sheetId, sheetUrl: req.user.sheetUrl });
    }

    const { sheetId, sheetUrl } = await createUserSheet(
      req.user.accessToken,
      req.user.refreshToken,
      req.user.name
    );

    req.user.sheetId = sheetId;
    req.user.sheetUrl = sheetUrl;
    await req.user.save();

    res.json({ sheetId, sheetUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Logout ──────────────────────────────────────────────────────────────────
router.post("/logout", (req, res) => {
  req.logout(() => res.json({ success: true }));
});

export default router;
