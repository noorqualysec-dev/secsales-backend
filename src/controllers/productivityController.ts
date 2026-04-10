import type { Response } from "express";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { rtdb } from "../config/firebase.js";
import { MeetingGoogleSyncService } from "../services/meetingGoogleSyncService.js";
import type {
    IMeeting,
    IMeetingAttendee,
    MeetingMode,
    MeetingStatus,
} from "../models/meetingModel.js";
import { TASK_PRIORITIES, TASK_STATUSES, type ITask, type TaskSource } from "../models/taskModel.js";

const LEADS_PATH = "leads";
const TASKS_PATH = "tasks";
const MEETINGS_PATH = "meetings";
const USER_ROLES_WITH_GLOBAL_MEETING_ACCESS = new Set(["admin", "manager"]);
const USER_ROLES_WITH_GLOBAL_TASK_ACCESS = new Set(["admin", "manager"]);
const ALLOWED_MEETING_STATUSES = new Set<MeetingStatus>(["Scheduled", "Completed", "Cancelled"]);
const ALLOWED_MEETING_MODES = new Set<MeetingMode>(["google_meet", "zoom", "phone", "in_person", "other"]);
const ALLOWED_TASK_STATUSES = new Set<string>(TASK_STATUSES);
const ALLOWED_TASK_PRIORITIES = new Set<string>(TASK_PRIORITIES);

const getMeetingStartTime = (meeting: any): number => Number(meeting.startTime ?? meeting.from ?? 0);
const getMeetingEndTime = (meeting: any): number => Number(meeting.endTime ?? meeting.to ?? 0);
const getMeetingSubject = (meeting: any): string => String(meeting.subject ?? meeting.title ?? "");

const canAccessMeeting = (user: AuthRequest["user"], meeting: any): boolean => {
    if (!user) return false;
    return USER_ROLES_WITH_GLOBAL_MEETING_ACCESS.has(user.role) || meeting.assignedTo === user.id;
};

const canAccessTask = (user: AuthRequest["user"], task: any): boolean => {
    if (!user) return false;
    return USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(user.role) || task.assignedTo === user.id || task.createdBy === user.id;
};

