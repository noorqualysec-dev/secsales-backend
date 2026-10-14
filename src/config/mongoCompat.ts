import { Types, type Model } from "mongoose";
import {
  AuditEvent,
  Lead,
  Meeting,
  Notification,
  Proposal,
  ProposalRevision,
  Task,
  User,
} from "../models/mongoModels.js";
import { PROPOSAL_STATUSES } from "../models/proposalModel.js";

type LegacyRecord = Record<string, any>;

const collections: Record<string, Model<any>> = {
  users: User,
  leads: Lead,
  proposals: Proposal,
  tasks: Task,
  meetings: Meeting,
  notifications: Notification,
};

const parseDateFields: Record<string, string[]> = {
  users: ["invitedAt", "activatedAt", "deactivatedAt"],
  leads: [
    "closedAt",
    "closingDate",
    "lastMeaningfulActivityAt",
    "lastActivityAt",
    "lastReminderAt",
    "nextReminderDueAt",
  ],
  tasks: ["dueDate", "completedAt"],
  meetings: ["startTime", "endTime", "lastSyncedAt"],
  notifications: ["readAt"],
};

const asDate = (value: unknown): unknown => {
  if (value === null || value === undefined || value === "") return value;
  if (value instanceof Date) return value;
  const parsed = new Date(value as string | number);
  if (Number.isNaN(parsed.getTime())) throw new Error("Invalid date value");
  return parsed;
};

const toPlain = (value: unknown): unknown => {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Types.ObjectId) return value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record._bsontype === "Decimal128") return value.toString();
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "__v" && key !== "passwordHash")
        .map(([key, nested]) => [key === "_id" ? "_id" : key, toPlain(nested)]),
    );
  }
  return value;
};

const fromMongo = async (collection: string, doc: LegacyRecord): Promise<LegacyRecord> => {
  const result = toPlain(doc) as LegacyRecord;
  if (collection === "users") {
    result.id = result._id;
    result.uid = result._id;
  }
  if (collection === "leads") {
    result.id = result._id;
    result.lastActivityAt = result.lastMeaningfulActivityAt;
    const events = await AuditEvent.find({ leadId: result._id }).sort({ occurredAt: 1 }).lean();
    result.timeline = events.map((event) => {
      const metadata = event.metadata as LegacyRecord | undefined;
      const changes = event.changes as Array<{ field: string; before?: unknown; after?: unknown }>;
      const statusChange = changes.find((change) => change.field === "status");
      const outcomeChange = changes.find((change) => change.field === "outcome");
      const eventLabels: Record<string, string> = {
        "lead.stage_changed": "Status Changed",
        "lead.proposal_sent": "Proposal Sent",
        "lead.won": "Won",
        "lead.lost": "Lost",
        "lead.cancelled": "Cancelled",
      };
      return {
        event: metadata?.legacyEvent ?? eventLabels[event.eventType] ?? event.eventType,
        status: metadata?.status ?? statusChange?.after,
        previousStatus: metadata?.previousStatus ?? statusChange?.before,
        outcome: metadata?.outcome ?? outcomeChange?.after,
        remark: event.note,
        reason: event.reason,
        performedBy: event.actorId.toString(),
        timestamp: event.occurredAt.getTime(),
      };
    });
  }
  if (collection === "proposals") {
    result.id = result._id;
    result.lead = result.leadId;
    const revision = result.currentRevisionId
      ? await ProposalRevision.findById(result.currentRevisionId).lean()
      : null;
    if (revision) {
      const plainRevision = toPlain(revision) as LegacyRecord;
      result.value = plainRevision.value;
      result.testingScope = plainRevision.scope;
      result.notes = plainRevision.notes ?? plainRevision.commercialTerms;
      result.revisionNumber = plainRevision.revisionNumber;
      result.currentRevision = plainRevision;
    }
  }
  if (collection === "tasks" || collection === "meetings" || collection === "notifications") {
    result.id = result._id;
  }
  return result;
};

