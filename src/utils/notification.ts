import { rtdb } from "../config/firebase.js";

const NOTIFICATIONS_PATH = "notifications";

interface CreateNotificationInput {
  userId: string;
  leadId: string;
  title: string;
  message: string;
  type?: string;
}

export const createNotification = async ({
  userId,
  leadId,
  title,
  message,
  type = "lead_followup_reminder",
}: CreateNotificationInput) => {
  const ref = rtdb.ref(`${NOTIFICATIONS_PATH}/${userId}`).push();

  const payload = {
    type,
    title,
    message,
    leadId,
    read: false,
    createdAt: Date.now(),
    readAt: null,
  };

  await ref.set(payload);

  return { id: ref.key, ...payload };
};
