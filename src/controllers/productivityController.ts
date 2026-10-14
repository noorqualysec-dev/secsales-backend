import type { Response } from "express";
import { Types } from "mongoose";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { mongoStore } from "../config/mongoCompat.js";
import { MeetingGoogleSyncService } from "../services/meetingGoogleSyncService.js";
import {
    MEETING_STATUSES,
    type IMeeting,
    type IMeetingAttendee,
    type MeetingMode,
    type MeetingStatus,
} from "../models/meetingModel.js";
import { TASK_PRIORITIES, TASK_STATUSES, type ITask, type TaskSource } from "../models/taskModel.js";

const LEADS_PATH = "leads";
const TASKS_PATH = "tasks";
const MEETINGS_PATH = "meetings";
const USER_ROLES_WITH_GLOBAL_MEETING_ACCESS = new Set(["admin", "manager"]);
const USER_ROLES_WITH_GLOBAL_TASK_ACCESS = new Set(["admin", "manager"]);
const ALLOWED_MEETING_STATUSES = new Set<string>(MEETING_STATUSES);
const ALLOWED_MEETING_MODES = new Set<MeetingMode>(["google_meet", "zoom", "phone", "in_person", "other"]);
const ALLOWED_TASK_STATUSES = new Set<string>(TASK_STATUSES);
const ALLOWED_TASK_PRIORITIES = new Set<string>(TASK_PRIORITIES);

const getMeetingStartTime = (meeting: any): number => Number(meeting.startTime ?? meeting.from ?? 0);
const getMeetingEndTime = (meeting: any): number => Number(meeting.endTime ?? meeting.to ?? 0);
const getMeetingSubject = (meeting: any): string => String(meeting.subject ?? meeting.title ?? "");
const getLeadOutcome = (lead: any): "open" | "won" | "lost" | "cancelled" => {
    const outcome = String(lead?.outcome || "").trim().toLowerCase();
    if (outcome === "won" || outcome === "lost" || outcome === "cancelled") return outcome;
    if (lead?.status === "Won") return "won";
    if (lead?.status === "Lost") return "lost";
    return "open";
};

const getLeadClosedAt = (lead: any): number => Number(lead?.closedAt || lead?.closingDate || lead?.updatedAt || 0);

const canUserAccessLead = (lead: any, user: any): boolean => {
    if (!user || !lead) return false;
    if (USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(user.role)) return true;

    const userIds = new Set(
        [user?.id, user?._id, user?.uid, user?.legacyUid]
            .map((v) => String(v ?? "").trim())
            .filter((v) => v.length > 0)
    );
    if (!userIds.size) return false;

    const assignedTo = String(lead?.assignedTo?._id ?? lead?.assignedTo?.id ?? lead?.assignedTo ?? "").trim();
    const createdBy = String(lead?.createdBy?._id ?? lead?.createdBy?.id ?? lead?.createdBy ?? "").trim();

    if (assignedTo && userIds.has(assignedTo)) return true;
    if (createdBy && userIds.has(createdBy)) return true;
    return false;
};

const canAccessMeeting = (user: AuthRequest["user"], meeting: any, lead?: any): boolean => {
    if (!user) return false;
    if (USER_ROLES_WITH_GLOBAL_MEETING_ACCESS.has(user.role)) return true;
    if (meeting.assignedTo === user.id || meeting.createdBy === user.id) return true;
    if (lead && canUserAccessLead(lead, user)) return true;
    return false;
};

const normalizeTaskAssigneeIds = (assignedTo: unknown): string[] => {
    const rawAssignees = Array.isArray(assignedTo) ? assignedTo : [assignedTo];
    const uniqueAssignees: string[] = [];

    for (const assignee of rawAssignees) {
        const assigneeId = String(assignee || "").trim();
        if (!assigneeId || uniqueAssignees.includes(assigneeId)) continue;
        uniqueAssignees.push(assigneeId);
    }

    return uniqueAssignees;
};

const taskHasAssignee = (task: any, userId: string): boolean =>
    normalizeTaskAssigneeIds(task?.assignedTo).includes(userId);

const canAccessTask = (user: AuthRequest["user"], task: any, lead?: any): boolean => {
    if (!user) return false;
    if (USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(user.role)) return true;
    if (taskHasAssignee(task, user.id) || task.createdBy === user.id) return true;
    if (lead && canUserAccessLead(lead, user)) return true;
    return false;
};

const canDeleteTask = (user: AuthRequest["user"], task: any, lead?: any): boolean => {
    if (!user) return false;
    if (USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(user.role)) return true;
    if (task.createdBy === user.id) return true;
    if (lead && canUserAccessLead(lead, user)) return true;
    return false;
};

const handleControllerError = (res: Response, error: any, defaultMessage: string) => {
    console.error(`${defaultMessage}:`, error);
    if (error?.name === "ValidationError") {
        const firstMessage = Object.values(error.errors || {})[0] as any;
        const msg = firstMessage?.message || error.message || "Validation failed";
        return res.status(400).json({ success: false, message: msg });
    }
    if (error?.name === "CastError") {
        return res.status(400).json({ success: false, message: `Invalid identifier: ${error.path || "field"}` });
    }
    return res.status(500).json({ success: false, message: defaultMessage });
};

