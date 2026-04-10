// import type { Response } from 'express';
// import type { AuthRequest } from '../middleware/authMiddleware.js';
// import { GoogleOAuthService } from '../services/googleOAuthService.js';

// export const getGoogleStatus = async (req: AuthRequest, res: Response) => {
//     try {
//         const tokens = await GoogleOAuthService.getTokens(req.user!.id);
//         res.json({ connected: !!tokens });
//     } catch (error) {
//         res.status(500).json({ success: false, message: 'Failed to get Google status' });
//     }
// };

// export const disconnectGoogle = async (req: AuthRequest, res: Response) => {
//     try {
//         await GoogleOAuthService.disconnect(req.user!.id);
//         res.json({ success: true, message: 'Disconnected from Google' });
//     } catch (error) {
//         res.status(500).json({ success: false, message: 'Failed to disconnect' });
//     }
// };


import type { Response } from 'express';
import type { AuthRequest } from '../middleware/authMiddleware.js';
import { GoogleOAuthService  } from '../services/googleOAuthService.js';
import { GoogleCalendarService } from '../services/googleCalendarService.js';

export const getGoogleStatus = async (req: AuthRequest, res: Response) => {
    try {
        console.log('Checking Google integration status for user:', req.user!.id);
        const tokens = await GoogleOAuthService.getUserTokens(req.user!.id);
        res.json({ connected: !!tokens });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to get Google status' });
    }
};

export const disconnectGoogle = async (req: AuthRequest, res: Response) => {
    try {
        await GoogleOAuthService.disconnect(req.user!.id);
        res.json({ success: true, message: 'Disconnected from Google' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to disconnect' });
    }
};

export const testCreateGoogleEvent = async (req: AuthRequest, res: Response) => {
    try {
        const result = await GoogleCalendarService.createEvent(req.user!.id, {
            summary: 'Test Meeting',
            description: 'Google Calendar integration test from CRM',
            start: {
                dateTime: '2026-04-09T10:00:00+05:30',
                timeZone: 'Asia/Kolkata',
            },
            end: {
                dateTime: '2026-04-09T10:30:00+05:30',
                timeZone: 'Asia/Kolkata',
            },
        });

        res.json({
            success: true,
            message: 'Test Google Calendar event created',
            data: result,
        });
    } catch (error: any) {
        console.error('testCreateGoogleEvent error:', error);
        res.status(500).json({
            success: false,
            message: error?.message || 'Failed to create test event',
        });
    }
};


export const getGoogleEvents = async (req: AuthRequest, res: Response) => {
    try {
        const { timeMin, timeMax } = req.query as {
            timeMin?: string;
            timeMax?: string;
        };

        const events = await GoogleCalendarService.listEvents(
            req.user!.id,
            timeMin,
            timeMax
        );

        res.json({
            success: true,
            data: events,
        });
    } catch (error: any) {
        console.error('getGoogleEvents error:', error);
        const isNotConnected = error?.message === 'User not connected to Google';
        res.status(isNotConnected ? 400 : 500).json({
            success: false,
            message: error?.message || 'Failed to fetch Google events',
        });
    }
};
