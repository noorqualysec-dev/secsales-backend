import type { LeadStatus } from "../models/leadModel.js";
import { SystemSetting } from "../models/mongoModels.js";

export async function getNextLeadReminderAt(
  stage: LeadStatus,
  activityAt = new Date(),
): Promise<Date | null> {
  const settings = await SystemSetting.findById("organization")
    .select("leadReminderPolicy.stageThresholds")
    .lean();
  const threshold = settings?.leadReminderPolicy?.stageThresholds.find((item) => item.stage === stage);
  if (!threshold || !Number.isFinite(threshold.duration) || threshold.duration <= 0) return null;
  const unitMs = threshold.unit === "minutes" ? 60_000 : threshold.unit === "hours" ? 3_600_000 : null;
  if (unitMs === null) {
    throw new Error(`Unsupported lead reminder interval unit: ${threshold.unit}`);
  }
  return new Date(activityAt.getTime() + threshold.duration * unitMs);
}

export async function getLeadReminderRepeatAt(referenceAt = new Date()): Promise<Date | null> {
  const settings = await SystemSetting.findById("organization")
    .select("leadReminderPolicy.repeatAfter")
    .lean();
  const repeat = settings?.leadReminderPolicy?.repeatAfter;
  if (!repeat || typeof repeat.duration !== "number" || !Number.isFinite(repeat.duration) || repeat.duration <= 0) return null;

  if (repeat.unit === "minutes") {
    return new Date(referenceAt.getTime() + repeat.duration * 60_000);
  }
  if (repeat.unit === "hours") {
    return new Date(referenceAt.getTime() + repeat.duration * 3_600_000);
  }
  if (repeat.unit === "business_days") {
    if (!Number.isInteger(repeat.duration)) {
      throw new Error("Lead reminder business-day repeat interval must be a whole number");
    }
    const result = new Date(referenceAt);
    let remaining = repeat.duration;
    while (remaining > 0) {
      result.setUTCDate(result.getUTCDate() + 1);
      const day = result.getUTCDay();
      if (day !== 0 && day !== 6) remaining--;
    }
    return result;
  }
  throw new Error(`Unsupported lead reminder repeat unit: ${repeat.unit}`);
}
