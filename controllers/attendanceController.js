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

      return res.status(201).json({ message: 'Check-out berhasil', type: 'checkout' });
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

        if (isOvernightY && endDateStrY === todayStr) {
          // shift berikutnya (hari ini)
          const nextShift = await getEffectiveShift(db, user_id, todayStr, defaultShiftId);
          const nextStartDT = nextShift ? makeDateTime(todayStr, nextShift.start_time) : null;
          const latestCheckout = nextStartDT ? new Date(nextStartDT.getTime() - 2 * 60 * 60 * 1000) : null;

          // Belum lewat end time kemarin -> masih jam kerja -> tolak checkout
          if (ts < endDTy) {
            return res.status(400).json({ message: 'Belum waktunya untuk check-out' });
          }

          // === KUNCI PERUBAHAN ===
          // Jika SUDAH melewati (nextStart - 2 jam), JANGAN error -> biarkan lanjut ke CHECK-IN flow
          if (latestCheckout && ts > latestCheckout) {
            // do nothing: skip checkout kemarin, lanjut ke check-in di bawah (fallthrough)
          } else {
            // (Tidak ada nextShift, ATAU masih <= deadline) -> boleh check-out kemarin
            await db.query(
              `UPDATE attendance
                SET check_out_time = ?, check_out_latitude = ?, check_out_longitude = ?
              WHERE id = ?`,
              [check_in_time, check_in_latitude, check_in_longitude, openYesterday.id]
            );

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

            return res.status(201).json({ message: 'Check-out berhasil', type: 'checkout' });
          }
        }
        // Jika bukan overnight yg berakhir hari ini -> langsung fallthrough ke check-in
      }
      // fallthrough: lanjut ke CHECK-IN flow di bawah
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

// controllers/nilaiGrade.controller.js
// Catatan: asumsi ada koneksi DB: const db = require('../db'); atau serupa.
const HttpError = class extends Error { constructor(status, message){ super(message); this.status = status; } };

// ==== Util umum ====
const addDays = (dateStr, n) => {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};
const cmpDate = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));
const isValidYMD = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(`${s}T00:00:00`).getTime());
const isWeekend = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay(); // 0=Min,6=Sab
  return day === 0 || day === 6;
};
const isWorkdayByLocation = (dateObj, locationId, specialIds = [1, 5]) => {
  const id = Number(locationId);
  return specialIds.includes(id) ? !isWeekend(dateObj) : true;
};
const hasDinasLuar = (txt) => /dinas\s*luar/i.test(String(txt || ''));
const isEmptyTime = (t) => t == null || t === '' || t === '00:00';

// bucket skor ala Excel
const scoreFromCount = (n) => (n >= 5 ? 0 : n === 4 ? 20 : n === 3 ? 40 : n === 2 ? 60 : n === 1 ? 80 : 100);
const alpaFactor     = (n) => (n >= 5 ? 0.0 : n === 4 ? 0.2 : n === 3 ? 0.4 : n === 2 ? 0.6 : n === 1 ? 0.8 : 1.0);

