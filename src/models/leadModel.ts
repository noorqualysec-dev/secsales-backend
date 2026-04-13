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
    /** E.164 calling code only, e.g. "+91". National digits live in `phone`. */
    phoneCountryCode?: string;
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

    lastActivityAt?: number;          // Last meaningful action on lead
lastReminderAt?: number | null;         // Last time reminder was sent
followUpReminderCount?: number;   // How many reminders sent
nextReminderDueAt?: number;       // Optional: precomputed next reminder time
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

/** Preset industry labels for UI dropdowns; custom values still allowed via "Other". */
export const LEAD_INDUSTRY_PRESETS = [
    "Technology",
    "Healthcare",
    "Financial Services",
    "Manufacturing",
    "Retail",
] as const;
