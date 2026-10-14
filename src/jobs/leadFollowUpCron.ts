import cron from "node-cron";
import {
  processLeadFollowUpReminders,
  processTaskReminders,
} from "../controllers/cronController.js";

let isRunning = false;

export const startLeadFollowUpCron = () => {
  cron.schedule("* * * * *", async () => {
    if (isRunning) return;

    try {
      isRunning = true;
      const [leads, tasks] = await Promise.all([
        processLeadFollowUpReminders(),
        processTaskReminders(),
      ]);
      const result = { leads, tasks };
      console.log("[lead-followup-cron]", result);
    } catch (error) {
      console.error("[lead-followup-cron]", error);
    } finally {
      isRunning = false;
    }
  });
};