// ===== Inti perhitungan: kembalikan payload siap pakai =====
async function computeNilaiGradePayload(req, db) {
  const { user_id } = req.query;
  let { start_date, end_date, start, end, bulan, tahun } = req.query;

  // normalisasi alias param
  start_date = (start_date || start || '').trim();
  end_date   = (end_date   || end   || '').trim();

  // validasi user
  const userIdInt = Number(user_id);
  if (!Number.isInteger(userIdInt)) {
    throw new HttpError(400, "Param wajib: user_id harus angka");
  }

  // ambil user
  const [[user]] = await db.query('SELECT id, shift_id, location_id FROM users WHERE id = ? LIMIT 1', [userIdInt]);
  if (!user) throw new HttpError(404, 'User tidak ditemukan.');

  // tentukan rentang tanggal
  let startDate, endDate;
  if (start_date && end_date) {
    if (!isValidYMD(start_date) || !isValidYMD(end_date)) {
      throw new HttpError(400, "Format tanggal harus YYYY-MM-DD (start_date & end_date)");
    }
    if (cmpDate(start_date, end_date) === 1) {
      throw new HttpError(400, "start_date tidak boleh lebih besar dari end_date");
    }
    startDate = start_date;
    endDate   = end_date;
  } else {
    const monthNum = Number(bulan);
    const yearNum  = Number(tahun);
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12 ||
        !Number.isInteger(yearNum) || String(tahun || '').length !== 4) {
      throw new HttpError(400, "Gunakan start_date & end_date (YYYY-MM-DD), atau bulan=1-12 & tahun=YYYY");
    }
    const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
    startDate = `${yearNum}-${String(monthNum).padStart(2, "0")}-01`;
    endDate   = `${yearNum}-${String(monthNum).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  }

  // clamp endDate ke hari ini supaya hari depan tidak dihitung ALPA
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  const effectiveEnd = (cmpDate(endDate, todayStr) === 1) ? todayStr : endDate;

  // ambil attendance & leave dalam rentang efektif
  const [attendance] = await db.query(
    `SELECT 
       DATE_FORMAT(a.date,'%Y-%m-%d')         AS date,
       TIME_FORMAT(a.check_in_time,'%H:%i')   AS check_in_time,
       TIME_FORMAT(a.check_out_time,'%H:%i')  AS check_out_time,
       a.leave_request_id,
       lr.leave_type,
       lr.reason
     FROM attendance a
     LEFT JOIN leave_requests lr ON lr.id = a.leave_request_id
     WHERE a.user_id = ? AND a.date BETWEEN ? AND ?`,
    [userIdInt, startDate, effectiveEnd]
  );
  const attMap = new Map(attendance.map(r => [r.date, r]));

  // telat > 3 menit (pakai default shift user)
  const [lateRows] = await db.query(
    `SELECT 
       DATE_FORMAT(a.date,'%Y-%m-%d') AS date,
       TIMESTAMPDIFF(SECOND, s.start_time, a.check_in_time) AS diff_sec
     FROM attendance a
     JOIN users u  ON u.id = a.user_id
     LEFT JOIN shifts s ON s.id = u.shift_id
     WHERE a.user_id = ?
       AND a.date BETWEEN ? AND ?
       AND a.check_in_time IS NOT NULL`,
    [userIdInt, startDate, effectiveEnd]
  );
  const lateMap = new Map(lateRows.map(r => [r.date, r.diff_sec]));

  // ===== agregasi =====
  let tidakLengkap = 0;
  let alpa = 0;              // total_alpa
  let ijin = 0;
  let sakit = 0;             // penalti (gabung dgn ijin)
  let sd = 0;                // SICK_WITH_CERT (tanpa penalti)
  let terlambatHari = 0;
  let totalKehadiranHari = 0; // hadir lengkap = ada check-in & check-out (meski ada leave)

  // iterasi harian
  for (let d = startDate; cmpDate(d, effectiveEnd) <= 0; d = addDays(d, 1)) {
    const rec = attMap.get(d);
    const isWorkday = isWorkdayByLocation(d, user.location_id);

    // hadir lengkap (dua jam ada), meski ada leave
    if (rec && !isEmptyTime(rec.check_in_time) && !isEmptyTime(rec.check_out_time)) {
      totalKehadiranHari += 1;
    }

    // penalti hanya untuk hari kerja
    if (!isWorkday) continue;

    if (!rec) {
      alpa += 1;
      continue;
    }

    const hasIn  = !isEmptyTime(rec.check_in_time);
    const hasOut = !isEmptyTime(rec.check_out_time);

    if (rec.leave_request_id) {
      const lt = rec.leave_type;

      // PLANNED + DINAS LUAR → hadir bila dua jam ada; kalau tidak, hitung Izin
      if (lt === 'PLANNED_ABSENCE' && hasDinasLuar(rec.reason)) {
        if (hasIn && hasOut) {
          // hadir, tanpa penalti
        } else {
          ijin += 1;
        }
        continue;
      }

      // LATE/EARLY (OFFSITE juga) → tanpa penalti (tidak-lengkap/telat)
      if (lt === 'LATE_ARRIVAL' || lt === 'LATE_ARRIVAL_OFFSITE' ||
          lt === 'EARLY_DEPARTURE' || lt === 'EARLY_DEPARTURE_OFFSITE') {
        continue;
      }

      // leave lain
      if (lt === 'SICK_NO_CERT')       sakit += 1;
      else if (lt === 'SICK_WITH_CERT') sd += 1;
      else if (['PLANNED_ABSENCE','UNPLANNED_ABSENCE','LEAVE_WORKPLACE'].includes(lt)) ijin += 1;

      continue;
    }

    // TANPA LEAVE: cek tidak lengkap & telat
    if ((hasIn && !hasOut) || (!hasIn && hasOut)) {
      tidakLengkap += 1;
    }

    const diffSec = lateMap.get(d);
    if (diffSec != null && diffSec > 180) {
      terlambatHari += 1;
    }
  }

  // komponen nilai
  const komponen =
    (scoreFromCount(tidakLengkap) * 0.30) +
    (scoreFromCount(ijin + sakit) * 0.40) +   // sd tidak dipenalti
    (scoreFromCount(terlambatHari) * 0.30);

  const nilai = Math.round(komponen * alpaFactor(alpa));

  // Grade
  let grade = "";
  if (nilai >= 90) grade = "A";
  else if (nilai >= 70 && nilai <= 89) grade = "B";
  else if (nilai >= 50 && nilai <= 69) grade = "C";
  else if (nilai >= 30 && nilai <= 49) grade = "D";
  else if (nilai <= 29) grade = "E";

  // jam absen pada end_effective
  const [[todayAtt]] = await db.query(
    `SELECT 
       TIME_FORMAT(check_in_time,'%H:%i')  AS check_in_time,
       TIME_FORMAT(check_out_time,'%H:%i') AS check_out_time
     FROM attendance
     WHERE user_id = ? AND date = ?
     LIMIT 1`,
    [userIdInt, effectiveEnd]
  );

  const absenDatang = todayAtt?.check_in_time || null;
  const absenPulang = todayAtt?.check_out_time || null;

  // total sakit (gabungan sakit tanpa surat + sakit dengan surat dokter)
  const totalSakit = sakit + sd;

  return {
    periode: { start: startDate, end: endDate, end_effective: effectiveEnd },
    nilai,
    grade,
    total_absen_lengkap: totalKehadiranHari,
    total_izin: ijin,
    total_telat: terlambatHari,
    total_tidak_lengkap: tidakLengkap,
    total_alpa: alpa,
    total_sakit: totalSakit,
    // detail opsional:
    // total_sakit_tanpa_surat: sakit,
    // total_sakit_dengan_surat: sd,
    absen_datang: absenDatang,
    absen_pulang: absenPulang
  };
}

// ====== Endpoint JSON (tetap ada) ======
exports.getNilaiGrade = async (req, res) => {
  try {
    const payload = await computeNilaiGradePayload(req, db);
    return res.json(payload);
  } catch (err) {
    console.error(err);
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: "Terjadi kesalahan server: " + err.message });
  }
};
// ====== Endpoint HTML Mobile (kompak + KPI 2 kolom, cocok WebView) ======
exports.getNilaiGradeHtml = async (req, res) => {
  try {
    const data = await computeNilaiGradePayload(req, db);

    // helper
    const escapeHtml = (s) =>
      String(s ?? '').replace(/[&<>"']/g, ch => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]
      ));
    const num = (v) => Number(v ?? 0);

    // total_sakit fallback (kalau payload lama)
    const totalSakit = num(data.total_sakit != null
      ? data.total_sakit
      : (data.sakit || 0) + (data.sd || 0));

    // palet sesuai grade
    const pal = {
      A: { start:'#34d399', end:'#10b981', tint:'#86efac' }, // emerald
      B: { start:'#60a5fa', end:'#3b82f6', tint:'#93c5fd' }, // blue
      C: { start:'#fbbf24', end:'#f59e0b', tint:'#fde68a' }, // amber
      D: { start:'#fb923c', end:'#f97316', tint:'#fdba74' }, // orange
      E: { start:'#f87171', end:'#ef4444', tint:'#fca5a5' }, // red
    }[data.grade || 'E'];

    const nilai = Math.max(0, Math.min(100, Number(data.nilai || 0)));

    const html = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Ringkasan Absensi</title>
<meta name="theme-color" content="${pal.end}">
<style>
  :root{
    --accent-start:${pal.start};
    --accent-end:${pal.end};
    --accent-tint:${pal.tint};
    --bg:#0b1020;
    --card:#0f172acc;
    --line:#ffffff22;
    --text:#e5e7eb;
    --muted:#9ca3af;
    --space:10px;
  }
  *{box-sizing:border-box}
  body{
    margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Inter, Roboto, Arial;
    color:var(--text);
    background:
      radial-gradient(900px 520px at -10% -10%, #06b6d4 0%, transparent 60%),
      radial-gradient(800px 480px at 50% 120%, #7c3aed 0%, transparent 60%),
      var(--bg);
    -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale;
  }
  .wrap{max-width:560px;margin:0 auto;padding:clamp(10px,4vw,16px)}

  /* kartu utama kompak */
  .summary{
    background:var(--card);
    border:1px solid var(--line);
    border-radius:16px;
    padding:12px;
    box-shadow:0 10px 28px rgba(0,0,0,.32), inset 0 0 0 1px rgba(255,255,255,.07);
    backdrop-filter: blur(6px);
  }

  /* periode pills (ringkas) */
  .pills{ display:flex; flex-wrap:wrap; gap:6px; margin:0 0 var(--space) }
  .pill{
    display:inline-flex; align-items:center; gap:6px;
    border-radius:999px; padding:5px 8px;
    border:1px dashed rgba(255,255,255,.24);
    background: rgba(255,255,255,.06);
    color:#dbeafe; font-size:.82rem;
  }

  /* hero (progress ring + grade) */
  .hero{ display:grid; gap:8px; grid-template-columns:1fr; margin-bottom:var(--space) }
  .ring{
    display:flex; align-items:center; gap:12px;
    background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
    border:1px solid rgba(255,255,255,.10);
    border-radius:14px; padding:10px;
  }
  .ring-outer{
    --size:84px; width:var(--size); height:var(--size); border-radius:50%;
    background:conic-gradient(var(--accent-start) ${nilai*3.6}deg, rgba(255,255,255,.17) 0deg 360deg);
    display:grid; place-items:center;
    box-shadow:0 8px 20px rgba(0,0,0,.25), inset 0 0 0 1px rgba(255,255,255,.18);
  }
  .ring-inner{
    width:calc(100% - 14px); height:calc(100% - 14px); border-radius:50%;
    background:rgba(7,12,28,.9); color:#fff; display:grid; place-items:center;
    font-weight:900; font-size:1.1rem; text-shadow:0 1px 2px rgba(0,0,0,.25);
  }
  .grade-badge{
    display:inline-grid; place-items:center;
    min-width:42px; height:28px; padding:0 8px; border-radius:9px;
    background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
    color:#06121a; font-weight:900; border:1px solid rgba(255,255,255,.24); font-size:.95rem;
  }
  .hero-note{ font-size:.85rem; color:var(--muted); margin-top:4px }

  /* KPI grid: 2 kolom SELALU */
  .grid{
    display:grid; gap:8px; grid-template-columns: 1fr 1fr;
  }
  .kpi{
    background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
    border:1px solid rgba(255,255,255,.10);
    border-radius:12px; padding:10px;
    display:flex; align-items:center; gap:10px; min-height:54px;
  }
  .kpi .i{
    width:32px; height:32px; flex:0 0 32px;
    display:grid; place-items:center; border-radius:9px;
    color:#0a1220;
    background: linear-gradient(135deg, var(--accent-start), var(--accent-end));
    box-shadow: 0 6px 12px rgba(0,0,0,.22), inset 0 0 0 1px rgba(255,255,255,.16);
    font-size:17px;
  }
  .kpi b{ font-size:1.1rem; line-height:1 }
  .kpi .label{ color:var(--muted); font-size:.8rem; margin-top:2px; line-height:1.1 }

  /* detail list ringkas (2 kolom agar pendek) */
  .list{ margin-top:var(--space); display:grid; gap:8px; grid-template-columns: 1fr 1fr }
  .row{
    display:flex; justify-content:space-between; align-items:center; gap:10px;
    background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.02));
    border:1px solid rgba(255,255,255,.10);
    border-radius:10px; padding:8px 10px; min-height:46px;
  }
  .left{ display:flex; flex-direction:column; }
  .left small{ color:var(--muted); font-size:.78rem }
</style>
</head>
<body>
  <div class="wrap">
    <section class="summary" aria-label="Ringkasan Absensi">
      <!-- PERIODE -->
      <div class="pills">
        <span class="pill">📅 ${escapeHtml(data.periode.start)} → ${escapeHtml(data.periode.end)}</span>
        <span class="pill">⏱️ s.d. ${escapeHtml(data.periode.end_effective)}</span>
      </div>

      <!-- HERO -->
      <div class="hero">
        <div class="ring">
          <div class="ring-outer" role="img" aria-label="Nilai ${nilai} dari 100">
            <div class="ring-inner">${nilai}<small>/100</small></div>
          </div>
          <div>
            <div style="font-size:.85rem;color:var(--muted)">Grade</div>
            <div class="grade-badge">${escapeHtml(data.grade)}</div>
            <div class="hero-note">Performa periode ini</div>
          </div>
        </div>
      </div>

      <!-- KPI GRID (2 kolom) -->
      <div class="grid" aria-label="KPI Periode">
        <div class="kpi"><div class="i">✅</div><div><b>${num(data.total_absen_lengkap)}</b><div class="label">Hadir Lengkap</div></div></div>
        <div class="kpi"><div class="i">⏰</div><div><b>${num(data.total_telat)}</b><div class="label">Telat (&gt;3 menit)</div></div></div>
        <div class="kpi"><div class="i">🟡</div><div><b>${num(data.total_tidak_lengkap)}</b><div class="label">Tidak Lengkap</div></div></div>
        <div class="kpi"><div class="i">📄</div><div><b>${num(data.total_izin)}</b><div class="label">Izin</div></div></div>
        <div class="kpi"><div class="i">❌</div><div><b>${num(data.total_alpa)}</b><div class="label">Alpa</div></div></div>
        <div class="kpi"><div class="i">🤒</div><div><b>${totalSakit}</b><div class="label">Sakit (Total)</div></div></div>
      </div>

      <!-- DETAIL (2 kolom agar pendek) -->
      <div class="list" aria-label="Detail Tambahan">
        <div class="row"><div class="left"><b>Absen Datang</b><small>Per ${escapeHtml(data.periode.end_effective)}</small></div><div><b>${data.absen_datang ? escapeHtml(data.absen_datang) : '-'}</b></div></div>
        <div class="row"><div class="left"><b>Absen Pulang</b><small>Per ${escapeHtml(data.periode.end_effective)}</small></div><div><b>${data.absen_pulang ? escapeHtml(data.absen_pulang) : '-'}</b></div></div>
      </div>
    </section>
  </div>
</body>
</html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);

  } catch (err) {
    console.error(err);
    const escapeHtml = (s) =>
      String(s ?? '').replace(/[&<>"']/g, ch => (
        {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]
      ));
    const msg = err?.message || ("Terjadi kesalahan server: " + err);
    res
      .status(err?.status || 500)
      .send(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body{font-family:system-ui,Segoe UI,Roboto,Arial;padding:24px;background:#0b1020;color:#e5e7eb}
        .box{max-width:560px;margin:0 auto;background:#111827aa;border:1px solid #ffffff22;border-radius:16px;padding:18px}
        h1{margin:0 0 8px 0}.muted{color:#9ca3af}a{color:#93c5fd}
      </style>
      <div class="box"><h1>Gagal memuat</h1><div class="muted">${escapeHtml(msg)}</div><p><a href="javascript:history.back()">Kembali</a></p></div>`);
  }
};
