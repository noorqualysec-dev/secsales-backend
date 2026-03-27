import express from "express";
import { createUser, signInUser, deleteUser, updateUser } from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Register and Login (public)
router.post("/", createUser);
router.post("/login", signInUser);

// User self-management (protected)
router.delete("/:id", protect, deleteUser);
router.put("/:id", protect, updateUser);

export default router;
