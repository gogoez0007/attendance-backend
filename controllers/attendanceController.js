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

// ===== helpers =====
const toYMD = (d) => {
    if (!d) return null;
    if (typeof d === 'string') {
        const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
    }
    if (d instanceof Date && !isNaN(d)) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
    }
    return null;
};

const parseHMS = (t) => {
    const [h = '0', m = '0', s = '0'] = String(t || '00:00:00').split(':');
    return { h: +h || 0, m: +m || 0, s: +s || 0 };
};

const makeDateTime = (dateStr, timeStr) => {
    const { h, m, s } = parseHMS(timeStr);
    const d = new Date(`${dateStr}T00:00:00`);
    d.setHours(h, m, s, 0);
    return d;
};

// Ambil shift efektif utk (user_id, schedule_date): pakai shift_schedules kalau ada; jika tidak pakai defaultShiftId
async function getEffectiveShift(db, user_id, schedule_date, defaultShiftId) {
    const [[sch]] = await db.query(
        'SELECT shift_id FROM shift_schedules WHERE user_id = ? AND schedule_date = ?',
        [user_id, schedule_date]
    );
    const effShiftId = sch?.shift_id ?? defaultShiftId;
    if (!effShiftId) return null;
    const [[shift]] = await db.query(
        'SELECT id, start_time, end_time, tolerance_start_time FROM shifts WHERE id = ?',
        [effShiftId]
    );
    if (!shift) return null;
    return { shift_id: effShiftId, ...shift };
}

// ===== MAIN =====
exports.handleAttendance = async (req, res) => {
    try {
        const { user_id, check_in_time, check_in_latitude, check_in_longitude } = req.body;
        if (!user_id || !check_in_time) {
            return res.status(400).json({ message: 'user_id dan check_in_time wajib' });
        }

        // User + default shift
        const [[user]] = await db.query(
            'SELECT id, name, shift_id FROM users WHERE id = ?',
            [user_id]
        );
        if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
        const namaLengkap = user.name;
        const defaultShiftId = user.shift_id || null;

        // Waktu scan
        const ts = new Date(check_in_time);
        if (isNaN(ts.getTime())) {
            return res.status(400).json({ message: 'check_in_time tidak valid' });
        }
        const todayStr = toYMD(ts);
        const yst = new Date(ts); yst.setDate(yst.getDate() - 1);
        const yesterdayStr = toYMD(yst);

        // ========= 1) CHECK-OUT kalau ada open attendance (date = today atau yesterday) =========
        const [openRows] = await db.query(
            `SELECT id, user_id, date, check_in_time, check_out_time
         FROM attendance
        WHERE user_id = ?
          AND check_out_time IS NULL
          AND date IN (?, ?)
        ORDER BY date DESC
        LIMIT 1`,
            [user_id, todayStr, yesterdayStr]
        );

        if (openRows.length) {
            const att = openRows[0];
            const attDateStr = toYMD(att.date);
            // ambil shift utk tanggal attendance
            const effShift = await getEffectiveShift(db, user_id, attDateStr, defaultShiftId);
            if (!effShift) {
                return res.status(400).json({ message: 'Shift tidak ditemukan untuk tanggal attendance' });
            }
            const { start_time, end_time } = effShift;
            const st = parseHMS(start_time);
            const et = parseHMS(end_time);
            const isOvernight = (et.h * 3600 + et.m * 60 + et.s) < (st.h * 3600 + st.m * 60 + st.s);

            const startDT = makeDateTime(attDateStr, start_time);
            let endDT = makeDateTime(attDateStr, end_time);
            if (isOvernight) {
                endDT.setDate(endDT.getDate() + 1);
            }

            if (ts < endDT) {
                return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
            }

            await db.query(
                `UPDATE attendance 
            SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ?
          WHERE id = ?`,
                [check_in_time, check_in_latitude, check_in_longitude, att.id]
            );
            // Notifikasi (sesuai kode kamu)
            try {
                await notificationService.sendFCMNotification(
                    [23,15],
                    '📲 Notifikasi Absensi',
                    `${namaLengkap} berhasil absen pulang pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
                    'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
                );
                console.log(`✅ Notif dikirim utk absen ${namaLengkap}`);
            } catch (notifErr) {
                console.error('❌ Gagal kirim notif absen:', notifErr?.message || notifErr);
            }

            return res.status(200).json({ message: 'Check-out berhasil', type: 'checkout' });
        }

        // ========= 2) CHECK-IN: tentukan shiftDate yang benar & validasi toleransi =========
        // Cek shift untuk "hari ini" dulu
        const shiftToday = await getEffectiveShift(db, user_id, todayStr, defaultShiftId);

        if (!shiftToday) {
            return res.status(400).json({ message: 'Tidak ada shift untuk user (schedule & default kosong)' });
        }

        // Jika shift hari ini overnight dan scan terjadi dini hari (< endH) → shift sebenarnya milik kemarin
        const stToday = parseHMS(shiftToday.start_time);
        const etToday = parseHMS(shiftToday.end_time);
        const isOvernightToday = (etToday.h * 3600 + etToday.m * 60 + etToday.s) < (stToday.h * 3600 + stToday.m * 60 + stToday.s);

        let shiftDateStr = todayStr;
        if (isOvernightToday && ts.getHours() < etToday.h) {
            shiftDateStr = yesterdayStr;
        }

        // Ambil shift efektif berdasarkan shiftDateStr (bisa beda jadwal dgn hari ini!)
        const effShift = await getEffectiveShift(db, user_id, shiftDateStr, defaultShiftId);
        if (!effShift) {
            return res.status(400).json({ message: 'Tidak ada shift pada tanggal yang ditentukan' });
        }
        const { shift_id: effectiveShiftId, start_time, end_time, tolerance_start_time } = effShift;

        // Cegah double check-in utk shiftDate
        const [[exists]] = await db.query(
            'SELECT id FROM attendance WHERE user_id = ? AND date = ?',
            [user_id, shiftDateStr]
        );
        if (exists) {
            return res.status(400).json({ message: 'Anda sudah melakukan absen untuk shift ini.' });
        }

        // Validasi toleransi
        const startDT = makeDateTime(shiftDateStr, start_time);
        const tol = parseHMS(tolerance_start_time || '00:00:00');
        const tolDT = new Date(startDT.getTime());
        tolDT.setHours(tolDT.getHours() + tol.h);
        tolDT.setMinutes(tolDT.getMinutes() + tol.m);
        tolDT.setSeconds(tolDT.getSeconds() + tol.s);

        if (ts > tolDT) {
            return res.status(400).json({ message: 'Waktu check-in melewati batas toleransi' });
        }

        // Insert attendance (date = tanggal mulai shift)
        await db.query(
            `INSERT INTO attendance 
       (user_id, check_in_time, check_in_latitude, check_in_longitude, date)
       VALUES (?, ?, ?, ?, ?)`,
            [user_id, check_in_time, check_in_latitude, check_in_longitude, shiftDateStr]
        );

        // Notifikasi (sesuai kode kamu)
        try {
            await notificationService.sendFCMNotification(
                [23,15],
                '📲 Notifikasi Absensi',
                `${namaLengkap} berhasil absen datang pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
                'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
            );
            console.log(`✅ Notif dikirim utk absen ${namaLengkap}`);
        } catch (notifErr) {
            console.error('❌ Gagal kirim notif absen:', notifErr?.message || notifErr);
        }

        return res.status(201).json({ message: 'Check-in berhasil', type: 'checkin' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
};
