import type { Response } from "express";
import mongoose, { Types } from "mongoose";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { AuditEvent, Lead, NegotiationEvent, Proposal, ProposalRevision } from "../models/mongoModels.js";
import { PROPOSAL_STATUSES } from "../models/proposalModel.js";
import { getNextLeadReminderAt } from "../services/reminderPolicy.js";

const hasGlobalAccess = (role: unknown): boolean => role === "admin" || role === "manager";
const validId = (value: string): boolean => Types.ObjectId.isValid(value);
const isProposalStatus = (value: unknown): value is typeof PROPOSAL_STATUSES[number] =>
  typeof value === "string" && PROPOSAL_STATUSES.includes(value as typeof PROPOSAL_STATUSES[number]);

async function canAccessLead(user: NonNullable<AuthRequest["user"]>, leadId: string): Promise<boolean> {
  if (hasGlobalAccess(user.role)) return true;
  return Boolean(await Lead.exists({
    _id: leadId,
    $or: [{ assignedTo: user.id }, { createdBy: user.id }],
  }));
}

function parseRevision(body: Record<string, unknown>) {
  const scopeRaw = body.testingScope ?? body.scope;
  const scope = Array.isArray(scopeRaw)
    ? scopeRaw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    : [];
  const valueRaw = body.value;
  let value: string | undefined;
  if (valueRaw !== undefined && valueRaw !== null && valueRaw !== "") {
    value = String(valueRaw).trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error("Proposal value must be a non-negative amount with at most 2 decimal places");
  }
  const currency = body.currency === undefined ? undefined : String(body.currency).trim().toUpperCase();
  if (value !== undefined && (!currency || !/^[A-Z]{3}$/.test(currency))) {
    throw new Error("A three-letter ISO currency code is required with proposal value");
  }
  return {
    scope,
    ...(value !== undefined ? { value: mongoose.Types.Decimal128.fromString(value) } : {}),
    ...(currency ? { currency } : {}),
    ...(body.commercialTerms !== undefined ? { commercialTerms: String(body.commercialTerms).trim() } : {}),
    ...(body.notes !== undefined ? { notes: String(body.notes).trim() } : {}),
    ...(body.reason !== undefined ? { reason: String(body.reason).trim() } : {}),
    ...(body.customerRequestOrResponse !== undefined
      ? { customerRequestOrResponse: String(body.customerRequestOrResponse).trim() }
      : {}),
    ...(Array.isArray(body.testingServices) ? { testingServices: body.testingServices } : {}),
  };
}

export async function proposalResponse(proposalId: Types.ObjectId | string) {
  const proposal = await Proposal.findById(proposalId)
    .populate("leadId", "firstName lastName company email status outcome")
    .populate("createdBy", "name email")
    .lean();
  if (!proposal) return null;
  const [currentRevision, revisions, negotiationEvents] = await Promise.all([
    proposal.currentRevisionId ? ProposalRevision.findById(proposal.currentRevisionId).lean() : null,
    ProposalRevision.find({ proposalId: proposal._id }).sort({ revisionNumber: 1 }).lean(),
    NegotiationEvent.find({ proposalId: proposal._id })
      .populate("actorId", "name email")
      .populate("revisionId", "revisionNumber")
      .sort({ occurredAt: 1 })
      .lean(),
  ]);
  return {
    ...proposal,
    lead: proposal.leadId,
    leadId: proposal.leadId,
    currentRevision,
    revisions,
    negotiationEvents,
  };
}

export const getProposals = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let leadFilter = {};
    if (!hasGlobalAccess(req.user?.role)) {
      const leads = await Lead.find({
        $or: [{ assignedTo: req.user?.id }, { createdBy: req.user?.id }],
      }).select("_id").lean();
      leadFilter = { leadId: { $in: leads.map((lead) => lead._id) } };
    }
    const proposals = await Proposal.find(leadFilter).sort({ updatedAt: -1 }).select("_id").lean();
    const data = await Promise.all(proposals.map((proposal) => proposalResponse(proposal._id)));
    res.status(200).json({ success: true, count: data.length, data: data.filter(Boolean) });
  } catch (error) {
    console.error("Proposal list failed:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve proposals" });
  }
};

