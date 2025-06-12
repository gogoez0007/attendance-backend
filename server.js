const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ✅ Konfigurasi CORS yang benar
app.use(cors({
  origin: 'http://localhost:3000', // Ganti sesuai URL frontend
  credentials: true               // Izinkan credentials
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));


const kpiRoutes = require('./routes/kpiRoutes');
app.use('/api', kpiRoutes);

// Rute-rute
const employeeRoutes = require('./routes/employeeRoutes');
app.use('/api/employees', employeeRoutes);

const shiftRoutes = require('./routes/shiftRoutes');
app.use('/api/shifts', shiftRoutes);

const attendanceRoutes = require('./routes/attendanceRoutes');
app.use('/api/attendance', attendanceRoutes);

const userShiftRoutes = require('./routes/userShiftRoutes');
app.use('/api/user_shifts', userShiftRoutes);

const settingRoutes = require('./routes/settingsRoutes');
app.use('/api/setting', settingRoutes);
app.use('/api/user_shifts', userShiftRoutes);

const notificationRoutes = require('./routes/notificationFirebaseRoutes');
app.use('/api/notif', notificationRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
