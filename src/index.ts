import app from "./server.js";
import connectDB from "./config/db.js";
import { startLeadFollowUpCron } from "./jobs/leadFollowUpCron.js";

const PORT = Number(process.env.PORT || 8002);

try {
  await connectDB();
  if (process.env.NODE_ENV !== "production") {
    startLeadFollowUpCron();
  }
  app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
  });
} catch (error) {
  console.error("Backend startup failed:", error);
  process.exitCode = 1;
}