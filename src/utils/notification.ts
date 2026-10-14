import { Notification } from "../models/mongoModels.js";

interface CreateNotificationInput {
  userId: string;
  leadId?: string;
  taskId?: string;
  title: string;
  message: string;
  type?: string;
  dedupeKey?: string;
}

export const createNotification = async (input: CreateNotificationInput) => {
  const notification = await Notification.create({
    ...input,
    read: false,
  });
  return notification.toObject();
};
