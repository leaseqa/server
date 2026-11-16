import express from "express";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import * as usersDao from "../Users/dao.js";
import { sendData, sendError, sendUnauthorized } from "../utils/responses.js";
import { isBlockedDemoAccount, isDemoAccountEmail } from "../shared/demoAccounts.js";
import { requireUser, scrubBlockedDemoSession } from "../utils/session.js";
import { parseLogin, parsePasswordChange, parseRegistration } from "./input.js";
import { ZodError } from "zod";

const sendValidationError = (res, error) => sendError(res, {
  code: "VALIDATION_ERROR",
  message: "Invalid request body.",
  details: error.issues,
  status: 400,
});

const getAccountEligibilityError = (user, env) => {
  if ( isBlockedDemoAccount(user.email, env) ) {
    return {
      code: "INVALID_CREDENTIALS",
      message: "Invalid login.",
      status: 401,
    };
  }
  if ( user.banned ) {
    return {
      code: "FORBIDDEN",
      message: "This account has been disabled by an administrator.",
      status: 403,
    };
  }
  return null;
};

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
  const sanitized = dao.sanitizeUser(user);
  req.session.currentUser = sanitized;
  return sanitized;
};

const establishAuthenticatedSession = (req, user, dao) => new Promise((resolve, reject) => {
  req.session.regenerate((regenerateError) => {
    if ( regenerateError ) return reject(regenerateError);

    let sanitized;
    try {
      sanitized = setSessionUser(req, user, dao);
    } catch ( error ) {
      return reject(error);
    }

    return req.session.save((saveError) => {
      if ( saveError ) return reject(saveError);
      return resolve(sanitized);
    });
  });
});

export const createAuthRouter = (dao = usersDao, { env = process.env } = {}) => {
  const router = express.Router();

  router.post("/register", async (req, res, next) => {
    try {
      const registration = parseRegistration(req.body);
      const { email } = registration;

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

      const user = await dao.createUser(registration);
      const eligibilityError = getAccountEligibilityError(user, env);
      if ( eligibilityError ) return sendError(res, eligibilityError);
      const safeUser = await establishAuthenticatedSession(req, user, dao);
      console.log("[Auth] registration_succeeded");
      return sendData(res, safeUser, 201);
    } catch ( error ) {
      if ( error instanceof ZodError ) return sendValidationError(res, error);
      return next(error);
    }
  });

  router.post("/login", async (req, res, next) => {
    try {
      let login;
      try {
        login = parseLogin(req.body);
      } catch ( error ) {
        if ( error instanceof ZodError ) return sendValidationError(res, error);
        throw error;
      }
      const { email, password } = login;

      const user = await dao.findUserByEmail(email);
      if ( !user ) {
        return sendError(res, {
          code: "INVALID_CREDENTIALS",
          message: "Invalid login.",
          status: 401,
        });
      }

      const isValidPassword = dao.verifyPassword(password, user.hashedPassword);
      if ( !isValidPassword ) {
        return sendError(res, {
          code: "INVALID_CREDENTIALS",
          message: "Invalid login.",
          status: 401,
        });
      }

      const eligibilityError = getAccountEligibilityError(user, env);
      if ( eligibilityError ) return sendError(res, eligibilityError);

      const safeUser = await establishAuthenticatedSession(req, user, dao);
      console.log("[Auth] login_succeeded");
      return sendData(res, safeUser);
    } catch ( error ) {
      return next(error);
    }
  });

  router.get("/google", passport.authenticate("google", { scope: ["profile", "email"], session: false }));

  router.get("/google/callback", passport.authenticate("google", {
    failureRedirect: "/auth/login",
    session: false
  }), async (req, res, next) => {
    try {
      const clientUrl = env.CLIENT_URL || "http://localhost:3000";
      const eligibilityError = getAccountEligibilityError(req.user, env);
      if ( eligibilityError ) return sendError(res, eligibilityError);
      await establishAuthenticatedSession(req, req.user, dao);
      console.log("[Auth] google_login_succeeded");
      return res.redirect(clientUrl);
    } catch ( error ) {
      return next(error);
    }
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      sendData(res, { success: true });
    });
  });

  router.get("/session", (req, res) => {
    scrubBlockedDemoSession(req, { env });
    const currentUser = requireUser(req, res, { env });
    if ( !currentUser ) return;
    return sendData(res, currentUser);
  });

  router.post("/password", async (req, res, next) => {
    try {
      const currentUser = requireUser(req, res, { env });
      if ( !currentUser ) return;

      let change;
      try {
        change = parsePasswordChange(req.body);
      } catch ( error ) {
        if ( error instanceof ZodError ) return sendValidationError(res, error);
        throw error;
      }

      const user = await dao.findUserById(currentUser._id);
      if ( !user ) return sendUnauthorized(res, "Sign in again to change your password.");
      // Everyone who tries the demo signs in with the same password.
      if ( isDemoAccountEmail(user.email) ) {
        return sendError(res, {
          code: "FORBIDDEN",
          message: "Demo accounts keep their shared password.",
          status: 403,
        });
      }
      if ( !user.hashedPassword ) {
        return sendError(res, {
          code: "NO_PASSWORD",
          message: "This account signs in with Google, so it has no password to change.",
          status: 409,
        });
      }
      // 400 rather than 401: the session is fine, the form is not.
      if ( !dao.verifyPassword(change.currentPassword, user.hashedPassword) ) {
        return sendError(res, {
          code: "INVALID_CURRENT_PASSWORD",
          message: "Current password is incorrect.",
          status: 400,
        });
      }
      if ( change.newPassword === change.currentPassword ) {
        return sendError(res, {
          code: "VALIDATION_ERROR",
          message: "Choose a new password that differs from the current one.",
          status: 400,
        });
      }

      const updated = await dao.updatePassword(user._id, change.newPassword);
      // A fresh session id, as at sign-in, so an id that leaked before the
      // change stops working with it.
      const safeUser = await establishAuthenticatedSession(req, updated, dao);
      console.log("[Auth] password_changed");
      return sendData(res, safeUser);
    } catch ( error ) {
      return next(error);
    }
  });

  return router;
};

export default createAuthRouter();
