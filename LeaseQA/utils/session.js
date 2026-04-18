import {sendForbidden, sendUnauthorized} from "./responses.js";
import { isBlockedDemoAccount } from "../shared/demoAccounts.js";

export const scrubBlockedDemoSession = (req, { env = process.env } = {}) => {
    const currentUser = req.session?.currentUser;
    if (!currentUser || !isBlockedDemoAccount(currentUser.email, env)) {
        return currentUser || null;
    }

    delete req.session.currentUser;
    if (typeof req.session?.destroy === "function") {
        req.session.destroy(() => {});
    }
    return null;
};

export const requireUser = (req, res, options = {}) => {
    scrubBlockedDemoSession(req, options);
    const currentUser = req.session.currentUser;
    if (!currentUser) {
        sendUnauthorized(res);
        return null;
    }
    return currentUser;
};

export const requireRole = (req, res, allowedRoles, options = {}) => {
    const currentUser = requireUser(req, res, options);
    if (!currentUser) {
        return null;
    }
    if (!allowedRoles.includes(currentUser.role)) {
        sendForbidden(res, "You do not have permission to access this resource.");
        return null;
    }
    return currentUser;
};
