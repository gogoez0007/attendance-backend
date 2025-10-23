const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');

router.get('/get_grade', attendanceController.getNilaiGrade);

router.get('/', attendanceController.getAttendances);
router.get('/:id', attendanceController.getAttendanceById);
router.post('/', attendanceController.createAttendance);
router.post('/submit/', attendanceController.handleAttendance);
router.put('/:id', attendanceController.updateAttendance);
router.delete('/:id', attendanceController.deleteAttendance);

module.exports = router;
