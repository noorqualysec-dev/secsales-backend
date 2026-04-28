import XLSX from "xlsx";
import type { ExcelLeadRow } from "../imports/leadImport.types.js";
import { mapExcelRowToLead } from "../imports/leadImport.mapper.js";
import { rtdb } from "../config/firebase.js"; // adjust path if your firebase export path is different
import type { ILead } from "../models/leadModel.js";

const LEADS_PATH = "leads";
const USERS_PATH = "users";
const OWNER_EMAIL_KEYS = ["Owner Email", "Owner E-mail", "OwnerEmail"] as const;
const OWNER_NAME_KEYS = ["Owner", "Owner Name", "Lead Owner", "Assigned To", "Assignee"] as const;
const ASSIGNABLE_USER_ROLES = new Set(["sales_rep", "manager"]);

type RowObject = Record<string, unknown>;

interface ImportUser {
    id: string;
    name: string;
    email: string;
}

interface AssignableUserLookup {
    byEmail: Map<string, ImportUser>;
    byName: Map<string, ImportUser[]>;
}

export interface ImportFailedRow {
    rowNumber: number;
    reason: string;
    row: ExcelLeadRow;
}

export interface ImportLeadResult {
    success: boolean;
    totalRows: number;
    importedCount: number;
    failedCount: number;
    failedRows: ImportFailedRow[];
}

function parseExcelBuffer(buffer: Buffer): ExcelLeadRow[] {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
if (!sheetName) {
    throw new Error("Excel file has no sheets");
}

const sheet = workbook.Sheets[sheetName];
if (!sheet) {
    throw new Error("Unable to read first sheet from Excel file");
}

    const rows = XLSX.utils.sheet_to_json<ExcelLeadRow>(sheet, {
        defval: "",
    });

    return rows;
}

function validateMappedLead(lead: ILead): string | null {
    if (!lead.email) return "Missing email";
    if (!lead.firstName) return "Missing first name";
    if (!lead.lastName) return "Missing last name";
    if (!lead.status) return "Missing status";
    if (!lead.outcome) return "Missing outcome";
    if (!lead.source) return "Missing source";
    if (!lead.createdBy) return "Missing createdBy";
    return null;
}

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

