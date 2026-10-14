import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import userRoutes from "./routes/userRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import proposalRoutes from "./routes/proposalRoutes.js";
import productivityRoutes from "./routes/productivityRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import integrationRoutes from "./routes/integrationRoutes.js";
import cronRoutes from "./routes/cronRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import leadImportRoutes from "./routes/leadImportRoutes.js";

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin.includes("localhost") || origin.includes("vercel.app")) {
      callback(null, true);
      return;
    }
    callback(new Error("CORS blocked"));
  },
  credentials: true,
}));
app.use(express.json());

app.use(async (_req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});

app.get("/", (_req, res) => {
  res.status(200).json({ message: "SecSales CRM API" });
});

app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/proposals", proposalRoutes);
app.use("/api/productivity", productivityRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/integrations", integrationRoutes);
app.use("/api/cron", cronRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/lead-import", leadImportRoutes);

export default app;
