const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Rute untuk employees
const employeeRoutes = require('./routes/employeeRoutes');
app.use('/api/employees', employeeRoutes);

// Rute untuk shifts
const shiftRoutes = require('./routes/shiftRoutes');
app.use('/api/shifts', shiftRoutes);

// Rute untuk attendance
const attendanceRoutes = require('./routes/attendanceRoutes');
app.use('/api/attendance', attendanceRoutes);

// Rute untuk user_shifts
const userShiftRoutes = require('./routes/userShiftRoutes');
app.use('/api/user_shifts', userShiftRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