const normalizeAttendees = (attendees: unknown): IMeetingAttendee[] => {
    if (!Array.isArray(attendees)) return [];

    const attendeeMap = new Map<string, IMeetingAttendee>();

    for (const attendee of attendees) {
        if (!attendee || typeof attendee !== "object") continue;

        const rawEmail = String((attendee as IMeetingAttendee).email || "").trim();
        if (!rawEmail) continue;

        const normalizedAttendee: IMeetingAttendee = {
            email: rawEmail,
            type: (attendee as IMeetingAttendee).type || "external",
            responseStatus: (attendee as IMeetingAttendee).responseStatus || "needsAction",
        };

        const name = (attendee as IMeetingAttendee).name?.trim();
        if (name) normalizedAttendee.name = name;

        attendeeMap.set(rawEmail.toLowerCase(), normalizedAttendee);
    }

    return Array.from(attendeeMap.values());
};

const attachDefaultMeetingAttendees = (
    attendees: IMeetingAttendee[],
    lead: any,
    user: any
): IMeetingAttendee[] => {
    const attendeeMap = new Map<string, IMeetingAttendee>();

    for (const attendee of attendees) {
        if (!attendee || typeof attendee !== "object") continue;
        const rawEmail = String(attendee.email || "").trim().toLowerCase();
        if (!rawEmail) continue;

        const normalizedAttendee: IMeetingAttendee = {
            email: rawEmail,
            type: attendee.type || "external",
            responseStatus: attendee.responseStatus || "needsAction",
        };
        const name = attendee.name?.trim();
        if (name) normalizedAttendee.name = name;
        attendeeMap.set(rawEmail, normalizedAttendee);
    }

    if (lead?.email && typeof lead.email === "string" && lead.email.trim()) {
        const leadEmail = lead.email.trim().toLowerCase();
        const leadAttendee: IMeetingAttendee = {
            email: leadEmail,
            type: "lead",
            responseStatus: attendeeMap.get(leadEmail)?.responseStatus || "needsAction",
        };
        const leadName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
        if (leadName) leadAttendee.name = leadName;
        attendeeMap.set(leadEmail, leadAttendee);
    }

    if (user?.email && typeof user.email === "string" && user.email.trim()) {
        const userEmail = user.email.trim().toLowerCase();
        const salesRepAttendee: IMeetingAttendee = {
            email: userEmail,
            type: "sales_rep",
            responseStatus: attendeeMap.get(userEmail)?.responseStatus || "accepted",
        };
        if (user.name) salesRepAttendee.name = user.name;
        attendeeMap.set(userEmail, salesRepAttendee);
    }

    return Array.from(attendeeMap.values());
};

const buildMeetingResponse = (meeting: any, leads: Record<string, any>) => {
    const lead = meeting.leadId ? leads[meeting.leadId] : null;

    return {
        ...meeting,
        subject: getMeetingSubject(meeting),
        startTime: getMeetingStartTime(meeting),
        endTime: getMeetingEndTime(meeting),
        leadName: lead ? `${lead.firstName} ${lead.lastName}`.trim() : undefined,
        company: lead?.company || (meeting.leadId ? "Individual" : undefined),
        lead: lead
            ? {
                id: meeting.leadId,
                firstName: lead.firstName,
                lastName: lead.lastName,
                email: lead.email,
                company: lead.company || "Individual",
                status: lead.status,
            }
            : null,
    };
};

const parsePayloadTime = (val: any): number | undefined => {
    if (val === undefined || val === null || val === "") return undefined;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) return val;
    const num = Number(val);
    if (Number.isFinite(num) && num > 0) return num;
    const parsed = new Date(val).getTime();
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const parseMeetingPayload = (body: any, isPartial = false): { data: Partial<IMeeting>; error?: string } => {
    const updates: Partial<IMeeting> = {};

    if (!isPartial || body.subject !== undefined || body.title !== undefined) {
        const subject = String(body.subject ?? body.title ?? "").trim();
        if (!subject) return { data: {}, error: "Meeting subject is required" };
        updates.subject = subject;
    }

    if (body.leadId !== undefined && body.leadId !== null) {
        const leadId = String(body.leadId).trim();
        if (leadId && leadId !== "null" && leadId !== "undefined" && leadId !== "none") {
            updates.leadId = leadId;
        } else {
            updates.leadId = "";
        }
    }

    if (!isPartial || body.startTime !== undefined || body.from !== undefined) {
        const startTime = parsePayloadTime(body.startTime ?? body.from);
        if (!startTime) return { data: {}, error: "Valid meeting start time is required" };
        updates.startTime = startTime;
    }

    if (!isPartial || body.endTime !== undefined || body.to !== undefined) {
        const endTime = parsePayloadTime(body.endTime ?? body.to);
        if (!endTime) return { data: {}, error: "Valid meeting end time is required" };
        updates.endTime = endTime;
    }

    if (updates.startTime !== undefined && updates.endTime !== undefined && updates.startTime >= updates.endTime) {
        return { data: {}, error: "Meeting end time must be after start time" };
    }

    if (body.description !== undefined) {
        const description = String(body.description || "").trim();
        if (description) updates.description = description;
    }
    if (body.agenda !== undefined) {
        const agenda = String(body.agenda || "").trim();
        if (agenda) updates.agenda = agenda;
    }
    if (body.location !== undefined) {
        const location = String(body.location || "").trim();
        if (location) updates.location = location;
    }

    if (body.status !== undefined) {
        if (!ALLOWED_MEETING_STATUSES.has(body.status)) {
            return { data: {}, error: "Invalid meeting status" };
        }
        updates.status = body.status;
    }

    if (body.meetingMode !== undefined) {
        if (!ALLOWED_MEETING_MODES.has(body.meetingMode)) {
            return { data: {}, error: "Invalid meeting mode" };
        }
        updates.meetingMode = body.meetingMode;
    } else if (body.createGoogleMeeting === true || body.createGoogleMeet === true || body.isGoogleMeet === true) {
        updates.meetingMode = "google_meet";
    }

    if (body.meetLink !== undefined) {
        const meetLink = String(body.meetLink || "").trim();
        if (meetLink) updates.meetLink = meetLink;
    }

    if (body.attendees !== undefined) {
        updates.attendees = normalizeAttendees(body.attendees);
    }

    return { data: updates };
};

