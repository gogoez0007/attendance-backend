const express = require('express');
const router = express.Router();
const userShiftController = require('../controllers/userShiftController');

router.get('/', userShiftController.getUserShifts);
router.get('/:id', userShiftController.getUserShiftById);
router.post('/', userShiftController.createUserShift);
router.delete('/:id', userShiftController.deleteUserShift);

module.exports = router;