const toMongoFields = (collection: string, input: object): LegacyRecord => {
  const data = { ...(input as LegacyRecord) };
  delete data.id;
  delete data._id;

  if (collection === "users") {
    if (typeof data.password === "string") {
      data.passwordHash = data.password;
      delete data.password;
    }
  }
  if (collection === "leads") {
    delete data.timeline;
    if (data.lastActivityAt !== undefined && data.lastMeaningfulActivityAt === undefined) {
      data.lastMeaningfulActivityAt = data.lastActivityAt;
    }
    delete data.lastActivityAt;
    if (data.contacts && Array.isArray(data.contacts)) {
      data.contacts = data.contacts.map((entry) => {
        const contact = { ...(entry as LegacyRecord) };
        for (const key of ["addedAt", "updatedAt", "lastContactedAt", "nextFollowUpAt", "joinedOn"]) {
          if (contact[key] !== undefined) contact[key] = asDate(contact[key]);
        }
        return contact;
      });
    }
    if (data.dealValue !== undefined && data.dealValue !== null) {
      data.dealValue = String(data.dealValue);
    }
  }
  if (collection === "proposals") {
    if (data.lead !== undefined) {
      data.leadId = data.lead;
      delete data.lead;
    }
    for (const key of ["value", "testingScope", "notes", "revisionNumber", "currentRevision"]) {
      delete data[key];
    }
  }
  if (data.leadId !== undefined) {
    const rawLeadId = String(data.leadId ?? "").trim();
    if (rawLeadId && rawLeadId !== "null" && rawLeadId !== "undefined" && rawLeadId !== "none" && Types.ObjectId.isValid(rawLeadId)) {
      data.leadId = new Types.ObjectId(rawLeadId);
    } else {
      delete data.leadId;
    }
  }
  if (collection === "tasks" && data.assignedTo) {
    const rawAssignees = Array.isArray(data.assignedTo) ? data.assignedTo : [data.assignedTo];
    data.assignedTo = rawAssignees
      .map((a: unknown) => String(a || "").trim())
      .filter((a: string) => a && Types.ObjectId.isValid(a))
      .map((a: string) => new Types.ObjectId(a));
  }
  if (collection === "meetings" && data.assignedTo) {
    const rawAssigned = String(data.assignedTo || "").trim();
    if (rawAssigned && Types.ObjectId.isValid(rawAssigned)) {
      data.assignedTo = new Types.ObjectId(rawAssigned);
    }
  }
  for (const refField of ["assignedBy", "completedBy", "createdBy"]) {
    if (data[refField] !== undefined) {
      const rawRef = String(data[refField] || "").trim();
      if (rawRef && rawRef !== "null" && rawRef !== "undefined" && Types.ObjectId.isValid(rawRef)) {
        data[refField] = new Types.ObjectId(rawRef);
      } else {
        delete data[refField];
      }
    }
  }
  for (const field of parseDateFields[collection] ?? []) {
    if (data[field] !== undefined) data[field] = asDate(data[field]);
  }
  return data;
};

const snapshot = (data: any, key: string | null = null) => ({
  exists: () => data !== null && (Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0),
  val: (): any => data,
  key,
});

class MongoReference implements PromiseLike<void> {
  private filters: LegacyRecord = {};
  private orderField?: string;
  private pendingWrite?: Promise<void>;
  readonly pathParts: string[];

  constructor(path: string) {
    this.pathParts = path.split("/").filter(Boolean);
  }

  orderByChild(field: string): this {
    this.orderField = field;
    return this;
  }

  equalTo(value: unknown): this {
    if (this.orderField) {
      const query = toMongoFields(this.collection, { [this.orderField]: value });
      Object.assign(this.filters, query);
    }
    return this;
  }

  private get collection(): string {
    return this.pathParts[0] ?? "";
  }

