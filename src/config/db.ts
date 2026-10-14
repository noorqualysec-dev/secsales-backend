import mongoose from "mongoose";

let connectionPromise: Promise<typeof mongoose> | undefined;

export default function connectDB(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    return Promise.reject(
      new Error("MONGODB_URI is required. Set it in secsales-backend/.env."),
    );
  }

  if (mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose);
  }

  if (!connectionPromise) {
    connectionPromise = mongoose
      .connect(uri, {
        dbName: process.env.MONGODB_DATABASE || "secsales_crm",
        autoIndex: process.env.NODE_ENV !== "production",
      })
      .then((connection) => {
        console.info(`MongoDB connected to ${connection.connection.host}`);
        return connection;
      })
      .catch((error: unknown) => {
        connectionPromise = undefined;
        throw error;
      });
  }

  return connectionPromise;
}
