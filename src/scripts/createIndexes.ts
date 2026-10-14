import mongoose from "mongoose";
import connectDB from "../config/db.js";
import {
  AuditEvent,
  Lead,
  Meeting,
  NegotiationEvent,
  Notification,
  Proposal,
  ProposalRevision,
  ReminderDelivery,
  SystemSetting,
  Task,
  Team,
  User,
} from "../models/mongoModels.js";

try {
  await connectDB();
  const models = [
    User,
    Team,
    Lead,
    Proposal,
    ProposalRevision,
    NegotiationEvent,
    AuditEvent,
    Task,
    Meeting,
    Notification,
    ReminderDelivery,
    SystemSetting,
  ];
  for (const schemaModel of models) {
    await schemaModel.createIndexes();
    console.info(`Indexes ensured: ${schemaModel.collection.collectionName}`);
  }
} catch (error) {
  console.error("MongoDB index deployment failed:", error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
