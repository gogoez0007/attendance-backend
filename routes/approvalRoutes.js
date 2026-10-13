const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const approvalController = require('../controllers/approvalController');

// Konfigurasi Multer untuk upload dokumen pendukung terpisah
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../uploads/leave_docs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `doc_${Date.now()}_${Math.random().toString(36).substring(7)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

router.get('/list', approvalController.getApprovals);
router.get('/badge-count', approvalController.getBadgeCount);
router.post('/action', approvalController.processApproval);
router.post('/external/sync', approvalController.syncExternalDocument);
router.get('/external/systems', approvalController.getExternalSystems);
router.post('/external/:id/retry-callback', approvalController.retryExternalCallback);
router.get('/entity-rules', approvalController.getEntityRules);
router.post('/upload-document', upload.any(), approvalController.uploadDocument);
router.post('/leave/submit', approvalController.submitLeaveRequest);
router.get('/leave/my-requests', approvalController.getMyLeaveRequests);

module.exports = router;
