import admin from '../config/firebase.js';
import { GoogleCalendarService, type CalendarEventData } from './googleCalendarService.js';
import { GoogleOAuthService } from './googleOAuthService.js';
import type { IMeeting, IMeetingAttendee } from '../models/meetingModel.js';

const MEETINGS_PATH = 'meetings';
const LEADS_PATH = 'leads';
const USERS_PATH = 'users';

const mergeAttendees = (
    meetingAttendees: IMeetingAttendee[] = [],
    lead: any,
    user: any
): { email: string }[] => {
    const attendeeMap = new Map<string, { email: string }>();

    for (const attendee of meetingAttendees) {
        if (!attendee?.email) continue;
        attendeeMap.set(attendee.email.toLowerCase(), { email: attendee.email });
    }

    if (lead?.email) {
        attendeeMap.set(String(lead.email).toLowerCase(), { email: lead.email });
    }

    if (user?.email) {
        attendeeMap.set(String(user.email).toLowerCase(), { email: user.email });
    }

    return Array.from(attendeeMap.values());
};

const buildMeetingEventData = (meeting: IMeeting, lead: any, user: any): CalendarEventData => {
    const eventData: CalendarEventData = {
        summary: meeting.subject,
        start: {
            dateTime: new Date(meeting.startTime).toISOString(),
            timeZone: 'UTC'
        },
        end: {
            dateTime: new Date(meeting.endTime).toISOString(),
            timeZone: 'UTC'
        },
        attendees: mergeAttendees(meeting.attendees, lead, user)
    };

    const description = meeting.description || meeting.agenda;
    if (description) eventData.description = description;
    if (meeting.location) eventData.location = meeting.location;

    return eventData;
};

export class MeetingGoogleSyncService {
    static async syncMeeting(meetingId: string): Promise<void> {
        try {
            const meetingRef = admin.database().ref(`${MEETINGS_PATH}/${meetingId}`);
            const meetingSnapshot = await meetingRef.once('value');
            const meeting = meetingSnapshot.val() as IMeeting | null;
            if (!meeting) throw new Error('Meeting not found');

            const userId = meeting.assignedTo;
            const tokens = await GoogleOAuthService.getUserTokens(userId);
            if (!tokens) {
                await meetingRef.update({
                    syncStatus: 'pending',
                    syncError: 'Google account not connected',
                    updatedAt: Date.now()
                });
                return;
            }

            const leadSnapshot = await admin.database().ref(`${LEADS_PATH}/${meeting.leadId}`).once('value');
            const lead = leadSnapshot.val();

            const userSnapshot = await admin.database().ref(`${USERS_PATH}/${userId}`).once('value');
            const user = userSnapshot.val();

            const eventData = buildMeetingEventData(meeting, lead, user);

            if (meeting.status === 'Cancelled' && meeting.googleEventId) {
                await GoogleCalendarService.deleteEvent(userId, meeting.googleEventId);
                await meetingRef.update({
                    googleEventId: null,
                    googleEventLink: null,
                    meetLink: null,
                    syncStatus: 'success',
                    syncError: null,
                    lastSyncedAt: Date.now(),
                    updatedAt: Date.now()
                });
            } else if (meeting.googleEventId) {
                const syncResult = await GoogleCalendarService.updateEvent(userId, meeting.googleEventId, eventData);
                await meetingRef.update({
                    googleEventLink: syncResult.eventLink || null,
                    meetLink: syncResult.meetLink || null,
                    attendees: (meeting.attendees || []).map((attendee) => {
                        const matchedAttendee = syncResult.attendees?.find(
                            (calendarAttendee) =>
                                calendarAttendee.email?.toLowerCase() === attendee.email.toLowerCase()
                        );

                        return {
                            ...attendee,
                            responseStatus: (matchedAttendee?.responseStatus as IMeetingAttendee['responseStatus']) || attendee.responseStatus || 'needsAction'
                        };
                    }),
                    syncStatus: 'success',
                    syncError: null,
                    lastSyncedAt: Date.now(),
                    updatedAt: Date.now()
                });
            } else if (meeting.status === 'Scheduled') {
                const syncResult = await GoogleCalendarService.createEvent(userId, eventData);
                await meetingRef.update({
                    googleEventId: syncResult.eventId,
                    googleEventLink: syncResult.eventLink || null,
                    meetLink: syncResult.meetLink || null,
                    attendees: (meeting.attendees || []).map((attendee) => {
                        const matchedAttendee = syncResult.attendees?.find(
                            (calendarAttendee) =>
                                calendarAttendee.email?.toLowerCase() === attendee.email.toLowerCase()
                        );

                        return {
                            ...attendee,
                            responseStatus: (matchedAttendee?.responseStatus as IMeetingAttendee['responseStatus']) || attendee.responseStatus || 'needsAction'
                        };
                    }),
                    syncStatus: 'success',
                    syncError: null,
                    lastSyncedAt: Date.now(),
                    updatedAt: Date.now()
                });
            }
        } catch (error) {
            console.error('Sync error:', error);
            await admin.database().ref(`${MEETINGS_PATH}/${meetingId}`).update({
                syncStatus: 'failed',
                syncError: error instanceof Error ? error.message : 'Google Calendar sync failed',
                updatedAt: Date.now()
            });
        }
    }

    static async deleteCalendarEventForMeeting(meeting: IMeeting): Promise<void> {
        if (!meeting.googleEventId) return;

        const tokens = await GoogleOAuthService.getUserTokens(meeting.assignedTo);
        if (!tokens) return;

        await GoogleCalendarService.deleteEvent(meeting.assignedTo, meeting.googleEventId);
    }
}
