import type { Response } from "express";
import { rtdb } from "../config/firebase.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { LEAD_STATUSES, normalizeLeadStatus } from "../models/leadModel.js";
import type { ILead, LeadOutcome, LeadStatus } from "../models/leadModel.js";
import { syncProposalsFromLeadTransition } from "../utils/proposalSync.js";

const USERS_PATH = "users";
const LEADS_PATH = "leads";
const PROPOSALS_PATH = "proposals";
const CLOSED_STATUSES = new Set(["Won", "Lost"]);
const OPEN_PIPELINE_STATUSES = new Set<string>([
    ...LEAD_STATUSES,
    "Pre-Assessment Form Sent",
    "Proposal Preparation",
]);
const normalizeTestingScope = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === "string") : [];

const getLeadOutcome = (lead: Partial<ILead>): LeadOutcome => {
    if (lead.outcome === "won" || lead.outcome === "lost" || lead.outcome === "cancelled") {
        return lead.outcome;
    }
    const status = String(lead.status ?? "");
    if (status === "Won") return "won";
    if (status === "Lost") return "lost";
    return "open";
};

const getLeadStage = (lead: Partial<ILead>): LeadStatus => {
    if (lead.status && !CLOSED_STATUSES.has(lead.status)) {
        return normalizeLeadStatus(lead.status);
    }
    if (lead.lostAtStatus) return normalizeLeadStatus(lead.lostAtStatus);
    if (lead.wonAtStatus) return normalizeLeadStatus(lead.wonAtStatus);
    return "Lead Captured";
};

