import { model, Schema, type Types } from "mongoose";
import {
  LEAD_OUTCOMES,
  LEAD_REGIONS,
  LEAD_SOURCES,
  LEAD_STATUSES,
} from "./leadModel.js";
import { PROPOSAL_STATUSES } from "./proposalModel.js";
import { TASK_PRIORITIES, TASK_SOURCES, TASK_STATUSES } from "./taskModel.js";
import {
  MEETING_MODES,
  MEETING_STATUSES,
  MEETING_SYNC_STATUSES,
} from "./meetingModel.js";

const id = Schema.Types.ObjectId;
const timestamps = { timestamps: true, versionKey: false } as const;

const googleCredentialsSchema = new Schema(
  {
    accessTokenEncrypted: { type: String, select: false },
    refreshTokenEncrypted: { type: String, select: false },
    expiry: Date,
  },
  { _id: false },
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["admin", "manager", "sales_rep"], required: true, default: "sales_rep" },
    teamIds: { type: [id], ref: "Team", default: [] },
    isActive: { type: Boolean, required: true, default: true },
    invitedAt: Date,
    activatedAt: Date,
    deactivatedAt: Date,
    googleCredentials: { type: googleCredentialsSchema, select: false },
  },
  { ...timestamps, collection: "users", strict: "throw" },
);
userSchema.index({ email: 1 }, { unique: true, name: "users_email_unique" });
userSchema.index({ isActive: 1, role: 1 });
userSchema.index({ teamIds: 1, isActive: 1 });

const teamSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    managerIds: { type: [id], ref: "User", default: [] },
    isActive: { type: Boolean, required: true, default: true },
    createdBy: { type: id, ref: "User", required: true },
  },
  { ...timestamps, collection: "teams", strict: "throw" },
);
teamSchema.index({ name: 1 }, { unique: true, name: "teams_name_unique" });

const leadContactSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    fullName: { type: String, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: String,
    phoneCountryCode: String,
    designation: String,
    department: String,
    isPrimary: { type: Boolean, default: false },
    isDecisionMaker: { type: Boolean, default: false },
    isInfluencer: { type: Boolean, default: false },
    isTechnicalContact: { type: Boolean, default: false },
    isBillingContact: { type: Boolean, default: false },
    linkedinUrl: String,
    notes: String,
    source: String,
    addedAt: { type: Date, required: true, default: Date.now },
    updatedAt: { type: Date, required: true, default: Date.now },
    addedBy: { type: id, ref: "User", required: true },
    lastContactedAt: Date,
    nextFollowUpAt: Date,
    contactStatus: { type: String, enum: ["active", "inactive", "unresponsive", "left_company"] },
    preferredChannel: { type: String, enum: ["email", "phone", "whatsapp", "linkedin"] },
    employmentStage: { type: String, enum: ["current", "joining_soon", "newly_joined"] },
    joinedOn: Date,
  },
  { timestamps: false },
);

const companyLocationSchema = new Schema(
  {
    formattedAddress: String,
    street: String,
    locality: String,
    region: String,
    postalCode: String,
    country: String,
    placeId: String,
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    provider: { type: String, enum: ["google_places", "manual"] },
    verifiedAt: Date,
  },
  { _id: false },
);

const leadSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    designation: String,
    employeeStrength: { type: String, enum: ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"] },
    phone: String,
    phoneCountryCode: String,
    company: { type: String, trim: true },
    country: String,
    region: { type: String, enum: LEAD_REGIONS },
    industry: String,
    companyLocation: companyLocationSchema,
    status: { type: String, enum: LEAD_STATUSES, required: true, default: "Lead Captured" },
    outcome: { type: String, enum: LEAD_OUTCOMES, required: true, default: "open" },
    lostAtStatus: { type: String, enum: LEAD_STATUSES },
    wonAtStatus: { type: String, enum: LEAD_STATUSES },
    closedAt: Date,
    lostReason: String,
    wonReason: String,
    cancellationReason: String,
    wasEverWon: { type: Boolean, default: false },
    latestRemark: String,
    source: { type: String, enum: LEAD_SOURCES, required: true },
    assignedTo: { type: id, ref: "User", default: null },
    createdBy: { type: id, ref: "User", required: true, immutable: true },
    contacts: { type: [leadContactSchema], default: [] },
    primaryContactId: id,
    closingDate: Date,
    dealValue: Schema.Types.Decimal128,
    lastMeaningfulActivityAt: { type: Date, required: true },
    lastReminderAt: Date,
    followUpReminderCount: { type: Number, default: 0, min: 0 },
    nextReminderDueAt: Date,
    companyInsights: {
      hiringSignal: String,
      recentTrigger: String,
      nextOpportunity: String,
      accountNotes: String,
    },
  },
  {
    ...timestamps,
    versionKey: "__v",
    collection: "leads",
    strict: "throw",
    optimisticConcurrency: true,
  },
);
leadSchema.index({ outcome: 1, status: 1, assignedTo: 1 });
leadSchema.index({ assignedTo: 1, updatedAt: -1 });
leadSchema.index({ createdBy: 1, createdAt: -1 });
leadSchema.index({ nextReminderDueAt: 1, outcome: 1 });

const proposalSchema = new Schema(
  {
    leadId: { type: id, ref: "Lead", required: true, immutable: true },
    status: { type: String, enum: PROPOSAL_STATUSES, required: true, default: "Draft" },
    currentRevisionId: { type: id, ref: "ProposalRevision" },
    currentRevisionNumber: { type: Number, min: 1, default: 1 },
    createdBy: { type: id, ref: "User", required: true, immutable: true },
    voidedAt: Date,
    voidedBy: { type: id, ref: "User" },
    voidReason: String,
  },
  { ...timestamps, versionKey: "__v", collection: "proposals", strict: "throw", optimisticConcurrency: true },
);
proposalSchema.index({ leadId: 1 }, { unique: true, name: "one_proposal_per_lead" });
proposalSchema.index({ status: 1, updatedAt: -1 });

const proposalRevisionSchema = new Schema(
  {
    proposalId: { type: id, ref: "Proposal", required: true, immutable: true },
    leadId: { type: id, ref: "Lead", required: true, immutable: true },
    revisionNumber: { type: Number, required: true, min: 1, immutable: true },
    scope: { type: [String], required: true, default: [], immutable: true },
    testingServices: { type: [Schema.Types.Mixed], default: [], immutable: true },
    value: { type: Schema.Types.Decimal128, immutable: true },
    currency: { type: String, uppercase: true, minlength: 3, maxlength: 3, immutable: true },
    commercialTerms: { type: String, immutable: true },
    notes: { type: String, immutable: true },
    statusAtCreation: { type: String, enum: PROPOSAL_STATUSES, required: true, immutable: true },
    reason: { type: String, immutable: true },
    customerRequestOrResponse: { type: String, immutable: true },
    preparedBy: { type: id, ref: "User", required: true, immutable: true },
    preparedAt: { type: Date, required: true, immutable: true },
  },
  {
    collection: "proposalRevisions",
    versionKey: false,
    timestamps: { createdAt: true, updatedAt: false },
    strict: "throw",
  },
);
proposalRevisionSchema.index(
  { proposalId: 1, revisionNumber: 1 },
  { unique: true, name: "proposal_revision_sequence" },
);
proposalRevisionSchema.index({ leadId: 1, createdAt: -1 });

