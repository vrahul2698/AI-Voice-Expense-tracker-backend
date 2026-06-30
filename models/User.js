import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    avatar: { type: String },

    // Google OAuth tokens — used to call Sheets/Drive API on behalf of user
    accessToken: { type: String, required: true },
    refreshToken: { type: String },

    // Auto-created Google Sheet for this user
    sheetId: { type: String, default: null },
    sheetUrl: { type: String, default: null },

    // Stats
    totalExpenses: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },

    // Preferred language for voice/text parsing + UI strings.
    // "en" | "ta" — defaults to English so existing users are unaffected.
    language: { type: String, enum: ["en", "ta"], default: "en" },

    // WhatsApp number for daily reminders/summary, in international format
    // with country code, no "+" or spaces (e.g. "919876543210"), matching
    // the chatId format WhatScale expects ("<number>@c.us" is built from this).
    // null = reminders are off for this user until they set one.
    whatsappNumber: { type: String, default: null },

    // Lets a user opt out of one or both daily WhatsApp messages without
    // clearing their number (e.g. they want the summary but not the nudge).
    remindersEnabled: { type: Boolean, default: true },
    summaryEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
