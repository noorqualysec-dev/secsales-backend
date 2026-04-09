import type { Response } from "express";
import type { AuthRequest } from "../middleware/authMiddleware.js";
import { rtdb } from "../config/firebase.js";
import { MeetingGoogleSyncService } from "../services/meetingGoogleSyncService.js";

const LEADS_PATH = "leads";
const TASKS_PATH = "tasks";
const MEETINGS_PATH = "meetings";

/**
 * @desc    Get dashboard metrics with date filtering
 */
export const getSalesSummary = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const { startDate, endDate } = req.query;
        
        const now = Date.now();
        const startOfToday = new Date().setHours(0, 0, 0, 0);
        
        // Filter logic
        let filterStart = startDate ? Number(startDate) : 0;
        let filterEnd = endDate ? Number(endDate) : 9999999999999;

        const [leadsSnap, tasksSnap, meetingsSnap] = await Promise.all([
            rtdb.ref(LEADS_PATH).once("value"),
            rtdb.ref(TASKS_PATH).once("value"),
            rtdb.ref(MEETINGS_PATH).once("value")
        ]);

        const leads = leadsSnap.val() || {};
        const tasks = tasksSnap.val() || {};
        const meetings = meetingsSnap.val() || {};

        // Ensure all objects have their IDs injected from the DB keys
        const leadsWithIds = Object.entries(leads).map(([id, l]: [string, any]) => ({ ...l, id, _id: id }));
        const tasksWithIds = Object.entries(tasks).map(([id, t]: [string, any]) => ({ ...t, id }));
        const meetingsWithIds = Object.entries(meetings).map(([id, m]: [string, any]) => ({ ...m, id }));

        const myLeads = leadsWithIds.filter((l: any) => l.assignedTo === userId);
        
        // Helper to attach lead info
        const attachLead = (item: any) => {
            if (item.leadId && leads[item.leadId]) {
                const l = leads[item.leadId];
                return { ...item, leadName: `${l.firstName} ${l.lastName}`, company: l.company || "Individual" };
            }
            return item;
        };

        const stats = {
            openDeals: myLeads.filter((l: any) => !["Won", "Lost"].includes(l.status)).length,
            untouchedDeals: myLeads.filter((l: any) => !l.timeline || l.timeline.length <= 1).length,
            callsToday: meetingsWithIds.filter((m: any) => 
                m.assignedTo === userId && 
                m.from >= startOfToday && 
                m.from <= (startOfToday + 86400000)
            ).length,
            totalMyLeads: myLeads.length,
            
            // Period specific aggregates with POPULATED lead data
            openTasks: tasksWithIds
                .filter((t: any) => t.assignedTo === userId && t.status !== "Completed")
                .map(attachLead),
            meetings: meetingsWithIds
                .filter((m: any) => m.assignedTo === userId && m.from >= filterStart && m.from <= filterEnd)
                .map(attachLead),
            todaysLeads: myLeads.filter((l: any) => l.createdAt >= startOfToday),
            dealsClosingThisMonth: myLeads.filter((l: any) => {
                const closingDate = l.closingDate || 0;
                const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
                const endOfMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getTime();
                return closingDate >= startOfMonth && closingDate <= endOfMonth;
            })
        };

        res.status(200).json({ success: true, data: stats });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Update an existing task
 */
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

/**
 * @desc    Update an existing meeting
 */
export const updateMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params as { id: string };
        const updates = req.body;
        await rtdb.ref(`${MEETINGS_PATH}/${id}`).update({ ...updates, updatedAt: Date.now() });

        // Sync to Google Calendar
        MeetingGoogleSyncService.syncMeeting(id).catch(console.error);

        res.status(200).json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Schedule a meeting (Discovery Call)
 */
export const scheduleMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { leadId, title, from, to } = req.body;
        const userId = req.user!.id;

        const meetingRef = rtdb.ref(MEETINGS_PATH).push();
        const meetingData = {
            id: meetingRef.key,
            title,
            from: Number(from),
            to: Number(to),
            status: "Scheduled",
            assignedTo: userId,
            leadId,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };

        await meetingRef.set(meetingData);

        // Sync to Google Calendar
        MeetingGoogleSyncService.syncMeeting(meetingData.id).catch(console.error);
        
        // Update lead timeline
        const leadRef = rtdb.ref(`${LEADS_PATH}/${leadId}`);
        const leadSnap = await leadRef.once("value");
        const lead = leadSnap.val();
        
        if (lead) {
            const timeline = lead.timeline || [];
            timeline.push({
                event: "Status Changed", // Or custom "Meeting Scheduled" if we add it
                remark: `Meeting scheduled: ${title}`,
                performedBy: userId,
                timestamp: Date.now()
            });
            await leadRef.update({ timeline });
        }

        res.status(201).json({ success: true, data: meetingData });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Create a new task
 */
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
            updatedAt: Date.now()
        };

        await taskRef.set(taskData);

        // Update lead timeline if leadId provided
        if (leadId) {
            const leadRef = rtdb.ref(`${LEADS_PATH}/${leadId}`);
            const leadSnap = await leadRef.once("value");
            const lead = leadSnap.val();

            if (lead) {
                const timeline = lead.timeline || [];
                timeline.push({
                    event: "Task Created",
                    remark: `Task created: ${subject}`,
                    performedBy: userId,
                    timestamp: Date.now()
                });
                await leadRef.update({ timeline });
            }
        }

        res.status(201).json({ success: true, data: taskData });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Delete a meeting
 */
export const deleteMeeting = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        await rtdb.ref(`${MEETINGS_PATH}/${id}`).remove();
        res.status(200).json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * @desc    Delete a task
 */
export const deleteTask = async (req: AuthRequest, res: Response) => {
    try {
        const { id } = req.params;
        await rtdb.ref(`${TASKS_PATH}/${id}`).remove();
        res.status(200).json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
};