const canDeleteTask = (user: AuthRequest["user"], task: any): boolean => {
    if (!user) return false;
    return USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(user.role) || task.createdBy === user.id;
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
        attendeeMap.set(attendee.email.toLowerCase(), attendee);
    }

    if (lead?.email) {
        const leadAttendee: IMeetingAttendee = {
            email: lead.email,
            type: "lead",
            responseStatus: attendeeMap.get(String(lead.email).toLowerCase())?.responseStatus || "needsAction",
        };
        const leadName = `${lead.firstName || ""} ${lead.lastName || ""}`.trim();
        if (leadName) leadAttendee.name = leadName;
        attendeeMap.set(String(lead.email).toLowerCase(), leadAttendee);
    }

    if (user?.email) {
        const salesRepAttendee: IMeetingAttendee = {
            email: user.email,
            type: "sales_rep",
            responseStatus: attendeeMap.get(String(user.email).toLowerCase())?.responseStatus || "accepted",
        };
        if (user.name) salesRepAttendee.name = user.name;
        attendeeMap.set(String(user.email).toLowerCase(), salesRepAttendee);
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
        company: lead?.company || "Individual",
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

const parseMeetingPayload = (body: any, isPartial = false): { data: Partial<IMeeting>; error?: string } => {
    const updates: Partial<IMeeting> = {};

    if (!isPartial || body.subject !== undefined || body.title !== undefined) {
        const subject = String(body.subject ?? body.title ?? "").trim();
        if (!subject) return { data: {}, error: "Meeting subject is required" };
        updates.subject = subject;
    }

    if (!isPartial || body.leadId !== undefined) {
        const leadId = String(body.leadId || "").trim();
        if (!leadId) return { data: {}, error: "Lead ID is required" };
        updates.leadId = leadId;
    }

    if (!isPartial || body.startTime !== undefined || body.from !== undefined) {
        const startTime = Number(body.startTime ?? body.from);
        if (!Number.isFinite(startTime)) return { data: {}, error: "Valid meeting start time is required" };
        updates.startTime = startTime;
    }

    if (!isPartial || body.endTime !== undefined || body.to !== undefined) {
        const endTime = Number(body.endTime ?? body.to);
        if (!Number.isFinite(endTime)) return { data: {}, error: "Valid meeting end time is required" };
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
    }

    if (body.attendees !== undefined) {
        updates.attendees = normalizeAttendees(body.attendees);
    }

    return { data: updates };
};

const fetchLeadById = async (leadId: string) => {
    const leadSnapshot = await rtdb.ref(`${LEADS_PATH}/${leadId}`).once("value");
    return leadSnapshot.val();
};

const fetchUserById = async (userId: string) => {
    const userSnapshot = await rtdb.ref(`users/${userId}`).once("value");
    return userSnapshot.val();
};

const buildTaskResponse = (
    task: any,
    leads: Record<string, any>,
    users: Record<string, any> = {}
) => {
    const lead = task.leadId ? leads[task.leadId] : null;
    const assignee = task.assignedTo ? users[task.assignedTo] : null;
    const creator = task.createdBy ? users[task.createdBy] : null;

    return {
        ...task,
        leadName: lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim() : undefined,
        company: lead?.company || undefined,
        assignedToName: assignee?.name,
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
    const meetingSnapshot = await rtdb.ref(`${MEETINGS_PATH}/${meetingId}`).once("value");
    const meeting = meetingSnapshot.val();
    if (!meeting) return null;

    const leadsSnapshot = await rtdb.ref(LEADS_PATH).once("value");
    const leads = leadsSnapshot.val() || {};

    return buildMeetingResponse({ ...meeting, id: meetingSnapshot.key }, leads);
};

const addLeadTimelineEntry = async (leadId: string, remark: string, performedBy: string) => {
    const leadRef = rtdb.ref(`${LEADS_PATH}/${leadId}`);
    const leadSnapshot = await leadRef.once("value");
    const lead = leadSnapshot.val();

    if (!lead) return;

    const timeline = Array.isArray(lead.timeline) ? lead.timeline : [];
    timeline.push({
        event: "Status Changed",
        remark,
        performedBy,
        timestamp: Date.now(),
    });

    await leadRef.update({ timeline, updatedAt: Date.now() });
};

const GLOBAL_TASK_ASSIGNABLE_ROLES = new Set(["sales_rep", "manager"]);

const resolveTaskSource = (creatorRole: string, createdBy: string, assignedTo: string): TaskSource => {
    if (assignedTo === createdBy) return "self";
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
            rtdb.ref(LEADS_PATH).once("value"),
            rtdb.ref(TASKS_PATH).once("value"),
            rtdb.ref(MEETINGS_PATH).once("value"),
        ]);

        const leads = leadsSnap.val() || {};
        const tasks = tasksSnap.val() || {};
        const meetings = meetingsSnap.val() || {};

        const leadsWithIds = Object.entries(leads).map(([id, lead]: [string, any]) => ({ ...lead, id, _id: id }));
        const tasksWithIds = Object.entries(tasks).map(([id, task]: [string, any]) => ({ ...task, id }));
        const meetingsWithIds = Object.entries(meetings).map(([id, meeting]: [string, any]) => ({ ...meeting, id }));
        const myLeads = leadsWithIds.filter((lead: any) => lead.assignedTo === userId);

        const attachLead = (item: any) => {
            if (item.leadId && leads[item.leadId]) {
                const lead = leads[item.leadId];
                return { ...item, leadName: `${lead.firstName} ${lead.lastName}`, company: lead.company || "Individual" };
            }
            return item;
        };

        const stats = {
            openDeals: myLeads.filter((lead: any) => !["Won", "Lost"].includes(lead.status)).length,
            untouchedDeals: myLeads.filter((lead: any) => !lead.timeline || lead.timeline.length <= 1).length,
            callsToday: meetingsWithIds.filter((meeting: any) =>
                meeting.assignedTo === userId &&
                getMeetingStartTime(meeting) >= startOfToday &&
                getMeetingStartTime(meeting) <= startOfToday + 86400000
            ).length,
            totalMyLeads: myLeads.length,
            allTasks: tasksWithIds
                .filter((task: any) => task.assignedTo === userId)
                .map(attachLead),
            openTasks: tasksWithIds
                .filter((task: any) => task.assignedTo === userId && task.status !== "Completed")
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
                const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
                const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getTime();
                return closingDate >= startOfMonth && closingDate <= endOfMonth;
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
        const meetingsSnapshot = await rtdb.ref(MEETINGS_PATH).once("value");
        const leadsSnapshot = await rtdb.ref(LEADS_PATH).once("value");
        const meetings = meetingsSnapshot.val() || {};
        const leads = leadsSnapshot.val() || {};

        let items = Object.entries(meetings).map(([id, meeting]: [string, any]) => ({ ...meeting, id }));

        if (!USER_ROLES_WITH_GLOBAL_MEETING_ACCESS.has(req.user!.role)) {
            items = items.filter((meeting: any) => meeting.assignedTo === req.user!.id);
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
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getTasks = async (req: AuthRequest, res: Response) => {
    try {
        const { status, priority, leadId, assignedTo, search } = req.query as Record<string, string | undefined>;
        const [tasksSnapshot, leadsSnapshot, usersSnapshot] = await Promise.all([
            rtdb.ref(TASKS_PATH).once("value"),
            rtdb.ref(LEADS_PATH).once("value"),
            rtdb.ref("users").once("value"),
        ]);

        const tasks = tasksSnapshot.val() || {};
        const leads = leadsSnapshot.val() || {};
        const users = usersSnapshot.val() || {};

        let items = Object.entries(tasks).map(([id, task]: [string, any]) => ({ ...task, id }));

        if (!USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(req.user!.role)) {
            items = items.filter((task: any) => task.assignedTo === req.user!.id || task.createdBy === req.user!.id);
        } else if (assignedTo) {
            items = items.filter((task: any) => task.assignedTo === assignedTo);
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
        res.status(500).json({ success: false, message: error.message });
    }
};

export const getMeetingById = async (req: AuthRequest, res: Response) => {
    try {
        const meetingSnapshot = await rtdb.ref(`${MEETINGS_PATH}/${req.params.id}`).once("value");
        const meeting = meetingSnapshot.val();

        if (!meeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        if (!canAccessMeeting(req.user, meeting)) {
            res.status(403).json({ success: false, message: "Not authorized to access this meeting" });
            return;
        }

        const leadsSnapshot = await rtdb.ref(LEADS_PATH).once("value");
        const leads = leadsSnapshot.val() || {};

        res.status(200).json({
            success: true,
            data: buildMeetingResponse({ ...meeting, id: meetingSnapshot.key }, leads),
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateTask = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const taskRef = rtdb.ref(`${TASKS_PATH}/${id}`);
        const snapshot = await taskRef.once("value");
        const existingTask = snapshot.val();

        if (!existingTask) {
            res.status(404).json({ success: false, message: "Task not found" });
            return;
        }

        if (!canAccessTask(req.user, existingTask)) {
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
            const dueDate = Number(req.body.dueDate);
            if (!Number.isFinite(dueDate)) {
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
            const leadId = String(req.body.leadId || "").trim();
            if (leadId) {
                const lead = await fetchLeadById(leadId);
                if (!lead) {
                    res.status(404).json({ success: false, message: "Lead not found" });
                    return;
                }
                updates.leadId = leadId;
            } else {
                updates.leadId = null;
            }
        }

        if (req.body.assignedTo !== undefined) {
            if (!USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(req.user!.role)) {
                res.status(403).json({ success: false, message: "Only admins and managers can reassign tasks" });
                return;
            }

            const assignedTo = String(req.body.assignedTo || "").trim();
            if (!assignedTo) {
                res.status(400).json({ success: false, message: "Assigned user is required" });
                return;
            }

            const assignedUser = await fetchUserById(assignedTo);
            if (!assignedUser) {
                res.status(404).json({ success: false, message: "Assigned user not found" });
                return;
            }

            updates.assignedTo = assignedTo;
            updates.assignedBy = req.user!.id;
            updates.source = resolveTaskSource(req.user!.role, existingTask.createdBy, assignedTo);
            updates.isRead = assignedTo === req.user!.id;
        }

        if (req.body.completionRemark !== undefined) {
            updates.completionRemark = String(req.body.completionRemark || "").trim() || null;
        }

        updates.updatedAt = Date.now();

        await taskRef.update(updates);

        const [tasksSnapshot, leadsSnapshot, usersSnapshot] = await Promise.all([
            taskRef.once("value"),
            rtdb.ref(LEADS_PATH).once("value"),
            rtdb.ref("users").once("value"),
        ]);

        res.status(200).json({
            success: true,
            data: buildTaskResponse({ ...tasksSnapshot.val(), id }, leadsSnapshot.val() || {}, usersSnapshot.val() || {}),
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const updateMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params as { id: string };
        const meetingRef = rtdb.ref(`${MEETINGS_PATH}/${id}`);
        const snapshot = await meetingRef.once("value");
        const existingMeeting = snapshot.val();

        if (!existingMeeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        if (!canAccessMeeting(req.user, existingMeeting)) {
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
        const nextLeadId = parsed.data.leadId ?? existingMeeting.leadId;
        const lead = await fetchLeadById(nextLeadId);

        if (!lead) {
            res.status(404).json({ success: false, message: "Lead not found for this meeting" });
            return;
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
        res.status(500).json({ success: false, message: error.message });
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
        const lead = await fetchLeadById(parsed.data.leadId!);

        if (!lead) {
            res.status(404).json({ success: false, message: "Lead not found" });
            return;
        }

        const meetingRef = rtdb.ref(MEETINGS_PATH).push();
        const attendees = attachDefaultMeetingAttendees(parsed.data.attendees || [], lead, req.user);
        const meetingData: IMeeting = {
            id: meetingRef.key!,
            subject: parsed.data.subject!,
            meetingMode: parsed.data.meetingMode || "google_meet",
            startTime: parsed.data.startTime!,
            endTime: parsed.data.endTime!,
            status: parsed.data.status || "Scheduled",
            assignedTo: userId,
            leadId: parsed.data.leadId!,
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

        await meetingRef.set(meetingData);
        await MeetingGoogleSyncService.syncMeeting(meetingData.id!);
        await addLeadTimelineEntry(meetingData.leadId, `Meeting scheduled: ${meetingData.subject}`, userId);

        const refreshedMeeting = await fetchMeetingWithLead(meetingData.id!);
        res.status(201).json({ success: true, data: refreshedMeeting });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const createTask = async (req: AuthRequest, res: Response) => {
    try {
        const { leadId, subject, dueDate, priority, status, description } = req.body;
        const userId = req.user!.id;
        const userRole = req.user!.role;
        const trimmedSubject = String(subject || "").trim();

        if (!trimmedSubject) {
            res.status(400).json({ success: false, message: "Task subject is required" });
            return;
        }

        const normalizedDueDate = Number(dueDate);
        if (!Number.isFinite(normalizedDueDate)) {
            res.status(400).json({ success: false, message: "Valid due date is required" });
            return;
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

        let assignedTo = userId;
        if (req.body.assignedTo !== undefined) {
            const requestedAssignee = String(req.body.assignedTo || "").trim();

            if (!requestedAssignee) {
                res.status(400).json({ success: false, message: "Assigned user is required" });
                return;
            }

            if (!USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(userRole) && requestedAssignee !== userId) {
                res.status(403).json({ success: false, message: "Sales reps can only create tasks for themselves" });
                return;
            }

            const assignedUser = await fetchUserById(requestedAssignee);
            if (!assignedUser) {
                res.status(404).json({ success: false, message: "Assigned user not found" });
                return;
            }

            if (USER_ROLES_WITH_GLOBAL_TASK_ACCESS.has(userRole) && !GLOBAL_TASK_ASSIGNABLE_ROLES.has(assignedUser.role)) {
                res.status(400).json({ success: false, message: "Tasks can only be assigned to sales reps or managers" });
                return;
            }

            assignedTo = requestedAssignee;
        }

        let normalizedLeadId: string | undefined;
        if (leadId) {
            normalizedLeadId = String(leadId).trim();
            const lead = await fetchLeadById(normalizedLeadId);
            if (!lead) {
                res.status(404).json({ success: false, message: "Lead not found" });
                return;
            }
        }

        const taskRef = rtdb.ref(TASKS_PATH).push();
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
            isRead: assignedTo === userId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            ...(normalizedLeadId ? { leadId: normalizedLeadId } : {}),
        };

        await taskRef.set(taskData);

        if (normalizedLeadId) {
            const leadRef = rtdb.ref(`${LEADS_PATH}/${normalizedLeadId}`);
            const leadSnap = await leadRef.once("value");
            const lead = leadSnap.val();

            if (lead) {
                const timeline = lead.timeline || [];
                timeline.push({
                    event: "Status Changed",
                    remark: `Task created: ${trimmedSubject}`,
                    performedBy: userId,
                    timestamp: Date.now(),
                });
                await leadRef.update({ timeline });
            }
        }

        const [leadsSnapshot, usersSnapshot] = await Promise.all([
            rtdb.ref(LEADS_PATH).once("value"),
            rtdb.ref("users").once("value"),
        ]);

        res.status(201).json({
            success: true,
            data: buildTaskResponse(taskData, leadsSnapshot.val() || {}, usersSnapshot.val() || {}),
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const meetingRef = rtdb.ref(`${MEETINGS_PATH}/${id}`);
        const snapshot = await meetingRef.once("value");
        const meeting = snapshot.val();

        if (!meeting) {
            res.status(404).json({ success: false, message: "Meeting not found" });
            return;
        }

        if (!canAccessMeeting(req.user, meeting)) {
            res.status(403).json({ success: false, message: "Not authorized to delete this meeting" });
            return;
        }

        await MeetingGoogleSyncService.deleteCalendarEventForMeeting({ ...meeting, id });
        await meetingRef.remove();

        res.status(200).json({ success: true, message: "Meeting deleted successfully" });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

export const deleteTask = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        const taskRef = rtdb.ref(`${TASKS_PATH}/${id}`);
        const snapshot = await taskRef.once("value");
        const task = snapshot.val();

        if (!task) {
            res.status(404).json({ success: false, message: "Task not found" });
            return;
        }

        if (!canDeleteTask(req.user, task)) {
            res.status(403).json({ success: false, message: "Not authorized to delete this task" });
            return;
        }

        await taskRef.remove();
        res.status(200).json({ success: true, message: "Task deleted successfully" });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
