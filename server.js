import dotenv from "dotenv";
dotenv.config();

// Debug: print env vars on startup
console.log("=== ENV CHECK ===");
console.log("GOOGLE_CLIENT_ID:", process.env.GOOGLE_CLIENT_ID ? "✅ loaded" : "❌ MISSING");
console.log("GOOGLE_CLIENT_SECRET:", process.env.GOOGLE_CLIENT_SECRET ? "✅ loaded" : "❌ MISSING");
console.log("GOOGLE_CALLBACK_URL:", process.env.GOOGLE_CALLBACK_URL);
console.log("CLIENT_URL:", process.env.CLIENT_URL);
console.log("MONGODB_URI:", process.env.MONGODB_URI ? "✅ loaded" : "❌ MISSING");
console.log("JWT_SECRET:", process.env.JWT_SECRET ? "✅ loaded" : "❌ MISSING");
console.log("SESSION_SECRET:", process.env.SESSION_SECRET ? "✅ loaded" : "❌ MISSING");
console.log("=================");

import express from "express";
import cors from "cors";
import session from "express-session";
import mongoose from "mongoose";
import "./config/passport.js";
import passport from "passport";
import authRoutes from "./routes/auth.js";
import expenseRoutes from "./routes/expenses.js";

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false },
  })
);
app.use(passport.initialize());
app.use(passport.session());

// Debug: log every request
app.use((req, res, next) => {
  console.log(`→ ${req.method} ${req.url}`);
  next();
});

app.use("/auth", authRoutes);
app.use("/api/expenses", expenseRoutes);
app.get("/health", (req, res) => res.json({ status: "ok", version: "2.0.0" }));

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB connected");
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1);
  });