function normalizeName(value: unknown): string {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function getFirstFilled(row: ExcelLeadRow, keys: readonly string[]): unknown {
    const record = row as RowObject;
    for (const key of keys) {
        const value = record[key];
        if (value === null || value === undefined) continue;
        if (typeof value === "string" && !value.trim()) continue;
        return value;
    }
    return undefined;
}

function isLikelySamePersonName(ownerName: string, userName: string): boolean {
    if (!ownerName || !userName) return true;
    if (ownerName === userName) return true;
    return ownerName.includes(userName) || userName.includes(ownerName);
}

async function getAssignableUsersLookup(): Promise<AssignableUserLookup> {
    const byEmail = new Map<string, ImportUser>();
    const byName = new Map<string, ImportUser[]>();

    const snapshot = await rtdb.ref(USERS_PATH).once("value");
    if (!snapshot.exists()) {
        return { byEmail, byName };
    }

    const users = snapshot.val() as Record<string, {
        name?: unknown;
        email?: unknown;
        role?: unknown;
        isActive?: unknown;
    }>;

    for (const [userId, user] of Object.entries(users)) {
        if (!user || user.isActive === false) continue;

        const role = String(user.role ?? "").trim().toLowerCase();
        if (role && !ASSIGNABLE_USER_ROLES.has(role)) continue;

        const normalizedEmail = normalizeEmail(user.email);
        const displayName = String(user.name ?? "").trim();
        const normalizedName = normalizeName(displayName);

        if (!normalizedEmail && !normalizedName) continue;

        const mappedUser: ImportUser = {
            id: userId,
            name: displayName,
            email: normalizedEmail,
        };

        if (normalizedEmail && !byEmail.has(normalizedEmail)) {
            byEmail.set(normalizedEmail, mappedUser);
        }

        if (normalizedName) {
            const existing = byName.get(normalizedName) || [];
            existing.push(mappedUser);
            byName.set(normalizedName, existing);
        }
    }

    return { byEmail, byName };
}

function resolveAssigneeForRow(
    row: ExcelLeadRow,
    currentUserId: string,
    usersLookup: AssignableUserLookup
): { userId: string } | { error: string } {
    const ownerEmail = normalizeEmail(getFirstFilled(row, OWNER_EMAIL_KEYS));
    const ownerNameRaw = String(getFirstFilled(row, OWNER_NAME_KEYS) ?? "").trim();
    const ownerName = normalizeName(ownerNameRaw);

    if (ownerEmail) {
        const user = usersLookup.byEmail.get(ownerEmail);
        if (!user) {
            return { error: `Owner email '${ownerEmail}' was not found in active sales reps/managers` };
        }
        if (ownerName && !isLikelySamePersonName(ownerName, normalizeName(user.name))) {
            return { error: `Owner '${ownerNameRaw}' does not match user name '${user.name}' for email '${ownerEmail}'` };
        }
        return { userId: user.id };
    }

    if (ownerName) {
        const matches = usersLookup.byName.get(ownerName) || [];
        if (matches.length === 1) {
            const matched = matches[0];
            if (!matched) {
                return { error: `Owner '${ownerNameRaw}' could not be resolved` };
            }
            return { userId: matched.id };
        }
        if (matches.length > 1) {
            return { error: `Owner '${ownerNameRaw}' matched multiple users. Please provide Owner Email.` };
        }
        return { error: `Owner '${ownerNameRaw}' was not found in active sales reps/managers` };
    }

    return { userId: currentUserId };
}

async function getExistingLeadEmails(): Promise<Set<string>> {
    const snapshot = await rtdb.ref(LEADS_PATH).once("value");
    const existingEmails = new Set<string>();

    if (!snapshot.exists()) return existingEmails;

    const leads = snapshot.val() as Record<string, ILead>;
    for (const lead of Object.values(leads)) {
        const email = normalizeEmail(lead.email);
        if (email) existingEmails.add(email);
    }

    return existingEmails;
}

export async function importLeadsFromExcelBuffer(
    fileBuffer: Buffer,
    currentUserId: string
): Promise<ImportLeadResult> {
    const rows = parseExcelBuffer(fileBuffer);

    const failedRows: ImportFailedRow[] = [];
    const validLeads: ILead[] = [];
    const existingEmails = await getExistingLeadEmails();
    const assignableUsersLookup = await getAssignableUsersLookup();

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        if (!row) {
            failedRows.push({
                rowNumber: i + 2,
                reason: "Row is empty or unreadable",
                row: {} as ExcelLeadRow,
            });
            continue;
        }

        try {
            const assigneeResolution = resolveAssigneeForRow(row, currentUserId, assignableUsersLookup);
            if ("error" in assigneeResolution) {
                failedRows.push({
                    rowNumber: i + 2,
                    reason: assigneeResolution.error,
                    row,
                });
                continue;
            }

            const lead = mapExcelRowToLead(row, currentUserId, assigneeResolution.userId);
            lead.assignedTo = assigneeResolution.userId;

            const normalizedEmail = normalizeEmail(lead.email);
            lead.email = normalizedEmail;

            const validationError = validateMappedLead(lead);
            if (validationError) {
                failedRows.push({
                    rowNumber: i + 2,
                    reason: validationError,
                    row,
                });
                continue;
            }

            if (existingEmails.has(normalizedEmail)) {
                failedRows.push({
                    rowNumber: i + 2,
                    reason: "Duplicate email",
                    row,
                });
                continue;
            }

            existingEmails.add(normalizedEmail);
            validLeads.push(lead);
        } catch (error) {
            failedRows.push({
                rowNumber: i + 2,
                reason: error instanceof Error ? error.message : "Unknown error",
                row,
            });
        }
    }

    for (const lead of validLeads) {
        await rtdb.ref(LEADS_PATH).push(lead);
    }

    return {
        success: true,
        totalRows: rows.length,
        importedCount: validLeads.length,
        failedCount: failedRows.length,
        failedRows,
    };
}
