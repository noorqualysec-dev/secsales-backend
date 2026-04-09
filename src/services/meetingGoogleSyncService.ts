import admin from '../config/firebase.js';
import { GoogleCalendarService, type CalendarEventData } from './googleCalendarService.js';
import { GoogleOAuthService } from './googleOAuthService.js';

export class MeetingGoogleSyncService {
    static async syncMeeting(meetingId: string): Promise<void> {
        try {
            // Get meeting
            const meetingSnapshot = await admin.database().ref(`meetings/${meetingId}`).once('value');
            const meeting = meetingSnapshot.val();
            if (!meeting) throw new Error('Meeting not found');

            const userId = meeting.assignedTo;
            const tokens = await GoogleOAuthService.getUserTokens(userId);
            if (!tokens) {
                console.log('User not connected to Google, skipping sync');
                return;
            }

            // Get lead for attendees
            const leadSnapshot = await admin.database().ref(`leads/${meeting.leadId}`).once('value');
            const lead = leadSnapshot.val();

            // Get user email
            const userSnapshot = await admin.database().ref(`users/${userId}`).once('value');
            const user = userSnapshot.val();

            const attendees = [];
            if (lead?.email) attendees.push({ email: lead.email });
            if (user?.email) attendees.push({ email: user.email });

            const eventData: CalendarEventData = {
                summary: meeting.title,
                start: {
                    dateTime: new Date(meeting.from).toISOString(),
                    timeZone: 'UTC'
                },
                end: {
                    dateTime: new Date(meeting.to).toISOString(),
                    timeZone: 'UTC'
                },
                attendees: attendees
            };

            if (meeting.status === 'Cancelled' && meeting.googleEventId) {
                // Delete event
                await GoogleCalendarService.deleteEvent(userId, meeting.googleEventId);
                await admin.database().ref(`meetings/${meetingId}`).update({
                    googleEventId: null,
                    meetLink: null,
                    syncStatus: 'synced',
                    updatedAt: Date.now()
                });
            } else if (meeting.googleEventId) {
                // Update event
                await GoogleCalendarService.updateEvent(userId, meeting.googleEventId, eventData);
                await admin.database().ref(`meetings/${meetingId}`).update({
                    syncStatus: 'synced',
                    updatedAt: Date.now()
                });
            } else if (meeting.status === 'Scheduled') {
                // Create event
                const { eventId, meetLink } = await GoogleCalendarService.createEvent(userId, eventData);
                await admin.database().ref(`meetings/${meetingId}`).update({
                    googleEventId: eventId,
                    meetLink: meetLink,
                    syncStatus: 'synced',
                    updatedAt: Date.now()
                });
            }
        } catch (error) {
            console.error('Sync error:', error);
            await admin.database().ref(`meetings/${meetingId}`).update({
                syncStatus: 'failed',
                updatedAt: Date.now()
            });
        }
    }
}