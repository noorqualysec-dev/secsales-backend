import admin from "firebase-admin";
import bcrypt from "bcrypt";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// --- Configuration ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serviceAccountPath = path.resolve(__dirname, "../../secsales-29c94-firebase-adminsdk-fbsvc-d87e04623f.json");

if (!fs.existsSync(serviceAccountPath)) {
    console.error("❌ Service account file not found.");
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));
const PROJECT_ID = "secsales-29c94";
const RTDB_URL = `https://${PROJECT_ID}-default-rtdb.asia-southeast1.firebasedatabase.app/`;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: RTDB_URL
});

const db = admin.database();

async function seed() {
    console.log(`🚀 Seeding Realtime Database for project: ${PROJECT_ID}...`);
    
    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash("password123", salt);

        // 1. Seed Users
        console.log("👥 Seeding Users...");
        const users = {
            "admin-1": { name: "Admin User", email: "admin@qualysec.com", role: "admin", password: passwordHash, isActive: true, createdAt: Date.now() },
            "sales-1": { name: "Noor Alam", email: "noor@qualysec.com", role: "sales_rep", password: passwordHash, isActive: true, createdAt: Date.now() },
            "manager-1": { name: "Manager User", email: "manager@qualysec.com", role: "manager", password: passwordHash, isActive: true, createdAt: Date.now() }
        };
        await db.ref("users").set(users);

        // 2. Seed Leads
        console.log("📊 Seeding Leads...");
        const leads = {
            "lead-1": { 
                firstName: "Pabitra", lastName: "Sahoo", email: "pabitra@qualysec.com", 
                company: "Qualysec", status: "Lead Captured", source: "website", 
                assignedTo: "sales-1", createdBy: "admin-1",
                createdAt: Date.now(),
                timeline: [{ event: "Creation", performedBy: "admin-1", remark: "Bulk seed", timestamp: Date.now() }]
            },
            "lead-2": { 
                firstName: "Alice", lastName: "Johnson", email: "alice@google.com", 
                company: "Google", status: "Won", source: "linkedin", 
                assignedTo: "sales-1", createdBy: "admin-1",
                createdAt: Date.now()
            }
        };
        await db.ref("leads").set(leads);

        // 3. Seed Proposals (Empty for now to let user create one)
        console.log("📝 Clearing old proposals...");
        await db.ref("proposals").set(null);

        console.log("\n✅ REALTIME DATABASE SYNCED & READY!");
        console.log("👉 Now you can create a proposal for 'Pabitra Sahoo' in the UI.");
    } catch (error: any) {
        console.error("❌ SEEDING FAILED:", error.message);
    } finally {
        process.exit();
    }
}

seed();
