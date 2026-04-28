import type { Request, Response } from "express";
import { importLeadsFromExcelBuffer } from "../services/leadImport.service.js";

interface AuthRequest extends Request {
    user?: {
        uid?: string;
        id?: string;
        _id?: string;
        legacyUid?: string;
    };
}

export async function importLeadsFromExcelController(
    req: AuthRequest,
    res: Response
): Promise<void> {
    try {
        if (!req.file || !req.file.buffer) {
            res.status(400).json({
                success: false,
                message: "Excel file is required",
            });
            return;
        }

        const currentUserId = req.user?.id || req.user?._id || req.user?.uid || req.user?.legacyUid;
        if (!currentUserId) {
            res.status(401).json({
                success: false,
                message: "Unauthorized user",
            });
            return;
        }

        const result = await importLeadsFromExcelBuffer(
            req.file.buffer,
            currentUserId
        );

        res.status(200).json(result);
    } catch (error) {
        res.status(500).json({
            success: false,
            message: error instanceof Error ? error.message : "Import failed",
        });
    }
}