export const createProposal = async (req: AuthRequest, res: Response): Promise<void> => {
  const leadId = String(req.body.leadId ?? req.body.lead ?? "");
  if (!validId(leadId)) {
    res.status(400).json({ success: false, message: "A valid lead ID is required" });
    return;
  }
  if (req.body.status !== undefined && req.body.status !== "Draft") {
    res.status(400).json({ success: false, message: "A proposal must be saved as Draft; use the explicit send action to send it" });
    return;
  }
  if (!(await canAccessLead(req.user!, leadId))) {
    res.status(403).json({ success: false, message: "Not authorized to create a proposal for this lead" });
    return;
  }

  const session = await mongoose.startSession();
  let createdId: Types.ObjectId | undefined;
  try {
    await session.withTransaction(async () => {
      const lead = await Lead.findById(leadId).session(session);
      if (!lead || lead.outcome !== "open") throw new Error("An open lead is required");
      const revisionData = parseRevision(req.body);
      const [proposal] = await Proposal.create([{
        leadId: lead._id,
        status: "Draft",
        currentRevisionNumber: 1,
        createdBy: req.user!.id,
      }], { session });
      if (!proposal) throw new Error("Failed to create canonical proposal");
      const [revision] = await ProposalRevision.create([{
        ...revisionData,
        proposalId: proposal._id,
        leadId: lead._id,
        revisionNumber: 1,
        statusAtCreation: "Draft",
        preparedBy: req.user!.id,
        preparedAt: new Date(),
      }], { session });
      if (!revision) throw new Error("Failed to create proposal revision");
      proposal.currentRevisionId = revision._id;
      await proposal.save({ session });
      createdId = proposal._id;
    });
    const data = createdId ? await proposalResponse(createdId) : null;
    res.status(201).json({ success: true, data });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      res.status(409).json({ success: false, message: "This lead already has a canonical proposal" });
      return;
    }
    const message = error instanceof Error ? error.message : "Proposal creation failed";
    const status = message === "An open lead is required" ? 409 : 400;
    res.status(status).json({ success: false, message });
  } finally {
    await session.endSession();
  }
};

export const getProposal = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!validId(id)) {
    res.status(400).json({ success: false, message: "Invalid proposal ID" });
    return;
  }
  try {
    const proposal = await Proposal.findById(id).select("leadId");
    if (!proposal) {
      res.status(404).json({ success: false, message: "Proposal not found" });
      return;
    }
    if (!(await canAccessLead(req.user!, proposal.leadId.toString()))) {
      res.status(403).json({ success: false, message: "Not authorized to access this proposal" });
      return;
    }
    res.status(200).json({ success: true, data: await proposalResponse(id) });
  } catch (error) {
    console.error("Proposal retrieval failed:", error);
    res.status(500).json({ success: false, message: "Failed to retrieve proposal" });
  }
};

