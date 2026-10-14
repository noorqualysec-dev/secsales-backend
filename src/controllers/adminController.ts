import type { Response } from "express";
import bcrypt from "bcrypt";
import { mongoStore } from "../config/mongoCompat.js";
import { AuditEvent, NegotiationEvent, Proposal, User } from "../models/mongoModels.js";
import { proposalResponse } from "./proposalController.js";
import { getNextLeadReminderAt } from "../services/reminderPolicy.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { LEAD_STATUSES, normalizeLeadStatus } from "../models/leadModel.js";
import type { ILead, LeadOutcome, LeadStatus } from "../models/leadModel.js";

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

export const provisionUser = async (req: AuthRequest, res: Response) => {
    try {
        if (req.user?.role !== "admin") {
            res.status(403).json({ success: false, message: "Only an admin can provision users" });
            return;
        }
        const name = String(req.body.name ?? "").trim();
        const email = String(req.body.email ?? "").trim().toLowerCase();
        const password = req.body.password;
        const role = req.body.role ?? "sales_rep";
        if (!name || !email || typeof password !== "string" || password.length < 6) {
            res.status(400).json({ success: false, message: "Name, email, and a password of at least 6 characters are required" });
            return;
        }
        if (!["admin", "manager", "sales_rep"].includes(role)) {
            res.status(400).json({ success: false, message: "Invalid role" });
            return;
        }
        const passwordHash = await bcrypt.hash(password, 12);
        const user = await User.create({
            name,
            email,
            passwordHash,
            role,
            isActive: true,
            activatedAt: new Date(),
        });
        await AuditEvent.create({
            entityType: "user",
            entityId: user._id,
            eventType: "user.provisioned",
            actorId: req.user.id,
            occurredAt: new Date(),
            meaningfulActivity: false,
            changes: [{ field: "role", after: role }],
        });
        res.status(201).json({
            success: true,
            data: { _id: user._id, name: user.name, email: user.email, role: user.role, isActive: user.isActive },
        });
    } catch (error) {
        if ((error as { code?: number }).code === 11000) {
            res.status(409).json({ success: false, message: "A user with that email already exists" });
            return;
        }
        console.error("User provisioning failed:", error);
        res.status(500).json({ success: false, message: "User provisioning failed" });
    }
};

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
    const snapshot = await mongoStore.ref(`${path}/${id}`).once("value");
    if (!snapshot.exists()) return null;
    const data = snapshot.val();
    const result: any = { _id: snapshot.key };
    fields.forEach(f => { result[f] = data?.[f]; });
    return result;
};

// ─── User Management (RTDB) ──────────────────────────────────────────────────

