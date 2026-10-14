import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const getKey = (): Buffer => {
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || !/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be configured as 64 hexadecimal characters");
  }
  return Buffer.from(key, "hex");
};

export const encryptSecret = (value: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}.${cipher.getAuthTag().toString("hex")}.${encrypted.toString("hex")}`;
};

export const decryptSecret = (value: string): string => {
  const [ivHex, authTagHex, encryptedHex] = value.split(".");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Stored encrypted credential has an invalid format");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
};
