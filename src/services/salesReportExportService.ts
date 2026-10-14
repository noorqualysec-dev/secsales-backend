import XLSX from "xlsx";
import { rtdb } from "../config/firebase.js";
import { LEAD_STATUSES, normalizeLeadStatus } from "../models/leadModel.js";

const USERS_PATH = "users";
const LEADS_PATH = "leads";
const PROPOSALS_PATH = "proposals";
const CLOSED_LEAD_STATUSES = new Set(["Won", "Lost"]);
const COMBINED_REPORT_ROLE = "sales_rep";
const INDIVIDUAL_ALLOWED_ROLES = new Set(["sales_rep", "manager"]);
const SHEET_NAME_LIMIT = 31;

export type SalesReportPeriod = "current_month" | "last_3_months" | "custom";

export interface SalesReportRange {
    period: SalesReportPeriod;
    from: number;
    to: number;
    fromMonth: string;
    toMonth: string;
    label: string;
}

export interface WorkbookDownload {
    fileName: string;
    buffer: Buffer;
}

export class SalesReportValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SalesReportValidationError";
    }
}

export class SalesReportNotFoundError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SalesReportNotFoundError";
    }
}

interface ReportUser {
    _id: string;
    legacyUid: string;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
}

interface ReportLead {
    _id: string;
    firstName: string;
    lastName: string;
    email: string;
    company: string;
    country: string;
    source: string;
    assignedTo: string;
    status: string;
    outcome: string;
    dealValue: number;
    latestRemark: string;
    createdAt: number;
    updatedAt: number;
    closedAt: number;
}

interface ReportProposal {
    _id: string;
    leadId: string;
    createdBy: string;
    status: string;
    value: number;
    testingScope: string[];
    notes: string;
    createdAt: number;
    updatedAt: number;
}

interface UserPerformanceStats {
    totalLeads: number;
    openDeals: number;
    wonDeals: number;
    lostDeals: number;
    leadsByStatus: Record<string, number>;
    pipelineValue: number;
    revenue: number;
    totalProposals: number;
    acceptedProposals: number;
    acceptanceRate: number;
    proposalValue: number;
    winRate: number;
}

interface LoadedReportData {
    users: ReportUser[];
    leads: ReportLead[];
    proposals: ReportProposal[];
}

const monthTokenPattern = /^(\d{4})-(0[1-9]|1[0-2])$/;
const reportStatusHeaders = [...LEAD_STATUSES, "Won", "Lost"];

function readQueryValue(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? "").trim();
    return String(value ?? "").trim();
}

function toNumber(value: unknown): number {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : 0;
}

function parseTimestamp(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
        if (value <= 0) return 0;
        // Handle legacy UNIX-second values by normalizing to milliseconds.
        return value < 1_000_000_000_000 ? Math.round(value * 1000) : Math.round(value);
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return 0;

        const numericCandidate = Number(trimmed);
        if (Number.isFinite(numericCandidate)) {
            return parseTimestamp(numericCandidate);
        }

        const parsedDate = Date.parse(trimmed);
        return Number.isFinite(parsedDate) ? parsedDate : 0;
    }

    if (value && typeof value === "object") {
        const candidate = value as Record<string, unknown>;
        const secondsRaw = candidate.seconds ?? candidate._seconds;
        const nanosecondsRaw = candidate.nanoseconds ?? candidate._nanoseconds;
        const seconds = Number(secondsRaw);
        const nanoseconds = Number(nanosecondsRaw);

        if (Number.isFinite(seconds)) {
            const millisFromSeconds = seconds * 1000;
            const millisFromNanos = Number.isFinite(nanoseconds)
                ? Math.floor(nanoseconds / 1_000_000)
                : 0;
            return Math.round(millisFromSeconds + millisFromNanos);
        }
    }

    return 0;
}

function toText(value: unknown): string {
    return String(value ?? "").trim();
}

function toBoolean(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value.trim().toLowerCase() === "true";
    return Boolean(value);
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((item) => String(item ?? "").trim())
        .filter(Boolean);
}

