import { rtdb } from "../config/firebase.js";
import { normalizeLeadStatus } from "../models/leadModel.js";
import type { ILead, LeadOutcome, LeadStatus } from "../models/leadModel.js";
import type { IProposal } from "../models/proposalModel.js";

const PROPOSALS_PATH = "proposals";
const CLOSED_PROPOSAL_STATUSES = new Set<IProposal["status"]>(["Accepted", "Rejected"]);

function getLeadOutcome(lead: Partial<ILead>): LeadOutcome {
  if (lead.outcome === "won" || lead.outcome === "lost" || lead.outcome === "cancelled") {
    return lead.outcome;
  }
  const status = String(lead.status ?? "");
  if (status === "Won") return "won";
  if (status === "Lost") return "lost";
  return "open";
}

function getLeadStage(lead: Partial<ILead>): LeadStatus {
  const status = String(lead.status ?? "").trim();
  if (status && status !== "Won" && status !== "Lost") {
    return normalizeLeadStatus(status);
  }
  if (lead.lostAtStatus) return normalizeLeadStatus(lead.lostAtStatus);
  if (lead.wonAtStatus) return normalizeLeadStatus(lead.wonAtStatus);
  return "Lead Captured";
}

function normalizeCurrency(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n;
}

function buildAutoProposalNotes(params: {
  fallback: string;
  leadNote?: unknown;
  syncNote?: unknown;
}): string {
  const syncNote = String(params.syncNote ?? "").trim();
  if (syncNote) return syncNote;
  const leadNote = String(params.leadNote ?? "").trim();
  if (leadNote) return leadNote;
  return params.fallback;
}

async function createAutoProposal(params: {
  leadId: string;
  createdBy: string;
  value: number;
  status: IProposal["status"];
  notes: string;
  now: number;
}) {
  const proposalPayload: IProposal = {
    lead: params.leadId,
    createdBy: params.createdBy,
    value: params.value,
    testingScope: [],
    status: params.status,
    notes: params.notes,
    createdAt: params.now,
    updatedAt: params.now,
  };
  const ref = rtdb.ref(PROPOSALS_PATH).push();
  await ref.set(proposalPayload);
}

async function moveLatestProposalToNegotiation(leadId: string, now: number) {
  const snapshot = await rtdb.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(leadId).once("value");
  if (!snapshot.exists()) return;

  const proposals = Object.entries(snapshot.val() as Record<string, IProposal>)
    .map(([id, proposal]) => ({ id, ...proposal }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const candidate = proposals.find((proposal) => !CLOSED_PROPOSAL_STATUSES.has(proposal.status));
  if (!candidate) return;
  if (candidate.status === "In Negotiation") return;

  await rtdb.ref(`${PROPOSALS_PATH}/${candidate.id}`).update({
    status: "In Negotiation",
    updatedAt: now,
  });
}

async function closeLatestActiveProposal(leadId: string, status: "Accepted" | "Rejected", now: number) {
  const snapshot = await rtdb.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(leadId).once("value");
  if (!snapshot.exists()) return;

  const proposals = Object.entries(snapshot.val() as Record<string, IProposal>)
    .map(([id, proposal]) => ({ id, ...proposal }))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const candidate = proposals.find((proposal) => !CLOSED_PROPOSAL_STATUSES.has(proposal.status));
  if (!candidate) return;
  if (candidate.status === status) return;

  await rtdb.ref(`${PROPOSALS_PATH}/${candidate.id}`).update({
    status,
    updatedAt: now,
  });
}

export async function syncProposalsFromLeadTransition(params: {
  leadId: string;
  previousLead: Partial<ILead>;
  nextLead: Partial<ILead>;
  performedBy: string;
  note?: string;
}) {
  const previousOutcome = getLeadOutcome(params.previousLead);
  const nextOutcome = getLeadOutcome(params.nextLead);
  const previousStage = getLeadStage(params.previousLead);
  const nextStage = getLeadStage(params.nextLead);
  const now = Date.now();

  if (nextOutcome === "won" && previousOutcome !== "won") {
    await closeLatestActiveProposal(params.leadId, "Accepted", now);
    return;
  }

  if (nextOutcome === "lost" && previousOutcome !== "lost") {
    await closeLatestActiveProposal(params.leadId, "Rejected", now);
    return;
  }

  if (nextOutcome !== "open") return;

  if (nextStage === "Proposal Sent" && (previousOutcome !== "open" || previousStage !== "Proposal Sent")) {
    const proposalValue = normalizeCurrency(params.nextLead.dealValue ?? params.previousLead.dealValue);
    const notes = buildAutoProposalNotes({
      fallback: `Auto-generated when lead moved to Proposal Sent`,
      leadNote: params.nextLead.latestRemark ?? params.previousLead.latestRemark,
      syncNote: params.note,
    });

    await createAutoProposal({
      leadId: params.leadId,
      createdBy: params.performedBy,
      value: proposalValue,
      status: "Sent",
      notes,
      now,
    });
    return;
  }

  if (nextStage === "Negotiation" && nextOutcome === "open" && (previousOutcome !== "open" || previousStage !== "Negotiation")) {
    await moveLatestProposalToNegotiation(params.leadId, now);
  }
}
