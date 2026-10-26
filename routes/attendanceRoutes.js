const express = require('express');
const router = express.Router();
const attendanceController = require('../controllers/attendanceController');

router.get('/get_grade', attendanceController.getNilaiGrade);
router.get('/get_grade_html', attendanceController.getNilaiGradeHtml);

router.get('/', attendanceController.getAttendances);
const locationController = require('../controllers/locationController');
router.get('/location-rules', locationController.getLocationRules);
router.put('/location-rules/:location_id', locationController.updateLocationRule);
router.get('/employee-off-days', attendanceController.getEmployeeOffDays);
router.get('/hari-libur', attendanceController.getHariLibur);
router.get('/leave-requests', attendanceController.getUserLeaveRequests);
router.get('/leave-requests/:id', attendanceController.getUserLeaveRequests);
router.get('/:id', attendanceController.getAttendanceById);
router.post('/', attendanceController.createAttendance);
router.post('/submit/', attendanceController.handleAttendance);
router.put('/:id', attendanceController.updateAttendance);
router.delete('/:id', attendanceController.deleteAttendance);

module.exports = router;
