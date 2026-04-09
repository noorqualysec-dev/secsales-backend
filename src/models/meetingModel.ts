export interface IMeeting {
    id?: string;
    title: string;
    from: number; // Start timestamp
    to: number; // End timestamp
    status: "Scheduled" | "Completed" | "Cancelled";
    assignedTo: string; // Sales Rep ID
    leadId: string; // Lead ID
    createdAt: number;
    updatedAt: number;
    googleEventId?: string;
    meetLink?: string | null;
    syncStatus?: "synced" | "pending" | "failed";
}

export const MEETING_STATUSES = ["Scheduled", "Completed", "Cancelled"] as const;
