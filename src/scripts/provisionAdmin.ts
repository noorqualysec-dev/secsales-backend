import bcrypt from "bcrypt";
import connectDB from "../config/db.js";
import { User } from "../models/mongoModels.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured to provision the initial administrator`);
  return value;
};

try {
  await connectDB();
  const name = required("INITIAL_ADMIN_NAME");
  const email = required("INITIAL_ADMIN_EMAIL").toLowerCase();
  const password = required("INITIAL_ADMIN_PASSWORD");
  if (password.length < 6) throw new Error("INITIAL_ADMIN_PASSWORD must be at least 12 characters");

  const passwordHash = await bcrypt.hash(password, 12);
  await User.updateOne(
    { email },
    {
      $set: {
        name,
        email,
        passwordHash,
        role: "admin",
        isActive: true,
        activatedAt: new Date(),
        deactivatedAt: null,
      },
      $setOnInsert: { teamIds: [] },
    },
    { upsert: true, runValidators: true },
  );
  console.info(`Administrator provisioned for ${email}. Remove INITIAL_ADMIN_PASSWORD from the environment.`);
  process.exitCode = 0;
} catch (error) {
  console.error("Administrator provisioning failed:", error);
  process.exitCode = 1;
} finally {
  const mongoose = await import("mongoose");
  await mongoose.default.disconnect();
}
