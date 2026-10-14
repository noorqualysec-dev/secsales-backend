export type ProposalStatus = "Draft" | "Proposal Sent" | "Negotiation" | "Won" | "Lost";

export interface IProposal {
    id?: string;
    lead: string; // Firestore Lead ID
    createdBy: string; // Firestore User ID
    value: number;
    testingScope: string[]; // e.g., ["Web App Pentest", "API Pentest"]
    status: ProposalStatus;
    notes?: string;
    createdAt: number;
    updatedAt: number;
}

export const PROPOSAL_STATUSES = ["Draft", "Proposal Sent", "Negotiation", "Won", "Lost"] as const;