  private get documentId(): string | undefined {
    return this.pathParts[1];
  }

  private get model(): Model<any> {
    const model = collections[this.collection];
    if (!model) throw new Error(`Unsupported MongoDB collection: ${this.collection}`);
    return model;
  }

  async once(_event: "value") {
    if (!this.documentId) {
      const docs = await this.model.find(this.filters).lean();
      const keyed: LegacyRecord = {};
      for (const doc of docs) {
        const item = await fromMongo(this.collection, doc as LegacyRecord);
        keyed[String(item._id)] = item;
      }
      return snapshot(keyed);
    }
    if (!Types.ObjectId.isValid(this.documentId)) return snapshot(null, this.documentId);
    const doc = await this.model.findById(this.documentId).lean();
    if (!doc) return snapshot(null, this.documentId);
    return snapshot(await fromMongo(this.collection, doc as LegacyRecord), this.documentId);
  }

  push(value?: object): MongoReference & { key: string; set(data: object): Promise<void> } {
    const child = new MongoReference(`${this.collection}/${new Types.ObjectId().toString()}`) as MongoReference & {
      key: string;
      set(data: object): Promise<void>;
    };
    Object.defineProperty(child, "key", { value: child.documentId, enumerable: true });
    child.set = async (data: object) => child.setDocument(data);
    if (value) child.pendingWrite = child.set(value);
    return child;
  }

