import { rtdb } from "../config/firebase.js";

/**
 * Pushes a notification or status update to the Firebase Realtime Database.
 * This can be used on the frontend to listen for immediate changes.
 * @param path - The path in the database (e.g. 'notifications/user123').
 * @param data - The data object to push.
 */
export const pushRealtimeUpdate = async (path: string, data: any): Promise<void> => {
  const ref = rtdb.ref(path);
  await ref.push({
    ...data,
    timestamp: Date.now(),
  });
};

/**
 * Sets a value at a specific path in the Realtime Database.
 * Useful for simple state flags (e.g. 'users/user123/isOnline').
 * @param path - The database path.
 * @param value - The value to set.
 */
export const setRealtimeState = async (path: string, value: any): Promise<void> => {
  const ref = rtdb.ref(path);
  await ref.set(value);
};

/**
 * Increments a counter in the Realtime Database (atomically).
 * Useful for live metrics tracking.
 * @param path - The database path to the counter.
 * @param incrementBy - The amount to increment.
 */
export const incrementLiveCounter = async (path: string, incrementBy: number = 1): Promise<void> => {
  const ref = rtdb.ref(path);
  await ref.transaction((currentValue) => {
    return (currentValue || 0) + incrementBy;
  });
};
