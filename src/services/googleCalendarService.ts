import { google } from 'googleapis';
import { GoogleOAuthService } from './googleOAuthService.js';

const calendar = google.calendar('v3');

export interface CalendarEventAttendee {
    email?: string | null;
    responseStatus?: string | null;
    displayName?: string | null;
}

export interface CalendarEventData {
    summary: string;
    description?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees?: { email: string }[];
    location?: string;
}

export interface CalendarSyncResult {
    eventId: string;
    eventLink?: string | null;
    meetLink?: string | null;
    attendees?: CalendarEventAttendee[];
}

const extractCalendarSyncResult = (event: any): CalendarSyncResult => {
    const meetLink = event?.conferenceData?.entryPoints?.find(
        (entryPoint: any) => entryPoint.entryPointType === 'video'
    )?.uri;

    return {
        eventId: event.id!,
        eventLink: event.htmlLink || null,
        meetLink: meetLink || null,
        attendees: (event.attendees || []).map((attendee: any) => ({
            email: attendee.email || null,
            responseStatus: attendee.responseStatus || null,
            displayName: attendee.displayName || null
        }))
    };
};

export class GoogleCalendarService {
    static async createEvent(userId: string, eventData: CalendarEventData): Promise<CalendarSyncResult> {
        const tokens = await GoogleOAuthService.getUserTokens(userId);
        if (!tokens) throw new Error('User not connected to Google');

        const client = GoogleOAuthService.getOAuth2Client(tokens);
        const requestId = `meet-${Date.now()}`;

        const event = {
            ...eventData,
            conferenceData: {
                createRequest: {
                    requestId: requestId,
                    conferenceSolutionKey: { type: 'hangoutsMeet' },
                    status: { statusCode: 'pending' }
                }
            }
        };

        const response = await calendar.events.insert({
            calendarId: 'primary',
            conferenceDataVersion: 1,
            sendUpdates: 'all',
            requestBody: event,
            auth: client
        });

        return extractCalendarSyncResult(response.data);
    }

    static async updateEvent(userId: string, eventId: string, eventData: Partial<CalendarEventData>): Promise<CalendarSyncResult> {
        const tokens = await GoogleOAuthService.getUserTokens(userId);
        if (!tokens) throw new Error('User not connected to Google');

        const client = GoogleOAuthService.getOAuth2Client(tokens);

        const response = await calendar.events.update({
            calendarId: 'primary',
            eventId: eventId,
            sendUpdates: 'none',
            requestBody: eventData,
            auth: client
        });

        return extractCalendarSyncResult(response.data);
    }

    static async deleteEvent(userId: string, eventId: string): Promise<void> {
        const tokens = await GoogleOAuthService.getUserTokens(userId);
        if (!tokens) throw new Error('User not connected to Google');

        const client = GoogleOAuthService.getOAuth2Client(tokens);

        await calendar.events.delete({
            calendarId: 'primary',
            eventId: eventId,
            auth: client,
            sendUpdates: 'none'
        });
    }

    static async listEvents(
    userId: string,
    timeMin?: string,
    timeMax?: string
) {
    const tokens = await GoogleOAuthService.getUserTokens(userId);
    if (!tokens) throw new Error('User not connected to Google');

    const client = GoogleOAuthService.getOAuth2Client(tokens);

    const requestParams: any = {
        calendarId: 'primary',
        auth: client,
        singleEvents: true,
        orderBy: 'startTime',
        timeMin: timeMin || new Date().toISOString(),
        maxResults: 50,
    };

    if (timeMax) {
        requestParams.timeMax = timeMax;
    }

    const response = await calendar.events.list(requestParams);

    return response.data?.items || [];
}
}
