import type { ExcelLeadRow } from "./leadImport.types.js";
import type { ILead, ITimelineEvent, LeadOutcome, LeadStatus } from "../models/leadModel.ts";

type RowObject = Record<string, unknown>;

function cleanText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

function getFirstFilled(row: ExcelLeadRow, keys: string[]): unknown {
  const record = row as RowObject;
  for (const key of keys) {
    const value = record[key];
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return undefined;
}

function splitName(fullName?: string): { firstName: string; lastName: string } {
  const clean = cleanText(fullName);
  if (!clean) return { firstName: "Unknown", lastName: "Lead" };

  const parts = clean.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] || "Unknown", lastName: "Lead" };

  return {
    firstName: parts[0] || "Unknown",
    lastName: parts.slice(1).join(" "),
  };
}

function parseCurrency(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const cleaned = String(value).replace(/[^0-9.-]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : undefined;
}

function toTimestamp(value: unknown): number | undefined {
  if (!value) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const date = value instanceof Date ? value : new Date(String(value));
  const ts = date.getTime();
  return Number.isFinite(ts) ? ts : undefined;
}

function mapEmployeeStrength(value: unknown): ILead["employeeStrength"] | undefined {
  const text = cleanText(value);
  if (text && ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"].includes(text)) {
    return text as ILead["employeeStrength"];
  }

  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n <= 10) return "1-10";
  if (n <= 50) return "11-50";
  if (n <= 200) return "51-200";
  if (n <= 500) return "201-500";
  if (n <= 1000) return "501-1000";
  return "1000+";
}

const STAGE_MAP: Record<string, LeadStatus> = {
  Lead: "Lead Captured",
  "Lead Captured": "Lead Captured",
  "Qualification Call": "Discovery Call Scheduled",
  "Discovery Call": "Discovery Call Scheduled",
  "Discovery Call Scheduled": "Discovery Call Scheduled",
  "Requirement Gathering": "Requirement Gathering",
  "Pre-Assessment Form Sent": "Requirement Gathering",
  "Proposal Preparation": "Proposal Sent",
  "Proposal Sent": "Proposal Sent",
  Negotiation: "Negotiation",
  Won: "Negotiation",
  Lost: "Negotiation",
};

const OUTCOME_MAP: Record<string, LeadOutcome> = {
  Won: "won",
  Lost: "lost",
  Cancelled: "cancelled",
  Open: "open",
  "In Progress": "open",
  Pending: "open",
  "Lead Captured": "open",
  "Discovery Call Scheduled": "open",
  "Requirement Gathering": "open",
  "Pre-Assessment Form Sent": "open",
  "Proposal Preparation": "open",
  "Proposal Sent": "open",
  Negotiation: "open",
};

const SOURCE_MAP: Record<string, ILead["source"]> = {
  "organic search": "website",
  website: "website",
  linkedin: "linkedin",
  referral: "referral",
  event: "events",
  events: "events",
  "email marketing": "email_marketing",
  email_marketing: "email_marketing",
  partnership: "partnership",
  offline: "offline_source",
  offline_source: "offline_source",
  recurring: "recurring",
  other: "other",
};

function normalizeStatus(stageRaw?: string): LeadStatus {
  const stage = cleanText(stageRaw);
  if (!stage) return "Lead Captured";
  return STAGE_MAP[stage] || "Lead Captured";
}

function normalizeOutcome(outcomeRaw?: string, stageRaw?: string): LeadOutcome {
  const outcome = cleanText(outcomeRaw);
  if (outcome && OUTCOME_MAP[outcome]) return OUTCOME_MAP[outcome];

  const stage = cleanText(stageRaw);
  if (stage && OUTCOME_MAP[stage]) return OUTCOME_MAP[stage];

  return "open";
}

function normalizeSource(sourceRaw?: string): ILead["source"] {
  const key = cleanText(sourceRaw)?.toLowerCase();
  if (!key) return "other";
  return SOURCE_MAP[key] || "other";
}

