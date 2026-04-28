import { Router } from "express";
import multer from "multer";
import { importLeadsFromExcelController } from "../controllers/leadImportController.js";
import { protect } from "../middleware/authMiddleware.js"; // adjust according to your project

const router = Router();

const upload = multer({
    storage: multer.memoryStorage(),
});

router.post( "/excel", protect, upload.single("file"), importLeadsFromExcelController
);

export default router;