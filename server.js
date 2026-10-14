const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ✅ Konfigurasi CORS & Body Parser
app.use(cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));


const kpiRoutes = require('./routes/kpiRoutes');
app.use('/api', kpiRoutes);

// Rute-rute
const employeeRoutes = require('./routes/employeeRoutes');
app.use('/api/employees', employeeRoutes);

const locationRoutes = require('./routes/locationRoutes');
app.use('/api/locations', locationRoutes);

const shiftRoutes = require('./routes/shiftRoutes');
app.use('/api/shifts', shiftRoutes);

const attendanceRoutes = require('./routes/attendanceRoutes');
app.use('/api/attendance', attendanceRoutes);

const attendanceController = require('./controllers/attendanceController');
app.get('/api/hari-libur', attendanceController.getHariLibur);
app.get('/api/leave-requests', attendanceController.getUserLeaveRequests);
app.get('/api/leave-requests/:id', attendanceController.getUserLeaveRequests);

const userShiftRoutes = require('./routes/userShiftRoutes');
app.use('/api/user_shifts', userShiftRoutes);

const settingRoutes = require('./routes/settingsRoutes');
app.use('/api/setting', settingRoutes);

const notificationRoutes = require('./routes/notificationFirebaseRoutes');
app.use('/api/notif', notificationRoutes);

const approvalRoutes = require('./routes/approvalRoutes');
app.use('/api/approval', approvalRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
