const db = require('../db');
const notificationService = require('../services/notificationService');

// ✅ Get All Attendances
exports.getAttendances = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, user_id, check_in_time, check_out_time FROM attendance');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getAttendanceById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM attendance WHERE user_id = ? AND date=Date(now())', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Attendance not found' });
        res.json(rows[0]);
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

exports.handleAttendance = async (req, res) => {
    try {
        const { user_id, check_in_time, check_in_latitude, check_in_longitude } = req.body;

        const [userRows] = await db.query(
            'SELECT shift_id, name FROM users WHERE id = ?',
            [user_id]
        );
        if (userRows.length === 0) {
            return res.status(404).json({ message: 'User tidak ditemukan' });
        }
        const shiftId = userRows[0].shift_id;
        const namaLengkap = userRows[0].name;

        const [shiftRows] = await db.query(
            'SELECT start_time, end_time, tolerance_start_time FROM shifts WHERE id = ?',
            [shiftId]
        );
        if (shiftRows.length === 0) {
            return res.status(404).json({ message: 'Shift tidak ditemukan' });
        }

        const { start_time, end_time, tolerance_start_time } = shiftRows[0];
        const checkDateTime = new Date(check_in_time);

        const createDateTime = (timeStr, baseDate, addDay = 0) => {
            const [h, m] = timeStr.split(':').map(Number);
            const dt = new Date(baseDate);
            dt.setHours(h, m, 0, 0);
            if (addDay) dt.setDate(dt.getDate() + addDay);
            return dt;
        };

        const [startH] = start_time.split(':').map(Number);
        const [endH] = end_time.split(':').map(Number);
        const overnight = endH < startH;
        
        const todayStr = checkDateTime.toISOString().slice(0, 10);
        const yesterday = new Date(checkDateTime);
        if(overnight)
            yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().slice(0, 10);

        const [openAttendanceRows] = await db.query(
            `SELECT * FROM attendance
             WHERE user_id = ?
               AND check_out_time IS NULL
               AND date IN (?, ?)
             ORDER BY date DESC
             LIMIT 1`,
            [user_id, todayStr, yesterdayStr]
        );

        if (openAttendanceRows.length > 0) {
            const attendance = openAttendanceRows[0];
            const checkInDate = new Date(attendance.date);
            const shiftStartForCheckout = createDateTime(start_time, checkInDate, 0);
            const shiftEndForCheckout = createDateTime(end_time, shiftStartForCheckout, overnight ? 1 : 0);

            if (checkDateTime < shiftEndForCheckout) {
                return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
            }

            await db.query(
                `UPDATE attendance 
                 SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ? 
                 WHERE id = ?`,
                [check_in_time, check_in_latitude, check_in_longitude, attendance.id]
            );

            return res.status(200).json({ message: 'Check-out berhasil', type: 'checkout' });
        }
        
        let shiftStart = createDateTime(start_time, checkDateTime, 0);
        
        if (overnight && checkDateTime.getHours() < endH) {
            shiftStart.setDate(shiftStart.getDate() - 1);
        }
        
        const shiftDate = shiftStart.toISOString().slice(0, 10);

        const [existingAttendance] = await db.query(
            'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
            [user_id, shiftDate]
        );

        if (existingAttendance.length > 0) {
            return res.status(400).json({ message: 'Anda sudah melakukan absen untuk shift ini.' });
        }
        
        const toleranceLimit = new Date(shiftStart);
        const [tolH, tolM] = tolerance_start_time.split(':').map(Number);
        toleranceLimit.setHours(toleranceLimit.getHours() + tolH);
        toleranceLimit.setMinutes(toleranceLimit.getMinutes() + tolM);
        
        if (checkDateTime > toleranceLimit) { 
            return res.status(400).json({ message: 'Waktu check-in melewati batas toleransi' });
        }

        // Insert attendance
        await db.query(
            `INSERT INTO attendance 
            (user_id, check_in_time, check_in_latitude, check_in_longitude, date) 
            VALUES (?, ?, ?, ?, ?)`,
            [user_id, check_in_time, check_in_latitude, check_in_longitude, shiftDate]
        );

        // === Kirim notifikasi ke user_id 23 ===
        try {
            await notificationService.sendFCMNotification(
                [23,15],
                '📲 Notifikasi Absensi',
                `${namaLengkap} berhasil absen pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
                'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
            );
            
            console.log(`✅ Notif dikirim ke user 23 untuk absen ${namaLengkap}`);
        } catch (notifErr) {
            console.error('❌ Gagal kirim notif absen:', notifErr.message);
        }

        return res.status(201).json({ message: 'Check-in berhasil', type: 'checkin' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
};
