import express from "express";
import passport from "passport";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import { createUserSheet } from "../config/sheets.js";

const router = express.Router();

// ─── Start Google OAuth ───────────────────────────────────────────────────────
router.get(
  "/google",
  passport.authenticate("google", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/spreadsheets",
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
    // Issue JWT
    const token = jwt.sign({ userId: req.user._id }, process.env.JWT_SECRET, { expiresIn: "7d" });

    // Redirect to frontend with token
    res.redirect(`${process.env.CLIENT_URL}/auth/callback?token=${token}`);
  }
);

// ─── Get current user ─────────────────────────────────────────────────────────
router.get("/me", requireAuth, async (req, res) => {
  const { _id, name, email, avatar, sheetId, sheetUrl, totalExpenses, totalAmount, createdAt } = req.user;
  res.json({ _id, name, email, avatar, sheetId, sheetUrl, totalExpenses, totalAmount, createdAt });
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
