export interface ITimelineEvent {
    event: "Creation" | "Status Changed" | "Remark Added" | "Assigned" | "Won" | "Lost" | "Cancelled" | "Reopened";
    status?: LeadStatus;
     previousStatus?: LeadStatus;
    outcome?: LeadOutcome;
    remark?: string;
    reason?: string;
    performedBy: string; // User ID
    timestamp: number;
}

export const LEAD_REGIONS = [
    "India",
    "Middle-East",
    "North-America",
    "SouthEast-Asia",
    "Australia",
    "South-America"
] as const;

export interface LeadContact {
    id: string;
    firstName: string;
    lastName: string;
    fullName?: string; // optional computed/helper field
    email: string;
    phone?: string;
    phoneCountryCode?: string;
    designation?: string;
    department?: string;

    isPrimary?: boolean;
    isDecisionMaker?: boolean;
    isInfluencer?: boolean;
    isTechnicalContact?: boolean;
    isBillingContact?: boolean;

    linkedinUrl?: string;
    notes?: string;
    source?: string; // referral, website, event, manual, etc.

    addedAt: number;
    updatedAt: number;
    addedBy: string;

    lastContactedAt?: number;
    nextFollowUpAt?: number;
    contactStatus?: "active" | "inactive" | "unresponsive" | "left_company";

    preferredChannel?: "email" | "phone" | "whatsapp" | "linkedin";
    employmentStage?: "current" | "joining_soon" | "newly_joined";
    joinedOn?: number;
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
    region?: LeadRegion;
    industry?: string;
    status: LeadStatus;
    // overall result of lead
    outcome: LeadOutcome;
    // tracking where lead was closed
    lostAtStatus?: LeadStatus;
    wonAtStatus?: LeadStatus;
    closedAt?: number;

    // reasons
    lostReason?: string;
    wonReason?: string;
    cancellationReason?: string;

    // special business case
    wasEverWon?: boolean;
    latestRemark?: string;
    source: string;
    assignedTo?: string; // User ID
    createdBy: string; // User ID
    timeline: ITimelineEvent[];
    closingDate?: number; // Target timestamp
    dealValue?: number; // Estimated value
    createdAt: number;
    updatedAt: number;
    contacts?: LeadContact[];
    primaryContactId?: string;

    lastActivityAt?: number;          // Last meaningful action on lead
lastReminderAt?: number | null;         // Last time reminder was sent
followUpReminderCount?: number;   // How many reminders sent
    nextReminderDueAt?: number;       // Optional: precomputed next reminder time

    companyInsights?: {
        hiringSignal?: string;
        recentTrigger?: string;
        nextOpportunity?: string;
        accountNotes?: string;
    };
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
    "Proposal Sent",
    "Negotiation",
] as const;

export const LEGACY_LEAD_STATUS_ALIASES = {
    "Pre-Assessment Form Sent": "Requirement Gathering",
    "Proposal Preparation": "Proposal Sent",
} as const;

type LegacyLeadStatus = keyof typeof LEGACY_LEAD_STATUS_ALIASES;
const LEAD_STATUS_SET = new Set<string>(LEAD_STATUSES);

export const LEAD_OUTCOMES = [
    "open",
    "won",
    "lost",
    "cancelled"
]

export type LeadStatus = typeof LEAD_STATUSES[number];
export type LeadOutcome = typeof LEAD_OUTCOMES[number];
export type LeadRegion = typeof LEAD_REGIONS[number];
export function normalizeLeadStatus(statusRaw: unknown): LeadStatus {
    const status = String(statusRaw ?? "").trim();
    if (!status) return "Lead Captured";
    if (status in LEGACY_LEAD_STATUS_ALIASES) {
        return LEGACY_LEAD_STATUS_ALIASES[status as LegacyLeadStatus];
    }
    if (LEAD_STATUS_SET.has(status)) {
        return status as LeadStatus;
    }
    return "Lead Captured";
}

/** Preset industry labels for UI dropdowns; custom values still allowed via "Other". */
export const LEAD_INDUSTRY_PRESETS = [
    "Technology",
    "Healthcare",
    "Financial Services",
    "Manufacturing",
    "Retail",
] as const;
