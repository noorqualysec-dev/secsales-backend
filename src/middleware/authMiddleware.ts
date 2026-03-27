import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { rtdb } from "../config/firebase.js";

// Extend Express Request type to include the user
export interface AuthRequest extends Request {
    user?: any;
}

const USERS_PATH = "users";

// Middleware to check if user is logged in and token is valid
export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") {
  return res.status(200).end(); // ✅ STOP HERE
}
    let token: string | undefined;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        try {
            // Get token from header (Format: "Bearer <token>")
            token = req.headers.authorization.split(" ")[1];
            
            if (!token) {
                res.status(401).json({ success: false, message: "Not authorized, token missing" });
                return;
            }

            // Verify token
            const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);

            // Get user from RTDB (excluding password)
            const userRef = rtdb.ref(`${USERS_PATH}/${decoded.id}`);
            const snapshot = await userRef.once("value");

            if (!snapshot.exists()) {
                res.status(401).json({ success: false, message: "Not authorized, user not found" });
                return;
            }

            const userData = snapshot.val();
            if (userData) {
                delete userData.password;
                // Standardize: use both id and _id to be safe
                req.user = { id: snapshot.key, _id: snapshot.key, ...userData };
            }

            next();
        } catch (error) {
            console.error("❌ Auth Middleware Error:", error);
            res.status(401).json({ success: false, message: "Not authorized, token failed" });
        }
    } else if (!token) {
        res.status(401).json({ success: false, message: "Not authorized, no token" });
    }
};

// Middleware to check if user has required roles
export const authorize = (...roles: string[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        if (!req.user) {
            res.status(401).json({ success: false, message: "Not authorized" });
            return;
        }
        
        if (!roles.includes(req.user.role)) {
            res.status(403).json({ 
                success: false, 
                message: `User role '${req.user.role}' is not authorized to access this route` 
            });
            return;
        }
        next();
    };
};
