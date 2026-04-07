import type { Response } from "express";
import { rtdb } from "../config/firebase.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import type { ILead } from "../models/leadModel.js";

const LEADS_PATH = "leads";
const USERS_PATH = "users";
const PROPOSALS_PATH = "proposals";

const DIAL_CODE_RE = /^\+\d{1,4}$/;
const NATIONAL_PHONE_RE = /^\d{4,15}$/;

/** When both inputs empty after trim, returns empty strings (clear phone). Otherwise validates pair. */
function normalizePhonePair(
    codeRaw: unknown,
    phoneRaw: unknown
): { error: string } | { phoneCountryCode: string; phone: string } {
    const code0 = String(codeRaw ?? "").trim();
    const phone0 = String(phoneRaw ?? "").trim();
    const hasAny = code0.length > 0 || phone0.length > 0;
    if (!hasAny) {
        return { phoneCountryCode: "", phone: "" };
    }
    if (!code0 || !phone0) {
        return { error: "Country calling code and national phone number must both be provided together." };
    }
    if (/[a-zA-Z]/.test(phone0)) {
        return { error: "Phone number must contain digits only (no letters)." };
    }
    if (!DIAL_CODE_RE.test(code0)) {
        return { error: "Invalid country calling code." };
    }
    if (!NATIONAL_PHONE_RE.test(phone0)) {
        return { error: "Phone must be between 4 and 15 digits." };
    }
    return { phoneCountryCode: code0, phone: phone0 };
}

function normalizeIndustry(indRaw: unknown): { error: string } | { industry: string | undefined } {
    if (indRaw === undefined || indRaw === null) {
        return { industry: undefined };
    }
    const s = String(indRaw).trim();
    if (s.length > 120) {
        return { error: "Industry must be at most 120 characters." };
    }
    return { industry: s || undefined };
}

function applyNormalizedPhoneToLeadData(leadData: Partial<ILead>, norm: { phoneCountryCode: string; phone: string }) {
    if (!norm.phoneCountryCode && !norm.phone) {
        delete leadData.phoneCountryCode;
        leadData.phone = "";
    } else {
        leadData.phoneCountryCode = norm.phoneCountryCode;
        leadData.phone = norm.phone;
    }
}

// Helper for manual "population"
const populateRef = async (path: string, id: string, fields: string[]) => {
    if (!id) return null;
    const snapshot = await rtdb.ref(`${path}/${id}`).once("value");
    if (!snapshot.exists()) return null;
    const data = snapshot.val();
    const result: any = { _id: snapshot.key };
    fields.forEach(f => { result[f] = data?.[f]; });
    return result;
};

// Helper to "populate" user data manually for simplicity
const populateUser = async (userId: string) => {
    if (!userId) return null;
    const snapshot = await rtdb.ref(`${USERS_PATH}/${userId}`).once("value");
    if (!snapshot.exists()) return null;
    const data = snapshot.val();
    return { _id: snapshot.key, name: data?.name, email: data?.email };
};

// @desc    Get all leads
export const getLeads = async (req: AuthRequest, res: Response) => {
  try {
    let ref = rtdb.ref(LEADS_PATH);
    let snapshot;

    if (req.user.role !== "admin") {
      snapshot = await ref.orderByChild("assignedTo").equalTo(req.user.id).once("value");
    } else {
      snapshot = await ref.orderByChild("createdAt").once("value");
    }

    if (!snapshot.exists()) {
        res.status(200).json({ success: true, count: 0, data: [] });
        return;
    }

    const leadsData = snapshot.val();
    const leads = await Promise.all(Object.keys(leadsData).map(async (key) => {
        const data = leadsData[key];
        return { 
            _id: key, 
            ...data,
            assignedTo: await populateUser(data.assignedTo),
            createdBy: await populateUser(data.createdBy)
        };
    }));

    // RTDB orderByChild is ascending by default, we want descending
    leads.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ success: true, count: leads.length, data: leads });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new lead
