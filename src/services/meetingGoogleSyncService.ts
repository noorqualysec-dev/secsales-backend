import { Lead, Meeting, User } from "../models/mongoModels.js";
import { GoogleCalendarService, type CalendarEventData } from "./googleCalendarService.js";
import { GoogleOAuthService } from "./googleOAuthService.js";
import type { IMeeting, IMeetingAttendee } from "../models/meetingModel.js";

const mergeAttendees = (
  attendees: IMeetingAttendee[] = [],
  lead: { email?: string; firstName?: string; lastName?: string } | null,
  user: { email?: string; name?: string } | null,
): { email: string }[] => {
  const result = new Map<string, { email: string }>();
  for (const attendee of attendees) {
    if (attendee.email) result.set(attendee.email.toLowerCase(), { email: attendee.email });
  }
  if (lead?.email) result.set(lead.email.toLowerCase(), { email: lead.email });
  if (user?.email) result.set(user.email.toLowerCase(), { email: user.email });
  return [...result.values()];
};

const buildMeetingEventData = (
  meeting: IMeeting,
  lead: { email?: string; firstName?: string; lastName?: string } | null,
  user: { email?: string; name?: string } | null,
): CalendarEventData => {
  const event: CalendarEventData = {
    summary: meeting.subject,
    start: { dateTime: new Date(meeting.startTime).toISOString(), timeZone: "UTC" },
    end: { dateTime: new Date(meeting.endTime).toISOString(), timeZone: "UTC" },
    attendees: mergeAttendees(meeting.attendees, lead, user),
  };
  const description = meeting.description || meeting.agenda;
  if (description) event.description = description;
  if (meeting.location) event.location = meeting.location;
  return event;
};

export class MeetingGoogleSyncService {
  static async syncMeeting(meetingId: string): Promise<void> {
    const meeting = await Meeting.findById(meetingId).lean();
    if (!meeting) throw new Error("Meeting not found");
    const userId = meeting.assignedTo.toString();

    try {
      const tokens = await GoogleOAuthService.getUserTokens(userId);
      if (!tokens) {
        await Meeting.updateOne(
          { _id: meetingId },
          { $set: { syncStatus: "pending", syncError: "Google account not connected" } },
        );
        return;
      }
      const [lead, user] = await Promise.all([
        meeting.leadId ? Lead.findById(meeting.leadId).select("email firstName lastName").lean() : Promise.resolve(null),
        User.findById(userId).select("email name").lean(),
      ]);
      const legacyMeeting: IMeeting = {
        id: meeting._id.toString(),
        subject: meeting.subject,
        startTime: meeting.startTime.getTime(),
        endTime: meeting.endTime.getTime(),
        status: meeting.status,
        assignedTo: userId,
        leadId: meeting.leadId ? meeting.leadId.toString() : "",
        createdBy: meeting.createdBy.toString(),
        createdAt: meeting.createdAt.getTime(),
        updatedAt: meeting.updatedAt.getTime(),
        ...(meeting.description ? { description: meeting.description } : {}),
        ...(meeting.agenda ? { agenda: meeting.agenda } : {}),
        ...(meeting.location ? { location: meeting.location } : {}),
        ...(meeting.meetingMode ? { meetingMode: meeting.meetingMode } : {}),
        ...(meeting.attendees
          ? {
              attendees: meeting.attendees.map((attendee) => ({
                email: attendee.email,
                type: attendee.type,
                responseStatus: attendee.responseStatus,
                ...(attendee.name ? { name: attendee.name } : {}),
              })),
            }
          : {}),
        ...(meeting.googleEventId ? { googleEventId: meeting.googleEventId } : {}),
      };
      const data = buildMeetingEventData(
        legacyMeeting,
        lead ? { email: lead.email, firstName: lead.firstName, ...(lead.lastName ? { lastName: lead.lastName } : {}) } : null,
        user ? { email: user.email, name: user.name } : null,
      );

      const update = (values: Record<string, unknown>) =>
        Meeting.updateOne({ _id: meetingId }, { $set: values });

      if (meeting.status === "Cancelled" && meeting.googleEventId) {
        await GoogleCalendarService.deleteEvent(userId, meeting.googleEventId);
        await update({
          googleEventId: undefined,
          googleEventLink: undefined,
          meetLink: undefined,
          syncStatus: "success",
          syncError: undefined,
          lastSyncedAt: new Date(),
        });
      } else if (meeting.googleEventId) {
        const synced = await GoogleCalendarService.updateEvent(userId, meeting.googleEventId, data);
        await update({
          googleEventLink: synced.eventLink || undefined,
          meetLink: synced.meetLink || undefined,
          syncStatus: "success",
          syncError: undefined,
          lastSyncedAt: new Date(),
        });
      } else if (meeting.status === "Scheduled") {
        const synced = await GoogleCalendarService.createEvent(userId, data);
        await update({
          googleEventId: synced.eventId,
          googleEventLink: synced.eventLink || undefined,
          meetLink: synced.meetLink || undefined,
          syncStatus: "success",
          syncError: undefined,
          lastSyncedAt: new Date(),
        });
      }
    } catch (error) {
      console.error("Google Calendar sync failed:", error);
      await Meeting.updateOne(
        { _id: meetingId },
        {
          $set: {
            syncStatus: "failed",
            syncError: error instanceof Error ? error.message.slice(0, 500) : "Google Calendar sync failed",
          },
        },
      );
      throw error;
    }
  }

  static async deleteCalendarEventForMeeting(meeting: IMeeting): Promise<void> {
    if (!meeting.googleEventId) return;
    const tokens = await GoogleOAuthService.getUserTokens(meeting.assignedTo);
    if (!tokens) return;
    await GoogleCalendarService.deleteEvent(meeting.assignedTo, meeting.googleEventId);
  }
}
