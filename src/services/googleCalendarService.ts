import { google } from 'googleapis';
import { GoogleOAuthService } from './googleOAuthService.js';

const calendar = google.calendar('v3');

export interface CalendarEventData {
    summary: string;
    description?: string;
    start: { dateTime: string; timeZone: string };
    end: { dateTime: string; timeZone: string };
    attendees?: { email: string }[];
    location?: string;
}

export class GoogleCalendarService {
    static async createEvent(userId: string, eventData: CalendarEventData): Promise<{ eventId: string; meetLink?: string | null }> {
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
            sendUpdates: 'none',
            requestBody: event,
            auth: client
        });

        const meetLink = response.data.conferenceData?.entryPoints?.find((ep: any) => ep.entryPointType === 'video')?.uri;

        if (meetLink) {
            return {
                eventId: response.data.id!,
                meetLink
            };
        }

        return {
            eventId: response.data.id!
        };
    }

    static async updateEvent(userId: string, eventId: string, eventData: Partial<CalendarEventData>): Promise<void> {
        const tokens = await GoogleOAuthService.getUserTokens(userId);
        if (!tokens) throw new Error('User not connected to Google');

        const client = GoogleOAuthService.getOAuth2Client(tokens);

        await calendar.events.update({
            calendarId: 'primary',
            eventId: eventId,
            sendUpdates: 'none',
            requestBody: eventData,
            auth: client
        });
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