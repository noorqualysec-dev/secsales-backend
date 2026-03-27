// import express from "express";
// import cors from 'cors';

// // Route imports
// import userRoutes from "./routes/userRoutes.js";
// import leadRoutes from "./routes/leadRoutes.js";
// import proposalRoutes from "./routes/proposalRoutes.js";
// import productivityRoutes from "./routes/productivityRoutes.js";
// import adminRoutes from "./routes/adminRoutes.js";

// // Firebase initialization
// import "./config/firebase.js";

// const app = express();

// // Enable Cross-Origin Resource Sharing for the React Frontend
// app.use(cors({
//     origin: ["http://localhost:3000", "http://localhost:3001", "http://localhost:4200"],
//     credentials: true,
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
// }));

// // Parse incoming JSON bodies
// app.use(express.json());

// app.get("/", (req, res) => {
//     res.status(200).json({
//         message: "hello from Qualysec - Firebase Integrated"
//     });
// });

// // Mount routers
// app.use("/api/users", userRoutes);
// app.use("/api/leads", leadRoutes);
// app.use("/api/proposals", proposalRoutes);
// app.use("/api/productivity", productivityRoutes);
// app.use("/api/admin", adminRoutes);

// const PORT = process.env.PORT || 8002;

// // Fix ECONNRESET with Next.js proxy
// const server = app.listen(PORT, () => {
//     console.log(`Server is running on port ${PORT}`);
// });

// server.keepAliveTimeout = 61000;
// server.headersTimeout = 65000;


import express from "express";
import cors from "cors";

// Route imports
import userRoutes from "./routes/userRoutes.js";
import leadRoutes from "./routes/leadRoutes.js";
import proposalRoutes from "./routes/proposalRoutes.js";
import productivityRoutes from "./routes/productivityRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

// Firebase initialization
import "./config/firebase.js";

const app = express();

// Enable CORS
// const allowedOrigins = [
//     "http://localhost:3000",
//     "http://localhost:3001",
//     "http://localhost:4200",
//     "https://secsales.vercel.app",
//     process.env.FRONTEND_URL,           // set this in Vercel env vars
// ].filter(Boolean) as string[];

// app.use(cors({
//     origin: allowedOrigins,
//     credentials: true,
//     methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//     allowedHeaders: ["Content-Type", "Authorization"],
// }));
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:4200",
  "https://secsales.vercel.app",
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // allow postman / mobile

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.log("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use((req, res, next) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "https://secsales.vercel.app"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  );
  next();
});

// ✅ 2. HANDLE PREFLIGHT (ADD HERE)
// app.options("/*", (req, res) => {
//   res.status(200).end();
// });

// Middleware
app.use(express.json());

// Test route
app.get("/", (req, res) => {
    res.status(200).json({
        message: "hello from Qualysec - Firebase Integrated"
    });
});

// Routes
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/proposals", proposalRoutes);
app.use("/api/productivity", productivityRoutes);
app.use("/api/admin", adminRoutes);

// ❗ IMPORTANT: NO app.listen here

export default app;