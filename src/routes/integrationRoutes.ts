import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { getGoogleStatus, disconnectGoogle, testCreateGoogleEvent, getGoogleEvents } from '../controllers/integrationController.js';

const router = express.Router();

// Google integration routes
router.get('/google/status', protect, getGoogleStatus);
router.post('/google/disconnect', protect, disconnectGoogle);
router.post('/google/test-create-event', protect, testCreateGoogleEvent);
router.get('/google/events', protect, getGoogleEvents);

export default router;