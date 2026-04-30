import type { Response } from "express";
import { rtdb } from "../config/firebase.js";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { LEAD_REGIONS, LEAD_STATUSES, normalizeLeadStatus } from "../models/leadModel.js";
import type { ILead, LeadContact, LeadOutcome, LeadStatus, LeadRegion } from "../models/leadModel.js";
import { canAccessAllLeads } from "../utils/roles.js";
import { v4 as uuidv4 } from "uuid";

const LEADS_PATH = "leads";
const USERS_PATH = "users";
const PROPOSALS_PATH = "proposals";

const DIAL_CODE_RE = /^\+\d{1,4}$/;
const NATIONAL_PHONE_RE = /^\d{4,15}$/;
const COMPANY_KEY_RE = /[^a-z0-9]+/g;
const CLOSED_OUTCOME_STATUSES = new Set(["Won", "Lost"]);
const LEGACY_OPEN_STATUSES = new Set<string>([
    ...LEAD_STATUSES,
    "Pre-Assessment Form Sent",
    "Proposal Preparation",
]);
const VALID_OUTCOMES = new Set<LeadOutcome>(["open", "won", "lost", "cancelled"]);
const VALID_REGIONS = new Set<string>(LEAD_REGIONS);

function normalizeCompanyName(value: unknown): string {
    return String(value ?? "").trim().replace(/\s+/g, " ");
}

function companyToKey(company: string): string {
    return company.trim().toLowerCase().replace(COMPANY_KEY_RE, "-").replace(/^-+|-+$/g, "");
}

/** When both inputs empty after trim, returns empty strings (clear phone). Otherwise validates pair. */
function normalizePhonePair(
    codeRaw: unknown,
    phoneRaw: unknown
): { error: string } | { phoneCountryCode: string; phone: string } {
    const code0 = String(codeRaw ?? "").trim();
    const phone0 = String(phoneRaw ?? "").trim();
    const hasAny = code0.length > 0 || phone0.length > 0;
    if (!hasAny) {
        return { phoneCountryCode: "", phone: "" };
    }
    if (!code0 || !phone0) {
        return { error: "Country calling code and national phone number must both be provided together." };
    }
    if (/[a-zA-Z]/.test(phone0)) {
        return { error: "Phone number must contain digits only (no letters)." };
    }
    if (!DIAL_CODE_RE.test(code0)) {
        return { error: "Invalid country calling code." };
    }
    if (!NATIONAL_PHONE_RE.test(phone0)) {
        return { error: "Phone must be between 4 and 15 digits." };
    }
    return { phoneCountryCode: code0, phone: phone0 };
}

function normalizeIndustry(indRaw: unknown): { error: string } | { industry: string | undefined } {
    if (indRaw === undefined || indRaw === null) {
        return { industry: undefined };
    }
    const s = String(indRaw).trim();
    if (s.length > 120) {
        return { error: "Industry must be at most 120 characters." };
    }
    return { industry: s || undefined };
}

function applyNormalizedPhoneToLeadData(leadData: Partial<ILead>, norm: { phoneCountryCode: string; phone: string }) {
    if (!norm.phoneCountryCode && !norm.phone) {
        delete leadData.phoneCountryCode;
        leadData.phone = "";
    } else {
        leadData.phoneCountryCode = norm.phoneCountryCode;
        leadData.phone = norm.phone;
    }
}

function normalizeShortText(value: unknown, max = 160): string | undefined {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) return undefined;
    return cleaned.slice(0, max);
}

function normalizeLongText(value: unknown, max = 1000): string | undefined {
    const cleaned = String(value ?? "").trim();
    if (!cleaned) return undefined;
    return cleaned.slice(0, max);
}

function normalizeCompanyInsights(raw: unknown): ILead["companyInsights"] | undefined {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    const record = raw as Record<string, unknown>;
    const hiringSignal = normalizeShortText(record.hiringSignal, 180);
    const recentTrigger = normalizeShortText(record.recentTrigger, 180);
    const nextOpportunity = normalizeShortText(record.nextOpportunity, 180);
    const accountNotes = normalizeLongText(record.accountNotes, 1500);

    const insights: NonNullable<ILead["companyInsights"]> = {};
    if (hiringSignal) insights.hiringSignal = hiringSignal;
    if (recentTrigger) insights.recentTrigger = recentTrigger;
    if (nextOpportunity) insights.nextOpportunity = nextOpportunity;
    if (accountNotes) insights.accountNotes = accountNotes;

    return Object.keys(insights).length ? insights : undefined;
}