export const getAllUsers = async (req: AuthRequest, res: Response) => {
    try {
        const snapshot = await mongoStore.ref(USERS_PATH).once("value");
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

        const userRef = mongoStore.ref(`${USERS_PATH}/${id}`);
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
        const userRef = mongoStore.ref(`${USERS_PATH}/${id}`);
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
        const snapshot = await mongoStore.ref(LEADS_PATH).once("value");

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

        const leadRef = mongoStore.ref(`${LEADS_PATH}/${id}`);
        const leadSnapshot = await leadRef.once("value");

        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }

        const userSnapshot = await mongoStore.ref(`${USERS_PATH}/${assignedTo}`).once("value");
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

        const reassignedAt = Date.now();
        const nextReminder = leadData.outcome === "open"
            ? await getNextLeadReminderAt(getLeadStage(leadData), new Date(reassignedAt))
            : null;
        await leadRef.update({
            assignedTo,
            timeline,
            updatedAt: reassignedAt,
            ...(nextReminder ? { nextReminderDueAt: nextReminder.getTime() } : { nextReminderDueAt: null }),
        });

        res.status(200).json({ success: true, message: `Lead assigned to ${targetUser?.name}` });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateLeadStatus = async (req: AuthRequest, res: Response) => {
    try {
        const { status, outcome, lostReason, wonReason, latestRemark, cancellationReason } = req.body;
        const id = req.params.id as string;

        if (!status && !outcome) {
            res.status(400).json({ success: false, message: "Please provide a status or outcome" });
            return;
        }

        const leadRef = mongoStore.ref(`${LEADS_PATH}/${id}`);
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
        if (
            requestedStatus &&
            OPEN_PIPELINE_STATUSES.has(requestedStatus) &&
            nextStatus === "Proposal Sent" &&
            oldStatus !== "Proposal Sent" &&
            !(await Proposal.exists({ leadId: id }))
        ) {
            res.status(409).json({
                success: false,
                message: "A proposal is mandatory before moving this lead to Proposal Sent. Please create a proposal first.",
            });
            return;
        }
        if (
            requestedStatus &&
            OPEN_PIPELINE_STATUSES.has(requestedStatus) &&
            nextStatus === "Negotiation" &&
            oldStatus !== "Negotiation" &&
            !(await Proposal.exists({ leadId: id }))
        ) {
            res.status(409).json({
                success: false,
                message: "A proposal is required before moving this lead to Negotiation.",
            });
            return;
        }

        if (requestedOutcome) {
            if (!["open", "won", "lost", "cancelled"].includes(requestedOutcome)) {
                res.status(400).json({ success: false, message: "Invalid outcome" });
                return;
            }
            nextOutcome = requestedOutcome as LeadOutcome;
        }

        if (nextOutcome === "lost" && !String(lostReason ?? "").trim()) {
            res.status(400).json({ success: false, message: "Loss reason is required when marking lead as lost" });
            return;
        }
        if (nextOutcome === "cancelled" && !String(req.body.cancellationReason ?? "").trim()) {
            res.status(400).json({ success: false, message: "Cancellation reason is required when cancelling a lead" });
            return;
        }
        if (nextOutcome === "won" && oldOutcome !== "won") {
            if (!["Proposal Sent", "Negotiation"].includes(oldStatus) && !["Proposal Sent", "Negotiation"].includes(nextStatus)) {
                res.status(409).json({ success: false, message: "A lead cannot be marked as Won unless it is in the Proposal Sent or Negotiation stage." });
                return;
            }
            if (!(await Proposal.exists({ leadId: id, status: { $in: ["Won", "Accepted"] } }))) {
                res.status(409).json({ success: false, message: "A lead can be marked won only after its proposal is accepted" });
                return;
            }
        }

        if (nextStatus === "Proposal Sent" && oldStatus !== "Proposal Sent") {
            const existingProposal = await Proposal.findOne({ leadId: id });
            if (existingProposal && existingProposal.status === "Draft") {
                existingProposal.status = "Proposal Sent";
                await existingProposal.save();
                await NegotiationEvent.create([{
                    proposalId: existingProposal._id,
                    leadId: id,
                    ...(existingProposal.currentRevisionId ? { revisionId: existingProposal.currentRevisionId } : {}),
                    type: "Proposal Sent",
                    fromStatus: "Draft",
                    toStatus: "Proposal Sent",
                    occurredAt: new Date(now),
                    actorId: req.user!.id,
                    note: "Proposal moved to Proposal Sent as lead moved to Proposal Sent stage via Admin",
                }]);
            }
        }

        if (nextStatus === "Negotiation" && oldStatus !== "Negotiation") {
            const existingProposal = await Proposal.findOne({ leadId: id });
            if (existingProposal && !["Negotiation", "Won", "Revision", "In Negotiation", "Accepted"].includes(existingProposal.status)) {
                const prevStatus = existingProposal.status;
                existingProposal.status = "Negotiation";
                await existingProposal.save();
                await NegotiationEvent.create([{
                    proposalId: existingProposal._id,
                    leadId: id,
                    ...(existingProposal.currentRevisionId ? { revisionId: existingProposal.currentRevisionId } : {}),
                    type: "Negotiation",
                    fromStatus: prevStatus,
                    toStatus: "Negotiation",
                    occurredAt: new Date(now),
                    actorId: req.user!.id,
                    note: "Lead moved to Negotiation stage via Admin",
                }]);
            }
        }

        if (nextOutcome !== "open") {
            const closureReason = String(
                nextOutcome === "won" ? (wonReason ?? "")
                    : nextOutcome === "lost" ? (lostReason ?? "")
                        : (cancellationReason ?? ""),
            ).trim();
            const closureEvent: any = {
                event: nextOutcome === "won" ? "Won" : nextOutcome === "lost" ? "Lost" : "Cancelled",
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
                updates.cancellationReason = null as any;
                updates.wasEverWon = true;
                const normalizedWonReason = String(wonReason ?? "").trim();
                if (normalizedWonReason) {
                    updates.wonReason = normalizedWonReason;
                }
            } else if (nextOutcome === "lost") {
                updates.lostAtStatus = nextStatus;
                updates.wonAtStatus = null as any;
                updates.cancellationReason = null as any;
                const normalizedLostReason = String(lostReason ?? "").trim();
                if (normalizedLostReason) {
                    updates.lostReason = normalizedLostReason;
                }
            } else {
                updates.wonAtStatus = null as any;
                updates.lostAtStatus = null as any;
                updates.cancellationReason = closureReason;
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
                        ? `Lead reopened and moved to ${nextStatus} via Admin`
                        : `Stage changed from ${oldStatus} to ${nextStatus}`
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
        if (nextOutcome !== "open") {
            updates.nextReminderDueAt = null as any;
        } else if (nextStatus !== oldStatus || oldOutcome !== "open") {
            const nextReminder = await getNextLeadReminderAt(nextStatus, new Date(now));
            updates.nextReminderDueAt = (nextReminder?.getTime() ?? null) as any;
            updates.lastActivityAt = now;
        }
        updates.timeline = timeline;
        await leadRef.update(updates);

        res.status(200).json({ success: true, message: `Lead updated to ${nextOutcome === "open" ? nextStatus : nextOutcome}` });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getLeadStats = async (req: AuthRequest, res: Response) => {
    try {
        const snapshot = await mongoStore.ref(LEADS_PATH).once("value");
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
        const leadSnapshot = await mongoStore.ref(`${LEADS_PATH}/${id}`).once("value");
        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }
        const leadData = normalizeLeadStatusFields(leadSnapshot.val() as ILead);

        // 2. Get Assigned User
        const assignedUser = await populateRef(USERS_PATH, leadData.assignedTo || "", ["name", "email", "role"]);

        // 3. Get Proposals for this lead
        let canonicalProposal: any = null;
        try {
            const canonicalDoc = await Proposal.findOne({ leadId: id }).select("_id").lean();
            if (canonicalDoc) {
                canonicalProposal = await proposalResponse(canonicalDoc._id);
            }
        } catch (e) {
            console.error("Failed to fetch canonical proposal for admin lead journey:", e);
        }

        const proposalsSnapshot = await mongoStore.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(id).once("value");
        const proposalsData = proposalsSnapshot.val() || {};
        const fallbackProposals = Object.entries(proposalsData).map(([key, val]: [string, any]) => ({
            _id: key,
            value: val.value,
            status: val.status,
            createdAt: val.createdAt
        }));

        const proposals = canonicalProposal ? [canonicalProposal] : fallbackProposals;

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
                proposals,
                proposal: canonicalProposal
            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ─── Proposal Management (RTDB) ──────────────────────────────────────────────

export const getAllProposals = async (req: AuthRequest, res: Response) => {
    try {
        const proposalDocs = await Proposal.find().sort({ updatedAt: -1 }).select("_id").lean();
        const fullProposals = await Promise.all(proposalDocs.map((doc) => proposalResponse(doc._id)));
        const data = fullProposals.filter(Boolean);
        res.status(200).json({ success: true, count: data.length, data });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