const fetchLeadById = async (leadId: string) => {
    const leadSnapshot = await mongoStore.ref(`${LEADS_PATH}/${leadId}`).once("value");
    return leadSnapshot.val();
};

const fetchUserById = async (userId: string) => {
    const userSnapshot = await mongoStore.ref(`users/${userId}`).once("value");
    return userSnapshot.val();
};

const buildTaskResponse = (
    task: any,
    leads: Record<string, any>,
    users: Record<string, any> = {}
) => {
    const lead = task.leadId ? leads[task.leadId] : null;
    const assigneeIds = normalizeTaskAssigneeIds(task.assignedTo);
    const assignees = assigneeIds
        .map((assigneeId) => {
            const assignee = users[assigneeId];
            if (!assignee) return null;
            return {
                _id: assigneeId,
                name: assignee.name,
                email: assignee.email,
                role: assignee.role,
            };
        })
        .filter(Boolean) as Array<{ _id: string; name?: string; email?: string; role?: string }>;
    const assigneeNames = assignees
        .map((assignee) => String(assignee.name || "").trim())
        .filter(Boolean);
    const creator = task.createdBy ? users[task.createdBy] : null;

    return {
        ...task,
        assignedTo: assigneeIds,
        leadName: lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim() : undefined,
        company: lead?.company || undefined,
        assignedToName: assigneeNames.join(", "),
        assignedToNames: assigneeNames,
        assignedToUsers: assignees,
        assignedByName: task.assignedBy ? users[task.assignedBy]?.name : undefined,
        createdByName: creator?.name,
        lead: lead
            ? {
                id: task.leadId,
                firstName: lead.firstName,
                lastName: lead.lastName,
                email: lead.email,
                company: lead.company || "Individual",
                status: lead.status,
            }
            : null,
    };
};

const fetchMeetingWithLead = async (meetingId: string) => {
    const meetingSnapshot = await mongoStore.ref(`${MEETINGS_PATH}/${meetingId}`).once("value");
    const meeting = meetingSnapshot.val();
    if (!meeting) return null;

    const leadsSnapshot = await mongoStore.ref(LEADS_PATH).once("value");
    const leads = leadsSnapshot.val() || {};

    return buildMeetingResponse({ ...meeting, id: meetingSnapshot.key }, leads);
};

const addLeadTimelineEntry = async (
    leadId: string,
    remark: string,
    performedBy: string,
    event: string = "Meeting Scheduled"
) => {
    try {
        if (!Types.ObjectId.isValid(leadId)) return;
        const leadRef = mongoStore.ref(`${LEADS_PATH}/${leadId}`);
        const leadSnapshot = await leadRef.once("value");
        const lead = leadSnapshot.val();

        if (!lead) return;

        const timeline = Array.isArray(lead.timeline) ? lead.timeline : [];
        timeline.push({
            event,
            remark,
            performedBy,
            timestamp: Date.now(),
        });

        await leadRef.update({ timeline, updatedAt: Date.now() });
    } catch (timelineErr) {
        console.error("Failed to append timeline entry to lead:", timelineErr);
    }
};

const GLOBAL_TASK_ASSIGNABLE_ROLES = new Set(["admin", "sales_rep", "manager"]);

const resolveTaskSource = (creatorRole: string, createdBy: string, assignedTo: string[]): TaskSource => {
    const assigneeIds = normalizeTaskAssigneeIds(assignedTo);
    if (assigneeIds.length === 1 && assigneeIds[0] === createdBy) return "self";
    return creatorRole === "admin" || creatorRole === "manager" ? "admin" : "self";
};

