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
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