export const updateProposal = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!validId(id)) {
    res.status(400).json({ success: false, message: "Invalid proposal ID" });
    return;
  }
  if (req.body.status !== undefined || req.body.lead !== undefined || req.body.leadId !== undefined || req.body.createdBy !== undefined) {
    res.status(400).json({ success: false, message: "Proposal status and relationship fields cannot be changed through this endpoint" });
    return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const proposal = await Proposal.findById(id).session(session);
      if (!proposal) throw new Error("Proposal not found");
      if (!(await canAccessLead(req.user!, proposal.leadId.toString()))) throw new Error("Not authorized");
      const lead = await Lead.findById(proposal.leadId).session(session);
      if (!lead || lead.outcome !== "open") throw new Error("Proposal cannot be edited for a closed lead");
      const previousStatus = proposal.status;
      const revisionData = parseRevision(req.body);
      const revision = await ProposalRevision.create([{
        ...revisionData,
        proposalId: proposal._id,
        leadId: proposal.leadId,
        revisionNumber: (proposal.currentRevisionNumber ?? 0) + 1,
        statusAtCreation: proposal.status,
        preparedBy: req.user!.id,
        preparedAt: new Date(),
      }], { session });
      const nextRevision = revision[0];
      if (!nextRevision) throw new Error("Failed to create proposal revision");
      proposal.currentRevisionId = nextRevision._id;
      proposal.currentRevisionNumber = (proposal.currentRevisionNumber ?? 0) + 1;
      proposal.status = "Negotiation";
      await proposal.save({ session });

      const occurredAt = new Date();
      await NegotiationEvent.create([{
        proposalId: proposal._id,
        leadId: lead._id,
        revisionId: nextRevision._id,
        type: "Negotiation",
        fromStatus: previousStatus,
        toStatus: "Negotiation",
        occurredAt,
        actorId: req.user!.id,
        note: revisionData.notes ?? revisionData.reason ?? `Revision ${nextRevision.revisionNumber} saved`,
      }], { session });

      if (lead.status !== "Negotiation") {
        const previousStage = lead.status;
        lead.status = "Negotiation";
        lead.lastMeaningfulActivityAt = occurredAt;
        lead.nextReminderDueAt = await getNextLeadReminderAt("Negotiation", occurredAt);
        await lead.save({ session });
        await AuditEvent.create([{
          entityType: "lead",
          entityId: lead._id,
          leadId: lead._id,
          eventType: "lead.stage_changed",
          actorId: req.user!.id,
          occurredAt,
          meaningfulActivity: true,
          changes: [{ field: "status", before: previousStage, after: "Negotiation" }],
          note: "Lead moved to Negotiation on proposal revision",
        }], { session });
      }
    });
    res.status(200).json({ success: true, message: "Proposal revision saved", data: await proposalResponse(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal update failed";
    const status = message === "Proposal not found" ? 404 : message === "Not authorized" ? 403 : 400;
    res.status(status).json({ success: false, message });
  } finally {
    await session.endSession();
  }
};

export const sendProposal = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id ?? "");
  if (!validId(id)) {
    res.status(400).json({ success: false, message: "Invalid proposal ID" });
    return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const proposal = await Proposal.findById(id).session(session);
      if (!proposal) throw new Error("Proposal not found");
      if (!(await canAccessLead(req.user!, proposal.leadId.toString()))) throw new Error("Not authorized");
      const lead = await Lead.findById(proposal.leadId).session(session);
      if (!lead || lead.outcome !== "open") throw new Error("Proposal can only be sent for an open lead");
      const allowedSend = ["Proposal Sent", "Negotiation"].includes(lead.status) || req.body?.moveToProposalStage === true;
      if (!allowedSend) {
        throw new Error("Cannot send proposal unless the lead is in Proposal Sent or Negotiation stage. Save as draft first.");
      }
      if (!proposal.currentRevisionId) throw new Error("Save a proposal revision before sending");

      const existingSend = await NegotiationEvent.exists({
        proposalId: proposal._id,
        revisionId: proposal.currentRevisionId,
        type: { $in: ["Proposal Sent", "sent", "proposal_sent"] },
      }).session(session);
      if (existingSend) throw new Error("The current revision has already been sent");

      const previousStatus = proposal.status;
      proposal.status = "Proposal Sent";
      await proposal.save({ session });
      await NegotiationEvent.create([{
        proposalId: proposal._id,
        leadId: lead._id,
        revisionId: proposal.currentRevisionId,
        type: "Proposal Sent",
        fromStatus: previousStatus,
        toStatus: "Proposal Sent",
        actorId: req.user!.id,
        occurredAt: new Date(),
        note: typeof req.body.note === "string" ? req.body.note.trim() : undefined,
      }], { session });

      const previousStage = lead.status;
      const stageChanged = lead.status !== "Negotiation" && lead.status !== "Proposal Sent";
      if (stageChanged) {
        lead.status = "Proposal Sent";
      }
      const sentAt = new Date();
      lead.lastMeaningfulActivityAt = sentAt;
      lead.nextReminderDueAt = await getNextLeadReminderAt(lead.status, sentAt);
      await lead.save({ session });
      await AuditEvent.create([{
        entityType: "lead",
        entityId: lead._id,
        leadId: lead._id,
        eventType: stageChanged ? "lead.stage_changed" : "lead.proposal_sent",
        actorId: req.user!.id,
        occurredAt: sentAt,
        meaningfulActivity: true,
        changes: stageChanged ? [{ field: "status", before: previousStage, after: "Proposal Sent" }] : [],
        note: "Proposal sent",
      }], { session });
    });
    res.status(200).json({ success: true, message: "Proposal sent", data: await proposalResponse(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal send failed";
    const status = message === "Proposal not found" ? 404 : message === "Not authorized" ? 403 : 409;
    res.status(status).json({ success: false, message });
  } finally {
    await session.endSession();
  }
};

export const updateProposalDecision = async (req: AuthRequest, res: Response): Promise<void> => {
  const id = String(req.params.id ?? "");
  const nextStatusRaw: string = String(req.body.status ?? "").trim();
  // Normalize status to the 5 stages: Draft, Proposal Sent, Negotiation, Won, Lost
  const nextStatus =
    nextStatusRaw === "Won" || nextStatusRaw === "Accepted"
      ? "Won"
      : nextStatusRaw === "Lost" || nextStatusRaw === "Rejected" || nextStatusRaw === "Declined"
      ? "Lost"
      : nextStatusRaw === "Negotiation" || nextStatusRaw === "Revision" || nextStatusRaw === "In Negotiation"
      ? "Negotiation"
      : nextStatusRaw;

  if (!validId(id) || !["Negotiation", "Won", "Lost"].includes(nextStatus)) {
    res.status(400).json({ success: false, message: "A valid proposal ID and a decision status (Negotiation, Won, or Lost) are required" });
    return;
  }
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const proposal = await Proposal.findById(id).session(session);
      if (!proposal) throw new Error("Proposal not found");
      if (!(await canAccessLead(req.user!, proposal.leadId.toString()))) throw new Error("Not authorized");
      const lead = await Lead.findById(proposal.leadId).session(session);
      if (!lead || lead.outcome !== "open") throw new Error("Lead is not open");
      if (!["Proposal Sent", "Negotiation", "Sent", "In Negotiation", "Revision"].includes(proposal.status)) {
        throw new Error("A proposal must be sent before its customer decision can be recorded");
      }
      if (nextStatus === "Lost" && req.body.finalDecision === true && !String(req.body.reason ?? "").trim()) {
        throw new Error("A reason is required for a final rejection");
      }

      const previousStatus = proposal.status;
      const decisionAt = new Date();
      proposal.status = nextStatus as "Negotiation" | "Won" | "Lost";
      await proposal.save({ session });
      await NegotiationEvent.create([{
        proposalId: proposal._id,
        leadId: lead._id,
        ...(proposal.currentRevisionId ? { revisionId: proposal.currentRevisionId } : {}),
        type: nextStatus,
        fromStatus: previousStatus,
        toStatus: nextStatus,
        ...(typeof req.body.customerMessage === "string" ? { customerMessage: req.body.customerMessage.trim() } : {}),
        actorId: req.user!.id,
        occurredAt: decisionAt,
        ...(typeof req.body.note === "string" ? { note: req.body.note.trim() } : {}),
      }], { session });

      if (nextStatus === "Won" || (nextStatus === "Lost" && req.body.finalDecision === true)) {
        const outcome = nextStatus === "Won" ? "won" : "lost";
        const stage = lead.status;
        lead.outcome = outcome;
        lead.closedAt = decisionAt;
        lead.lastMeaningfulActivityAt = decisionAt;
        lead.nextReminderDueAt = null;
        if (outcome === "won") {
          lead.wonAtStatus = stage;
          lead.wasEverWon = true;
          if (req.body.reason) lead.wonReason = String(req.body.reason).trim();
        } else {
          lead.lostAtStatus = stage;
          lead.lostReason = String(req.body.reason).trim();
        }
        await lead.save({ session });
        await AuditEvent.create([{
          entityType: "lead",
          entityId: lead._id,
          leadId: lead._id,
          eventType: `lead.${outcome}`,
          actorId: req.user!.id,
          occurredAt: decisionAt,
          meaningfulActivity: true,
          changes: [{ field: "outcome", before: "open", after: outcome }],
          ...(typeof req.body.reason === "string" ? { reason: req.body.reason.trim() } : {}),
        }], { session });
      } else if (lead.status !== "Negotiation") {
        const previousStage = lead.status;
        lead.status = "Negotiation";
        lead.lastMeaningfulActivityAt = decisionAt;
        lead.nextReminderDueAt = await getNextLeadReminderAt("Negotiation", decisionAt);
        await lead.save({ session });
        await AuditEvent.create([{
          entityType: "lead",
          entityId: lead._id,
          leadId: lead._id,
          eventType: "lead.stage_changed",
          actorId: req.user!.id,
          occurredAt: decisionAt,
          meaningfulActivity: true,
          changes: [{ field: "status", before: previousStage, after: "Negotiation" }],
          note: "Proposal entered revision/negotiation",
        }], { session });
      }
    });
    res.status(200).json({ success: true, message: "Proposal decision recorded", data: await proposalResponse(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal decision failed";
    const status = message === "Proposal not found" ? 404 : message === "Not authorized" ? 403 : 400;
    res.status(status).json({ success: false, message });
  } finally {
    await session.endSession();
  }
};

export const deleteProposal = async (_req: AuthRequest, res: Response): Promise<void> => {
  res.status(409).json({
    success: false,
    message: "Proposal history cannot be deleted. An approved audited withdrawal action is required.",
  });
};