function normalizeContact(raw: unknown, fallbackUserId: string): LeadContact | null {
    if (!raw || typeof raw !== "object") {
        return null;
    }

    const contact = raw as Record<string, unknown>;
    const firstName = String(contact.firstName ?? "").trim();
    const lastName = String(contact.lastName ?? "").trim();
    const email = String(contact.email ?? "").trim().toLowerCase();

    if (!firstName || !email) {
        return null;
    }

    const phoneNorm = normalizePhonePair(contact.phoneCountryCode, contact.phone);
    if ("error" in phoneNorm) {
        throw new Error(`Invalid phone for contact ${email}: ${phoneNorm.error}`);
    }

    const fullName = `${firstName} ${lastName}`.trim();
    const normalized: LeadContact = {
        id: String(contact.id ?? "").trim() || uuidv4(),
        firstName,
        lastName,
        fullName,
        email,
        addedAt: Number(contact.addedAt) || Date.now(),
        updatedAt: Date.now(),
        addedBy: String(contact.addedBy ?? "").trim() || fallbackUserId,
        isPrimary: Boolean(contact.isPrimary),
        isDecisionMaker: Boolean(contact.isDecisionMaker),
        isInfluencer: Boolean(contact.isInfluencer),
        isTechnicalContact: Boolean(contact.isTechnicalContact),
        isBillingContact: Boolean(contact.isBillingContact),
    };

    if (phoneNorm.phone) normalized.phone = phoneNorm.phone;
    if (phoneNorm.phoneCountryCode) normalized.phoneCountryCode = phoneNorm.phoneCountryCode;

    const designation = normalizeShortText(contact.designation);
    const department = normalizeShortText(contact.department);
    const linkedinUrl = normalizeShortText(contact.linkedinUrl, 300);
    const notes = normalizeLongText(contact.notes);
    const source = normalizeShortText(contact.source);
    const joinedOn = Number(contact.joinedOn) || undefined;
    const lastContactedAt = Number(contact.lastContactedAt) || undefined;
    const nextFollowUpAt = Number(contact.nextFollowUpAt) || undefined;
    const contactStatus = ["active", "inactive", "unresponsive", "left_company"].includes(String(contact.contactStatus ?? ""))
        ? (contact.contactStatus as LeadContact["contactStatus"])
        : undefined;
    const preferredChannel = ["email", "phone", "whatsapp", "linkedin"].includes(String(contact.preferredChannel ?? ""))
        ? (contact.preferredChannel as LeadContact["preferredChannel"])
        : undefined;
    const employmentStage = ["current", "joining_soon", "newly_joined"].includes(String(contact.employmentStage ?? ""))
        ? (contact.employmentStage as LeadContact["employmentStage"])
        : undefined;

    if (designation) normalized.designation = designation;
    if (department) normalized.department = department;
    if (linkedinUrl) normalized.linkedinUrl = linkedinUrl;
    if (notes) normalized.notes = notes;
    if (source) normalized.source = source;
    if (contactStatus) normalized.contactStatus = contactStatus;
    if (preferredChannel) normalized.preferredChannel = preferredChannel;
    if (employmentStage) normalized.employmentStage = employmentStage;
    if (joinedOn) normalized.joinedOn = joinedOn;
    if (lastContactedAt) normalized.lastContactedAt = lastContactedAt;
    if (nextFollowUpAt) normalized.nextFollowUpAt = nextFollowUpAt;

    return normalized;
}

function normalizeContacts(raw: unknown, fallbackUserId: string): LeadContact[] | undefined {
    if (!Array.isArray(raw)) {
        return undefined;
    }

    const contacts = raw
        .map((item) => normalizeContact(item, fallbackUserId))
        .filter((item): item is LeadContact => Boolean(item));

    return contacts.length ? contacts : [];
}

function normalizeRegion(regionRaw: unknown): { error: string } | { region: LeadRegion | undefined } {
    if (regionRaw === undefined || regionRaw === null || String(regionRaw).trim() === "") {
        return { region: undefined };
    }
    const region = String(regionRaw).trim();
    if (!VALID_REGIONS.has(region)) {
        return { error: "Invalid region selected." };
    }
    return { region: region as LeadRegion };
}

function getEffectiveLeadOutcome(lead: Partial<ILead>): LeadOutcome {
    if (lead.outcome && VALID_OUTCOMES.has(lead.outcome)) {
        return lead.outcome;
    }
    const status = String(lead.status ?? "");
    if (status === "Won") return "won";
    if (status === "Lost") return "lost";
    return "open";
}

function getLatestActiveStage(lead: Partial<ILead>): LeadStatus {
    if (lead.status && !CLOSED_OUTCOME_STATUSES.has(lead.status)) {
        return normalizeLeadStatus(lead.status);
    }
    if (lead.lostAtStatus) return normalizeLeadStatus(lead.lostAtStatus);
    if (lead.wonAtStatus) return normalizeLeadStatus(lead.wonAtStatus);
    return "Lead Captured";
}

function normalizeLeadStatusFields<T extends Partial<ILead>>(lead: T): T {
    const normalized = { ...lead } as T & Record<string, unknown>;
    const status = String(lead.status ?? "").trim();
    if (status && !CLOSED_OUTCOME_STATUSES.has(status)) {
        normalized.status = normalizeLeadStatus(status);
    }
    if (lead.lostAtStatus) {
        normalized.lostAtStatus = normalizeLeadStatus(lead.lostAtStatus);
    }
    if (lead.wonAtStatus) {
        normalized.wonAtStatus = normalizeLeadStatus(lead.wonAtStatus);
    }
    return normalized as T;
}

function buildPrimaryContactFromLead(leadId: string, lead: ILead) {
    const fullName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
    return {
        contactId: `lead-${leadId}`,
        leadId,
        fullName,
        firstName: lead.firstName || "",
        lastName: lead.lastName || "",
        email: lead.email || "",
        designation: lead.designation || "",
        phone: lead.phone || "",
        phoneCountryCode: lead.phoneCountryCode || "",
        status: lead.status,
        createdAt: lead.createdAt || 0,
        updatedAt: lead.updatedAt || 0,
        source: lead.source || "",
        type: "lead",
    };
}

