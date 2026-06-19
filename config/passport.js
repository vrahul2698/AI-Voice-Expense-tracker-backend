import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import User from "../models/User.js";
import { createUserSheet } from "./sheets.js";
import dotenv from "dotenv";
dotenv.config();

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        console.log("=== GOOGLE LOGIN ===");
        console.log("Profile:", profile.displayName, profile.emails[0].value);
        console.log("AccessToken:", accessToken ? "✅ received" : "❌ missing");
        console.log("RefreshToken:", refreshToken ? "✅ received" : "❌ MISSING — sheet creation will fail");

        let user = await User.findOne({ googleId: profile.id });

        if (user) {
          console.log("Existing user found, updating tokens...");
          user.accessToken = accessToken;
          if (refreshToken) user.refreshToken = refreshToken;

          // If sheetId is null, try to create it now
          if (!user.sheetId) {
            console.log("sheetId is null — attempting to create sheet now...");
            try {
              const sheet = await createUserSheet(accessToken, refreshToken || user.refreshToken, user.name);
              user.sheetId = sheet.sheetId;
              user.sheetUrl = sheet.sheetUrl;
              console.log("✅ Sheet created on re-login:", sheet.sheetUrl);
            } catch (sheetErr) {
              console.error("❌ Sheet creation failed:", sheetErr.message);
              console.error("Full error:", JSON.stringify(sheetErr?.response?.data || sheetErr, null, 2));
            }
          }

          await user.save();
          return done(null, user);
        }

        // New user
        const name = profile.displayName || profile.emails[0].value.split("@")[0];
        console.log("New user — creating account for:", name);

        let sheetId = null;
        let sheetUrl = null;

        if (!refreshToken) {
          console.error("❌ No refresh token received! Cannot create sheet.");
          console.error("Fix: revoke app access at myaccount.google.com/permissions and login again");
        } else {
          try {
            console.log("Creating Google Sheet...");
            const sheet = await createUserSheet(accessToken, refreshToken, name);
            sheetId = sheet.sheetId;
            sheetUrl = sheet.sheetUrl;
            console.log("✅ Sheet created:", sheetUrl);
          } catch (sheetErr) {
            console.error("❌ Sheet creation failed:", sheetErr.message);
            console.error("Full error:", JSON.stringify(sheetErr?.response?.data || sheetErr, null, 2));
          }
        }

        user = await User.create({
          googleId: profile.id,
          email: profile.emails[0].value,
          name,
          avatar: profile.photos?.[0]?.value,
          accessToken,
          refreshToken: refreshToken || null,
          sheetId,
          sheetUrl,
        });

        console.log("User created. sheetId:", sheetId || "NULL");
        return done(null, user);
      } catch (err) {
        console.error("❌ Passport error:", err.message);
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
  const user = await User.findById(id);
  done(null, user);
});

export default passport;
