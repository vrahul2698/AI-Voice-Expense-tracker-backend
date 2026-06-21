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
  },
  { timestamps: true }
);

// Most analytics queries filter by userId and group/sort by date —
// this compound index keeps those queries fast as data grows.
expenseSchema.index({ userId: 1, date: 1 });

export default mongoose.model("Expense", expenseSchema);
