import cron from "node-cron";
import { processLeadFollowUpReminders } from "../controllers/cronController.js";

let isRunning = false;

export const startLeadFollowUpCron = () => {
  cron.schedule("* * * * *", async () => {
    if (isRunning) return;

    try {
      isRunning = true;
      const result = await processLeadFollowUpReminders();
      console.log("[lead-followup-cron]", result);
    } catch (error) {
      console.error("[lead-followup-cron]", error);
    } finally {
      isRunning = false;
    }
  });
};