// Helper for manual "population"
const populateRef = async (path: string, id: string, fields: string[]) => {
    if (!id) return null;
    const snapshot = await rtdb.ref(`${path}/${id}`).once("value");
    if (!snapshot.exists()) return null;
    const data = snapshot.val();
    const result: any = { _id: snapshot.key };
    fields.forEach(f => { result[f] = data?.[f]; });
    return result;
};

// Helper to "populate" user data manually for simplicity
const populateUser = async (userId: string) => {
    if (!userId) return null;
    const snapshot = await rtdb.ref(`${USERS_PATH}/${userId}`).once("value");
    if (!snapshot.exists()) return null;
    const data = snapshot.val();
    return { _id: snapshot.key, name: data?.name, email: data?.email };
};

const getUserIdentityCandidates = (user: any): string[] => {
  const ids = [user?.id, user?._id, user?.uid, user?.legacyUid]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(ids));
};

const canUserAccessLead = (lead: Partial<ILead>, user: any): boolean => {
  const userIds = new Set(getUserIdentityCandidates(user));
  if (!userIds.size) return false;

  const assignedTo = String(lead.assignedTo ?? "").trim();
  const createdBy = String(lead.createdBy ?? "").trim();

  // Primary rule: when assignment exists, visibility is strictly by assignee.
  if (assignedTo) return userIds.has(assignedTo);

  // Legacy fallback: only use creator-based access if assignment is missing.
  if (createdBy) return userIds.has(createdBy);
  return false;
};

const getScopedLeadsMap = async (user: any, role: string | null | undefined): Promise<Record<string, ILead>> => {
  const snapshot = await rtdb.ref(LEADS_PATH).orderByChild("createdAt").once("value");
  if (!snapshot.exists()) return {};

  const allLeadsRaw = snapshot.val() as Record<string, ILead>;
  const allLeads = Object.fromEntries(
    Object.entries(allLeadsRaw).map(([leadId, lead]) => [leadId, normalizeLeadStatusFields(lead)])
  ) as Record<string, ILead>;
  if (canAccessAllLeads(role)) return allLeads;

  const scoped: Record<string, ILead> = {};
  for (const [leadId, lead] of Object.entries(allLeads)) {
    if (!lead) continue;
    if (canUserAccessLead(lead, user)) {
      scoped[leadId] = lead;
    }
  }
  return scoped;
};