export const getSalesSummary = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { startDate, endDate } = req.query;
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        const filterStart = startDate ? Number(startDate) : 0;
        const filterEnd = endDate ? Number(endDate) : 9999999999999;

        const [leadsSnap, tasksSnap, meetingsSnap] = await Promise.all([
            mongoStore.ref(LEADS_PATH).once("value"),
            mongoStore.ref(TASKS_PATH).once("value"),
            mongoStore.ref(MEETINGS_PATH).once("value"),
        ]);

        const leads = leadsSnap.val() || {};
        const tasks = tasksSnap.val() || {};
        const meetings = meetingsSnap.val() || {};

        const leadsWithIds = Object.entries(leads).map(([id, lead]: [string, any]) => ({ ...lead, id, _id: id }));
        const tasksWithIds = Object.entries(tasks).map(([id, task]: [string, any]) => ({
            ...task,
            id,
            assignedTo: normalizeTaskAssigneeIds(task?.assignedTo),
        }));
        const meetingsWithIds = Object.entries(meetings).map(([id, meeting]: [string, any]) => ({ ...meeting, id }));
        const myLeads = leadsWithIds.filter((lead: any) => lead.assignedTo === userId);

        const attachLead = (item: any) => {
            if (item.leadId && leads[item.leadId]) {
                const lead = leads[item.leadId];
                return { ...item, leadName: `${lead.firstName} ${lead.lastName}`, company: lead.company || "Individual" };
            }
            return item;
        };

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
        const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
        const wonDeals = myLeads.filter((lead: any) => getLeadOutcome(lead) === "won");

        const stats = {
            openDeals: myLeads.filter((lead: any) => getLeadOutcome(lead) === "open").length,
            wonDeals: wonDeals.length,
            wonDealsThisMonth: wonDeals.filter((lead: any) => {
                const closedAt = getLeadClosedAt(lead);
                return closedAt >= startOfMonth && closedAt <= endOfMonth;
            }),
            untouchedDeals: myLeads.filter((lead: any) => !lead.timeline || lead.timeline.length <= 1).length,
            callsToday: meetingsWithIds.filter((meeting: any) =>
                meeting.assignedTo === userId &&
                getMeetingStartTime(meeting) >= startOfToday &&
                getMeetingStartTime(meeting) <= startOfToday + 86400000
            ).length,
            totalMyLeads: myLeads.length,
            allTasks: tasksWithIds
                .filter((task: any) => taskHasAssignee(task, userId))
                .map(attachLead),
            openTasks: tasksWithIds
                .filter((task: any) => taskHasAssignee(task, userId) && task.status !== "Completed")
                .map(attachLead),
            meetings: meetingsWithIds
                .filter((meeting: any) =>
                    meeting.assignedTo === userId &&
                    getMeetingStartTime(meeting) >= filterStart &&
                    getMeetingStartTime(meeting) <= filterEnd
            )
                .map((meeting: any) => attachLead(buildMeetingResponse(meeting, leads))),
            todaysLeads: myLeads.filter((lead: any) => lead.createdAt >= startOfToday),
            dealsClosingThisMonth: myLeads.filter((lead: any) => {
                const closingDate = lead.closingDate || 0;
                if (getLeadOutcome(lead) === "won") {
                    const closedAt = getLeadClosedAt(lead);
                    return closedAt >= startOfMonth && closedAt <= endOfMonth;
                }
                return getLeadOutcome(lead) === "open" && closingDate >= startOfMonth && closingDate <= endOfMonth;
            }),
        };

        res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getMeetings = async (req: AuthRequest, res: Response) => {
    try {
        const { status, leadId, startDate, endDate, assignedTo } = req.query as Record<string, string | undefined>;
        const meetingsSnapshot = await mongoStore.ref(MEETINGS_PATH).once("value");
        const leadsSnapshot = await mongoStore.ref(LEADS_PATH).once("value");
        const meetings = meetingsSnapshot.val() || {};
        const leads = leadsSnapshot.val() || {};

        let items = Object.entries(meetings).map(([id, meeting]: [string, any]) => ({ ...meeting, id }));

        if (!USER_ROLES_WITH_GLOBAL_MEETING_ACCESS.has(req.user!.role)) {
            items = items.filter((meeting: any) => {
                if (meeting.assignedTo === req.user!.id || meeting.createdBy === req.user!.id) return true;
                if (meeting.leadId && leads[meeting.leadId] && canUserAccessLead(leads[meeting.leadId], req.user)) return true;
                return false;
            });
        } else if (assignedTo) {
            items = items.filter((meeting: any) => meeting.assignedTo === assignedTo);
        }

        if (status) items = items.filter((meeting: any) => meeting.status === status);
        if (leadId) items = items.filter((meeting: any) => meeting.leadId === leadId);
        if (startDate) items = items.filter((meeting: any) => getMeetingStartTime(meeting) >= Number(startDate));
        if (endDate) items = items.filter((meeting: any) => getMeetingStartTime(meeting) <= Number(endDate));

        const data = items
            .sort((a: any, b: any) => getMeetingStartTime(a) - getMeetingStartTime(b))
            .map((meeting: any) => buildMeetingResponse(meeting, leads));

        res.status(200).json({ success: true, count: data.length, data });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to fetch meetings");
    }
};

