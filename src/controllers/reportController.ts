import type { Response } from "express";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import {
    generateCombinedSalesRepReport,
    generateIndividualSalesRepReport,
    parseSalesReportRange,
    SalesReportNotFoundError,
    SalesReportValidationError,
} from "../services/salesReportExportService.js";

const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function setDownloadHeaders(res: Response, fileName: string): void {
    res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
    res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);
}

function handleReportError(res: Response, error: unknown): void {
    if (error instanceof SalesReportValidationError) {
        res.status(400).json({ success: false, message: error.message });
        return;
    }

    if (error instanceof SalesReportNotFoundError) {
        res.status(404).json({ success: false, message: error.message });
        return;
    }

    const message = error instanceof Error ? error.message : "Failed to generate report";
    res.status(500).json({ success: false, message });
}

export const downloadCombinedSalesRepReport = async (req: AuthRequest, res: Response) => {
    try {
        const range = parseSalesReportRange(req.query as Record<string, unknown>);
        const report = await generateCombinedSalesRepReport(range);
        setDownloadHeaders(res, report.fileName);
        res.status(200).send(report.buffer);
    } catch (error) {
        handleReportError(res, error);
    }
};

export const downloadIndividualSalesRepReport = async (req: AuthRequest, res: Response) => {
    try {
        const userId = String(req.params.userId || "").trim();
        if (!userId) {
            res.status(400).json({ success: false, message: "Sales user id is required." });
            return;
        }

        const range = parseSalesReportRange(req.query as Record<string, unknown>);
        const report = await generateIndividualSalesRepReport(userId, range);
        setDownloadHeaders(res, report.fileName);
        res.status(200).send(report.buffer);
    } catch (error) {
        handleReportError(res, error);
    }
};
