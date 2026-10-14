import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { User } from "../models/mongoModels.js";

// Extend Express Request type to include the user
export interface AuthRequest extends Request {
    user?: any;
}

// Middleware to check if user is logged in and token is valid
export const protect = async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return res.status(200).end();
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
            const jwtSecret = process.env.JWT_SECRET;
            if (!jwtSecret) throw new Error("JWT_SECRET is not configured");
            const decoded = jwt.verify(token, jwtSecret);
            if (
                typeof decoded !== "object" ||
                !("id" in decoded) ||
                typeof decoded.id !== "string" ||
                !Types.ObjectId.isValid(decoded.id)
            ) {
                res.status(401).json({ success: false, message: "Not authorized, user not found" });
                return;
            }

            const userData = await User.findOne({ _id: decoded.id, isActive: true })
                .select("_id name email role isActive teamIds")
                .lean();
            if (!userData) {
                res.status(401).json({ success: false, message: "Not authorized, user not found or inactive" });
                return;
            }

            req.user = {
                ...userData,
                id: userData._id.toString(),
                _id: userData._id.toString(),
                uid: userData._id.toString(),
            };
            next();
        } catch (error) {
            if (error instanceof Error && error.message === "JWT_SECRET is not configured") {
                console.error("Authentication configuration error:", error.message);
                res.status(503).json({ success: false, message: "Authentication is not configured" });
                return;
            }
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