const negotiationEventSchema = new Schema(
  {
    proposalId: { type: id, ref: "Proposal", required: true },
    leadId: { type: id, ref: "Lead", required: true },
    revisionId: { type: id, ref: "ProposalRevision" },
    type: {
      type: String,
      enum: [
        "Draft",
        "Proposal Sent",
        "Negotiation",
        "Won",
        "Lost",
      ],
      set: (val: string) => {
        if (!val) return val;
        const normalized = val.trim().toLowerCase();
        if (normalized === "draft") return "Draft";
        if (normalized === "sent" || normalized === "proposal_sent" || normalized === "proposal sent") return "Proposal Sent";
        if (normalized === "negotiation" || normalized === "in_negotiation" || normalized === "revision") return "Negotiation";
        if (normalized === "won" || normalized === "accepted") return "Won";
        if (normalized === "lost" || normalized === "rejected" || normalized === "declined") return "Lost";
        return val;
      },
      required: true,
    },
    fromStatus: { type: String, enum: PROPOSAL_STATUSES },
    toStatus: { type: String, enum: PROPOSAL_STATUSES },
    customerMessage: String,
    changedFields: { type: [String], default: [] },
    note: String,
    actorId: { type: id, ref: "User", required: true },
    occurredAt: { type: Date, required: true, default: Date.now },
  },
  { collection: "negotiationEvents", versionKey: false, timestamps: { createdAt: true, updatedAt: false }, strict: "throw" },
);
negotiationEventSchema.index({ proposalId: 1, occurredAt: 1 });
negotiationEventSchema.index({ leadId: 1, occurredAt: -1 });

const auditEventSchema = new Schema(
  {
    entityType: { type: String, enum: ["lead", "user", "team", "proposal", "task", "meeting", "system_setting"], required: true },
    entityId: { type: id, required: true },
    leadId: { type: id, ref: "Lead" },
    eventType: { type: String, required: true },
    actorId: { type: id, ref: "User", required: true },
    occurredAt: { type: Date, required: true, default: Date.now },
    meaningfulActivity: { type: Boolean, required: true, default: false },
    changes: {
      type: [{ field: { type: String, required: true }, before: Schema.Types.Mixed, after: Schema.Types.Mixed }],
      default: [],
    },
    note: String,
    reason: String,
    metadata: Schema.Types.Mixed,
  },
  { collection: "auditEvents", versionKey: false, timestamps: { createdAt: true, updatedAt: false }, strict: true },
);
auditEventSchema.index({ leadId: 1, occurredAt: -1 });
auditEventSchema.index({ entityType: 1, entityId: 1, occurredAt: -1 });
auditEventSchema.index({ actorId: 1, occurredAt: -1 });

const taskSchema = new Schema(
  {
    subject: { type: String, required: true, trim: true },
    description: String,
    dueDate: { type: Date, required: true },
    status: { type: String, enum: TASK_STATUSES, required: true, default: "Pending" },
    priority: { type: String, enum: TASK_PRIORITIES, required: true, default: "Medium" },
    assignedTo: { type: [id], ref: "User", required: true, validate: (ids: Types.ObjectId[]) => ids.length > 0 },
    assignedBy: { type: id, ref: "User", required: true },
    createdBy: { type: id, ref: "User", required: true },
    source: { type: String, enum: TASK_SOURCES, required: true },
    leadId: { type: id, ref: "Lead" },
    isRead: { type: Boolean, default: false },
    completedAt: Date,
    completedBy: { type: id, ref: "User" },
    completionRemark: String,
  },
  { ...timestamps, collection: "tasks", strict: true },
);
taskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });
taskSchema.index({ leadId: 1, createdAt: -1 });
taskSchema.index({ status: 1, dueDate: 1 });

const meetingAttendeeSchema = new Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    name: String,
    type: { type: String, enum: ["sales_rep", "lead", "external"], default: "external" },
    responseStatus: { type: String, enum: ["needsAction", "accepted", "declined", "tentative"], default: "needsAction" },
  },
  { _id: false },
);
const meetingSchema = new Schema(
  {
    subject: { type: String, required: true, trim: true },
    description: String,
    agenda: String,
    location: String,
    meetingMode: { type: String, enum: MEETING_MODES, default: "other" },
    startTime: { type: Date, required: true },
    endTime: {
      type: Date,
      required: true,
      validate: {
        validator(this: any, value: Date) {
          const start = this?.startTime ?? (this?.getUpdate ? (this.getUpdate()?.startTime ?? this.getUpdate()?.$set?.startTime) : undefined);
          return !start || value > start;
        },
        message: "Meeting end must be after start",
      },
    },
    status: { type: String, enum: MEETING_STATUSES, required: true, default: "Scheduled" },
    assignedTo: { type: id, ref: "User", required: true },
    leadId: { type: id, ref: "Lead" },
    createdBy: { type: id, ref: "User", required: true },
    attendees: { type: [meetingAttendeeSchema], default: [] },
    googleEventId: String,
    googleEventLink: String,
    meetLink: String,
    syncStatus: { type: String, enum: MEETING_SYNC_STATUSES, default: "pending" },
    syncError: String,
    lastSyncedAt: Date,
  },
  { ...timestamps, collection: "meetings", strict: true },
);
meetingSchema.index({ leadId: 1, startTime: 1 });
meetingSchema.index({ assignedTo: 1, startTime: 1, status: 1 });
meetingSchema.index({ googleEventId: 1 }, { unique: true, sparse: true });