function resolveEntityId(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "object") {
        const candidate = value as Record<string, unknown>;
        const id = candidate._id ?? candidate.id ?? candidate.uid;
        return typeof id === "string" ? id.trim() : "";
    }
    return "";
}

function createUserAliasMap(users: ReportUser[]): Map<string, string> {
    const aliasMap = new Map<string, string>();

    for (const user of users) {
        const aliases = [user._id, user.legacyUid, user.email.toLowerCase()];
        for (const alias of aliases) {
            const normalizedAlias = alias.trim();
            if (!normalizedAlias || aliasMap.has(normalizedAlias)) continue;
            aliasMap.set(normalizedAlias, user._id);
        }
    }

    return aliasMap;
}

function resolveCanonicalUserId(
    value: unknown,
    aliasMap: Map<string, string>
): string {
    const directId = resolveEntityId(value);
    if (directId && aliasMap.has(directId)) {
        return aliasMap.get(directId) || directId;
    }

    if (typeof value === "string") {
        const normalizedEmail = value.trim().toLowerCase();
        if (aliasMap.has(normalizedEmail)) {
            return aliasMap.get(normalizedEmail) || directId;
        }
    }

    if (value && typeof value === "object") {
        const candidate = value as Record<string, unknown>;
        const rawEmail = toText(candidate.email).toLowerCase();
        if (rawEmail && aliasMap.has(rawEmail)) {
            return aliasMap.get(rawEmail) || directId;
        }

        const rawUid = toText(candidate.uid);
        if (rawUid && aliasMap.has(rawUid)) {
            return aliasMap.get(rawUid) || directId;
        }
    }

    return directId;
}

