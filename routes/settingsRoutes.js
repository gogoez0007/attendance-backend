// File: routes/settingsRoutes.js
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// ✅ Get All Settings
router.get('/listAll', settingsController.getSettings);

// ✅ Get Setting by ID
router.get('/:id', settingsController.getSettingById);

// ✅ Create Setting
router.post('/', settingsController.createSetting);

// ✅ Update Setting
router.put('/:id', settingsController.updateSetting);

// ✅ Delete Setting
router.delete('/:id', settingsController.deleteSetting);

module.exports = router;