// @desc    Get all leads
export const getLeads = async (req: AuthRequest, res: Response) => {
  try {
    const leadsData = await getScopedLeadsMap(req.user, req.user?.role);

    if (!Object.keys(leadsData).length) {
        res.status(200).json({ success: true, count: 0, data: [] });
        return;
    }

    const rawLeads = await Promise.all(
      Object.entries(leadsData).map(async ([key, data]) => {
        if (!data) return null;
        return {
          _id: key,
          ...data,
          assignedTo: await populateUser(data.assignedTo || ""),
          createdBy: await populateUser(data.createdBy || ""),
        };
      })
    );
    const leads = rawLeads.filter((lead): lead is NonNullable<typeof lead> => Boolean(lead));

    // RTDB orderByChild is ascending by default, we want descending
    leads.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    res.status(200).json({ success: true, count: leads.length, data: leads });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCompanies = async (req: AuthRequest, res: Response) => {
  try {
    const leadsData = await getScopedLeadsMap(req.user, req.user?.role);

    if (!Object.keys(leadsData).length) {
      res.status(200).json({ success: true, count: 0, data: [] });
      return;
    }

    const companies = new Map<string, any>();

    for (const [leadId, lead] of Object.entries(leadsData)) {
      const companyName = normalizeCompanyName(lead.company);
      if (!companyName) continue;

      const key = companyToKey(companyName);
      const existing = companies.get(key) || {
        key,
        name: companyName,
        industry: lead.industry || "",
        country: lead.country || "",
        employeeStrength: lead.employeeStrength || "",
        leadCount: 0,
        memberCount: 0,
        openOpportunities: 0,
        lastUpdatedAt: 0,
        owners: new Map<string, string>(),
      };

      existing.leadCount += 1;
      existing.memberCount += 1 + (lead.contacts?.length || 0);
      if (getEffectiveLeadOutcome(lead) === "open") {
        existing.openOpportunities += 1;
      }
      existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, lead.updatedAt || lead.createdAt || 0);
      if (!existing.industry && lead.industry) existing.industry = lead.industry;
      if (!existing.country && lead.country) existing.country = lead.country;
      if (!existing.employeeStrength && lead.employeeStrength) existing.employeeStrength = lead.employeeStrength;
      if (lead.assignedTo) {
        const owner = await populateUser(lead.assignedTo);
        if (owner?._id) {
          existing.owners.set(owner._id, owner.name || owner.email || "Unknown");
        }
      }

      companies.set(key, existing);
    }

    const data = Array.from(companies.values())
      .map((item) => ({
        key: item.key,
        name: item.name,
        industry: item.industry || undefined,
        country: item.country || undefined,
        employeeStrength: item.employeeStrength || undefined,
        leadCount: item.leadCount,
        memberCount: item.memberCount,
        openOpportunities: item.openOpportunities,
        lastUpdatedAt: item.lastUpdatedAt,
        owners: Array.from(item.owners.entries() as Iterable<[string, string]>).map(([id, name]) => ({ _id: id, name })),
      }))
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt || a.name.localeCompare(b.name));

    res.status(200).json({ success: true, count: data.length, data });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCompanyDetails = async (req: AuthRequest, res: Response) => {
  try {
    const companyKey = String(req.params.companyKey || "").trim().toLowerCase();
    if (!companyKey) {
      res.status(400).json({ success: false, message: "Company key is required" });
      return;
    }

    const leadsData = await getScopedLeadsMap(req.user, req.user?.role);

    if (!Object.keys(leadsData).length) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }

    const matching = Object.entries(leadsData).filter(([, lead]) => companyToKey(normalizeCompanyName(lead.company)) === companyKey);

    if (!matching.length) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }

    const leads = await Promise.all(matching.map(async ([leadId, lead]) => ({
      _id: leadId,
      ...lead,
      assignedTo: await populateUser(lead.assignedTo || ""),
      createdBy: await populateUser(lead.createdBy || ""),
      members: [
        buildPrimaryContactFromLead(leadId, lead),
        ...((lead.contacts || []).map((contact) => ({
          contactId: contact.id,
          leadId,
          fullName: contact.fullName || `${contact.firstName} ${contact.lastName}`.trim(),
          firstName: contact.firstName,
          lastName: contact.lastName,
          email: contact.email,
          designation: contact.designation || "",
          department: contact.department || "",
          phone: contact.phone || "",
          phoneCountryCode: contact.phoneCountryCode || "",
          status: contact.contactStatus || "active",
          source: contact.source || "",
          type: "contact",
          preferredChannel: contact.preferredChannel,
          employmentStage: contact.employmentStage,
          joinedOn: contact.joinedOn,
          notes: contact.notes || "",
          updatedAt: contact.updatedAt || lead.updatedAt || lead.createdAt || 0,
          createdAt: contact.addedAt || lead.createdAt || 0,
        }))),
      ],
    })));

    leads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const baseLead = leads[0];
    if (!baseLead) {
      res.status(404).json({ success: false, message: "Company not found" });
      return;
    }
    const members = leads
      .flatMap((lead) => lead.members)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    res.status(200).json({
      success: true,
      data: {
        key: companyKey,
        name: normalizeCompanyName(baseLead.company),
        industry: baseLead.industry || undefined,
        country: baseLead.country || undefined,
        employeeStrength: baseLead.employeeStrength || undefined,
        companyInsights: baseLead.companyInsights || undefined,
        leads,
        members,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Create new lead
// export const createLead = async (req: AuthRequest, res: Response) => {
//   try {
//     const leadData: Partial<ILead> = { ...req.body };

//     const phoneNorm = normalizePhonePair(leadData.phoneCountryCode, leadData.phone);
//     if ("error" in phoneNorm) {
//         res.status(400).json({ success: false, message: phoneNorm.error });
//         return;
//     }
//     applyNormalizedPhoneToLeadData(leadData, phoneNorm);

//     if (leadData.industry !== undefined && leadData.industry !== null) {
//         const indNorm = normalizeIndustry(leadData.industry);
//         if ("error" in indNorm) {
//             res.status(400).json({ success: false, message: indNorm.error });
//             return;
//         }
//         if (indNorm.industry !== undefined) {
//             leadData.industry = indNorm.industry;
//         } else {
//             delete leadData.industry;
//         }
//     }

//     leadData.createdBy = req.user.id;
//     if (req.user.role !== "admin" || !leadData.assignedTo) {
//       leadData.assignedTo = req.user.id;
//     }

//     leadData.timeline = [{
//         event: "Creation",
//         performedBy: req.user.id,
//         remark: req.body.latestRemark || "Lead manually entered into system",
//         timestamp: Date.now()
//     }];

//     leadData.status = leadData.status || "Lead Captured";
//     leadData.createdAt = Date.now();
//     leadData.updatedAt = Date.now();

//     const newLeadRef = rtdb.ref(LEADS_PATH).push();
//     await newLeadRef.set(leadData);

//     res.status(201).json({ success: true, data: { _id: newLeadRef.key, ...leadData } });
//   } catch (error: any) {
//     res.status(400).json({ success: false, message: error.message });
//   }
// };
export const createLead = async (req: AuthRequest, res: Response) => {
  try {
    const leadData: Partial<ILead> = { ...req.body };
    const FOLLOW_UP_DELAY_MS = 2 * 60 * 1000;

    const phoneNorm = normalizePhonePair(leadData.phoneCountryCode, leadData.phone);
    if ("error" in phoneNorm) {
      res.status(400).json({ success: false, message: phoneNorm.error });
      return;
    }
    applyNormalizedPhoneToLeadData(leadData, phoneNorm);

    if (leadData.industry !== undefined && leadData.industry !== null) {
      const indNorm = normalizeIndustry(leadData.industry);
      if ("error" in indNorm) {
        res.status(400).json({ success: false, message: indNorm.error });
        return;
      }
      if (indNorm.industry !== undefined) {
        leadData.industry = indNorm.industry;
      } else {
        delete leadData.industry;
      }
    }

    if (Object.prototype.hasOwnProperty.call(leadData, "region")) {
      const regionNorm = normalizeRegion(leadData.region);
      if ("error" in regionNorm) {
        res.status(400).json({ success: false, message: regionNorm.error });
        return;
      }
      if (regionNorm.region !== undefined) {
        leadData.region = regionNorm.region;
      } else {
        delete leadData.region;
      }
    }

    leadData.company = normalizeCompanyName(leadData.company);
    const normalizedContacts = normalizeContacts(req.body.contacts, req.user.id);
    const normalizedCompanyInsights = normalizeCompanyInsights(req.body.companyInsights);
    if (normalizedContacts !== undefined) leadData.contacts = normalizedContacts;
    if (normalizedCompanyInsights !== undefined) leadData.companyInsights = normalizedCompanyInsights;

    leadData.createdBy = req.user.id;
    if (!canAccessAllLeads(req.user?.role) || !leadData.assignedTo) {
      leadData.assignedTo = req.user.id;
    }

    const now = Date.now();

    leadData.timeline = [{
      event: "Creation",
      performedBy: req.user.id,
      remark: req.body.latestRemark || "Lead manually entered into system",
      timestamp: now
    }];

    leadData.status = normalizeLeadStatus(leadData.status);
    leadData.outcome = "open";
    leadData.createdAt = now;
    leadData.updatedAt = now;

    // Follow-up reminder fields
    leadData.lastActivityAt = now;
    leadData.lastReminderAt = null;
    leadData.followUpReminderCount = 0;
    leadData.nextReminderDueAt = now + FOLLOW_UP_DELAY_MS;

    const newLeadRef = rtdb.ref(LEADS_PATH).push();
    await newLeadRef.set(leadData);

    res.status(201).json({
      success: true,
      data: { _id: newLeadRef.key, ...leadData }
    });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

const VALID_SOURCES  = ["website","email_marketing","linkedin","referral","events","recurring","partnership","offline_source","other"];
const OWNER_EMAIL_FIELDS = ["Owner Email", "Owner E-mail", "OwnerEmail", "ownerEmail", "owner_email", "owner_email_address"];
const OWNER_NAME_FIELDS = ["Owner", "Owner Name", "Lead Owner", "Assigned To", "Assignee", "owner", "ownerName"];
const IMPORT_ASSIGNABLE_ROLES = new Set(["sales_rep", "manager"]);

type ImportAssignableUser = {
  id: string;
  name: string;
  email: string;
};

function normalizeImportEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeImportName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getFirstImportField(row: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

function isLikelyNameMatch(inputName: string, userName: string): boolean {
  if (!inputName || !userName) return false;
  if (inputName === userName) return true;
  if (userName.includes(inputName) || inputName.includes(userName)) return true;

  const inputTokens = inputName.split(" ").filter(Boolean);
  const userTokens = userName.split(" ").filter(Boolean);
  if (!inputTokens.length || !userTokens.length) return false;
  return inputTokens.some((token) => userTokens.some((u) => u.startsWith(token) || token.startsWith(u)));
}

async function getImportAssignableUsers() {
  const byEmail = new Map<string, ImportAssignableUser>();
  const byName = new Map<string, ImportAssignableUser[]>();
  const snapshot = await rtdb.ref(USERS_PATH).once("value");

  if (!snapshot.exists()) {
    return { byEmail, byName };
  }

  const users = snapshot.val() as Record<string, { name?: unknown; email?: unknown; role?: unknown; isActive?: unknown }>;
  for (const [id, user] of Object.entries(users)) {
    if (!user || user.isActive === false) continue;

    const role = String(user.role ?? "").trim().toLowerCase();
    if (role && !IMPORT_ASSIGNABLE_ROLES.has(role)) continue;

    const email = normalizeImportEmail(user.email);
    const name = String(user.name ?? "").trim();
    const normalizedName = normalizeImportName(name);
    if (!email && !normalizedName) continue;

    const mappedUser: ImportAssignableUser = { id, name, email };
    if (email && !byEmail.has(email)) {
      byEmail.set(email, mappedUser);
    }

    if (normalizedName) {
      const existing = byName.get(normalizedName) || [];
      existing.push(mappedUser);
      byName.set(normalizedName, existing);
    }
  }

  return { byEmail, byName };
}

function resolveImportAssigneeId(
  row: Record<string, unknown>,
  usersLookup: { byEmail: Map<string, ImportAssignableUser>; byName: Map<string, ImportAssignableUser[]> },
  fallbackUserId: string
): string | null {
  const ownerEmail = normalizeImportEmail(getFirstImportField(row, OWNER_EMAIL_FIELDS));
  const ownerNameRaw = getFirstImportField(row, OWNER_NAME_FIELDS);
  const ownerName = normalizeImportName(ownerNameRaw);

  if (ownerEmail) {
    const byEmail = usersLookup.byEmail.get(ownerEmail);
    if (!byEmail) return null;
    if (ownerName && !isLikelyNameMatch(ownerName, normalizeImportName(byEmail.name))) return null;
    return byEmail.id;
  }

  if (ownerName) {
    const exactMatches = usersLookup.byName.get(ownerName) || [];
    if (exactMatches.length === 1) return exactMatches[0]?.id || null;
    if (exactMatches.length > 1) return null;

    const fuzzyMatches: ImportAssignableUser[] = [];
    for (const users of usersLookup.byName.values()) {
      for (const user of users) {
        if (isLikelyNameMatch(ownerName, normalizeImportName(user.name))) {
          fuzzyMatches.push(user);
        }
      }
    }
    if (fuzzyMatches.length === 1) return fuzzyMatches[0]?.id || null;
    if (fuzzyMatches.length > 1) return null;
  }

  return fallbackUserId;
}

// @desc    Bulk import leads from CSV
export const bulkImportLeads = async (req: AuthRequest, res: Response) => {
  try {
    const { leads: rows } = req.body as { leads: any[] };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ success: false, message: "No leads provided" });
      return;
    }

    // Collect existing emails to skip duplicates
    const existingSnap = await rtdb.ref(LEADS_PATH).once("value");
    const existingEmails = new Set<string>();
    if (existingSnap.exists()) {
      Object.values(existingSnap.val() as Record<string, any>).forEach((l: any) => {
        if (l.email) existingEmails.add(l.email.toLowerCase().trim());
      });
    }
    const assignableUsers = await getImportAssignableUsers();

    let imported = 0;
    let skipped = 0;

    for (const rawRow of rows) {
      const row = rawRow as Record<string, unknown>;
      const email = normalizeImportEmail(row.email ?? row.Email);
      const firstName = String(row.firstName ?? row["First Name"] ?? "").trim();

      if (!firstName || !email) { skipped++; continue; }
      if (existingEmails.has(email)) { skipped++; continue; }

      const assigneeId = resolveImportAssigneeId(row, assignableUsers, req.user.id);
      if (!assigneeId) { skipped++; continue; }

      const ref = rtdb.ref(LEADS_PATH).push();
      const rawStatus = String(row.status ?? row.Status ?? "").trim();
      const normalizedStatus = LEGACY_OPEN_STATUSES.has(rawStatus)
        ? normalizeLeadStatus(rawStatus)
        : "Lead Captured";

      await ref.set({
        firstName:        String(row.firstName ?? row["First Name"] ?? ""),
        lastName:         String(row.lastName ?? row["Last Name"] ?? ""),
        email,
        phone:            String(row.phone ?? row.Phone ?? ""),
        designation:      String(row.designation ?? row.Position ?? ""),
        company:          String(row.company ?? row.Company ?? ""),
        industry:         String(row.industry ?? row["Industry Vertical"] ?? row["Industrial Vertical"] ?? ""),
        country:          String(row.country ?? row.Country ?? ""),
        region:           VALID_REGIONS.has(String(row.region ?? row.Region ?? "").trim()) ? String(row.region ?? row.Region).trim() : undefined,
        employeeStrength: String(row.employeeStrength ?? row["Employee Count"] ?? row["Employee Strength"] ?? ""),
        status:           normalizedStatus,
        outcome:          rawStatus === "Won" ? "won" : rawStatus === "Lost" ? "lost" : "open",
        wonAtStatus:      rawStatus === "Won" ? "Negotiation" : undefined,
        lostAtStatus:     rawStatus === "Lost" ? "Negotiation" : undefined,
        source:           VALID_SOURCES.includes(String(row.source ?? row["Lead Source"] ?? "").trim()) ? String(row.source ?? row["Lead Source"]).trim() : "other",
        dealValue:        Number(row.dealValue ?? row["Deal Value"]) || 0,
        closingDate:      Number(row.closingDate ?? row["Close Date"] ?? row["Closing Date"]) || 0,
        latestRemark:     String(row.latestRemark ?? row.Notes ?? ""),
        assignedTo:       assigneeId,
        createdBy:        req.user.id,
        timeline: [{
          event: "Creation",
          performedBy: req.user.id,
          remark: "Imported via CSV",
          timestamp: Date.now()
        }],
        closedAt:         row.status === "Won" || row.status === "Lost" ? Date.now() : undefined,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      existingEmails.add(email);
      imported++;
    }

    res.status(200).json({ success: true, data: { imported, skipped } });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get single lead
export const getLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const snapshot = await rtdb.ref(`${LEADS_PATH}/${id}`).once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;

      if (!canAccessAllLeads(req.user?.role) && !canUserAccessLead(lead, req.user)) {
      res.status(403).json({ success: false, message: "Not authorized to access this lead" });
      return;
    }

    const normalizedLead = normalizeLeadStatusFields(lead);

    const populatedLead = {
        _id: snapshot.key,
        ...normalizedLead,
        assignedTo: await populateUser(normalizedLead.assignedTo || ""),
        createdBy: await populateUser(normalizedLead.createdBy || ""),
        timeline: await Promise.all((normalizedLead.timeline || []).map(async event => ({
              ...event,
            performedBy: await populateUser(event.performedBy || "")
        })))
    };

    res.status(200).json({ success: true, data: populatedLead });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update lead
// export const updateLead = async (req: AuthRequest, res: Response) => {
//   try {
//     const id = req.params.id as string;
//     const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
//     const snapshot = await leadRef.once("value");

//     if (!snapshot.exists()) {
//       res.status(404).json({ success: false, message: "Lead not found" });
//       return;
//     }

//     const lead = snapshot.val() as ILead;

//     if (lead.assignedTo !== req.user.id && req.user.role !== "admin") {
//       res.status(403).json({ success: false, message: "Not authorized to update this lead" });
//       return;
//     }

//     const updates: any = { ...req.body, updatedAt: Date.now() };

//     const phoneKeysTouched = Object.prototype.hasOwnProperty.call(req.body, "phone")
//         || Object.prototype.hasOwnProperty.call(req.body, "phoneCountryCode");
//     if (phoneKeysTouched) {
//         const mergedCode = updates.phoneCountryCode !== undefined
//             ? String(updates.phoneCountryCode ?? "").trim()
//             : String(lead.phoneCountryCode ?? "").trim();
//         const mergedPhone = updates.phone !== undefined
//             ? String(updates.phone ?? "").trim()
//             : String(lead.phone ?? "").trim();
//         const phoneNorm = normalizePhonePair(mergedCode, mergedPhone);
//         if ("error" in phoneNorm) {
//             res.status(400).json({ success: false, message: phoneNorm.error });
//             return;
//         }
//         applyNormalizedPhoneToLeadData(updates, phoneNorm);
//     } else {
//         delete updates.phone;
//         delete updates.phoneCountryCode;
//     }

//     if (updates.industry !== undefined) {
//         const indNorm = normalizeIndustry(updates.industry);
//         if ("error" in indNorm) {
//             res.status(400).json({ success: false, message: indNorm.error });
//             return;
//         }
//         updates.industry = indNorm.industry;
//     }

//     const timeline = [...(lead.timeline || [])];

//     if (updates.status && updates.status !== lead.status) {
//         timeline.push({
//             event: "Status Changed",
//             status: updates.status,
//             remark: updates.latestRemark || `Status updated to ${updates.status}`,
//             performedBy: req.user.id,
//             timestamp: Date.now()
//         });
//     } else if (updates.latestRemark) {
//         timeline.push({
//             event: "Remark Added",
//             status: lead.status,
//             remark: updates.latestRemark,
//             performedBy: req.user.id,
//             timestamp: Date.now()
//         });
//     }

//     updates.timeline = timeline;
//     delete updates.assignedTo;
//     delete updates.createdBy;

//     await leadRef.update(updates);
//     res.status(200).json({ success: true, message: "Lead updated successfully" });
//   } catch (error: any) {
//     res.status(400).json({ success: false, message: error.message });
//   }
// };
export const updateLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
    const snapshot = await leadRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;

    if (!canAccessAllLeads(req.user?.role) && !canUserAccessLead(lead, req.user)) {
      res.status(403).json({ success: false, message: "Not authorized to update this lead" });
      return;
    }

    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const updates: any = { ...req.body, updatedAt: now };
    const currentOutcome = getEffectiveLeadOutcome(lead);
    const currentStage = getLatestActiveStage(lead);

    const phoneKeysTouched =
      Object.prototype.hasOwnProperty.call(req.body, "phone") ||
      Object.prototype.hasOwnProperty.call(req.body, "phoneCountryCode");

    if (phoneKeysTouched) {
      const mergedCode = updates.phoneCountryCode !== undefined
        ? String(updates.phoneCountryCode ?? "").trim()
        : String(lead.phoneCountryCode ?? "").trim();

      const mergedPhone = updates.phone !== undefined
        ? String(updates.phone ?? "").trim()
        : String(lead.phone ?? "").trim();

      const phoneNorm = normalizePhonePair(mergedCode, mergedPhone);
      if ("error" in phoneNorm) {
        res.status(400).json({ success: false, message: phoneNorm.error });
        return;
      }
      applyNormalizedPhoneToLeadData(updates, phoneNorm);
    } else {
      delete updates.phone;
      delete updates.phoneCountryCode;
    }

    if (updates.industry !== undefined) {
      const indNorm = normalizeIndustry(updates.industry);
      if ("error" in indNorm) {
        res.status(400).json({ success: false, message: indNorm.error });
        return;
      }
      updates.industry = indNorm.industry;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "region")) {
      const regionNorm = normalizeRegion(req.body.region);
      if ("error" in regionNorm) {
        res.status(400).json({ success: false, message: regionNorm.error });
        return;
      }
      updates.region = regionNorm.region ?? null;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "company")) {
      updates.company = normalizeCompanyName(req.body.company);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "contacts")) {
      const normalizedContacts = normalizeContacts(req.body.contacts, req.user.id);
      updates.contacts = normalizedContacts ?? [];
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "companyInsights")) {
      const normalizedCompanyInsights = normalizeCompanyInsights(req.body.companyInsights);
      updates.companyInsights = normalizedCompanyInsights ?? null;
    }

    const timeline = [...(lead.timeline || [])];
    let meaningfulActivity = false;
    let nextStage = currentStage;
    let nextOutcome = currentOutcome;

    if (typeof updates.outcome === "string") {
      const normalizedOutcome = updates.outcome.trim().toLowerCase() as LeadOutcome;
      if (!VALID_OUTCOMES.has(normalizedOutcome)) {
        res.status(400).json({ success: false, message: "Invalid lead outcome." });
        return;
      }
      nextOutcome = normalizedOutcome;
    }

    const requestedStatus = typeof updates.status === "string" ? updates.status.trim() : "";
    const wantsLegacyLost = requestedStatus === "Lost";
    const wantsLegacyWon = requestedStatus === "Won";
    const wantsStageChange = requestedStatus.length > 0 && !CLOSED_OUTCOME_STATUSES.has(requestedStatus);

    if (wantsStageChange && !LEGACY_OPEN_STATUSES.has(requestedStatus)) {
      res.status(400).json({ success: false, message: "Invalid lead status." });
      return;
    }

    if (wantsLegacyLost) {
      nextOutcome = "lost";
      delete updates.status;
    } else if (wantsLegacyWon) {
      nextOutcome = "won";
      delete updates.status;
    } else if (wantsStageChange) {
      nextStage = normalizeLeadStatus(requestedStatus);
    }

    if (nextOutcome === "open" && currentOutcome !== "open") {
      updates.lostAtStatus = null;
      updates.wonAtStatus = null;
      updates.closedAt = null;
      timeline.push({
        event: "Reopened",
        status: nextStage,
        previousStatus: currentStage,
        outcome: nextOutcome,
        remark: updates.latestRemark || `Lead reopened at ${nextStage}`,
        performedBy: req.user.id,
        timestamp: now,
      });
      meaningfulActivity = true;
    }

    if (wantsStageChange && nextStage !== currentStage) {
      timeline.push({
        event: "Status Changed",
        status: nextStage,
        previousStatus: currentStage,
        outcome: nextOutcome,
        remark: updates.latestRemark || `Status updated to ${nextStage}`,
        performedBy: req.user.id,
        timestamp: now
      });
      meaningfulActivity = true;
    }

    if (nextOutcome !== currentOutcome && nextOutcome !== "open") {
      const stageAtClosure = nextStage;
      const event = nextOutcome === "won" ? "Won" : nextOutcome === "lost" ? "Lost" : "Cancelled";
      const closureReason = String(
        nextOutcome === "won"
          ? (updates.wonReason ?? "")
          : nextOutcome === "lost"
            ? (updates.lostReason ?? "")
            : (updates.cancellationReason ?? "")
      ).trim();
      const closureEvent: any = {
        event,
        status: stageAtClosure,
        previousStatus: currentStage,
        outcome: nextOutcome,
        remark: updates.latestRemark || `Lead marked ${nextOutcome} at ${stageAtClosure}`,
        performedBy: req.user.id,
        timestamp: now
      };
      if (closureReason) {
        closureEvent.reason = closureReason;
      }
      timeline.push(closureEvent);
      meaningfulActivity = true;
      updates.closedAt = now;
      if (nextOutcome === "won") {
        updates.wonAtStatus = stageAtClosure;
        updates.lostAtStatus = null;
        updates.wasEverWon = true;
      } else if (nextOutcome === "lost") {
        updates.lostAtStatus = stageAtClosure;
        updates.wonAtStatus = null;
      } else {
        updates.wonAtStatus = null;
        updates.lostAtStatus = null;
      }
    } else if (updates.latestRemark) {
      timeline.push({
        event: "Remark Added",
        status: nextStage,
        outcome: nextOutcome,
        remark: updates.latestRemark,
        performedBy: req.user.id,
        timestamp: now
      });
      meaningfulActivity = true;
    }

    if (meaningfulActivity) {
      updates.lastActivityAt = now;
      updates.nextReminderDueAt = now + TWO_DAYS_MS;
    }

    updates.status = nextStage;
    updates.outcome = nextOutcome;
    updates.timeline = timeline;
    delete updates.assignedTo;
    delete updates.createdBy;

    await leadRef.update(updates);
    res.status(200).json({ success: true, message: "Lead updated successfully" });
  } catch (error: any) {
    res.status(400).json({ success: false, message: error.message });
  }
};

// @desc    Delete lead
export const deleteLead = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id as string;
    const leadRef = rtdb.ref(`${LEADS_PATH}/${id}`);
    const snapshot = await leadRef.once("value");

    if (!snapshot.exists()) {
      res.status(404).json({ success: false, message: "Lead not found" });
      return;
    }

    const lead = snapshot.val() as ILead;
    if (!canAccessAllLeads(req.user?.role) && !canUserAccessLead(lead, req.user)) {
      res.status(403).json({ success: false, message: "Not authorized to delete this lead" });
      return;
    }

    await leadRef.remove();
    res.status(200).json({ success: true, message: "Lead removed" });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get full lead journey (details + timeline + proposals)
export const getLeadJourney = async (req: AuthRequest, res: Response) => {
    try {
        const id = req.params.id as string;
        
        // 1. Get Lead
        const leadSnapshot = await rtdb.ref(`${LEADS_PATH}/${id}`).once("value");
        if (!leadSnapshot.exists()) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }
        const leadData = normalizeLeadStatusFields(leadSnapshot.val() as ILead);

        // 2. Authorization Check
        if (!canAccessAllLeads(req.user?.role) && !canUserAccessLead(leadData as ILead, req.user)) {
            res.status(403).json({ success: false, message: "Not authorized to access this lead journey" });
            return;
        }

        // 3. Get Assigned User
        const assignedUser = await populateRef(USERS_PATH, leadData.assignedTo || "", ["name", "email", "role"]);

        // 4. Get Proposals for this lead
        const proposalsSnapshot = await rtdb.ref(PROPOSALS_PATH).orderByChild("lead").equalTo(id).once("value");
        const proposalsData = proposalsSnapshot.val() || {};
        const proposals = Object.entries(proposalsData).map(([key, val]: [string, any]) => ({
            _id: key,
            value: val.value,
            status: val.status,
            createdAt: val.createdAt
        }));

        // 5. Populate Timeline PerformedBy
        const timeline = await Promise.all((leadData.timeline || []).map(async (event: any) => ({
            ...event,
            performedBy: await populateRef(USERS_PATH, event.performedBy, ["name", "email"])
        })));

        res.status(200).json({
            success: true,
            data: {
                lead: { _id: id, ...leadData, timeline },
                assignedUser,
                proposals
            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
