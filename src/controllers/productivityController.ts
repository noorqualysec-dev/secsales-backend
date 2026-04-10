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

const LEADS_PATH = "leads";
const TASKS_PATH = "tasks";
const MEETINGS_PATH = "meetings";
const USER_ROLES_WITH_GLOBAL_MEETING_ACCESS = new Set(["admin", "manager"]);
const ALLOWED_MEETING_STATUSES = new Set<MeetingStatus>(["Scheduled", "Completed", "Cancelled"]);
const ALLOWED_MEETING_MODES = new Set<MeetingMode>(["google_meet", "zoom", "phone", "in_person", "other"]);

const getMeetingStartTime = (meeting: any): number => Number(meeting.startTime ?? meeting.from ?? 0);
const getMeetingEndTime = (meeting: any): number => Number(meeting.endTime ?? meeting.to ?? 0);
const getMeetingSubject = (meeting: any): string => String(meeting.subject ?? meeting.title ?? "");

const canAccessMeeting = (user: AuthRequest["user"], meeting: any): boolean => {
    if (!user) return false;
    return USER_ROLES_WITH_GLOBAL_MEETING_ACCESS.has(user.role) || meeting.assignedTo === user.id;
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
        const updates = req.body;
        await rtdb.ref(`${TASKS_PATH}/${id}`).update({ ...updates, updatedAt: Date.now() });
        res.status(200).json({ success: true });
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
        const { leadId, subject, dueDate, priority } = req.body;
        const userId = req.user!.id;

        const taskRef = rtdb.ref(TASKS_PATH).push();
        const taskData = {
            id: taskRef.key,
            subject,
            dueDate: Number(dueDate),
            status: "Pending",
            priority: priority || "Medium",
            assignedTo: userId,
            leadId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };

        await taskRef.set(taskData);

        if (leadId) {
            const leadRef = rtdb.ref(`${LEADS_PATH}/${leadId}`);
            const leadSnap = await leadRef.once("value");
            const lead = leadSnap.val();

            if (lead) {
                const timeline = lead.timeline || [];
                timeline.push({
                    event: "Status Changed",
                    remark: `Task created: ${subject}`,
                    performedBy: userId,
                    timestamp: Date.now(),
                });
                await leadRef.update({ timeline });
            }
        }

        res.status(201).json({ success: true, data: taskData });
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
        await rtdb.ref(`${TASKS_PATH}/${id}`).remove();
        res.status(200).json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
