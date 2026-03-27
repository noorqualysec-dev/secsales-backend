export interface IProposal {
    id?: string;
    lead: string; // Firestore Lead ID
    createdBy: string; // Firestore User ID
    value: number;
    testingScope: string[]; // e.g., ["Web App Pentest", "API Pentest"]
    status: "Draft" | "Sent" | "In Negotiation" | "Accepted" | "Rejected";
    notes?: string;
    createdAt: number;
    updatedAt: number;
}

export const PROPOSAL_STATUSES = ["Draft", "Sent", "In Negotiation", "Accepted", "Rejected"] as const;
