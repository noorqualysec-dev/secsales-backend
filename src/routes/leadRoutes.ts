import express from "express";
import {
  getLeads,
  createLead,
  bulkImportLeads,
  getLead,
  updateLead,
  deleteLead,
  getLeadJourney,
  getCompanies,
  getCompanyDetails
} from "../controllers/leadController.js";
import { protect } from "../middleware/authMiddleware.js";

const router = express.Router();

router.route("/").get(protect, getLeads).post(protect, createLead);
router.post("/bulk", protect, bulkImportLeads);
router.get("/companies", protect, getCompanies);
router.get("/companies/:companyKey", protect, getCompanyDetails);

router.get("/:id/journey", protect, getLeadJourney);

router
  .route("/:id")
  .get(protect, getLead)
  .put(protect, updateLead)
  .delete(protect, deleteLead);

export default router;
