import type { Response, Request } from 'express';
import type { AuthRequest } from '../middleware/authMiddleware.js';
import jwt from 'jsonwebtoken';
import { GoogleOAuthService } from '../services/googleOAuthService.js';

const JWT_SECRET = process.env.JWT_SECRET!;

export const startGoogleAuth = async (req: AuthRequest, res: Response) => {
    try {
        const userId = req.user!.id;
        const state = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '10m' });
        const authUrl = GoogleOAuthService.generateAuthUrl(state);
        res.json({ authUrl });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to start Google auth' });
    }
};

export const handleGoogleCallback = async (req: Request, res: Response) => {
    try {
        const { code, state } = req.query as { code: string; state: string };
        const decoded = jwt.verify(state, JWT_SECRET) as { userId: string };
        const userId = decoded.userId;

        const tokens = await GoogleOAuthService.getTokens(code);
        await GoogleOAuthService.storeTokens(userId, tokens);

        // Redirect to frontend success page
        res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations/google`);
    } catch (error) {
        console.error('Google callback error:', error);
        res.redirect(`${process.env.FRONTEND_URL}/dashboard/integrations/google/error`);
    }
};