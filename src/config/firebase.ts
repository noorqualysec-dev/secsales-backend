import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { getDatabase } from "firebase-admin/database";
import { getStorage } from "firebase-admin/storage";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Get __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to your service account JSON file
const serviceAccountPath = path.resolve(
  __dirname,
  "../../secsales-29c94-firebase-adminsdk-fbsvc-d87e04623f.json"
);

try {
  const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf8"));

  // For RTDB in asia-southeast1, the URL format is: https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app/
  const rtdbURL = process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}-default-rtdb.asia-southeast1.firebasedatabase.app/`;

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`,
    databaseURL: rtdbURL,
  });

  console.log("🔥 Firebase Admin SDK initialized for project:", serviceAccount.project_id);
  console.log("🔗 Realtime DB URL:", rtdbURL);
} catch (error) {
  console.error("❌ Error initializing Firebase Admin SDK:", error);
}

export const db = getFirestore();
export const rtdb = getDatabase();
export const storage = getStorage();
export default admin;
