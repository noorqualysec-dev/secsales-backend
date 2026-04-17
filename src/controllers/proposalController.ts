import type { Response } from "express";
import { rtdb } from "../config/firebase.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import type { IProposal } from "../models/proposalModel.js";
import type { ILead, LeadOutcome, LeadStatus } from "../models/leadModel.js";
import { canAccessAllProposals } from "../utils/roles.js";

const PROPOSALS_PATH = "proposals";
const LEADS_PATH = "leads";
const USERS_PATH = "users";
const CLOSED_STATUSES = new Set(["Won", "Lost"]);

const getLeadStage = (lead: Partial<ILead>): LeadStatus => {
    if (lead.status && !CLOSED_STATUSES.has(lead.status)) {
        return lead.status;
    }
    if (lead.lostAtStatus) return lead.lostAtStatus;
    if (lead.wonAtStatus) return lead.wonAtStatus;
    return "Lead Captured";
};

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

// @desc    Get proposals
export const getProposals = async (req: AuthRequest, res: Response) => {
  try {
    let ref = rtdb.ref(PROPOSALS_PATH);
    let snapshot;

    if (!canAccessAllProposals(req.user?.role)) {
      snapshot = await ref.orderByChild("createdBy").equalTo(req.user.id).once("value");
    } else {
      snapshot = await ref.orderByChild("createdAt").once("value");
    }

    if (!snapshot.exists()) {
        res.status(200).json({ success: true, count: 0, data: [] });
        return;
    }

    const proposalsData = snapshot.val();
    const proposals = await Promise.all(Object.keys(proposalsData).map(async (key) => {
        const data = proposalsData[key];
        return {
            _id: key,
            ...data,
            lead: await populateRef(LEADS_PATH, data.lead, ["firstName", "lastName", "company"]),
            createdBy: await populateRef(USERS_PATH, data.createdBy, ["name", "email"])
        };
    }));

    proposals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ success: true, count: proposals.length, data: proposals });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new proposal
