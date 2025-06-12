const express = require('express');
const router = express.Router();
const notificationFirebaseController = require('../controllers/notificationFirebaseController');

router.post('/submit/', notificationFirebaseController.sendFCMNotification);

module.exports = router;
