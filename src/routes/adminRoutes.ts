import express from "express";
import { protect, authorize } from "../middleware/authMiddleware.js";
import {
    getAllUsers,
    updateUserRole,
    toggleUserStatus,
    getAllLeads,
    assignLead,
    updateLeadStatus,
    getLeadStats,
    getLeadJourney,
    getAllProposals,
} from "../controllers/adminController.js";

const router = express.Router();

// All routes in this file require: valid JWT token + admin role
router.use(protect, authorize("admin"));

// ── User management ──────────────────────────────────────────────────────────
router.get("/users", getAllUsers);
router.put("/users/:id/role", updateUserRole);
router.put("/users/:id/status", toggleUserStatus);

// ── Lead Management & Analytics ──────────────────────────────────────────────
router.get("/leads", getAllLeads);
router.get("/lead-stats", getLeadStats);
router.get("/lead/:id", getLeadJourney);
router.put("/leads/:id/assign", assignLead);
router.put("/leads/:id/status", updateLeadStatus);

// ── Proposal management ──────────────────────────────────────────────────────
router.get("/proposals", getAllProposals);

export default router;