export const getTasks = async (req: AuthRequest, res: Response) => {
    try {
        const { status, priority, leadId, assignedTo, search } = req.query as Record<string, string | undefined>;
        const [tasksSnapshot, leadsSnapshot, usersSnapshot] = await Promise.all([
            mongoStore.ref(TASKS_PATH).once("value"),
            mongoStore.ref(LEADS_PATH).once("value"),
            mongoStore.ref("users").once("value"),
        ]);

        const tasks = tasksSnapshot.val() || {};
        const leads = leadsSnapshot.val() || {};
        const users = usersSnapshot.val() || {};

        let items = Object.entries(tasks).map(([id, task]: [string, any]) => ({ ...task, id }));

        if (!USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(req.user!.role)) {
            items = items.filter((task: any) => {
                if (taskHasAssignee(task, req.user!.id) || task.createdBy === req.user!.id) return true;
                if (task.leadId && leads[task.leadId] && canUserAccessLead(leads[task.leadId], req.user)) return true;
                return false;
            });
        } else if (assignedTo) {
            items = items.filter((task: any) => taskHasAssignee(task, assignedTo));
        }

        if (status) items = items.filter((task: any) => task.status === status);
        if (priority) items = items.filter((task: any) => task.priority === priority);
        if (leadId) items = items.filter((task: any) => task.leadId === leadId);
        if (search) {
            const query = search.toLowerCase();
            items = items.filter((task: any) => {
                const lead = task.leadId ? leads[task.leadId] : null;
                const leadName = lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim().toLowerCase() : "";
                return (
                    String(task.subject || "").toLowerCase().includes(query) ||
                    String(task.description || "").toLowerCase().includes(query) ||
                    leadName.includes(query)
                );
            });
        }

        const data = items
            .sort((a: any, b: any) => {
                const aDue = Number(a.dueDate || 0);
                const bDue = Number(b.dueDate || 0);
                if (aDue !== bDue) return aDue - bDue;
                return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
            })
            .map((task: any) => buildTaskResponse(task, leads, users));

        res.status(200).json({ success: true, count: data.length, data });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to fetch tasks");
    }
};

