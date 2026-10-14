import { google } from "googleapis";
import { User } from "../models/mongoModels.js";
import { decryptSecret, encryptSecret } from "../utils/tokenEncryption.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/meetings.space.created",
];

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI,
);

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiry: number;
}

export class GoogleOAuthService {
  static generateAuthUrl(state: string): string {
    return oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      state,
      prompt: "consent",
    });
  }

  static async getTokens(code: string): Promise<GoogleTokens> {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      throw new Error("Google OAuth did not return the required credentials");
    }
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiry: tokens.expiry_date,
    };
  }

  static async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await oauth2Client.refreshAccessToken();
    if (!credentials.access_token || !credentials.expiry_date) {
      throw new Error("Google OAuth failed to refresh the access token");
    }
    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || refreshToken,
      expiry: credentials.expiry_date,
    };
  }

  static async storeTokens(userId: string, tokens: GoogleTokens): Promise<void> {
    const result = await User.updateOne(
      { _id: userId, isActive: true },
      {
        $set: {
          "googleCredentials.accessTokenEncrypted": encryptSecret(tokens.accessToken),
          "googleCredentials.refreshTokenEncrypted": encryptSecret(tokens.refreshToken),
          "googleCredentials.expiry": new Date(tokens.expiry),
        },
      },
    );
    if (result.matchedCount === 0) throw new Error("Active user not found for Google credentials");
  }

  static async getUserTokens(userId: string): Promise<GoogleTokens | null> {
    const user = await User.findOne({ _id: userId, isActive: true })
      .select("+googleCredentials.accessTokenEncrypted +googleCredentials.refreshTokenEncrypted");
    const credentials = user?.googleCredentials;
    if (!credentials?.accessTokenEncrypted || !credentials.refreshTokenEncrypted || !credentials.expiry) {
      return null;
    }
    return {
      accessToken: decryptSecret(credentials.accessTokenEncrypted),
      refreshToken: decryptSecret(credentials.refreshTokenEncrypted),
      expiry: credentials.expiry.getTime(),
    };
  }

  static async disconnect(userId: string): Promise<void> {
    await User.updateOne({ _id: userId }, { $unset: { googleCredentials: 1 } });
  }

  static getOAuth2Client(tokens?: GoogleTokens): typeof oauth2Client {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI,
    );
    if (tokens) {
      client.setCredentials({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expiry_date: tokens.expiry,
      });
    }
    return client;
  }
}
