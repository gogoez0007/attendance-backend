const db = require('../db');

// ✅ Get All Attendances
exports.getAttendances = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, user_id, check_in_time, check_out_time FROM attendance');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
// ✅ Get Attendance by ID + Summary Telat
exports.getAttendanceById = async (req, res) => {
    try {
        const { id } = req.params;
        const { month, year } = req.query;

        const today = new Date();
        let queryDateStart;
        let queryDateEnd;

        if (month && year) {
            if (isNaN(month) || isNaN(year) || month < 1 || month > 12 || year < 1000 || year > 9999) {
                return res.status(400).json({ message: 'Invalid month or year' });
            }
            queryDateStart = `${year}-${String(month).padStart(2, '0')}-01`;
            queryDateEnd = `${year}-${String(month).padStart(2, '0')}-${new Date(year, month, 0).getDate()}`;
        } else {
            const todayStr = today.toISOString().split('T')[0];
            queryDateStart = todayStr;
            queryDateEnd = todayStr;
        }

        // Ambil data attendance
        const [rows] = await db.query(
            'SELECT * FROM attendance WHERE user_id = ? AND date BETWEEN ? AND ?', 
            [id, queryDateStart, queryDateEnd]
        );

        // Hitung jumlah keterlambatan user tersebut
        const [lateSummary] = await db.query(
            `SELECT COUNT(*) AS late_count 
             FROM attendance a
             JOIN shifts s ON a.user_id = ? AND a.date BETWEEN ? AND ?
             AND s.id = (SELECT shift_id FROM users WHERE id = ?) 
             WHERE TIMESTAMPDIFF(SECOND, s.start_time, a.check_in_time) > 59`, 
            [id, queryDateStart, queryDateEnd, id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Attendance not found' });
        }

        res.json({
            attendance: rows,
            summary: {
                late_count: lateSummary[0].late_count || 0
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


// ✅ Create Attendance
exports.createAttendance = async (req, res) => {
    try {
        const { user_id, check_in_time, check_in_latitude, check_in_longitude, check_in_image } = req.body;
        await db.query('INSERT INTO attendance (user_id, check_in_time, check_in_latitude, check_in_longitude, check_in_image) VALUES (?, ?, ?, ?, ?)', 
            [user_id, check_in_time, check_in_latitude, check_in_longitude, check_in_image]);
        res.status(201).json({ message: 'Attendance created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Update Attendance (Check-out)
exports.updateAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        const { check_out_time, check_out_latitude, check_out_longitude, check_out_image } = req.body;
        await db.query('UPDATE attendance SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ?, check_out_image = ? WHERE id = ?',
            [check_out_time, check_out_latitude, check_out_longitude, check_out_image, id]);
        res.json({ message: 'Attendance updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Delete Attendance
exports.deleteAttendance = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM attendance WHERE id = ?', [id]);
        res.json({ message: 'Attendance deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Handle Attendance (Check-in/Check-out)
exports.handleAttendance = async (req, res) => {
    try {
        const { user_id, check_in_time, check_in_latitude, check_in_longitude } = req.body;

        console.log('ini adalaah ', req.body);
        // Dapatkan shift dan toleransi waktu untuk user
        const [userRows] = await db.query(
            'SELECT shift_id FROM users WHERE id = ?',
            [user_id]
        );

        if (userRows.length === 0) {
            return res.status(404).json({ message: 'User tidak ditemukan' });
        }

        const shiftId = userRows[0].shift_id;

        const [shiftRows] = await db.query(
            'SELECT start_time, end_time, tolerance_start_time FROM shifts WHERE id = ?',
            [shiftId]
        );

        if (shiftRows.length === 0) {
            return res.status(404).json({ message: 'Shift tidak ditemukan' });
        }

        const { start_time, end_time, tolerance_start_time } = shiftRows[0];

        // Cek apakah sudah ada data absensi untuk user_id pada tanggal hari ini
        const [attendanceRows] = await db.query(
            'SELECT id, check_in_time, check_out_time FROM attendance WHERE user_id = ? AND date = CURDATE()',
            [user_id]
        );

        if (attendanceRows.length === 0) {
            // Jika belum ada data absensi untuk hari ini
            const checkInDateTime = new Date(check_in_time);
            const startDateTime = new Date();
            const [startHours, startMinutes] = start_time.split(':');
            startDateTime.setHours(startHours, startMinutes, 0, 0);

            const [toleranceHours, toleranceMinutes] = tolerance_start_time.split(':');
            startDateTime.setHours(startDateTime.getHours() + parseInt(toleranceHours));
            startDateTime.setMinutes(startDateTime.getMinutes() + parseInt(toleranceMinutes));

            if (checkInDateTime > startDateTime) {
                return res.status(400).json({ message: 'Waktu check-in telah melewati batas toleransi' });
            }

            await db.query(
                'INSERT INTO attendance (user_id, check_in_time, check_in_latitude, check_in_longitude, date) VALUES (?, ?, ?, ?, date(now()))',
                [user_id, check_in_time, check_in_latitude, check_in_longitude]
            );
            res.status(201).json({ message: 'Check-in berhasil' });
        } else {
            // Jika sudah ada data absensi untuk hari ini
            const attendance = attendanceRows[0];

            if (attendance.check_out_time) {
                return res.status(400).json({ message: 'Anda sudah melakukan check-out hari ini' });
            }

            const checkOutDateTime = new Date(check_in_time);
            const endDateTime = new Date();
            const [endHours, endMinutes] = end_time.split(':');
            endDateTime.setHours(endHours, endMinutes, 0, 0);

            if (checkOutDateTime < endDateTime) {
                return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
            }

            await db.query(
                'UPDATE attendance SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ? WHERE id = ?',
                [check_in_time, check_in_latitude, check_in_longitude, attendance.id]
            );
            console.log('ini adalaah ', check_in_time);
            res.status(201).json({ message: 'Check-out berhasil' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
