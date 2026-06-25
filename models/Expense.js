import mongoose from "mongoose";

const expenseSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    item: { type: String, required: true },
    category: { type: String, required: true },
    amount: { type: Number, required: true },
    date: { type: String, required: true }, // DD/MM/YYYY — matches existing sheet format
    originalText: { type: String },
    loggedAt: { type: Date, default: Date.now },
    sheetRowSynced: { type: Boolean, default: false },

    // The exact row number (1-indexed, matching the Sheets UI) this expense
    // was written to in the "Expenses" tab, plus that tab's numeric gid.
    // Needed to delete or patch the correct row later — searching by content
    // (item/amount/date) is unreliable once rows get edited or duplicated.
    sheetRowNumber: { type: Number, default: null },
    sheetGid: { type: Number, default: null },

    // Language the original text/voice was captured in — "en" | "ta".
    // Purely informational (useful later for per-language analytics);
    // doesn't affect how the row is written to Sheets.
    language: { type: String, enum: ["en", "ta"], default: "en" },
  },
  { timestamps: true }
);

// Most analytics queries filter by userId and group/sort by date —
// this compound index keeps those queries fast as data grows.
expenseSchema.index({ userId: 1, date: 1 });

export default mongoose.model("Expense", expenseSchema);
