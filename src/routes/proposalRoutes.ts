import express from "express";
import {
  getProposals,
  createProposal,
  getProposal,
  updateProposal,
  deleteProposal,
} from "../controllers/proposalController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.route("/").get(protect, getProposals).post(protect, createProposal);

router
  .route("/:id")
  .get(protect, getProposal)
  .put(protect, updateProposal)
  .delete(protect, deleteProposal);

export default router;
