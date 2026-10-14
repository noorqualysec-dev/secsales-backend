import express from "express";
import { signInUser, deleteUser, updateUser } from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

// Public self-registration is disabled. Users are provisioned by an operator
// and subsequently managed through protected administrator operations.
router.post("/login", signInUser);

router.delete("/:id", protect, deleteUser);
router.put("/:id", protect, updateUser);

export default router;