export const getMeetingById = async (req: AuthRequest, res: Response) => {
    try {
        const meetingSnapshot = await mongoStore.ref(`${MEETINGS_PATH}/${req.params.id}`).once("value");
        const meeting = meetingSnapshot.val();

        if (!meeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        const lead = meeting.leadId ? await fetchLeadById(meeting.leadId) : null;
        if (!canAccessMeeting(req.user, meeting, lead)) {
            res.status(403).json({ success: false, message: "Not authorized to access this meeting" });
            return;
        }

        const leadsSnapshot = await mongoStore.ref(LEADS_PATH).once("value");
        const leads = leadsSnapshot.val() || {};

        res.status(200).json({
            success: true,
            data: buildMeetingResponse({ ...meeting, id: meetingSnapshot.key }, leads),
        });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to fetch meeting");
    }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const taskRef = mongoStore.ref(`${TASKS_PATH}/${id}`);
        const snapshot = await taskRef.once("value");
        const existingTask = snapshot.val();

        if (!existingTask) {
            res.status(404).json({ success: false, message: "Task not found" });
            return;
        }

        const existingLead = existingTask.leadId ? await fetchLeadById(existingTask.leadId) : null;
        if (!canAccessTask(req.user, existingTask, existingLead)) {
            res.status(403).json({ success: false, message: "Not authorized to update this task" });
            return;
        }

        const updates: Record<string, any> = {};

        if (req.body.subject !== undefined) {
            const subject = String(req.body.subject || "").trim();
            if (!subject) {
                res.status(400).json({ success: false, message: "Task subject is required" });
                return;
            }
            updates.subject = subject;
        }

        if (req.body.description !== undefined) {
            updates.description = String(req.body.description || "").trim();
        }

        if (req.body.dueDate !== undefined) {
            let dueDate: number | undefined;
            if (typeof req.body.dueDate === "number" && Number.isFinite(req.body.dueDate) && req.body.dueDate > 0) {
                dueDate = req.body.dueDate;
            } else if (typeof req.body.dueDate === "string" && req.body.dueDate.trim()) {
                const num = Number(req.body.dueDate);
                if (Number.isFinite(num) && num > 0) {
                    dueDate = num;
                } else {
                    const parsed = new Date(req.body.dueDate).getTime();
                    if (Number.isFinite(parsed) && parsed > 0) {
                        dueDate = parsed;
                    }
                }
            }
            if (!dueDate) {
                res.status(400).json({ success: false, message: "Valid due date is required" });
                return;
            }
            updates.dueDate = dueDate;
        }

        if (req.body.status !== undefined) {
            if (!ALLOWED_TASK_STATUSES.has(req.body.status)) {
                res.status(400).json({ success: false, message: "Invalid task status" });
                return;
            }
            updates.status = req.body.status;

            if (req.body.status === "Completed") {
                updates.completedAt = Date.now();
                updates.completedBy = req.user!.id;
                updates.completionRemark = String(req.body.completionRemark || existingTask.completionRemark || "").trim();
            } else if (existingTask.status === "Completed") {
                updates.completedAt = null;
                updates.completedBy = null;
                updates.completionRemark = null;
            }
        }

        if (req.body.priority !== undefined) {
            if (!ALLOWED_TASK_PRIORITIES.has(req.body.priority)) {
                res.status(400).json({ success: false, message: "Invalid task priority" });
                return;
            }
            updates.priority = req.body.priority;
        }

        if (req.body.leadId !== undefined) {
            const rawLeadId = String(req.body.leadId || "").trim();
            if (rawLeadId && rawLeadId !== "null" && rawLeadId !== "undefined" && rawLeadId !== "none") {
                if (!Types.ObjectId.isValid(rawLeadId)) {
                    res.status(404).json({ success: false, message: "Associated lead not found" });
                    return;
                }
                const lead = await fetchLeadById(rawLeadId);
                if (!lead) {
                    res.status(404).json({ success: false, message: "Associated lead not found" });
                    return;
                }
                if (!canUserAccessLead(lead, req.user)) {
                    res.status(403).json({ success: false, message: "Not authorized to link this lead" });
                    return;
                }
                updates.leadId = rawLeadId;
            } else {
                updates.leadId = null;
            }
        }

        if (req.body.assignedTo !== undefined) {
            if (!USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(req.user!.role)) {
                res.status(403).json({ success: false, message: "Only admins and managers can reassign tasks" });
                return;
            }

            const assignedTo = normalizeTaskAssigneeIds(req.body.assignedTo);
            if (!assignedTo.length) {
                res.status(400).json({ success: false, message: "At least one assignee is required" });
                return;
            }

            const assignedUsers = await Promise.all(
                assignedTo.map(async (assigneeId) => {
                    const user = await fetchUserById(assigneeId);
                    if (!user && assigneeId === req.user!.id) {
                        return { assigneeId, user: { _id: req.user!.id, role: req.user!.role, name: req.user!.email } };
                    }
                    return { assigneeId, user };
                })
            );
            const missingAssignee = assignedUsers.find((assignee) => !assignee.user);
            if (missingAssignee) {
                res.status(404).json({ success: false, message: `Assigned user not found: ${missingAssignee.assigneeId}`, error: `Assigned user not found: ${missingAssignee.assigneeId}` });
                return;
            }

            const invalidAssignee = assignedUsers.find(
                (assignee) => !GLOBAL_TASK_ASSIGNABLE_ROLES.has(String(assignee.user?.role || ""))
            );
            if (invalidAssignee) {
                res.status(400).json({ success: false, message: "Tasks can only be assigned to admins, managers, or sales reps", error: "Tasks can only be assigned to admins, managers, or sales reps" });
                return;
            }

            updates.assignedTo = assignedTo;
            updates.assignedBy = req.user!.id;
            updates.source = resolveTaskSource(req.user!.role, existingTask.createdBy, assignedTo);
            updates.isRead = assignedTo.includes(req.user!.id);
        }

        if (req.body.completionRemark !== undefined) {
            updates.completionRemark = String(req.body.completionRemark || "").trim() || null;
        }

        updates.updatedAt = Date.now();

        await taskRef.update(updates);

        const [tasksSnapshot, leadsSnapshot, usersSnapshot] = await Promise.all([
            taskRef.once("value"),
            mongoStore.ref(LEADS_PATH).once("value"),
            mongoStore.ref("users").once("value"),
        ]);

        res.status(200).json({
            success: true,
            data: buildTaskResponse({ ...tasksSnapshot.val(), id }, leadsSnapshot.val() || {}, usersSnapshot.val() || {}),
        });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to update task");
    }
};

export const updateMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params as { id: string };
        const meetingRef = mongoStore.ref(`${MEETINGS_PATH}/${id}`);
        const snapshot = await meetingRef.once("value");
        const existingMeeting = snapshot.val();

        if (!existingMeeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        const existingLead = existingMeeting.leadId ? await fetchLeadById(existingMeeting.leadId) : null;
        if (!canAccessMeeting(req.user, existingMeeting, existingLead)) {
            res.status(403).json({ success: false, message: "Not authorized to update this meeting" });
            return;
        }

        const parsed = parseMeetingPayload(req.body, true);
        if (parsed.error) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }

        const nextStartTime = parsed.data.startTime ?? getMeetingStartTime(existingMeeting);
        const nextEndTime = parsed.data.endTime ?? getMeetingEndTime(existingMeeting);
        if (nextStartTime >= nextEndTime) {
            res.status(400).json({ success: false, message: "Meeting end time must be after start time" });
            return;
        }

        let attendees = parsed.data.attendees ?? normalizeAttendees(existingMeeting.attendees);
        let lead: any = null;
        const nextLeadId = parsed.data.leadId !== undefined ? parsed.data.leadId : existingMeeting.leadId;
        if (nextLeadId) {
            if (!Types.ObjectId.isValid(nextLeadId)) {
                res.status(404).json({ success: false, message: "Associated lead not found for this meeting" });
                return;
            }
            lead = await fetchLeadById(nextLeadId);
            if (!lead) {
                res.status(404).json({ success: false, message: "Associated lead not found for this meeting" });
                return;
            }
            if (!canUserAccessLead(lead, req.user)) {
                res.status(403).json({ success: false, message: "Not authorized for this lead" });
                return;
            }
        }

        attendees = attachDefaultMeetingAttendees(attendees, lead, req.user);

        const updates: Partial<IMeeting> = {
            ...parsed.data,
            leadId: nextLeadId,
            attendees,
            syncStatus: "pending",
            syncError: null,
            updatedAt: Date.now(),
        };

        await meetingRef.update(updates);
        await MeetingGoogleSyncService.syncMeeting(id);

        const refreshedMeeting = await fetchMeetingWithLead(id);
        res.status(200).json({ success: true, data: refreshedMeeting });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to update meeting");
    }
};

