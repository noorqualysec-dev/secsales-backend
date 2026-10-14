// export interface IMeeting {
//     id?: string;
//     title: string;
//     from: number; // Start timestamp
//     to: number; // End timestamp
//     status: "Scheduled" | "Completed" | "Cancelled";
//     assignedTo: string; // Sales Rep ID
//     leadId: string; // Lead ID
//     createdAt: number;
//     updatedAt: number;
//     googleEventId?: string;
//     meetLink?: string | null;
//     syncStatus?: "synced" | "pending" | "failed";
// }

// export const MEETING_STATUSES = ["Scheduled", "Completed", "Cancelled"] as const;
export type MeetingStatus = "Scheduled" | "Completed" | "Cancelled";
export type MeetingMode = "google_meet" | "zoom" | "phone" | "in_person" | "other";
export type MeetingSyncStatus = "pending" | "success" | "failed";
export type MeetingAttendeeType = "sales_rep" | "lead" | "external";
export type MeetingResponseStatus =
  | "needsAction"
  | "accepted"
  | "declined"
  | "tentative";

export interface IMeetingAttendee {
  email: string;
  name?: string;
  type?: MeetingAttendeeType;
  responseStatus?: MeetingResponseStatus;
}

export interface IMeeting {
  id?: string;

  subject: string;
  description?: string;
  agenda?: string;
  location?: string;
  meetingMode?: MeetingMode;

  startTime: number;
  endTime: number;

  status: MeetingStatus;
  assignedTo: string;
  leadId: string;
  createdBy: string;

  attendees?: IMeetingAttendee[];

  googleEventId?: string;
  googleEventLink?: string;
  meetLink?: string | null;
  syncStatus?: MeetingSyncStatus;
  syncError?: string | null;
  lastSyncedAt?: number;

  createdAt: number;
  updatedAt: number;
}

export const MEETING_STATUSES = [
  "Scheduled",
  "Completed",
  "Cancelled",
] as const;

export const MEETING_MODES = [
  "google_meet",
  "zoom",
  "phone",
  "in_person",
  "other",
] as const;

export const MEETING_SYNC_STATUSES = [
  "pending",
  "success",
  "failed",
] as const;

export const MEETING_ATTENDEE_TYPES = [
  "sales_rep",
  "lead",
  "external",
] as const;

export const MEETING_RESPONSE_STATUSES = [
  "needsAction",
  "accepted",
  "declined",
  "tentative",
] as const;