// import type { Request, Response } from "express";
// import { rtdb } from "../config/firebase.js";
// import { createNotification } from "../utils/notification.js";
// import type { ILead } from "../models/leadModel.js";

// const LEADS_PATH = "leads";

// export const runLeadFollowUpReminderJob = async (req: Request, res: Response) => {
//   try {
//     const now = Date.now();
//     const snapshot = await rtdb.ref(LEADS_PATH).once("value");

//     if (!snapshot.exists()) {
//       res.status(200).json({
//         success: true,
//         message: "No leads found",
//         scanned: 0,
//         notified: 0,
//       });
//       return;
//     }

//     const leadsData = snapshot.val() as Record<string, ILead>;
//     let scanned = 0;
//     let notified = 0;
//     let skipped = 0;

//     for (const [leadId, lead] of Object.entries(leadsData)) {
//       scanned++;

//       if (!lead.assignedTo) {
//         skipped++;
//         continue;
//       }

//       if (lead.status === "Won" || lead.status === "Lost") {
//         skipped++;
//         continue;
//       }

//       if (!lead.nextReminderDueAt || now < lead.nextReminderDueAt) {
//         skipped++;
//         continue;
//       }

//       const alreadyRemindedAfterLastActivity =
//         !!lead.lastReminderAt &&
//         !!lead.lastActivityAt &&
//         lead.lastReminderAt >= lead.lastActivityAt;

//       if (alreadyRemindedAfterLastActivity) {
//         skipped++;
//         continue;
//       }

//       const leadName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();

//       await createNotification({
//         userId: lead.assignedTo,
//         leadId,
//         title: "Lead follow-up reminder",
//         message: `No activity on lead ${leadName || lead.email} for the follow-up window. Please update or reply.`,
//       });

//       await rtdb.ref(`${LEADS_PATH}/${leadId}`).update({
//         lastReminderAt: now,
//         followUpReminderCount: (lead.followUpReminderCount || 0) + 1,
//       });

//       notified++;
//     }

//     res.status(200).json({
//       success: true,
//       message: "Lead follow-up reminder job completed",
//       scanned,
//       notified,
//       skipped,
//     });
//   } catch (error: any) {
//     res.status(500).json({
//       success: false,
//       message: error.message,
//     });
//   }
// };



import type { Request, Response } from "express";
import { rtdb } from "../config/firebase.js";
import { createNotification } from "../utils/notification.js";
import type { ILead } from "../models/leadModel.js";

const LEADS_PATH = "leads";

export const processLeadFollowUpReminders = async () => {
  const now = Date.now();
  const snapshot = await rtdb.ref(LEADS_PATH).once("value");

  if (!snapshot.exists()) {
    return {
      success: true,
      message: "No leads found",
      scanned: 0,
      notified: 0,
      skipped: 0,
    };
  }

  const leadsData = snapshot.val() as Record<string, ILead>;
  let scanned = 0;
  let notified = 0;
  let skipped = 0;

  for (const [leadId, lead] of Object.entries(leadsData)) {
    scanned++;

    if (!lead.assignedTo) {
      skipped++;
      continue;
    }

    if (lead.status === "Won" || lead.status === "Lost") {
      skipped++;
      continue;
    }

    if (!lead.nextReminderDueAt || now < lead.nextReminderDueAt) {
      skipped++;
      continue;
    }

    const alreadyRemindedAfterLastActivity =
      !!lead.lastReminderAt &&
      !!lead.lastActivityAt &&
      lead.lastReminderAt >= lead.lastActivityAt;

    if (alreadyRemindedAfterLastActivity) {
      skipped++;
      continue;
    }

    const leadName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();

    await createNotification({
      userId: lead.assignedTo,
      leadId,
      title: "Lead follow-up reminder",
      message: `No activity on lead ${leadName || lead.email} for the follow-up window. Please update or reply.`,
    });

    await rtdb.ref(`${LEADS_PATH}/${leadId}`).update({
      lastReminderAt: now,
      followUpReminderCount: (lead.followUpReminderCount || 0) + 1,
    });

    notified++;
  }

  return {
    success: true,
    message: "Lead follow-up reminder job completed",
    scanned,
    notified,
    skipped,
  };
};

export const runLeadFollowUpReminderJob = async (_req: Request, res: Response) => {
  try {
    const result = await processLeadFollowUpReminders();
    res.status(200).json(result);
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};