function toMonthToken(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function parseMonthToken(monthTokenRaw: string): {
    token: string;
    label: string;
    start: number;
    end: number;
} | null {
    const token = monthTokenRaw.trim();
    const match = token.match(monthTokenPattern);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;

    const monthStart = new Date(year, month, 1, 0, 0, 0, 0).getTime();
    const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
    const label = new Date(year, month, 1).toLocaleDateString("en-IN", {
        year: "numeric",
        month: "long",
    });

    return {
        token,
        label,
        start: monthStart,
        end: monthEnd,
    };
}

function buildRangeLabel(fromLabel: string, toLabel: string): string {
    if (fromLabel === toLabel) return fromLabel;
    return `${fromLabel} - ${toLabel}`;
}

function buildCurrentMonthRange(): SalesReportRange {
    const currentMonth = parseMonthToken(toMonthToken(new Date()));
    if (!currentMonth) {
        throw new SalesReportValidationError("Unable to resolve current month for report.");
    }

    return {
        period: "current_month",
        from: currentMonth.start,
        to: currentMonth.end,
        fromMonth: currentMonth.token,
        toMonth: currentMonth.token,
        label: currentMonth.label,
    };
}

function buildLastThreeMonthsRange(): SalesReportRange {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const startMonth = parseMonthToken(toMonthToken(start));
    const endMonth = parseMonthToken(toMonthToken(now));

    if (!startMonth || !endMonth) {
        throw new SalesReportValidationError("Unable to resolve last 3 months for report.");
    }

    return {
        period: "last_3_months",
        from: startMonth.start,
        to: endMonth.end,
        fromMonth: startMonth.token,
        toMonth: endMonth.token,
        label: buildRangeLabel(startMonth.label, endMonth.label),
    };
}

function buildCustomRange(query: Record<string, unknown>): SalesReportRange {
    const month = readQueryValue(query.month);
    if (month) {
        const parsedMonth = parseMonthToken(month);
        if (!parsedMonth) {
            throw new SalesReportValidationError("Invalid month. Use YYYY-MM format.");
        }

        return {
            period: "custom",
            from: parsedMonth.start,
            to: parsedMonth.end,
            fromMonth: parsedMonth.token,
            toMonth: parsedMonth.token,
            label: parsedMonth.label,
        };
    }

    const fromMonth = readQueryValue(query.fromMonth);
    const toMonth = readQueryValue(query.toMonth) || fromMonth;

    if (!fromMonth) {
        throw new SalesReportValidationError(
            "Custom range requires `month` or `fromMonth` (YYYY-MM)."
        );
    }

    const parsedFromMonth = parseMonthToken(fromMonth);
    const parsedToMonth = parseMonthToken(toMonth);

    if (!parsedFromMonth || !parsedToMonth) {
        throw new SalesReportValidationError("Invalid custom month range. Use YYYY-MM format.");
    }

    if (parsedFromMonth.start > parsedToMonth.end) {
        throw new SalesReportValidationError("Custom month range is invalid: fromMonth is after toMonth.");
    }

    return {
        period: "custom",
        from: parsedFromMonth.start,
        to: parsedToMonth.end,
        fromMonth: parsedFromMonth.token,
        toMonth: parsedToMonth.token,
        label: buildRangeLabel(parsedFromMonth.label, parsedToMonth.label),
    };
}

export function parseSalesReportRange(query: Record<string, unknown>): SalesReportRange {
    const rawPeriod = readQueryValue(query.period).toLowerCase();
    if (!rawPeriod || rawPeriod === "current_month") {
        return buildCurrentMonthRange();
    }

    if (rawPeriod === "last_3_months") {
        return buildLastThreeMonthsRange();
    }

    if (rawPeriod === "custom") {
        return buildCustomRange(query);
    }

    throw new SalesReportValidationError(
        "Invalid period. Allowed values: current_month, last_3_months, custom."
    );
}

function isInRange(timestamp: number, range: SalesReportRange): boolean {
    return timestamp >= range.from && timestamp <= range.to;
}

function formatDate(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleDateString("en-IN", {
        year: "numeric",
        month: "short",
        day: "2-digit",
    });
}

function formatDateTime(timestamp: number): string {
    if (!timestamp || !Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleString("en-IN", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}

function sanitizeFileToken(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return slug || "user";
}

function clipSheetName(name: string): string {
    if (name.length <= SHEET_NAME_LIMIT) return name;
    return name.slice(0, SHEET_NAME_LIMIT);
}

function getLeadOutcome(lead: ReportLead): "open" | "won" | "lost" {
    const outcome = lead.outcome.toLowerCase();
    if (outcome === "won" || lead.status === "Won") return "won";
    if (outcome === "lost" || lead.status === "Lost") return "lost";
    return "open";
}

function getLeadStatusBucket(lead: ReportLead): string {
    const outcome = getLeadOutcome(lead);
    if (outcome === "won") return "Won";
    if (outcome === "lost") return "Lost";
    if (lead.status && !CLOSED_LEAD_STATUSES.has(lead.status)) {
        return normalizeLeadStatus(lead.status);
    }
    return "Lead Captured";
}

function createEmptyStats(): UserPerformanceStats {
    const leadsByStatus = Object.fromEntries(
        reportStatusHeaders.map((status) => [status, 0])
    ) as Record<string, number>;

    return {
        totalLeads: 0,
        openDeals: 0,
        wonDeals: 0,
        lostDeals: 0,
        leadsByStatus,
        pipelineValue: 0,
        revenue: 0,
        totalProposals: 0,
        acceptedProposals: 0,
        acceptanceRate: 0,
        proposalValue: 0,
        winRate: 0,
    };
}

function computeUserPerformanceStats(
    userId: string,
    leads: ReportLead[],
    proposals: ReportProposal[]
): UserPerformanceStats {
    const stats = createEmptyStats();

    const userLeads = leads.filter((lead) => lead.assignedTo === userId);
    const userProposals = proposals.filter((proposal) => proposal.createdBy === userId);

    for (const lead of userLeads) {
        const statusBucket = getLeadStatusBucket(lead);
        if (stats.leadsByStatus[statusBucket] === undefined) {
            stats.leadsByStatus[statusBucket] = 0;
        }
        stats.leadsByStatus[statusBucket] += 1;

        const outcome = getLeadOutcome(lead);
        if (outcome === "won") {
            stats.wonDeals += 1;
            stats.revenue += lead.dealValue;
        } else if (outcome === "lost") {
            stats.lostDeals += 1;
        } else {
            stats.openDeals += 1;
            stats.pipelineValue += lead.dealValue;
        }
    }

    stats.totalLeads = userLeads.length;
    stats.totalProposals = userProposals.length;
    stats.acceptedProposals = userProposals.filter(
        (proposal) => proposal.status === "Accepted"
    ).length;
    stats.proposalValue = userProposals
        .filter((proposal) => proposal.status === "Accepted")
        .reduce((sum, proposal) => sum + proposal.value, 0);

    if (stats.totalProposals > 0) {
        stats.acceptanceRate = Number(
            ((stats.acceptedProposals / stats.totalProposals) * 100).toFixed(1)
        );
    }

    const closedDeals = stats.wonDeals + stats.lostDeals;
    if (closedDeals > 0) {
        stats.winRate = Number(((stats.wonDeals / closedDeals) * 100).toFixed(1));
    }

    return stats;
}

function appendSheetFromRows(
    workbook: XLSX.WorkBook,
    sheetName: string,
    headers: string[],
    rows: Array<Record<string, unknown>>
): void {
    const values = rows.length
        ? rows.map((row) => headers.map((header) => row[header] ?? ""))
        : [headers.map((header, index) => (index === 0 ? "No records in selected period" : ""))];

    const sheet = XLSX.utils.aoa_to_sheet([headers, ...values]);
    XLSX.utils.book_append_sheet(workbook, sheet, clipSheetName(sheetName));
}

async function loadReportData(): Promise<LoadedReportData> {
    const [usersSnapshot, leadsSnapshot, proposalsSnapshot] = await Promise.all([
        rtdb.ref(USERS_PATH).once("value"),
        rtdb.ref(LEADS_PATH).once("value"),
        rtdb.ref(PROPOSALS_PATH).once("value"),
    ]);

    const usersRaw = (usersSnapshot.val() || {}) as Record<string, Record<string, unknown>>;
    const leadsRaw = (leadsSnapshot.val() || {}) as Record<string, Record<string, unknown>>;
    const proposalsRaw = (proposalsSnapshot.val() || {}) as Record<string, Record<string, unknown>>;

    const users: ReportUser[] = Object.entries(usersRaw).map(([id, value]) => ({
        _id: id,
        legacyUid: toText(value.uid),
        name: toText(value.name) || "Unnamed User",
        email: toText(value.email),
        role: toText(value.role) || "sales_rep",
        isActive: toBoolean(value.isActive),
    }));
    const userAliasMap = createUserAliasMap(users);

    const leads: ReportLead[] = Object.entries(leadsRaw).map(([id, value]) => ({
        _id: id,
        firstName: toText(value.firstName),
        lastName: toText(value.lastName),
        email: toText(value.email),
        company: toText(value.company),
        country: toText(value.country),
        source: toText(value.source),
        assignedTo: resolveCanonicalUserId(value.assignedTo, userAliasMap),
        status: toText(value.status),
        outcome: toText(value.outcome),
        dealValue: toNumber(value.dealValue),
        latestRemark: toText(value.latestRemark),
        createdAt: parseTimestamp(value.createdAt) || parseTimestamp(value.updatedAt),
        updatedAt: parseTimestamp(value.updatedAt),
        closedAt: parseTimestamp(value.closedAt),
    }));

    const proposals: ReportProposal[] = Object.entries(proposalsRaw).map(([id, value]) => ({
        _id: id,
        leadId: resolveEntityId(value.lead),
        createdBy: resolveCanonicalUserId(value.createdBy, userAliasMap),
        status: toText(value.status),
        value: toNumber(value.value),
        testingScope: normalizeStringArray(value.testingScope),
        notes: toText(value.notes),
        createdAt: parseTimestamp(value.createdAt) || parseTimestamp(value.updatedAt),
        updatedAt: parseTimestamp(value.updatedAt),
    }));

    return {
        users,
        leads,
        proposals,
    };
}

function createSummaryRows(
    reportType: string,
    range: SalesReportRange,
    userCount: number,
    leadCount: number,
    proposalCount: number,
    generatedAt: number
): Array<Record<string, unknown>> {
    return [
        { Metric: "Report Type", Value: reportType },
        { Metric: "Period", Value: range.label },
        { Metric: "From Month", Value: range.fromMonth },
        { Metric: "To Month", Value: range.toMonth },
        { Metric: "Range Start", Value: formatDate(range.from) },
        { Metric: "Range End", Value: formatDate(range.to) },
        { Metric: "Users Included", Value: userCount },
        { Metric: "Leads Included", Value: leadCount },
        { Metric: "Proposals Included", Value: proposalCount },
        { Metric: "Generated At", Value: formatDateTime(generatedAt) },
    ];
}

function buildRepMetricsRow(user: ReportUser, stats: UserPerformanceStats): Record<string, unknown> {
    return {
        "User ID": user._id,
        Name: user.name,
        Email: user.email,
        Role: user.role,
        Active: user.isActive ? "Yes" : "No",
        "Total Leads": stats.totalLeads,
        "Open Deals": stats.openDeals,
        "Won Deals": stats.wonDeals,
        "Lost Deals": stats.lostDeals,
        "Pipeline Value (INR)": stats.pipelineValue,
        "Revenue (INR)": stats.revenue,
        "Total Proposals": stats.totalProposals,
        "Accepted Proposals": stats.acceptedProposals,
        "Acceptance Rate (%)": stats.acceptanceRate,
        "Win Rate (%)": stats.winRate,
        "Lead Captured": stats.leadsByStatus["Lead Captured"] ?? 0,
        "Discovery Call Scheduled": stats.leadsByStatus["Discovery Call Scheduled"] ?? 0,
        "Requirement Gathering": stats.leadsByStatus["Requirement Gathering"] ?? 0,
        "Proposal Sent": stats.leadsByStatus["Proposal Sent"] ?? 0,
        Negotiation: stats.leadsByStatus.Negotiation ?? 0,
        Won: stats.leadsByStatus.Won ?? 0,
        Lost: stats.leadsByStatus.Lost ?? 0,
    };
}

function buildLeadDetailRow(
    lead: ReportLead,
    usersById: Map<string, ReportUser>
): Record<string, unknown> {
    const owner = usersById.get(lead.assignedTo);
    const leadName = `${lead.firstName} ${lead.lastName}`.trim() || "Unknown Lead";

    return {
        "Lead ID": lead._id,
        "Lead Name": leadName,
        Email: lead.email,
        Company: lead.company || "Individual",
        Country: lead.country,
        "Sales Owner": owner?.name || "Unassigned",
        "Owner Email": owner?.email || "",
        Stage: getLeadStatusBucket(lead),
        Outcome: getLeadOutcome(lead),
        "Deal Value (INR)": lead.dealValue,
        Source: lead.source,
        "Latest Remark": lead.latestRemark,
        "Created At": formatDateTime(lead.createdAt),
        "Closed At": formatDateTime(lead.closedAt),
        "Last Updated": formatDateTime(lead.updatedAt),
    };
}

function buildProposalDetailRow(
    proposal: ReportProposal,
    usersById: Map<string, ReportUser>,
    leadsById: Map<string, ReportLead>
): Record<string, unknown> {
    const creator = usersById.get(proposal.createdBy);
    const lead = leadsById.get(proposal.leadId);
    const leadName = lead ? `${lead.firstName} ${lead.lastName}`.trim() : "Unknown Lead";

    return {
        "Proposal ID": proposal._id,
        "Lead ID": proposal.leadId,
        "Lead Name": leadName || "Unknown Lead",
        "Sales Owner": creator?.name || "Unknown",
        "Owner Email": creator?.email || "",
        Status: proposal.status,
        "Value (INR)": proposal.value,
        "Testing Scope": proposal.testingScope.join(", "),
        Notes: proposal.notes,
        "Created At": formatDateTime(proposal.createdAt),
        "Last Updated": formatDateTime(proposal.updatedAt),
    };
}

function createWorkbookBuffer(workbook: XLSX.WorkBook): Buffer {
    return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

function buildRangeSlug(range: SalesReportRange): string {
    return range.fromMonth === range.toMonth
        ? range.fromMonth
        : `${range.fromMonth}_to_${range.toMonth}`;
}

export async function generateCombinedSalesRepReport(
    range: SalesReportRange
): Promise<WorkbookDownload> {
    const loaded = await loadReportData();

    const targetUsers = loaded.users
        .filter((user) => user.role === COMBINED_REPORT_ROLE)
        .sort((a, b) => a.name.localeCompare(b.name));

    const targetUserIds = new Set(targetUsers.map((user) => user._id));

    const filteredLeads = loaded.leads.filter(
        (lead) => targetUserIds.has(lead.assignedTo) && isInRange(lead.createdAt, range)
    );

    const filteredProposals = loaded.proposals.filter(
        (proposal) => targetUserIds.has(proposal.createdBy) && isInRange(proposal.createdAt, range)
    );

    const usersById = new Map(targetUsers.map((user) => [user._id, user]));
    const leadsById = new Map(filteredLeads.map((lead) => [lead._id, lead]));

    const repMetricRows = targetUsers.map((user) => {
        const stats = computeUserPerformanceStats(user._id, filteredLeads, filteredProposals);
        return buildRepMetricsRow(user, stats);
    });

    const leadDetailRows = filteredLeads
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((lead) => buildLeadDetailRow(lead, usersById));

    const proposalDetailRows = filteredProposals
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((proposal) => buildProposalDetailRow(proposal, usersById, leadsById));

    const generatedAt = Date.now();
    const workbook = XLSX.utils.book_new();

    appendSheetFromRows(
        workbook,
        "Summary",
        ["Metric", "Value"],
        createSummaryRows(
            "Combined sales rep performance report",
            range,
            targetUsers.length,
            filteredLeads.length,
            filteredProposals.length,
            generatedAt
        )
    );

    appendSheetFromRows(
        workbook,
        "Rep Metrics",
        [
            "User ID",
            "Name",
            "Email",
            "Role",
            "Active",
            "Total Leads",
            "Open Deals",
            "Won Deals",
            "Lost Deals",
            "Pipeline Value (INR)",
            "Revenue (INR)",
            "Total Proposals",
            "Accepted Proposals",
            "Acceptance Rate (%)",
            "Win Rate (%)",
            "Lead Captured",
            "Discovery Call Scheduled",
            "Requirement Gathering",
            "Proposal Sent",
            "Negotiation",
            "Won",
            "Lost",
        ],
        repMetricRows
    );

    appendSheetFromRows(
        workbook,
        "Lead Details",
        [
            "Lead ID",
            "Lead Name",
            "Email",
            "Company",
            "Country",
            "Sales Owner",
            "Owner Email",
            "Stage",
            "Outcome",
            "Deal Value (INR)",
            "Source",
            "Latest Remark",
            "Created At",
            "Closed At",
            "Last Updated",
        ],
        leadDetailRows
    );

    appendSheetFromRows(
        workbook,
        "Proposal Details",
        [
            "Proposal ID",
            "Lead ID",
            "Lead Name",
            "Sales Owner",
            "Owner Email",
            "Status",
            "Value (INR)",
            "Testing Scope",
            "Notes",
            "Created At",
            "Last Updated",
        ],
        proposalDetailRows
    );

    return {
        fileName: `sales_reps_report_${buildRangeSlug(range)}.xlsx`,
        buffer: createWorkbookBuffer(workbook),
    };
}

export async function generateIndividualSalesRepReport(
    userId: string,
    range: SalesReportRange
): Promise<WorkbookDownload> {
    const loaded = await loadReportData();

    const targetUser = loaded.users.find((user) => user._id === userId);
    if (!targetUser) {
        throw new SalesReportNotFoundError("Sales user not found.");
    }

    if (!INDIVIDUAL_ALLOWED_ROLES.has(targetUser.role)) {
        throw new SalesReportValidationError(
            "Individual report is allowed for sales reps and managers only."
        );
    }

    const filteredLeads = loaded.leads.filter(
        (lead) => lead.assignedTo === targetUser._id && isInRange(lead.createdAt, range)
    );
    const filteredProposals = loaded.proposals.filter(
        (proposal) => proposal.createdBy === targetUser._id && isInRange(proposal.createdAt, range)
    );

    const usersById = new Map< string, ReportUser>([[targetUser._id, targetUser]]);
    const leadsById = new Map(filteredLeads.map((lead) => [lead._id, lead]));
    const stats = computeUserPerformanceStats(targetUser._id, filteredLeads, filteredProposals);

    const leadDetailRows = filteredLeads
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((lead) => buildLeadDetailRow(lead, usersById));

    const proposalDetailRows = filteredProposals
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((proposal) => buildProposalDetailRow(proposal, usersById, leadsById));

    const generatedAt = Date.now();
    const workbook = XLSX.utils.book_new();

    appendSheetFromRows(
        workbook,
        "Summary",
        ["Metric", "Value"],
        [
            ...createSummaryRows(
                `${targetUser.name} performance report`,
                range,
                1,
                filteredLeads.length,
                filteredProposals.length,
                generatedAt
            ),
            { Metric: "Sales User", Value: targetUser.name },
            { Metric: "Sales Email", Value: targetUser.email },
            { Metric: "Sales Role", Value: targetUser.role },
            { Metric: "Total Leads", Value: stats.totalLeads },
            { Metric: "Open Deals", Value: stats.openDeals },
            { Metric: "Won Deals", Value: stats.wonDeals },
            { Metric: "Lost Deals", Value: stats.lostDeals },
            { Metric: "Pipeline Value (INR)", Value: stats.pipelineValue },
            { Metric: "Revenue (INR)", Value: stats.revenue },
            { Metric: "Total Proposals", Value: stats.totalProposals },
            { Metric: "Accepted Proposals", Value: stats.acceptedProposals },
            { Metric: "Proposal Value (INR)", Value: stats.proposalValue },
            { Metric: "Acceptance Rate (%)", Value: stats.acceptanceRate },
            { Metric: "Win Rate (%)", Value: stats.winRate },
        ]
    );

    appendSheetFromRows(
        workbook,
        "Pipeline Breakdown",
        ["Status", "Leads"],
        reportStatusHeaders.map((status) => ({
            Status: status,
            Leads: stats.leadsByStatus[status] ?? 0,
        }))
    );

    appendSheetFromRows(
        workbook,
        "Lead Details",
        [
            "Lead ID",
            "Lead Name",
            "Email",
            "Company",
            "Country",
            "Sales Owner",
            "Owner Email",
            "Stage",
            "Outcome",
            "Deal Value (INR)",
            "Source",
            "Latest Remark",
            "Created At",
            "Closed At",
            "Last Updated",
        ],
        leadDetailRows
    );

    appendSheetFromRows(
        workbook,
        "Proposal Details",
        [
            "Proposal ID",
            "Lead ID",
            "Lead Name",
            "Sales Owner",
            "Owner Email",
            "Status",
            "Value (INR)",
            "Testing Scope",
            "Notes",
            "Created At",
            "Last Updated",
        ],
        proposalDetailRows
    );

    const nameSlug = sanitizeFileToken(targetUser.name || targetUser._id);
    return {
        fileName: `sales_rep_${nameSlug}_${buildRangeSlug(range)}.xlsx`,
        buffer: createWorkbookBuffer(workbook),
    };
}
