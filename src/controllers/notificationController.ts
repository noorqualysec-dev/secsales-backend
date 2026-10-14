import type { Response } from "express";
import { Types } from "mongoose";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { Notification } from "../models/mongoModels.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const parseLimit = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), MAX_LIMIT)
    : DEFAULT_LIMIT;
};

export const getNotifications = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = String(req.user?.id ?? "");
    const limit = parseLimit(req.query.limit);
    const unreadOnly = String(req.query.unread ?? "false").toLowerCase() === "true";
    const query = { userId, ...(unreadOnly ? { read: false } : {}) };
    const [data, unreadCount, count] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).limit(limit).lean(),
      Notification.countDocuments({ userId, read: false }),
      Notification.countDocuments(query),
    ]);

    res.status(200).json({ success: true, count, unreadCount, data });
  } catch (error) {
    console.error("Notification retrieval failed:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve notifications" });
  }
};

export const markNotificationAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const id = String(req.params.id ?? "");
    if (!Types.ObjectId.isValid(id)) {
      res.status(400).json({ success: false, message: "Invalid notification ID" });
      return;
    }
    const result = await Notification.updateOne(
      { _id: id, userId: req.user?.id },
      { $set: { read: true, readAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      res.status(404).json({ success: false, message: "Notification not found" });
      return;
    }
    res.status(200).json({ success: true, message: "Notification marked as read" });
  } catch (error) {
    console.error("Notification update failed:", error);
    res.status(500).json({ success: false, message: "Failed to update notification" });
  }
};

export const markAllNotificationsAsRead = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await Notification.updateMany(
      { userId: req.user?.id, read: false },
      { $set: { read: true, readAt: new Date() } },
    );
    res.status(200).json({
      success: true,
      message: result.modifiedCount
        ? "Notifications marked as read"
        : "No unread notifications found",
      updated: result.modifiedCount,
    });
  } catch (error) {
    console.error("Bulk notification update failed:", error);
    res.status(500).json({ success: false, message: "Failed to update notifications" });
  }
};
