import { google } from 'googleapis';
import admin from '../config/firebase.js';

const SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/meetings.space.created'
];

const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
);

export interface GoogleTokens {
    accessToken: string;
    refreshToken: string;
    expiry: number;
}

export class GoogleOAuthService {
    static generateAuthUrl(state: string): string {
        return oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: SCOPES,
            state: state,
            prompt: 'consent' // to get refresh token
        });
    }

    static async getTokens(code: string): Promise<GoogleTokens> {
        const { tokens } = await oauth2Client.getToken(code);
        return {
            accessToken: tokens.access_token!,
            refreshToken: tokens.refresh_token!,
            expiry: tokens.expiry_date!
        };
    }

    static async refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const { credentials } = await oauth2Client.refreshAccessToken();
        return {
            accessToken: credentials.access_token!,
            refreshToken: credentials.refresh_token || refreshToken,
            expiry: credentials.expiry_date!
        };
    }

    static async storeTokens(userId: string, tokens: GoogleTokens): Promise<void> {
        await admin.database().ref(`users/${userId}`).update({
            googleTokens: tokens,
            updatedAt: Date.now()
        });
    }

    static async getUserTokens(userId: string): Promise<GoogleTokens | null> {
        const snapshot = await admin.database().ref(`users/${userId}/googleTokens`).once('value');
        return snapshot.val();
    }

    static async disconnect(userId: string): Promise<void> {
        await admin.database().ref(`users/${userId}/googleTokens`).remove();
        await admin.database().ref(`users/${userId}`).update({
            updatedAt: Date.now()
        });
    }

    static getOAuth2Client(tokens?: GoogleTokens): typeof oauth2Client {
        const client = new google.auth.OAuth2(
            process.env.GOOGLE_CLIENT_ID,
            process.env.GOOGLE_CLIENT_SECRET,
            process.env.GOOGLE_REDIRECT_URI
        );
        if (tokens) {
            client.setCredentials({
                access_token: tokens.accessToken,
                refresh_token: tokens.refreshToken,
                expiry_date: tokens.expiry
            });
        }
        return client;
    }
}