export const createLead = async (req: AuthRequest, res: Response) => {
  try {
    const leadData: Partial<ILead> = { ...req.body };

    const phoneNorm = normalizePhonePair(leadData.phoneCountryCode, leadData.phone);
    if ("error" in phoneNorm) {
        res.status(400).json({ success: false, message: phoneNorm.error });
        return;
    }
    applyNormalizedPhoneToLeadData(leadData, phoneNorm);

    if (leadData.industry !== undefined && leadData.industry !== null) {
        const indNorm = normalizeIndustry(leadData.industry);
        if ("error" in indNorm) {
            res.status(400).json({ success: false, message: indNorm.error });
            return;
        }
        if (indNorm.industry !== undefined) {
            leadData.industry = indNorm.industry;
        } else {
            delete leadData.industry;
        }
    }

    leadData.createdBy = req.user.id;
    if (req.user.role !== "admin" || !leadData.assignedTo) {
      leadData.assignedTo = req.user.id;
    }

    leadData.timeline = [{
        event: "Creation",
        performedBy: req.user.id,
        remark: req.body.latestRemark || "Lead manually entered into system",
        timestamp: Date.now()
    }];

    leadData.status = leadData.status || "Lead Captured";
    leadData.createdAt = Date.now();
    leadData.updatedAt = Date.now();

    const newLeadRef = rtdb.ref(LEADS_PATH).push();
    await newLeadRef.set(leadData);

    res.status(201).json({ success: true, data: { _id: newLeadRef.key, ...leadData } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const VALID_STATUSES = ["Lead Captured","Discovery Call Scheduled","Requirement Gathering","Pre-Assessment Form Sent","Proposal Preparation","Proposal Sent","Negotiation","Won","Lost"];
const VALID_SOURCES  = ["website","email_marketing","linkedin","referral","events","recurring","partnership","offline_source","other"];

// @desc    Bulk import leads from CSV
export const bulkImportLeads = async (req: AuthRequest, res: Response) => {
  try {
    const { leads: rows } = req.body as { leads: any[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ success: false, message: "No leads provided" });
      return;
    }

    // Collect existing emails to skip duplicates
    const existingSnap = await rtdb.ref(LEADS_PATH).once("value");
    const existingEmails = new Set<string>();
    if (existingSnap.exists()) {
      Object.values(existingSnap.val() as Record<string, any>).forEach((l: any) => {
        if (l.email) existingEmails.add(l.email.toLowerCase().trim());
      });
    }

    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!row.firstName || !row.email) { skipped++; continue; }
      if (existingEmails.has(row.email.toLowerCase().trim())) { skipped++; continue; }

      const ref = rtdb.ref(LEADS_PATH).push();
      await ref.set({
        firstName:        row.firstName || "",
        lastName:         row.lastName  || "",
        email:            row.email,
        phone:            row.phone     || "",
        designation:      row.designation || "",
        company:          row.company   || "",
        industry:         row.industry  || "",
        country:          row.country   || "",
        employeeStrength: row.employeeStrength || "",
        status:           VALID_STATUSES.includes(row.status) ? row.status : "Lead Captured",
        source:           VALID_SOURCES.includes(row.source)  ? row.source  : "other",
        dealValue:        Number(row.dealValue) || 0,
        closingDate:      Number(row.closingDate) || 0,
        latestRemark:     row.latestRemark || "",
        assignedTo:       req.user.id,
        createdBy:        req.user.id,
        timeline: [{
          event: "Creation",
          performedBy: req.user.id,
          remark: "Imported via CSV",
          timestamp: Date.now()
        }],
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      existingEmails.add(row.email.toLowerCase().trim());
      imported++;
    }

    res.status(200).json({ success: true, data: { imported, skipped } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single lead
export const getLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const snapshot = await rtdb.ref(`${LEADS_PATH}/${id}`).once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;

    if (lead.assignedTo !== req.user.id && req.user.role !== "admin") {
      res.status(403).json({ success: false, message: "Not authorized to access this lead" });
      return;
    }

    const populatedLead = {
        _id: snapshot.key,
        ...lead,
        assignedTo: await populateUser(lead.assignedTo || ""),
        createdBy: await populateUser(lead.createdBy || ""),
        timeline: await Promise.all((lead.timeline || []).map(async event => ({
              ...event,
            performedBy: await populateUser(event.performedBy || "")
        })))
    };

    res.status(200).json({ success: true, data: populatedLead });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update lead
export const updateLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
    const snapshot = await leadRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;

    if (lead.assignedTo !== req.user.id && req.user.role !== "admin") {
      res.status(403).json({ success: false, message: "Not authorized to update this lead" });
      return;
    }

    const updates: any = { ...req.body, updatedAt: Date.now() };

    const phoneKeysTouched = Object.prototype.hasOwnProperty.call(req.body, "phone")
        || Object.prototype.hasOwnProperty.call(req.body, "phoneCountryCode");
    if (phoneKeysTouched) {
        const mergedCode = updates.phoneCountryCode !== undefined
            ? String(updates.phoneCountryCode ?? "").trim()
            : String(lead.phoneCountryCode ?? "").trim();
        const mergedPhone = updates.phone !== undefined
            ? String(updates.phone ?? "").trim()
            : String(lead.phone ?? "").trim();
        const phoneNorm = normalizePhonePair(mergedCode, mergedPhone);
        if ("error" in phoneNorm) {
            res.status(400).json({ success: false, message: phoneNorm.error });
            return;
        }
        applyNormalizedPhoneToLeadData(updates, phoneNorm);
    } else {
        delete updates.phone;
        delete updates.phoneCountryCode;
    }

    if (updates.industry !== undefined) {
        const indNorm = normalizeIndustry(updates.industry);
        if ("error" in indNorm) {
            res.status(400).json({ success: false, message: indNorm.error });
            return;
        }
        updates.industry = indNorm.industry;
    }

    const timeline = [...(lead.timeline || [])];

    if (updates.status && updates.status !== lead.status) {
        timeline.push({
            event: "Status Changed",
            status: updates.status,
            remark: updates.latestRemark || `Status updated to ${updates.status}`,
            performedBy: req.user.id,
            timestamp: Date.now()
        });
    } else if (updates.latestRemark) {
        timeline.push({
            event: "Remark Added",
            status: lead.status,
            remark: updates.latestRemark,
            performedBy: req.user.id,
            timestamp: Date.now()
        });
    }

    updates.timeline = timeline;
    delete updates.assignedTo;
    delete updates.createdBy;

    await leadRef.update(updates);
    res.status(200).json({ success: true, message: "Lead updated successfully" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete lead
export const deleteLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
    const snapshot = await leadRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;
    if (lead.assignedTo !== req.user.id && req.user.role !== "admin") {
      res.status(403).json({ success: false, message: "Not authorized to delete this lead" });
      return;
    }

    await leadRef.remove();
    res.status(200).json({ success: true, message: "Lead removed" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get full lead journey (details + timeline + proposals)
export const getLeadJourney = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id as string;
        
        // 1. Get Lead
        const leadSnapshot = await rtdb.ref(`${LEADS_PATH}/${id}`).once("value");
        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }
        const leadData = leadSnapshot.val();

        // 2. Authorization Check
        if (req.user.role !== "admin" && leadData.assignedTo !== req.user.id) {
            res.status(403).json({ success: false, message: "Not authorized to access this lead journey" });
            return;
        }

        // 3. Get Assigned User
        const assignedUser = await populateRef(USERS_PATH, leadData.assignedTo, ["name", "email", "role"]);

        // 4. Get Proposals for this lead
        const proposalsSnapshot = await rtdb.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(id).once("value");
        const proposalsData = proposalsSnapshot.val() || {};
        const proposals = Object.entries(proposalsData).map(([key, val]: [string, any]) => ({
            _id: key,
            value: val.value,
            status: val.status,
            createdAt: val.createdAt
        }));

        // 5. Populate Timeline PerformedBy
        const timeline = await Promise.all((leadData.timeline || []).map(async (event: any) => ({
            ...event,
            performedBy: await populateRef(USERS_PATH, event.performedBy, ["name", "email"])
        })));

        res.status(200).json({
            success: true,
            data: {
                lead: { _id: id, ...leadData, timeline },
                assignedUser,
                proposals
            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
