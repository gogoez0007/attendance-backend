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

    // --- Helper lokal ---
    const sameYMD = (a, b) => toYMD(a) === toYMD(b);
    const hasExplicitSchedule = async (db, user_id, dateStr) => {
      const [[row]] = await db.query(
        'SELECT 1 FROM shift_schedules WHERE user_id = ? AND schedule_date = ? LIMIT 1',
        [user_id, dateStr]
      );
      return !!row;
    };

    // 0) User & default shift
    const [[user]] = await db.query(
      'SELECT id, name, shift_id FROM users WHERE id = ?',
      [user_id]
    );
    if (!user) return res.status(404).json({ message: 'User tidak ditemukan' });
    const namaLengkap = user.name;
    const defaultShiftId = user.shift_id || null;

    // 1) Waktu scan (pastikan TZ server = Asia/Jakarta)
    const ts = new Date(check_in_time);
    if (isNaN(ts.getTime())) {
      return res.status(400).json({ message: 'check_in_time tidak valid' });
    }
    const todayStr = toYMD(ts);
    const yst = new Date(ts); yst.setDate(yst.getDate() - 1);
    const yesterdayStr = toYMD(yst);

    // 2) Flag: apakah ada jadwal eksplisit hari ini?
    const hasSchToday = await hasExplicitSchedule(db, user_id, todayStr);

    // 3) CHECK-OUT logika: tanggal-first, tanpa grace window
    //    a) Prioritas: open attendance hari ini
    const [[openToday]] = await db.query(
      `SELECT id, user_id, date, check_in_time FROM attendance
       WHERE user_id = ? AND check_out_time IS NULL AND date = ? LIMIT 1`,
      [user_id, todayStr]
    );

    if (openToday) {
      const attDateStr = toYMD(openToday.date);
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
      if (isOvernight) endDT.setDate(endDT.getDate() + 1);

      if (ts < endDT) {
        return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
      }

      await db.query(
        `UPDATE attendance
           SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ?
         WHERE id = ?`,
        [check_in_time, check_in_latitude, check_in_longitude, openToday.id]
      );

      // Notifikasi (opsional)
      try {
        await notificationService.sendFCMNotification(
          [23, 15],
          '📲 Notifikasi Absensi',
          `${namaLengkap} berhasil absen pulang pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
          'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
        );
      } catch (notifErr) {
        console.error('❌ Gagal kirim notif absen:', notifErr?.message || notifErr);
      }

      return res.status(200).json({ message: 'Check-out berhasil', type: 'checkout' });
    }

    //    b) Jika tidak ada open hari ini, cek open kemarin
    const [[openYesterday]] = await db.query(
      `SELECT id, user_id, date, check_in_time FROM attendance
       WHERE user_id = ? AND check_out_time IS NULL AND date = ? LIMIT 1`,
      [user_id, yesterdayStr]
    );

    if (openYesterday) {
      const attDateStr = toYMD(openYesterday.date);
      const effY = await getEffectiveShift(db, user_id, attDateStr, defaultShiftId);

      if (effY) {
        const { start_time, end_time } = effY;
        const st = parseHMS(start_time);
        const et = parseHMS(end_time);
        const isOvernightY = (et.h * 3600 + et.m * 60 + et.s) < (st.h * 3600 + st.m * 60 + st.s);

        let endDTy = makeDateTime(attDateStr, end_time);
        if (isOvernightY) endDTy.setDate(endDTy.getDate() + 1);
        const endDateStrY = toYMD(endDTy);

        // RULE: auto-checkout kemarin HANYA jika:
        // - shift kemarin overnight
        // - end date = today
        // - TIDAK ada jadwal eksplisit untuk today
        if (isOvernightY && endDateStrY === todayStr && !hasSchToday) {
          if (ts < endDTy) {
            return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
          }

          await db.query(
            `UPDATE attendance
               SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ?
             WHERE id = ?`,
            [check_in_time, check_in_latitude, check_in_longitude, openYesterday.id]
          );

          // Notifikasi (opsional)
          try {
            await notificationService.sendFCMNotification(
              [23, 15],
              '📲 Notifikasi Absensi',
              `${namaLengkap} berhasil absen pulang pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
              'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
            );
          } catch (notifErr) {
            console.error('❌ Gagal kirim notif absen:', notifErr?.message || notifErr);
          }

          return res.status(200).json({ message: 'Check-out berhasil', type: 'checkout' });
        }
        // Jika ada jadwal eksplisit today ATAU shift kemarin bukan overnight → JANGAN close kemarin.
        // Lanjutkan ke alur check-in.
      }
      // Kalau tidak ada shift kemarin → juga jangan close; lanjutkan check-in.
    }

    // 4) CHECK-IN flow
    //    a) Ambil shift "hari ini" (untuk deteksi overnight pagi-pagi)
    const shiftToday = await getEffectiveShift(db, user_id, todayStr, defaultShiftId);
    if (!shiftToday) {
      return res.status(400).json({ message: 'Tidak ada shift untuk user (schedule & default kosong)' });
    }

    const stToday = parseHMS(shiftToday.start_time);
    const etToday = parseHMS(shiftToday.end_time);
    const isOvernightToday =
      (etToday.h * 3600 + etToday.m * 60 + etToday.s) < (stToday.h * 3600 + stToday.m * 60 + stToday.s);

    //    b) Resolusi tanggal shift untuk check-in
    // Default: today. Jika shift today overnight dan scan terjadi dini hari (< endH), masuk ke tanggal kemarin.
    let shiftDateStr = todayStr;
    if (isOvernightToday && ts.getHours() < etToday.h) {
      shiftDateStr = yesterdayStr;
    }

    //    c) Ambil shift efektif untuk shiftDateStr (jadwal spesifik meng-override default)
    const effShift = await getEffectiveShift(db, user_id, shiftDateStr, defaultShiftId);
    if (!effShift) {
      return res.status(400).json({ message: 'Tidak ada shift pada tanggal yang ditentukan' });
    }
    const { start_time, end_time, tolerance_start_time } = effShift;

    //    d) Cegah double check-in (unik per user+date)
    const [[exists]] = await db.query(
      'SELECT id FROM attendance WHERE user_id = ? AND date = ?',
      [user_id, shiftDateStr]
    );
    if (exists) {
      return res.status(400).json({ message: 'Anda sudah melakukan absen untuk shift ini.' });
    }

    //    e) Validasi toleransi datang
    const startDT = makeDateTime(shiftDateStr, start_time);
    const tol = parseHMS(tolerance_start_time || '00:00:00');
    const tolDT = new Date(startDT.getTime());
    tolDT.setHours(tolDT.getHours() + tol.h);
    tolDT.setMinutes(tolDT.getMinutes() + tol.m);
    tolDT.setSeconds(tolDT.getSeconds() + tol.s);

    if (ts > tolDT) {
      return res.status(400).json({ message: 'Waktu check-in melewati batas toleransi' });
    }

    //    f) Insert check-in
    await db.query(
      `INSERT INTO attendance
         (user_id, check_in_time, check_in_latitude, check_in_longitude, date)
       VALUES (?, ?, ?, ?, ?)`,
      [user_id, check_in_time, check_in_latitude, check_in_longitude, shiftDateStr]
    );

    // Notifikasi (opsional)
    try {
      await notificationService.sendFCMNotification(
        [23, 15],
        '📲 Notifikasi Absensi',
        `${namaLengkap} berhasil absen datang pada ${new Date(check_in_time).toLocaleTimeString('id-ID')}`,
        'https://delmargroup.id/wp-content/uploads/2025/07/KPI.jpg'
      );
    } catch (notifErr) {
      console.error('❌ Gagal kirim notif absen:', notifErr?.message || notifErr);
    }

    return res.status(201).json({ message: 'Check-in berhasil', type: 'checkin' });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