const normalizeLeadStatusFields = <T extends Partial<ILead>>(lead: T): T => {
    const normalized = { ...lead } as T & Record<string, unknown>;
    const status = String(lead.status ?? "").trim();
    if (status && !CLOSED_STATUSES.has(status)) {
        normalized.status = normalizeLeadStatus(status);
    }
    if (lead.lostAtStatus) {
        normalized.lostAtStatus = normalizeLeadStatus(lead.lostAtStatus);
    }
    if (lead.wonAtStatus) {
        normalized.wonAtStatus = normalizeLeadStatus(lead.wonAtStatus);
    }
    return normalized as T;
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

// ─── User Management (RTDB) ──────────────────────────────────────────────────

export const getAllUsers = async (req: AuthRequest, res: Response) => {
    try {
        const snapshot = await rtdb.ref(USERS_PATH).once("value");
        if (!snapshot.exists()) {
            res.status(200).json({ success: true, count: 0, data: [] });
            return;
        }

        const usersData = snapshot.val();
        const users = Object.keys(usersData).map((key) => {
            const data = usersData[key];
            delete data.password;
            return { _id: key, ...data };
        });

        users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.status(200).json({ success: true, count: users.length, data: users });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateUserRole = async (req: AuthRequest, res: Response) => {
    try {
        const { role } = req.body;
        const id = req.params.id as string;

        if (!role) {
            res.status(400).json({ success: false, message: "Please provide a role" });
            return;
        }

        const allowedRoles = ["admin", "sales_rep", "manager"];
        if (!allowedRoles.includes(role)) {
            res.status(400).json({
                success: false,
                message: `Invalid role. Must be one of: ${allowedRoles.join(", ")}`,
            });
            return;
        }

        if (role === "manager" && req.user?.role !== "admin") {
            res.status(403).json({
                success: false,
                message: "Only admin can assign manager role",
            });
            return;
        }

        const userRef = rtdb.ref(`${USERS_PATH}/${id}`);
        const snapshot = await userRef.once("value");

        if (!snapshot.exists()) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }

        await userRef.update({ role, updatedAt: Date.now() });
        const updatedSnapshot = await userRef.once("value");
        const userData = updatedSnapshot.val();
        if (userData) delete userData.password;

        res.status(200).json({ success: true, data: { _id: id, ...userData } });
    } catch (error: any) {
        res.status(400).json({ success: false, message: error.message });
    }
};

export const toggleUserStatus = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id as string;
        const userRef = rtdb.ref(`${USERS_PATH}/${id}`);
        const snapshot = await userRef.once("value");

        if (!snapshot.exists()) {
            res.status(404).json({ success: false, message: "User not found" });
            return;
        }

        if (id === req.user!.id) {
            res.status(400).json({ success: false, message: "You cannot deactivate your own account" });
            return;
        }

        const currentStatus = snapshot.val()?.isActive;
        const newStatus = !currentStatus;
        await userRef.update({ isActive: newStatus, updatedAt: Date.now() });

        res.status(200).json({
            success: true,
            message: `User ${newStatus ? "activated" : "deactivated"} successfully`,
            data: { _id: id, isActive: newStatus },
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Lead Management (RTDB) ──────────────────────────────────────────────────

export const getAllLeads = async (req: AuthRequest, res: Response) => {
    try {
        const statusFilterRaw = typeof req.query.status === "string" ? req.query.status.trim() : "";
        const snapshot = await rtdb.ref(LEADS_PATH).once("value");

        if (!snapshot.exists()) {
            res.status(200).json({ success: true, count: 0, data: [] });
            return;
        }

        const leadsData = snapshot.val();
        const leads = await Promise.all(Object.keys(leadsData).map(async (key) => {
            const data = normalizeLeadStatusFields(leadsData[key] as ILead);
            return {
                _id: key,
                ...data,
                assignedTo: await populateRef(USERS_PATH, data.assignedTo || "", ["name", "email", "role"])
            };
        }));

        const hasStageFilter = Boolean(statusFilterRaw) && statusFilterRaw !== "Won" && statusFilterRaw !== "Lost";
        if (hasStageFilter && !OPEN_PIPELINE_STATUSES.has(statusFilterRaw)) {
            res.status(200).json({ success: true, count: 0, data: [] });
            return;
        }

        const normalizedStageFilter = hasStageFilter
            ? normalizeLeadStatus(statusFilterRaw)
            : "";

        const filteredLeads = statusFilterRaw
            ? leads.filter((lead) => {
                const outcome = getLeadOutcome(lead);
                if (statusFilterRaw === "Won") return outcome === "won";
                if (statusFilterRaw === "Lost") return outcome === "lost";
                if (outcome !== "open") return false;
                return getLeadStage(lead) === normalizedStageFilter;
            })
            : leads;

        filteredLeads.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.status(200).json({ success: true, count: filteredLeads.length, data: filteredLeads });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const assignLead = async (req: AuthRequest, res: Response) => {
    try {
        const { assignedTo } = req.body;
        const id = req.params.id as string;

        if (!assignedTo) {
            res.status(400).json({ success: false, message: "Please provide a user ID" });
            return;
        }

        const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
        const leadSnapshot = await leadRef.once("value");

        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }

        const userSnapshot = await rtdb.ref(`${USERS_PATH}/${assignedTo}`).once("value");
        if (!userSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Target user not found" });
            return;
        }
        const targetUser = userSnapshot.val();

        const leadData = leadSnapshot.val() as ILead;
        const timeline = [...(leadData?.timeline || [])];

        timeline.push({
            event: "Assigned",
            performedBy: req.user!.id,
            remark: `Lead reassigned to ${targetUser?.name}`,
            timestamp: Date.now()
        });

        await leadRef.update({ assignedTo, timeline, updatedAt: Date.now() });

        res.status(200).json({ success: true, message: `Lead assigned to ${targetUser?.name}` });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateLeadStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { status, outcome, lostReason, wonReason, latestRemark } = req.body;
        const id = req.params.id as string;

        if (!status && !outcome) {
            res.status(400).json({ success: false, message: "Please provide a status or outcome" });
            return;
        }

        const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
        const snapshot = await leadRef.once("value");

        if (!snapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }

        const leadData = snapshot.val() as ILead;
        const oldStatus = getLeadStage(leadData);
        const oldOutcome = getLeadOutcome(leadData);
        const timeline = [...(leadData?.timeline || [])];
        const now = Date.now();
        const requestedStatus = typeof status === "string" ? status.trim() : "";
        const requestedOutcome = typeof outcome === "string" ? outcome.trim().toLowerCase() : "";
        const updates: Partial<ILead> & { updatedAt: number } = { updatedAt: now };
        let nextStatus = oldStatus;
        let nextOutcome = oldOutcome;

        if (requestedStatus) {
            if (requestedStatus === "Won") {
                nextOutcome = "won";
            } else if (requestedStatus === "Lost") {
                nextOutcome = "lost";
            } else if (OPEN_PIPELINE_STATUSES.has(requestedStatus)) {
                nextStatus = normalizeLeadStatus(requestedStatus);
            } else {
                res.status(400).json({ success: false, message: "Invalid status" });
                return;
            }
        }

        if (requestedOutcome) {
            if (!["open", "won", "lost", "cancelled"].includes(requestedOutcome)) {
                res.status(400).json({ success: false, message: "Invalid outcome" });
                return;
            }
            nextOutcome = requestedOutcome as LeadOutcome;
        }

        if (nextOutcome === "lost" && !String(lostReason ?? "").trim() && req.user.role === "sales_rep") {
            res.status(400).json({ success: false, message: "Loss note is required when marking lead as lost" });
            return;
        }

        if (nextOutcome === "won" || nextOutcome === "lost") {
            const closureReason = String(nextOutcome === "won" ? (wonReason ?? "") : (lostReason ?? "")).trim();
            const closureEvent: any = {
                event: nextOutcome === "won" ? "Won" : "Lost",
                status: nextStatus,
                previousStatus: oldStatus,
                outcome: nextOutcome,
                performedBy: req.user!.id,
                remark: String(latestRemark ?? "").trim() || `Lead marked ${nextOutcome} at [${nextStatus}] via Admin Kanban`,
                timestamp: now
            };
            if (closureReason) {
                closureEvent.reason = closureReason;
            }
            timeline.push(closureEvent);
            updates.status = nextStatus;
            updates.outcome = nextOutcome;
            updates.closedAt = now;
            if (nextOutcome === "won") {
                updates.wonAtStatus = nextStatus;
                updates.lostAtStatus = null as any;
                updates.wasEverWon = true;
                const normalizedWonReason = String(wonReason ?? "").trim();
                if (normalizedWonReason) {
                    updates.wonReason = normalizedWonReason;
                }
            } else {
                updates.lostAtStatus = nextStatus;
                updates.wonAtStatus = null as any;
                const normalizedLostReason = String(lostReason ?? "").trim();
                if (normalizedLostReason) {
                    updates.lostReason = normalizedLostReason;
                }
            }
        } else if (nextStatus !== oldStatus || oldOutcome !== "open") {
            timeline.push({
                event: oldOutcome !== "open" ? "Reopened" : "Status Changed",
                status: nextStatus,
                previousStatus: oldStatus,
                outcome: "open",
                performedBy: req.user!.id,
                remark: String(latestRemark ?? "").trim() || (
                    oldOutcome !== "open"
                        ? `Lead reopened and moved to [${nextStatus}] via Admin Kanban`
                        : `Lead moved from [${oldStatus}] to [${nextStatus}] via Admin Kanban`
                ),
                timestamp: now
            });
            updates.status = nextStatus;
            updates.outcome = "open";
            updates.closedAt = null as any;
            updates.wonAtStatus = null as any;
            updates.lostAtStatus = null as any;
        }

        if (String(latestRemark ?? "").trim()) {
            updates.latestRemark = String(latestRemark).trim();
        }
        updates.timeline = timeline;
        await leadRef.update(updates);

        try {
            const syncNote = String(latestRemark ?? "").trim();
            await syncProposalsFromLeadTransition({
                leadId: id,
                previousLead: leadData,
                nextLead: {
                    ...leadData,
                    ...updates,
                    status: updates.status || nextStatus,
                    outcome: updates.outcome || nextOutcome,
                },
                performedBy: req.user!.id,
                ...(syncNote ? { note: syncNote } : {}),
            });
        } catch (proposalSyncError) {
            console.error("[proposal-sync:updateLeadStatus]", proposalSyncError);
        }

        res.status(200).json({ success: true, message: `Lead updated to ${nextOutcome === "open" ? nextStatus : nextOutcome}` });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getLeadStats = async (req: AuthRequest, res: Response) => {
    try {
        const snapshot = await rtdb.ref(LEADS_PATH).once("value");
        if (!snapshot.exists()) {
            res.status(200).json({ success: true, data: {} });
            return;
        }

        const stats = Object.fromEntries(
            [...LEAD_STATUSES, "Won", "Lost"].map((status) => [status, 0])
        ) as Record<string, number>;

        const leads = snapshot.val();
        Object.values(leads).forEach((lead: any) => {
            const outcome = getLeadOutcome(lead);
            const status = outcome === "won"
                ? "Won"
                : outcome === "lost"
                    ? "Lost"
                    : getLeadStage(lead);
            const count = stats[status];
            if (status && count !== undefined) {
                stats[status] = count + 1;
            }
        });

        res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getLeadJourney = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id as string;
        
        // 1. Get Lead
        const leadSnapshot = await rtdb.ref(`${LEADS_PATH}/${id}`).once("value");
        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }
        const leadData = normalizeLeadStatusFields(leadSnapshot.val() as ILead);

        // 2. Get Assigned User
        const assignedUser = await populateRef(USERS_PATH, leadData.assignedTo || "", ["name", "email", "role"]);

        // 3. Get Proposals for this lead
        const proposalsSnapshot = await rtdb.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(id).once("value");
        const proposalsData = proposalsSnapshot.val() || {};
        const proposals = Object.entries(proposalsData).map(([key, val]: [string, any]) => ({
            _id: key,
            value: val.value,
            status: val.status,
            createdAt: val.createdAt
        }));

        // 4. Populate Timeline PerformedBy
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

// ─── Proposal Management (RTDB) ──────────────────────────────────────────────

export const getAllProposals = async (req: AuthRequest, res: Response) => {
    try {
        const snapshot = await rtdb.ref(PROPOSALS_PATH).once("value");
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
                testingScope: normalizeTestingScope(data.testingScope),
                lead: await populateRef(LEADS_PATH, data.lead, ["firstName", "lastName", "company", "status"]),
                createdBy: await populateRef(USERS_PATH, data.createdBy, ["name", "email", "role"])
            };
        }));

        proposals.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        res.status(200).json({ success: true, count: proposals.length, data: proposals });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
