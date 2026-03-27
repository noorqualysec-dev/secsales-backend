import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import {
  getSalesSummary,
  scheduleMeeting,
  createTask,
  updateTask,
  deleteTask,
  updateMeeting,
  deleteMeeting
} from "../controllers/productivityController.js";

const router = express.Router();

router.get("/summary", protect, getSalesSummary);
router.post("/meetings", protect, scheduleMeeting);
router.patch("/meetings/:id", protect, updateMeeting);
router.delete("/meetings/:id", protect, deleteMeeting);
router.post("/tasks", protect, createTask);
router.patch("/tasks/:id", protect, updateTask);
router.delete("/tasks/:id", protect, deleteTask);

export default router;