  then<TResult1 = void, TResult2 = never>(
    onfulfilled?: ((value: void) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return (this.pendingWrite ?? Promise.resolve()).then(onfulfilled, onrejected);
  }

  async set(data: object): Promise<void> {
    if (!this.documentId) throw new Error("Set requires a document reference");
    await this.setDocument(data);
  }

  private async setDocument(data: object): Promise<void> {
    const id = this.documentId;
    if (!id || !Types.ObjectId.isValid(id)) throw new Error("A valid MongoDB document ID is required");
    const legacyData = data as LegacyRecord;
    const payload = toMongoFields(this.collection, data);
    if (this.collection === "proposals") {
      await this.saveProposal(id, payload, false);
      return;
    }
    await this.model.findOneAndReplace({ _id: id }, { _id: id, ...payload }, {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    });
    if (this.collection === "leads") await this.writeTimelineAudit(id, legacyData.timeline);
  }

  async update(data: object): Promise<void> {
    if (!this.documentId) throw new Error("Update requires a document reference");
    if (!Types.ObjectId.isValid(this.documentId)) throw new Error("Invalid MongoDB document ID");
    const legacyData = data as LegacyRecord;
    const payload = toMongoFields(this.collection, data);
    if (this.collection === "proposals") {
      await this.saveProposal(this.documentId, payload, true);
      return;
    }
    const updateOp: Record<string, any> = { $set: payload };
    if (legacyData.leadId === null || legacyData.leadId === "" || legacyData.leadId === "none") {
      delete payload.leadId;
      updateOp.$unset = { leadId: 1 };
    }
    await this.model.updateOne({ _id: this.documentId }, updateOp, { runValidators: true });
    if (this.collection === "leads" && legacyData.timeline) {
      await this.writeTimelineAudit(this.documentId, legacyData.timeline);
    }
  }

  async remove(): Promise<void> {
    if (!this.documentId) throw new Error("Remove requires a document reference");
    if (this.collection === "proposals") throw new Error("Proposal history cannot be deleted; use an audited void action");
    await this.model.deleteOne({ _id: this.documentId });
  }

  private async saveProposal(id: string, payload: LegacyRecord, isUpdate: boolean): Promise<void> {
    if (!isUpdate && payload.status && payload.status !== "Draft") {
      throw new Error("Proposals must be created as Draft and explicitly sent through the proposal workflow");
    }
    const proposalId = new Types.ObjectId(id);
    const existing = await Proposal.findById(proposalId);
    const leadId = payload.leadId ?? existing?.leadId;
    if (!leadId) throw new Error("A proposal must reference a lead");
    const now = new Date();
    let proposal = existing;
    if (!proposal) {
      proposal = new Proposal({
        _id: proposalId,
        leadId,
        status: payload.status ?? "Draft",
        createdBy: payload.createdBy,
      });
      await proposal.save();
    } else if (payload.status !== undefined || payload.updatedAt !== undefined) {
      if (payload.status !== undefined) {
        if (!PROPOSAL_STATUSES.includes(payload.status)) throw new Error("Invalid proposal status");
        proposal.status = payload.status;
      }
      await proposal.save();
    }

    const hasMaterialChange =
      payload.value !== undefined ||
      payload.testingScope !== undefined ||
      payload.notes !== undefined;
    if (!proposal.currentRevisionId || hasMaterialChange) {
        const currentDoc = proposal.currentRevisionId
        ? await ProposalRevision.findById(proposal.currentRevisionId).lean()
        : null;
        const current = currentDoc as LegacyRecord | null;
      const revision = await ProposalRevision.create({
        proposalId: proposal._id,
        leadId,
        revisionNumber: (current?.revisionNumber ?? 0) + 1,
        scope: payload.testingScope ?? current?.scope ?? [],
        value: payload.value === undefined ? current?.value : String(payload.value),
        currency: payload.currency ?? current?.currency,
        notes: payload.notes ?? current?.notes,
        commercialTerms: payload.commercialTerms ?? current?.commercialTerms,
        statusAtCreation: payload.status ?? proposal.status,
        preparedBy: payload.createdBy ?? existing?.createdBy,
        preparedAt: now,
      });
      proposal.currentRevisionId = revision._id;
      proposal.currentRevisionNumber = revision.revisionNumber;
      await proposal.save();
    }

  }

  private async writeTimelineAudit(leadId: string, timeline: unknown): Promise<void> {
    if (!Array.isArray(timeline)) return;
    const existingEvents = await AuditEvent.find({ leadId }).select("metadata.legacyKey").lean();
    const known = new Set(existingEvents.map((event) => (event.metadata as LegacyRecord | undefined)?.legacyKey).filter(Boolean));
    const appended = timeline
      .map((entry) => entry as LegacyRecord)
      .filter((event) => {
        const occurredAt = asDate(event.timestamp) as Date;
        const key = `${event.performedBy}:${occurredAt.getTime()}:${event.event}`;
        if (known.has(key)) return false;
        known.add(key);
        event.legacyKey = key;
        event.occurredAtDate = occurredAt;
        return true;
      });
    if (appended.length) {
      try {
        const auditDocs = appended
          .map((event) => {
            const rawActor =
              typeof event.performedBy === "object" && event.performedBy
                ? (event.performedBy._id ?? event.performedBy.id)
                : event.performedBy;
            const actorStr = String(rawActor || "").trim();
            if (!actorStr || !Types.ObjectId.isValid(actorStr)) return null;

            return {
              entityType: "lead",
              entityId: leadId,
              leadId,
              eventType: `lead.${String(event.event ?? "updated").toLowerCase().replaceAll(" ", "_")}`,
              actorId: new Types.ObjectId(actorStr),
              occurredAt: event.occurredAtDate,
              meaningfulActivity: true,
              note: event.remark,
              reason: event.reason,
              metadata: {
                legacyKey: event.legacyKey,
                legacyEvent: event.event,
                status: event.status,
                previousStatus: event.previousStatus,
                outcome: event.outcome,
              },
            };
          })
          .filter(Boolean);

        if (auditDocs.length) {
          await AuditEvent.insertMany(auditDocs);
        }
      } catch (auditErr) {
        console.error("writeTimelineAudit error:", auditErr);
      }
    }
  }
}

export const mongoStore = {
  ref(path: string): MongoReference {
    return new MongoReference(path);
  },
};
