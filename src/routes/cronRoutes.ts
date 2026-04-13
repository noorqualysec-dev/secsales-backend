import express from "express";
import { runLeadFollowUpReminderJob } from "../controllers/cronController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// router.get("/lead-followup-reminders", protect, runLeadFollowUpReminderJob);
router.get("/lead-followup-reminders", (req, res) => {
  const ua = req.headers["user-agent"] || "";

  // Allow local dev
  if (process.env.NODE_ENV !== "production") {
    return runLeadFollowUpReminderJob(req, res);
  }

  // Allow only Vercel cron in production
  if (!ua.includes("vercel-cron")) {
    return res.status(401).json({ success: false });
  }

  return runLeadFollowUpReminderJob(req, res);
});

export default router;