export const createProposal = async (req: AuthRequest, res: Response) => {
  try {
    const { lead: leadId, value, testingScope, status, notes } = req.body;

    const leadRef = rtdb.ref(`${LEADS_PATH}/${leadId}`);
    const leadSnapshot = await leadRef.once("value");

    if (!leadSnapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const leadData = leadSnapshot.val();
    if (leadData?.assignedTo !== req.user.id && !canAccessAllProposals(req.user?.role)) {
      res.status(403).json({ success: false, message: "Not authorized to create a proposal for this lead" });
      return;
    }

    const proposalData: IProposal = {
      lead: leadId,
      value,
      testingScope,
      status: status || "Draft",
      notes,
      createdBy: req.user.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const newProposalRef = rtdb.ref(PROPOSALS_PATH).push();
    await newProposalRef.set(proposalData);

    if (proposalData.status) {
        const leadStatusMap: Record<string, string> = {
          "Sent": "Proposal Sent",
          "Accepted": "Won",
          "Rejected": "Lost",
          "In Negotiation": "Negotiation"
        };
        const newLeadStatus = leadStatusMap[proposalData.status];
        if (newLeadStatus && newLeadStatus !== leadData.status) {
            const timeline = [...(leadData.timeline || [])];
            const now = Date.now();
            if (newLeadStatus === "Won" || newLeadStatus === "Lost") {
                const stageAtClosure = getLeadStage(leadData);
                const outcome: LeadOutcome = newLeadStatus === "Won" ? "won" : "lost";
                timeline.push({
                    event: newLeadStatus,
                    status: stageAtClosure,
                    previousStatus: stageAtClosure,
                    outcome,
                    remark: `Lead marked ${outcome} at ${stageAtClosure} via Proposal`,
                    performedBy: req.user.id,
                    timestamp: now
                });
                await leadRef.update({
                    status: stageAtClosure,
                    outcome,
                    wonAtStatus: outcome === "won" ? stageAtClosure : null,
                    lostAtStatus: outcome === "lost" ? stageAtClosure : null,
                    closedAt: now,
                    wasEverWon: outcome === "won" ? true : leadData.wasEverWon || false,
                    timeline,
                    updatedAt: now
                });
            } else {
                timeline.push({
                    event: "Status Changed",
                    status: newLeadStatus,
                    previousStatus: getLeadStage(leadData),
                    outcome: "open",
                    remark: `Status updated to ${newLeadStatus} via Proposal`,
                    performedBy: req.user.id,
                    timestamp: now
                });
                await leadRef.update({
                    status: newLeadStatus,
                    outcome: "open",
                    timeline,
                    updatedAt: now
                });
            }
        }
    }

    res.status(201).json({ success: true, data: { _id: newProposalRef.key, ...proposalData } });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Get single proposal
export const getProposal = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const snapshot = await rtdb.ref(`${PROPOSALS_PATH}/${id}`).once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const proposal = snapshot.val() as IProposal;

    if (proposal.createdBy !== req.user.id && !canAccessAllProposals(req.user?.role)) {
      res.status(403).json({ success: false, message: "Not authorized to access this proposal" });
      return;
    }

    const populated = {
        _id: snapshot.key,
        ...proposal,
        lead: await populateRef(LEADS_PATH, proposal.lead, ["firstName", "lastName", "company"]),
        createdBy: await populateRef(USERS_PATH, proposal.createdBy, ["name", "email"])
    };

    res.status(200).json({ success: true, data: populated });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update proposal
export const updateProposal = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const propRef = rtdb.ref(`${PROPOSALS_PATH}/${id}`);
    const snapshot = await propRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const proposal = snapshot.val() as IProposal;

    if (proposal.createdBy !== req.user.id && !canAccessAllProposals(req.user?.role)) {
      res.status(403).json({ success: false, message: "Not authorized to update this proposal" });
      return;
    }

    const updates = { ...req.body, updatedAt: Date.now() };
    delete updates.createdBy;
    delete updates.lead;

    await propRef.update(updates);

    if (updates.status) {
        const statusMap: Record<string, string> = {
          Accepted: "Won",
          Rejected: "Lost",
          "In Negotiation": "Negotiation",
          Sent: "Proposal Sent",
        };
        const newLeadStatus = statusMap[updates.status];
        if (newLeadStatus) {
            const leadRef = rtdb.ref(`${LEADS_PATH}/${proposal.lead}`);
            const leadSnap = await leadRef.once("value");
            const leadData = leadSnap.val() as ILead;

            if (leadData && leadData.status !== newLeadStatus) {
                const timeline = [...(leadData.timeline || [])];
                const now = Date.now();
                if (newLeadStatus === "Won" || newLeadStatus === "Lost") {
                    const stageAtClosure = getLeadStage(leadData);
                    const outcome: LeadOutcome = newLeadStatus === "Won" ? "won" : "lost";
                    timeline.push({
                        event: newLeadStatus,
                        status: stageAtClosure,
                        previousStatus: stageAtClosure,
                        outcome,
                        remark: `Lead marked ${outcome} at ${stageAtClosure} via Proposal update`,
                        performedBy: req.user.id,
                        timestamp: now
                    });
                    await leadRef.update({
                        status: stageAtClosure,
                        outcome,
                        wonAtStatus: outcome === "won" ? stageAtClosure : null,
                        lostAtStatus: outcome === "lost" ? stageAtClosure : null,
                        closedAt: now,
                        wasEverWon: outcome === "won" ? true : leadData.wasEverWon || false,
                        timeline,
                        updatedAt: now
                    });
                } else {
                    timeline.push({
                        event: "Status Changed",
                        status: newLeadStatus as LeadStatus,
                        previousStatus: getLeadStage(leadData),
                        outcome: "open",
                        remark: `Status updated to ${newLeadStatus} via Proposal update`,
                        performedBy: req.user.id,
                        timestamp: now
                    });
                    await leadRef.update({
                        status: newLeadStatus,
                        outcome: "open",
                        timeline,
                        updatedAt: now
                    });
                }
            }
        }
    }

    res.status(200).json({ success: true, message: "Proposal updated successfully" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete proposal
export const deleteProposal = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const propRef = rtdb.ref(`${PROPOSALS_PATH}/${id}`);
    const snapshot = await propRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }

    const proposal = snapshot.val() as IProposal;
    if (proposal.createdBy !== req.user.id && !canAccessAllProposals(req.user?.role)) {
      res.status(403).json({ success: false, message: "Not authorized to delete this proposal" });
      return;
    }

    await propRef.remove();
    res.status(200).json({ success: true, message: "Proposal removed" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