export const scheduleMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const parsed = parseMeetingPayload(req.body);
        if (parsed.error) {
            res.status(400).json({ success: false, message: parsed.error });
            return;
        }

        const userId = req.user!.id;
        let lead: any = null;
        if (parsed.data.leadId) {
            if (!Types.ObjectId.isValid(parsed.data.leadId)) {
                res.status(404).json({ success: false, message: "Associated lead not found" });
                return;
            }
            lead = await fetchLeadById(parsed.data.leadId);
            if (!lead) {
                res.status(404).json({ success: false, message: "Associated lead not found" });
                return;
            }
            if (!canUserAccessLead(lead, req.user)) {
                res.status(403).json({ success: false, message: "Not authorized to schedule activities for this lead" });
                return;
            }
        }

        const meetingRef = mongoStore.ref(MEETINGS_PATH).push();
        const attendees = attachDefaultMeetingAttendees(parsed.data.attendees || [], lead, req.user);
        const isGoogleMeet = parsed.data.meetingMode === "google_meet" || req.body.createGoogleMeeting === true;
        const meetingMode = isGoogleMeet ? "google_meet" : (parsed.data.meetingMode || "other");
        const meetingData: IMeeting = {
            id: meetingRef.key!,
            subject: parsed.data.subject!,
            meetingMode,
            startTime: parsed.data.startTime!,
            endTime: parsed.data.endTime!,
            status: parsed.data.status || "Scheduled",
            assignedTo: userId,
            leadId: parsed.data.leadId || "",
            createdBy: userId,
            attendees,
            syncStatus: "pending",
            syncError: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        if (parsed.data.description) meetingData.description = parsed.data.description;
        if (parsed.data.agenda) meetingData.agenda = parsed.data.agenda;
        if (parsed.data.location) meetingData.location = parsed.data.location;

        if (meetingMode === "google_meet") {
            const meetCode = `sec-${meetingRef.key?.toLowerCase().slice(-3) || "crm"}-${Date.now().toString(36).slice(-4)}`;
            meetingData.meetLink = parsed.data.meetLink || `https://meet.google.com/${meetCode}`;
        }

        await meetingRef.set(meetingData);
        try {
            await MeetingGoogleSyncService.syncMeeting(meetingData.id!);
        } catch {
            // sync error is logged on the meeting record
        }
        if (meetingData.leadId) {
            const isCall = meetingMode === "phone";
            await addLeadTimelineEntry(
                meetingData.leadId,
                isCall ? `Call scheduled: ${meetingData.subject}` : `Meeting scheduled: ${meetingData.subject}`,
                userId,
                isCall ? "Call Scheduled" : "Meeting Scheduled"
            );
        }

        const refreshedMeeting = await fetchMeetingWithLead(meetingData.id!);
        res.status(201).json({ success: true, data: refreshedMeeting });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to schedule meeting or call");
    }
};

