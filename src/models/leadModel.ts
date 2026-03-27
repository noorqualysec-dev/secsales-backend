export interface ITimelineEvent {
    event: "Creation" | "Status Changed" | "Remark Added" | "Assigned" | "Won" | "Lost";
    status?: string;
    remark?: string;
    performedBy: string; // User ID
    timestamp: number;
}

export interface ILead {
    id?: string;
    firstName: string;
    lastName: string;
    email: string;
    designation?: string;
    employeeStrength?: "1-10" | "11-50" | "51-200" | "201-500" | "501-1000" | "1000+";
    phone?: string;
    company?: string;
    country?: string;
    industry?: string;
    status: string;
    latestRemark?: string;
    source: string;
    assignedTo?: string; // User ID
    createdBy: string; // User ID
    timeline: ITimelineEvent[];
    closingDate?: number; // Target timestamp
    dealValue?: number; // Estimated value
    createdAt: number;
    updatedAt: number;
}

export const LEAD_SOURCES = [
    "website",
    "email_marketing",
    "linkedin",
    "referral",
    "events",
    "recurring",
    "partnership",
    "offline_source",
    "other"
] as const;

export const LEAD_STATUSES = [
    "Lead Captured",
    "Discovery Call Scheduled",
    "Requirement Gathering",
    "Pre-Assessment Form Sent",
    "Proposal Preparation",
    "Proposal Sent",
    "Negotiation",
    "Won",
    "Lost"
] as const;
