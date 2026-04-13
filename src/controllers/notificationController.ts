import type { Response } from "express";
import { rtdb } from "../config/firebase.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import type { INotification } from "../models/notificationModel.js";

const NOTIFICATIONS_PATH = "notifications";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const parseLimit = (limitRaw: unknown) => {
  const parsed = Number(limitRaw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LIMIT;
  }

  return Math.min(Math.floor(parsed), MAX_LIMIT);
};

export const getNotifications = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id as string;
    const limit = parseLimit(req.query.limit);
    const unreadOnly = String(req.query.unread ?? "false").toLowerCase() === "true";

    const snapshot = await rtdb.ref(`${NOTIFICATIONS_PATH}/${userId}`).once("value");

    if (!snapshot.exists()) {
      res.status(200).json({
        success: true,
        count: 0,
        unreadCount: 0,
        data: [],
      });
      return;
    }

    const notificationsData = snapshot.val() as Record<string, INotification>;

    const allNotifications = Object.entries(notificationsData)
      .map(([id, notification]) => ({
        _id: id,
        ...notification,
      }))
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    const filteredNotifications = unreadOnly
      ? allNotifications.filter((notification) => !notification.read)
      : allNotifications;

    const unreadCount = allNotifications.filter((notification) => !notification.read).length;

    res.status(200).json({
      success: true,
      count: Math.min(filteredNotifications.length, limit),
      unreadCount,
      data: filteredNotifications.slice(0, limit),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const markNotificationAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id as string;
    const notificationId = req.params.id as string;
    const notificationRef = rtdb.ref(`${NOTIFICATIONS_PATH}/${userId}/${notificationId}`);
    const snapshot = await notificationRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({
        success: false,
        message: "Notification not found",
      });
      return;
    }

    const notification = snapshot.val() as INotification;

    if (!notification.read) {
      await notificationRef.update({
        read: true,
        readAt: Date.now(),
      });
    }

    res.status(200).json({
      success: true,
      message: "Notification marked as read",
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const markAllNotificationsAsRead = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id as string;
    const userNotificationsRef = rtdb.ref(`${NOTIFICATIONS_PATH}/${userId}`);
    const snapshot = await userNotificationsRef.once("value");

    if (!snapshot.exists()) {
      res.status(200).json({
        success: true,
        message: "No notifications to update",
        updated: 0,
      });
      return;
    }

    const notificationsData = snapshot.val() as Record<string, INotification>;
    const now = Date.now();
    const updates: Record<string, boolean | number> = {};
    let updated = 0;

    for (const [notificationId, notification] of Object.entries(notificationsData)) {
      if (notification.read) {
        continue;
      }

      updates[`${notificationId}/read`] = true;
      updates[`${notificationId}/readAt`] = now;
      updated++;
    }

    if (updated > 0) {
      await userNotificationsRef.update(updates);
    }

    res.status(200).json({
      success: true,
      message: updated > 0 ? "Notifications marked as read" : "No unread notifications found",
      updated,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
