import type { Request, Response } from "express";
import { Lead, Notification, ReminderDelivery, SystemSetting, Task, User } from "../models/mongoModels.js";
import { getLeadReminderRepeatAt } from "../services/reminderPolicy.js";

const toMilliseconds = (duration: number, unit: string): number => {
  if (unit === "minutes") return duration * 60_000;
  if (unit === "hours") return duration * 3_600_000;
  return duration * 86_400_000;
};

async function deliverReminder(params: {
  kind: "lead_inactivity" | "task_due" | "task_overdue";
  targetId: string;
  recipientId: string;
  cycleKey: string;
  title: string;
  message: string;
  leadId?: string;
  taskId?: string;
}): Promise<boolean> {
  const dedupeKey = `${params.kind}:${params.targetId}:${params.recipientId}:${params.cycleKey}`;
  let delivery;
  const now = new Date();
  const staleSendingBefore = new Date(now.getTime() - 5 * 60_000);
  try {
    const claimable = await ReminderDelivery.findOneAndUpdate(
      {
        dedupeKey,
        $or: [
          { status: "failed", nextAttemptAt: { $lte: now } },
          { status: "sending", lastAttemptAt: { $lte: staleSendingBefore } },
        ],
      },
      {
        $set: { status: "sending", lastAttemptAt: now, lastError: null },
        $inc: { attemptCount: 1 },
      },
      { new: true },
    );
    if (claimable) {
      delivery = claimable;
    } else {
      delivery = await ReminderDelivery.create({
        kind: params.kind,
        ...(params.leadId ? { leadId: params.leadId } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
        recipientId: params.recipientId,
        cycleKey: params.cycleKey,
        dedupeKey,
        status: "sending",
        attemptCount: 1,
        lastAttemptAt: now,
      });
    }
  } catch (error) {
    if ((error as { code?: number }).code === 11000) return false;
    throw error;
  }

  try {
    const notification = await Notification.findOneAndUpdate(
      { dedupeKey },
      {
        $setOnInsert: {
          userId: params.recipientId,
          type: params.kind,
          title: params.title,
          message: params.message,
          ...(params.leadId ? { leadId: params.leadId } : {}),
          ...(params.taskId ? { taskId: params.taskId } : {}),
          dedupeKey,
          read: false,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    delivery.status = "sent";
    delivery.sentAt = new Date();
    delivery.notificationId = notification._id;
    await delivery.save();
    return true;
  } catch (error) {
    delivery.status = "failed";
    delivery.lastError = error instanceof Error ? error.message.slice(0, 500) : "Notification failed";
    delivery.nextAttemptAt = new Date(Date.now() + 60_000);
    await delivery.save();
    throw error;
  }
}

export async function processLeadFollowUpReminders() {
  const now = new Date();
  const leads = await Lead.find({
    outcome: "open",
    assignedTo: { $ne: null },
    nextReminderDueAt: { $lte: now },
  }).lean();
  let notified = 0;
  let skipped = 0;

  for (const lead of leads) {
    const ownerId = lead.assignedTo?.toString();
    if (!ownerId || !(await User.exists({ _id: ownerId, isActive: true }))) {
      skipped++;
      continue;
    }
    const activityAt = lead.lastMeaningfulActivityAt?.toISOString() ?? "unknown";
    const cycleKey = `${lead.status}:${activityAt}:${ownerId}:${lead.nextReminderDueAt?.toISOString() ?? "initial"}`;
    const name = `${lead.firstName} ${lead.lastName ?? ""}`.trim() || lead.email;
    const sent = await deliverReminder({
      kind: "lead_inactivity",
      targetId: lead._id.toString(),
      recipientId: ownerId,
      cycleKey,
      title: "Lead follow-up reminder",
      message: `No meaningful activity has been recorded for ${name}. Current stage: ${lead.status}.`,
      leadId: lead._id.toString(),
    });
    if (!sent) {
      skipped++;
      continue;
    }

    const repeatAt = await getLeadReminderRepeatAt(now);
    await Lead.updateOne(
      {
        _id: lead._id,
        outcome: "open",
        status: lead.status,
        assignedTo: ownerId,
        lastMeaningfulActivityAt: lead.lastMeaningfulActivityAt,
        nextReminderDueAt: { $lte: now },
      },
      {
        $set: { lastReminderAt: now, nextReminderDueAt: repeatAt },
        $inc: { followUpReminderCount: 1 },
      },
    );
    notified++;
  }

  return { success: true, message: "Lead reminder job completed", scanned: leads.length, notified, skipped };
}

export async function processTaskReminders() {
  const now = new Date();
  const settings = await SystemSetting.findById("organization").lean();
  const policy = settings?.taskReminderPolicy;
  if (!policy?.enabled) {
    return { scanned: 0, notified: 0, skipped: 0, message: "Task reminder policy is disabled" };
  }

  const tasks = await Task.find({ status: { $ne: "Completed" }, assignedTo: { $exists: true, $ne: [] } }).lean();
  let notified = 0;
  let skipped = 0;
  for (const task of tasks) {
    for (const recipient of task.assignedTo) {
      const recipientId = recipient.toString();
      if (!(await User.exists({ _id: recipientId, isActive: true }))) {
        skipped++;
        continue;
      }
      const dueAt = task.dueDate.getTime();
      const overdue = dueAt <= now.getTime();
      let kind: "task_due" | "task_overdue" | undefined;
      let cycleKey: string | undefined;

      if (overdue) {
        const interval = policy.overdueRepeatAfter;
        const intervalMs = interval?.duration && interval.unit
          ? toMilliseconds(interval.duration, interval.unit)
          : Number.POSITIVE_INFINITY;
        const previous = await ReminderDelivery.findOne({
          kind: "task_overdue",
          taskId: task._id,
          recipientId,
          status: "sent",
        }).sort({ sentAt: -1 }).lean();
        if (!previous || (previous.sentAt && now.getTime() - previous.sentAt.getTime() >= intervalMs)) {
          kind = "task_overdue";
          cycleKey = `${dueAt}:overdue:${previous?.sentAt?.toISOString() ?? "initial"}`;
        }
      } else {
        const offset = policy.dueSoonOffsets.find((item) => {
          const ms = toMilliseconds(item.duration ?? 0, item.unit ?? "hours");
          return dueAt - ms <= now.getTime() && dueAt > now.getTime();
        });
        if (offset) {
          kind = "task_due";
          cycleKey = `${dueAt}:due:${offset.duration}:${offset.unit}`;
        }
      }
      if (!kind || !cycleKey) {
        skipped++;
        continue;
      }

      const sent = await deliverReminder({
        kind,
        targetId: task._id.toString(),
        recipientId,
        cycleKey,
        title: kind === "task_due" ? "Task due soon" : "Task overdue",
        message: `${task.subject} is ${kind === "task_due" ? "due soon" : "overdue"} (due ${task.dueDate.toISOString()}).`,
        ...(task.leadId ? { leadId: task.leadId.toString() } : {}),
        taskId: task._id.toString(),
      });
      if (sent) notified++;
      else skipped++;
    }
  }
  return { scanned: tasks.length, notified, skipped };
}

export const runLeadFollowUpReminderJob = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [leads, tasks] = await Promise.all([
      processLeadFollowUpReminders(),
      processTaskReminders(),
    ]);
    res.status(200).json({ success: true, leads, tasks });
  } catch (error) {
    console.error("Reminder job failed:", error);
    res.status(500).json({ success: false, message: "Reminder job failed" });
  }
};