const notificationSchema = new Schema(
  {
    userId: { type: id, ref: "User", required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    leadId: { type: id, ref: "Lead" },
    taskId: { type: id, ref: "Task" },
    actionUrl: String,
    dedupeKey: String,
    read: { type: Boolean, default: false },
    readAt: Date,
  },
  { ...timestamps, collection: "notifications", strict: "throw" },
);
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ leadId: 1, createdAt: -1 });
notificationSchema.index({ taskId: 1, createdAt: -1 });

const reminderDeliverySchema = new Schema(
  {
    kind: { type: String, enum: ["lead_inactivity", "task_due", "task_overdue"], required: true },
    leadId: { type: id, ref: "Lead" },
    taskId: { type: id, ref: "Task" },
    recipientId: { type: id, ref: "User", required: true },
    cycleKey: { type: String, required: true },
    dedupeKey: { type: String, required: true },
    status: { type: String, enum: ["pending", "sending", "sent", "failed", "cancelled"], required: true, default: "pending" },
    attemptCount: { type: Number, min: 0, default: 0 },
    nextAttemptAt: Date,
    lastAttemptAt: Date,
    sentAt: Date,
    lastError: String,
    notificationId: { type: id, ref: "Notification" },
  },
  { ...timestamps, collection: "reminderDeliveries", strict: "throw" },
);
reminderDeliverySchema.index({ dedupeKey: 1 }, { unique: true });
reminderDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
reminderDeliverySchema.index({ leadId: 1, createdAt: -1 });
reminderDeliverySchema.index({ taskId: 1, createdAt: -1 });

const systemSettingSchema = new Schema(
  {
    _id: { type: String, default: "organization" },
    timezone: { type: String, required: true, default: "UTC" },
    leadReminderPolicy: {
      stageThresholds: {
        type: [{ stage: { type: String, enum: LEAD_STATUSES, required: true }, duration: { type: Number, required: true, min: 1 }, unit: { type: String, enum: ["minutes", "hours"], required: true } }],
        default: [],
      },
      repeatAfter: { duration: Number, unit: { type: String, enum: ["minutes", "hours", "business_days"] } },
    },
    taskReminderPolicy: {
      enabled: { type: Boolean, default: false },
      dueSoonOffsets: { type: [{ duration: Number, unit: { type: String, enum: ["minutes", "hours", "days"] } }], default: [] },
      overdueRepeatAfter: { duration: Number, unit: { type: String, enum: ["minutes", "hours", "days"] } },
    },
    updatedBy: { type: id, ref: "User" },
  },
  { ...timestamps, collection: "systemSettings", strict: "throw" },
);

export const User = model("User", userSchema);
export const Team = model("Team", teamSchema);
export const Lead = model("Lead", leadSchema);
export const Proposal = model("Proposal", proposalSchema);
export const ProposalRevision = model("ProposalRevision", proposalRevisionSchema);
export const NegotiationEvent = model("NegotiationEvent", negotiationEventSchema);
export const AuditEvent = model("AuditEvent", auditEventSchema);
export const Task = model("Task", taskSchema);
export const Meeting = model("Meeting", meetingSchema);
export const Notification = model("Notification", notificationSchema);
export const ReminderDelivery = model("ReminderDelivery", reminderDeliverySchema);
export const SystemSetting = model("SystemSetting", systemSettingSchema);