function buildInitialTimeline(
  createdBy: string,
  createdAt: number,
  status: LeadStatus,
  outcome: LeadOutcome
): ITimelineEvent[] {
  return [
    {
      event: "Creation",
      status,
      outcome,
      performedBy: createdBy,
      timestamp: createdAt,
    },
  ];
}

export function mapExcelRowToLead(row: ExcelLeadRow, createdBy: string, assignedTo?: string): ILead {
  const now = Date.now();

  const fallbackName = splitName(cleanText(getFirstFilled(row, ["Contact Person"])) || "");
  const firstName = cleanText(getFirstFilled(row, ["First Name"])) || fallbackName.firstName;
  const lastName = cleanText(getFirstFilled(row, ["Last Name"])) || fallbackName.lastName;

  const stageRaw = cleanText(getFirstFilled(row, ["Stage", "Status"]));
  const outcomeRaw = cleanText(getFirstFilled(row, ["Outcome", "Status"]));
  const sourceRaw = cleanText(getFirstFilled(row, ["Lead Source", "Source"]));

  const status = normalizeStatus(stageRaw);
  const outcome = normalizeOutcome(outcomeRaw, stageRaw);
  const source = normalizeSource(sourceRaw);

  const createdAt = toTimestamp(getFirstFilled(row, ["Date"])) || now;
  const updatedAt = now;
  const closingDate = toTimestamp(getFirstFilled(row, ["Close Date", "Closing Date"]));
  const followupDate = toTimestamp(getFirstFilled(row, ["Followup Date", "Follow Up Date"]));

  const designation = cleanText(getFirstFilled(row, ["Position", "Designation"]));
  const phone = cleanText(getFirstFilled(row, ["Phone"]));
  const company = cleanText(getFirstFilled(row, ["Company"]));
  const country = cleanText(getFirstFilled(row, ["Country"]));
  const industry = cleanText(getFirstFilled(row, ["Industrial Vertical", "Industry Vertical", "Industry"]));
  const email = cleanText(getFirstFilled(row, ["Email"]));
  const employeeStrength = mapEmployeeStrength(getFirstFilled(row, ["Employee Count", "Employee Strength"]));
  const dealValue = parseCurrency(getFirstFilled(row, ["Deal Value"]));

  const notes = [
    getFirstFilled(row, ["Notes", "Remarks"]),
    getFirstFilled(row, ["Notes2", "Note 2"]),
    getFirstFilled(row, ["Notes3", "Note 3"]),
  ]
    .map((v) => cleanText(v))
    .filter((v): v is string => Boolean(v))
    .join(" | ");

  const dealName = cleanText(getFirstFilled(row, ["Deal Name"]));
  const latestRemarkParts = [dealName ? `Deal: ${dealName}` : undefined, notes || undefined]
    .filter((v): v is string => Boolean(v))
    .join(" | ");

  const lead: ILead = {
    firstName,
    lastName,
    email: email || "",
    status,
    outcome,
    source,
    createdBy,
    timeline: buildInitialTimeline(createdBy, createdAt, status, outcome),
    createdAt,
    updatedAt,
    lastActivityAt: createdAt,
    wasEverWon: outcome === "won",
  };

  if (designation) lead.designation = designation;
  if (employeeStrength) lead.employeeStrength = employeeStrength;
  if (phone) lead.phone = phone;
  if (company) lead.company = company;
  if (country) lead.country = country;
  if (industry) lead.industry = industry;
  if (assignedTo) lead.assignedTo = assignedTo;
  if (closingDate) lead.closingDate = closingDate;
  if (dealValue !== undefined) lead.dealValue = dealValue;
  if (latestRemarkParts) lead.latestRemark = latestRemarkParts;
  if (followupDate) lead.nextReminderDueAt = followupDate;

  if (outcome === "won") {
    lead.wonAtStatus = status;
    lead.closedAt = closingDate || updatedAt;
  }

  if (outcome === "lost") {
    lead.lostAtStatus = status;
    lead.closedAt = closingDate || updatedAt;
  }

  if (outcome === "cancelled") {
    lead.closedAt = closingDate || updatedAt;
  }

  return lead;
}
