import { storage } from "../config/firebase.js";
import path from "path";
import { v4 as uuidv4 } from "uuid";

/**
 * Uploads a file buffer to Firebase Storage and returns the public URL.
 * @param buffer - The file buffer to upload.
 * @param destination - The destination path in the bucket (e.g. 'meetings/audio123.mp3').
 * @param mimeType - The content type of the file.
 * @returns The public download URL.
 */
export const uploadFile = async (
  buffer: Buffer,
  destination: string,
  mimeType: string
): Promise<string> => {
  const bucket = storage.bucket();
  const file = bucket.file(destination);

  await file.save(buffer, {
    metadata: {
      contentType: mimeType,
      firebaseStorageDownloadTokens: uuidv4(), // Token for Firebase Console preview
    },
  });

  // Make the file public (optional, or use signed URLs for security)
  await file.makePublic();

  // Construct the public URL
  return `https://storage.googleapis.com/${bucket.name}/${file.name}`;
};

/**
 * Generates a signed URL for a file that expires in 1 hour.
 * @param destination - The path to the file in the bucket.
 * @returns A temporary signed URL.
 */
export const getSignedUrl = async (destination: string): Promise<string> => {
  const bucket = storage.bucket();
  const file = bucket.file(destination);

  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 60 * 60 * 1000, // 1 hour
  });

  return url;
};

/**
 * Deletes a file from Firebase Storage.
 * @param destination - The path to the file in the bucket.
 */
export const deleteFile = async (destination: string): Promise<void> => {
  const bucket = storage.bucket();
  const file = bucket.file(destination);
  await file.delete();
};
