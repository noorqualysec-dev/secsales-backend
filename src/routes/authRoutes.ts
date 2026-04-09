import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { startGoogleAuth, handleGoogleCallback } from '../controllers/authController.js';

const router = express.Router();

// Google OAuth routes
router.get('/google/start', protect, startGoogleAuth);
router.get('/google/callback', handleGoogleCallback);

export default router;