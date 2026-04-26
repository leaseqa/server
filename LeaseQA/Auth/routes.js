import express from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import * as usersDao from "../Users/dao.js";
import { sendData, sendError } from "../utils/responses.js";
import { isBlockedDemoAccount } from "../shared/demoAccounts.js";
import { requireUser, scrubBlockedDemoSession } from "../utils/session.js";

if ( process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ) passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL || "http://localhost:4000/api/auth/google/callback",
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if ( !email ) return done(new Error("No email from Google"));

        let user = await usersDao.findUserByGoogleId(profile.id);
        if ( !user ) user = await usersDao.findUserByEmail(email);

        if ( user ) {
          if ( !user.googleId ) {
            user = await usersDao.updateUserById(user._id, {
              googleId: profile.id,
              avatarUrl: profile.photos?.[0]?.value,
            });
          }
        } else {
          user = await usersDao.createUser({
            username: profile.displayName || email.split("@")[0],
            email,
            googleId: profile.id,
            avatarUrl: profile.photos?.[0]?.value,
          });
        }
        return done(null, user);
      } catch ( err ) {
        return done(err);
      }
    }
  )
);

const setSessionUser = (req, user, dao = usersDao) => {
  try {
    console.log("[Auth] Setting session for user:", user._id);
    const sanitized = dao.sanitizeUser(user);
    console.log("[Auth] Sanitized user:", sanitized);
    req.session.currentUser = sanitized;
    console.log("[Auth] Session set successfully");
  } catch ( error ) {
    console.error("[Auth] Error setting session:", error);
    throw error;
  }
};

export const createAuthRouter = (dao = usersDao, { env = process.env } = {}) => {
  const router = express.Router();

  router.post("/register", async (req, res) => {
    const { username, email, password, role, lawyerVerification } = req.body;

    if ( !username || !email || !password ) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "Username, email, and password are required.",
        status: 400,
      });
    }

    const existingUser = await dao.findUserByEmail(email);
    if ( existingUser ) {
      return sendError(res, {
        code: "USER_EXISTS",
        message: "A user with that email already exists.",
        status: 409,
      });
    }

    if ( isBlockedDemoAccount(email, env) ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "This email is reserved.",
        status: 403,
      });
    }

    const user = await dao.createUser({
      username,
      email,
      password,
      role,
      lawyerVerification,
    });

    setSessionUser(req, user, dao);
    req.session.save((err) => {
      if ( err ) {
        console.error("[Auth] Session save error:", err);
        return sendError(res, {
          code: "INTERNAL_ERROR",
          message: "Failed to save session.",
          status: 500
        });
      }
      return sendData(res, req.session.currentUser, 201);
    });
  });

  router.post("/login", async (req, res) => {
    try {
      const { email, password } = req.body;
      console.log(`[Auth] Login attempt for: ${email}`);

      if ( !email || !password ) {
        console.log("[Auth] Missing email or password");
        return sendError(res, {
          code: "VALIDATION_ERROR",
          message: "Email and password are required.",
          status: 400,
        });
      }

      const user = await dao.findUserByEmail(email);
      if ( !user ) {
        console.log("[Auth] User not found");
        return sendError(res, {
          code: "INVALID_CREDENTIALS",
          message: "Invalid login.",
          status: 401,
        });
      }

      if ( isBlockedDemoAccount(email, env) ) {
        console.log("[Auth] Blocked demo account outside development");
        return sendError(res, {
          code: "INVALID_CREDENTIALS",
          message: "Invalid login.",
          status: 401,
        });
      }

      const isValidPassword = dao.verifyPassword(password, user.hashedPassword);
      if ( !isValidPassword ) {
        console.log("[Auth] Invalid password");
        return sendError(res, {
          code: "INVALID_CREDENTIALS",
          message: "Invalid login.",
          status: 401,
        });
      }

      if ( user.banned ) {
        console.log("[Auth] User banned");
        return sendError(res, {
          code: "FORBIDDEN",
          message: "This account has been disabled by an administrator.",
          status: 403,
        });
      }

      const userObj = user.toObject ? user.toObject() : user;
      const { hashedPassword, ...safeUser } = userObj;

      req.session.currentUser = safeUser;

      console.log(`[Auth] Login successful. Session ID: ${req.sessionID}`);
      req.session.save((err) => {
        if ( err ) {
          console.error("[Auth] Session save error:", err);
          return sendError(res, {
            code: "INTERNAL_ERROR",
            message: "Failed to save session.",
            status: 500
          });
        }
        return sendData(res, safeUser);
      });
    } catch ( error ) {
      console.error("[Auth] CRITICAL ERROR in login route:", error);
      return sendError(res, {
        code: "INTERNAL_ERROR",
        message: "An internal server error occurred during login.",
        status: 500
      });
    }
  });

  router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));

  router.get("/google/callback", passport.authenticate("google", {
    failureRedirect: "/auth/login",
    session: false
  }), (req, res) => {
    const clientUrl = process.env.CLIENT_URL || process.env.CLIENT_URLS?.split(",")[0] || "http://localhost:3000";
    setSessionUser(req, req.user, dao);
    req.session.save(() => res.redirect(clientUrl));
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      sendData(res, { success: true });
    });
  });

  router.get("/session", (req, res) => {
    console.log(`[Auth] Session check. SessionID: ${req.sessionID}`);
    console.log(`[Auth] Session Data:`, req.session);
    scrubBlockedDemoSession(req, { env });
    const currentUser = requireUser(req, res, { env });
    if ( !currentUser ) {
      console.log("[Auth] No currentUser in session.");
      return;
    }
    console.log(`[Auth] Session valid for user: ${currentUser.email}`);
    return sendData(res, currentUser);
  });

  return router;
};

export default createAuthRouter();