export const createTask = async (req: AuthRequest, res: Response) => {
    try {
        const { leadId, subject, title, dueDate, priority, status, description } = req.body;
        const userId = req.user!.id;
        const userRole = req.user!.role;
        const trimmedSubject = String(subject ?? title ?? "").trim();

        if (!trimmedSubject) {
            res.status(400).json({ success: false, message: "Task subject is required" });
            return;
        }

        let normalizedDueDate: number;
        if (typeof dueDate === "number" && Number.isFinite(dueDate) && dueDate > 0) {
            normalizedDueDate = dueDate;
        } else if (typeof dueDate === "string" && dueDate.trim()) {
            const num = Number(dueDate);
            if (Number.isFinite(num) && num > 0) {
                normalizedDueDate = num;
            } else {
                const parsed = new Date(dueDate).getTime();
                if (Number.isFinite(parsed) && parsed > 0) {
                    normalizedDueDate = parsed;
                } else {
                    const d = new Date();
                    d.setHours(23, 59, 59, 999);
                    normalizedDueDate = d.getTime();
                }
            }
        } else {
            const d = new Date();
            d.setHours(23, 59, 59, 999);
            normalizedDueDate = d.getTime();
        }

        const normalizedPriority = priority || "Medium";
        if (!ALLOWED_TASK_PRIORITIES.has(normalizedPriority)) {
            res.status(400).json({ success: false, message: "Invalid task priority" });
            return;
        }

        const normalizedStatus = status || "Pending";
        if (!ALLOWED_TASK_STATUSES.has(normalizedStatus)) {
            res.status(400).json({ success: false, message: "Invalid task status" });
            return;
        }

        let assignedTo = [userId];
        if (req.body.assignedTo !== undefined && req.body.assignedTo !== null) {
            const requestedAssignees = normalizeTaskAssigneeIds(req.body.assignedTo);

            if (requestedAssignees.length > 0) {
                if (
                    !USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(userRole) &&
                    (requestedAssignees.length !== 1 || requestedAssignees[0] !== userId)
                ) {
                    res.status(403).json({ success: false, message: "Sales reps can only create tasks for themselves" });
                    return;
                }

                const assignedUsers = await Promise.all(
                    requestedAssignees.map(async (assigneeId) => {
                        const user = await fetchUserById(assigneeId);
                        if (!user && assigneeId === userId) {
                            return { assigneeId, user: { _id: userId, role: userRole, name: req.user!.email } };
                        }
                        return { assigneeId, user };
                    })
                );
                const missingAssignee = assignedUsers.find((assignee) => !assignee.user);
                if (missingAssignee) {
                    res.status(404).json({ success: false, message: `Assigned user not found: ${missingAssignee.assigneeId}`, error: `Assigned user not found: ${missingAssignee.assigneeId}` });
                    return;
                }

                if (
                    USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(userRole) &&
                    assignedUsers.some((assignee) => !GLOBAL_TASK_ASSIGNABLE_ROLES.has(String(assignee.user?.role || "")))
                ) {
                    res.status(400).json({ success: false, message: "Tasks can only be assigned to admins, managers, or sales reps", error: "Tasks can only be assigned to admins, managers, or sales reps" });
                    return;
                }

                assignedTo = requestedAssignees;
            }
        }

        let normalizedLeadId: string | undefined = undefined;
        const rawLeadId = String(leadId || "").trim();
        if (rawLeadId && rawLeadId !== "null" && rawLeadId !== "undefined" && rawLeadId !== "none") {
            if (!Types.ObjectId.isValid(rawLeadId)) {
                res.status(404).json({ success: false, message: "Associated lead not found" });
                return;
            }
            const lead = await fetchLeadById(rawLeadId);
            if (!lead) {
                res.status(404).json({ success: false, message: "Associated lead not found" });
                return;
            }
            if (!canUserAccessLead(lead, req.user)) {
                res.status(403).json({ success: false, message: "Not authorized to create tasks for this lead" });
                return;
            }
            normalizedLeadId = rawLeadId;
        }

        const taskRef = mongoStore.ref(TASKS_PATH).push();
        const source = resolveTaskSource(userRole, userId, assignedTo);
        const taskData: ITask = {
            id: taskRef.key,
            subject: trimmedSubject,
            description: String(description || "").trim(),
            dueDate: normalizedDueDate,
            status: normalizedStatus,
            priority: normalizedPriority,
            assignedTo,
            assignedBy: userId,
            createdBy: userId,
            source,
            isRead: assignedTo.includes(userId),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...(normalizedLeadId ? { leadId: normalizedLeadId } : {}),
        };

        await taskRef.set(taskData);

        if (normalizedLeadId) {
            await addLeadTimelineEntry(
                normalizedLeadId,
                `Task created: ${trimmedSubject}`,
                userId,
                "Task Created"
            );
        }

        const [leadsSnapshot, usersSnapshot] = await Promise.all([
            mongoStore.ref(LEADS_PATH).once("value"),
            mongoStore.ref("users").once("value"),
        ]);

        res.status(201).json({
            success: true,
            data: buildTaskResponse(taskData, leadsSnapshot.val() || {}, usersSnapshot.val() || {}),
        });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to create task");
    }
};

export const deleteMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const meetingRef = mongoStore.ref(`${MEETINGS_PATH}/${id}`);
        const snapshot = await meetingRef.once("value");
        const meeting = snapshot.val();

        if (!meeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        const lead = meeting.leadId ? await fetchLeadById(meeting.leadId) : null;
        if (!canAccessMeeting(req.user, meeting, lead)) {
            res.status(403).json({ success: false, message: "Not authorized to delete this meeting" });
            return;
        }

        await MeetingGoogleSyncService.deleteCalendarEventForMeeting({ ...meeting, id });
        await meetingRef.remove();

        res.status(200).json({ success: true, message: "Meeting deleted successfully" });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to delete meeting");
    }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const taskRef = mongoStore.ref(`${TASKS_PATH}/${id}`);
        const snapshot = await taskRef.once("value");
        const task = snapshot.val();

        if (!task) {
            res.status(404).json({ success: false, message: "Task not found" });
            return;
        }

        const lead = task.leadId ? await fetchLeadById(task.leadId) : null;
        if (!canDeleteTask(req.user, task, lead)) {
            res.status(403).json({ success: false, message: "Not authorized to delete this task" });
            return;
        }

        await taskRef.remove();
        res.status(200).json({ success: true, message: "Task deleted successfully" });
    } catch (error: any) {
        handleControllerError(res, error, "Failed to delete task");
    }
};
