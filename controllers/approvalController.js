const db = require('../db');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Controller untuk menangani sistem approval (Attendance & Odoo ERP / External)
 * 100% Real Database MySQL (Tanpa dummy/mock data)
 * Fitur:
 * 1. Pengajuan Izin Mobile (Submit Leave Request)
 * 2. Multi Approver per Dokumen (Default: Pak Jogi ID 15)
 * 3. Update otomatis ke `leave_requests` dan `attendance` setelah approved
 * 4. Filter Otoritas User: User 23 & 334 (Super Admin IT) melihat semua dokumen,
 *    user lain HANYA melihat dokumen di mana dia terdaftar sebagai approver.
 * 5. Ingestion Dokumen Eksternal Odoo ERP
 */

// Helper memformat kode sistem leave_type menjadi label bahasa Indonesia yang ramah pengguna
function formatLeaveTypeLabel(type) {
  if (!type) return 'Izin';
  const clean = type.toString().trim().toUpperCase();
  switch (clean) {
    case 'PLANNED_ABSENCE': return 'Tidak Masuk Direncanakan';
    case 'UNPLANNED_ABSENCE': return 'Tidak Masuk Mendadak';
    case 'LEAVE_WORKPLACE': return 'Meninggalkan Tempat Kerja';
    case 'LATE_ARRIVAL': return 'Datang Terlambat';
    case 'EARLY_DEPARTURE': return 'Pulang Lebih Awal';
    case 'LATE_ARRIVAL_OFFSITE': return 'Datang Terlambat Karena Dinas Luar';
    case 'EARLY_DEPARTURE_OFFSITE': return 'Pulang Lebih Awal Karena Dinas Luar';
    case 'SICK_NO_CERT': return 'Sakit Tanpa Surat Dokter';
    case 'SICK_WITH_CERT': return 'Sakit (Ada Surat Dokter)';
    default: return type.replace(/_/g, ' ');
  }
}

// Super Admins yang memiliki otoritas melihat semua dokumen approval
const SUPER_ADMIN_IDS = [23, 334, '23', '334'];

// Helper verifikasi token
function verifyApprovalToken(req) {
  const authHeader = req.headers['authorization'] || req.headers['x-api-token'];
  if (!authHeader) return { valid: false, message: 'Header Authorization atau x-api-token tidak ditemukan.' };
  
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  if (!token || token.length < 3) {
    return { valid: false, message: 'Token tidak valid.' };
  }
  return { valid: true, token };
}

/**
 * Helper: Sinkronisasi data Izin/Cuti ke tabel attendance saat approval selesai
 */
async function syncLeaveToAttendance(leaveId) {
  try {
    // 1. Ambil detail leave_request
    const [lrs] = await db.query(`
      SELECT id, user_id, full_name, leave_type, reason,
             DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
             DATE_FORMAT(return_date, '%Y-%m-%d') AS return_date
      FROM leave_requests WHERE id = ?
    `, [leaveId]);

    if (!lrs || lrs.length === 0) return;
    const lr = lrs[0];

    // 2. Ambil user info (location_id & shift_id & location_name)
    const [users] = await db.query(`
      SELECT u.id, u.location_id, u.shift_id, l.name AS location_name 
      FROM users u 
      LEFT JOIN locations l ON u.location_id = l.id 
      WHERE u.id = ?
    `, [lr.user_id]);
    const user = users[0] || {};

    // Cek aturan hari kerja dari location_rules (100% dinamis per lokasi)
    let workDayType = '5_DAYS';
    if (user.location_id) {
      const [rules] = await db.query('SELECT work_day_type, is_5_days FROM location_rules WHERE location_id = ?', [user.location_id]);
      if (rules.length > 0) {
        workDayType = rules[0].work_day_type || (rules[0].is_5_days ? '5_DAYS' : '7_DAYS');
      } else {
        workDayType = Number(user.location_id) === 1 ? '5_DAYS' : '7_DAYS';
      }
    }

    // 3. Ambil shift bounds
    let shift = { start_time: '08:00:00', end_time: '17:00:00', name: '' };
    if (user.shift_id) {
      const [shifts] = await db.query('SELECT start_time, end_time, name FROM shifts WHERE id = ?', [user.shift_id]);
      if (shifts.length > 0) shift = shifts[0];
    }

    // 4. Hitung daftar tanggal izin
    // Konvensi HR: 'return_date' adalah 'Tanggal Masuk Kembali Bekerja' (BUKAN tanggal izin).
    // Jadi hari izin adalah [start_date, return_date) (eksklusif terhadap return_date).
    // Kecuali jika start_date === return_date (misal izin parsial 1 hari), maka hari izin adalah start_date itu sendiri.
    const dStart = new Date(`${lr.start_date}T00:00:00`);
    const dEnd = new Date(`${lr.return_date || lr.start_date}T00:00:00`);

    const dates = [];
    let curr = new Date(dStart);
    if (dStart.getTime() === dEnd.getTime()) {
      dates.push(lr.start_date);
    } else {
      while (curr < dEnd) {
        const yyyy = curr.getFullYear();
        const mm = String(curr.getMonth() + 1).padStart(2, '0');
        const dd = String(curr.getDate()).padStart(2, '0');
        dates.push(`${yyyy}-${mm}-${dd}`);
        curr.setDate(curr.getDate() + 1);
      }
    }

    const isDinasLuar = /dinas\s*luar/i.test(String(lr.reason || '')) || (lr.leave_type && lr.leave_type.includes('OFFSITE'));
    const isLate = lr.leave_type === 'LATE_ARRIVAL' || lr.leave_type === 'LATE_ARRIVAL_OFFSITE';
    const isEarly = lr.leave_type === 'EARLY_DEPARTURE' || lr.leave_type === 'EARLY_DEPARTURE_OFFSITE';
    const isPlanned = lr.leave_type === 'PLANNED_ABSENCE';

    for (const d of dates) {
      const dayOfWeek = new Date(`${d}T00:00:00`).getDay(); // 0: Sun, 6: Sat

      // Cek apakah sudah ada baris attendance pada tanggal tersebut
      const [att] = await db.query(
        'SELECT id, check_in_time, check_out_time FROM attendance WHERE user_id = ? AND date = ? LIMIT 1',
        [lr.user_id, d]
      );

      // Tentukan apakah hari ini adalah hari libur rutin berdasarkan konfigurasi lokasi:
      // - 7_DAYS: Operasional shift / setiap hari (tidak ada libur akhir pekan rutin).
      // - 6_DAYS: Hanya Minggu (0) yang libur rutin.
      // - 5_DAYS: Sabtu (6) dan Minggu (0) adalah libur rutin.
      const isWeekendForUser = (workDayType === '7_DAYS')
        ? false
        : (workDayType === '6_DAYS')
        ? (dayOfWeek === 0)
        : (dayOfWeek === 0 || dayOfWeek === 6);

      // Lewati hari libur HANYA jika karyawan TIDAK memiliki baris absensi (tidak hadir)
      // Jika karyawan sudah absen masuk (att.length > 0), jangan di-skip agar checkout izin tetap tersinkronisasi!
      if (isWeekendForUser && att.length === 0) {
        continue; // Skip weekend untuk lokasi kantor / 5 hari kerja jika tidak ada absensi
      }

      let setCheckIn = null;
      let setCheckOut = null;

      if (isDinasLuar && isPlanned) {
        setCheckIn = shift.start_time;
        setCheckOut = shift.end_time;
      } else if (isLate) {
        setCheckIn = shift.start_time;
      } else if (isEarly) {
        setCheckOut = shift.end_time;
      }

      if (att.length > 0) {
        // UPDATE record attendance (hubungkan leave_request_id, jangan menimpa jam check-in/out yang sudah ada)
        let updateSql = 'UPDATE attendance SET leave_request_id = ?';
        const updateParams = [leaveId];

        if (setCheckIn && !att[0].check_in_time) {
          updateSql += ', check_in_time = ?';
          updateParams.push(setCheckIn);
        }
        if (setCheckOut && !att[0].check_out_time) {
          updateSql += ', check_out_time = ?';
          updateParams.push(setCheckOut);
        }
        if (user.location_name) {
          updateSql += ', location_name = COALESCE(location_name, ?)';
          updateParams.push(user.location_name);
        }

        updateSql += ' WHERE id = ?';
        updateParams.push(att[0].id);
        await db.query(updateSql, updateParams);
      } else {
        // INSERT record attendance baru
        await db.query(`
          INSERT INTO attendance 
            (user_id, shift_id, date, check_in_time, check_out_time, leave_request_id, location_name, created_date)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        `, [
          lr.user_id,
          user.shift_id || 1,
          d,
          setCheckIn || '00:00:00',
          setCheckOut || null,
          leaveId,
          user.location_name || null
        ]);
      }
    }

    console.log(`[SYNC ATTENDANCE] Successfully synced Leave #${leaveId} to attendance for User #${lr.user_id} across ${dates.length} days.`);
  } catch (syncErr) {
    console.error(`[SYNC ATTENDANCE ERROR] Failed to sync Leave #${leaveId} to attendance:`, syncErr);
  }
}

/**
 * Helper: Webhook Callback untuk menembak endpoint/backend sistem eksternal (misal: Odoo ERP)
 * saat dokumen disetujui / ditolak via mobile app
 */
async function triggerExternalCallback(approvalId, triggerContext = {}) {
  try {
    const [rows] = await db.query(`
      SELECT id, source, doc_type, doc_ref, external_doc_id, title,
             amount, currency, requester_name, department, status,
             callback_url, callback_method, callback_headers, payload_json
      FROM external_approvals
      WHERE id = ?
    `, [approvalId]);

    if (!rows || rows.length === 0) {
      return { success: false, message: 'Dokumen eksternal tidak ditemukan.' };
    }

    const ext = rows[0];

    // Ambil target webhook URL dari kolom tabel atau dari dalam payload_json
    let targetUrl = ext.callback_url;
    let payloadObj = {};
    try {
      payloadObj = typeof ext.payload_json === 'string' ? JSON.parse(ext.payload_json) : (ext.payload_json || {});
    } catch (_) {}

    if (!targetUrl && payloadObj) {
      targetUrl = payloadObj.callback_url || payloadObj.webhook_url || null;
    }

    if (!targetUrl) {
      console.log(`[EXTERNAL CALLBACK] Dokumen #${approvalId} (${ext.doc_ref}) tidak memiliki callback_url. Callback dilewati.`);
      return { success: true, skipped: true, message: 'No callback_url configured' };
    }

    // Ambil daftar status seluruh approver
    const [approvers] = await db.query(`
      SELECT step_order, approver_user_id, approver_name, approver_email, status, notes,
             DATE_FORMAT(action_date, '%Y-%m-%d %H:%i:%s') AS action_date
      FROM external_approval_approvers
      WHERE approval_id = ?
      ORDER BY step_order ASC
    `, [approvalId]);

    const isAllApproved = approvers.length > 0 && approvers.every(a => a.status === 'approved');
    const isAnyRejected = approvers.some(a => a.status === 'rejected');

    // Susun payload yang dikirimkan ke backend eksternal / Odoo
    const webhookData = {
      event: isAllApproved ? 'document_approved' : (isAnyRejected ? 'document_rejected' : 'approval_step_update'),
      timestamp: new Date().toISOString(),
      source: ext.source || 'odoo',
      document: {
        approval_id: ext.id,
        doc_type: ext.doc_type,
        doc_ref: ext.doc_ref,
        external_doc_id: ext.external_doc_id,
        title: ext.title,
        amount: ext.amount,
        currency: ext.currency,
        requester_name: ext.requester_name,
        department: ext.department,
        overall_status: ext.status,
        is_completed: isAllApproved || isAnyRejected
      },
      action_trigger: triggerContext ? {
        action: triggerContext.action,
        user_id: triggerContext.approverUserId,
        notes: triggerContext.notes || null,
        executed_at: new Date().toISOString()
      } : null,
      approvers: approvers.map(a => ({
        step: a.step_order,
        approver_id: a.approver_user_id,
        approver_name: a.approver_name,
        email: a.approver_email,
        status: a.status,
        notes: a.notes,
        action_date: a.action_date
      })),
      original_payload: payloadObj
    };

    // Susun HTTP Headers
    let customHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Attendance-Approval-Gateway/1.0'
    };

    if (ext.callback_headers) {
      try {
        const parsedHeaders = typeof ext.callback_headers === 'string'
          ? JSON.parse(ext.callback_headers)
          : ext.callback_headers;
        customHeaders = { ...customHeaders, ...parsedHeaders };
      } catch (_) {}
    }

    const method = (ext.callback_method || 'POST').toUpperCase();
    console.log(`[EXTERNAL CALLBACK] Mengirim ${method} ke ${targetUrl} untuk dokumen [${ext.doc_ref}]...`);

    const response = await axios({
      method,
      url: targetUrl,
      data: method !== 'GET' ? webhookData : undefined,
      params: method === 'GET' ? { doc_ref: ext.doc_ref, status: ext.status } : undefined,
      headers: customHeaders,
      timeout: 10000
    });

    const responseBodyStr = typeof response.data === 'object'
      ? JSON.stringify(response.data).slice(0, 2000)
      : String(response.data).slice(0, 2000);

    const logMessage = `[HTTP ${response.status}] ${responseBodyStr}`;

    await db.query(`
      UPDATE external_approvals
      SET callback_status = 'success',
          callback_response = ?,
          callback_executed_at = NOW()
      WHERE id = ?
    `, [logMessage, approvalId]);

    console.log(`[EXTERNAL CALLBACK] Sukses hit callback dokumen [${ext.doc_ref}]: HTTP ${response.status}`);
    return {
      success: true,
      status_code: response.status,
      response: response.data
    };
  } catch (err) {
    const errorMsg = err.response
      ? `[HTTP ${err.response.status}] ${JSON.stringify(err.response.data || err.message).slice(0, 2000)}`
      : `[Network Error] ${err.message}`;

    console.warn(`[EXTERNAL CALLBACK] Gagal hit callback dokumen #${approvalId}:`, errorMsg);

    await db.query(`
      UPDATE external_approvals
      SET callback_status = 'failed',
          callback_response = ?,
          callback_executed_at = NOW()
      WHERE id = ?
    `, [errorMsg, approvalId]).catch(() => {});

    return {
      success: false,
      error: errorMsg
    };
  }
}

/**
 * Helper: Menyimpan dokumen pendukung base64 ke disk file dan mengembalikan path URL
 */
function saveBase64Document(base64Str, userId) {
  if (!base64Str) return null;
  if (!base64Str.startsWith('data:')) {
    return base64Str;
  }

  try {
    const uploadDir = path.join(__dirname, '../uploads/leave_docs');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const matches = base64Str.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return null;
    }

    const mime = matches[1];
    let ext = 'jpg';
    if (mime.includes('png')) ext = 'png';
    else if (mime.includes('pdf')) ext = 'pdf';
    else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';

    const buffer = Buffer.from(matches[2], 'base64');
    const filename = `leave_doc_${userId}_${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, filename);

    fs.writeFileSync(filePath, buffer);
    return `/uploads/leave_docs/${filename}`;
  } catch (err) {
    console.error('Error saving base64 document:', err);
    return null;
  }
}

// POST /api/approval/leave/submit
// Endpoint pengajuan izin dari aplikasi mobile
exports.submitLeaveRequest = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const {
      user_id,
      full_name,
      department_division,
      leave_type,
      reason,
      start_date,
      return_date,
      submission_date,
      supporting_doc,
      supporting_docs,
    } = req.body;

    if (!user_id || !full_name || !leave_type || !reason || !start_date || !return_date) {
      return res.status(400).json({
        success: false,
        message: 'Field user_id, full_name, leave_type, reason, start_date, dan return_date wajib diisi.'
      });
    }

    // Simpan dokumen pendukung (mendukung multiple documents & base64)
    let docPath = null;
    if (supporting_docs && Array.isArray(supporting_docs) && supporting_docs.length > 0) {
      docPath = JSON.stringify(supporting_docs);
    } else if (supporting_doc) {
      if (Array.isArray(supporting_doc)) {
        docPath = JSON.stringify(supporting_doc);
      } else if (typeof supporting_doc === 'string') {
        if (supporting_doc.startsWith('data:')) {
          docPath = saveBase64Document(supporting_doc, user_id);
        } else {
          docPath = supporting_doc;
        }
      }
    }

    // 1. Simpan ke tabel leave_requests
    const [ins] = await db.query(`
      INSERT INTO leave_requests 
        (user_id, full_name, submission_date, department_division, leave_type, reason, start_date, return_date, status, supporting_doc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [
      user_id,
      full_name,
      submission_date || new Date().toISOString().split('T')[0],
      department_division || '',
      leave_type,
      reason,
      start_date,
      return_date,
      docPath || null
    ]);

    const leaveId = ins.insertId;

    // 2. Ambil entitas_id dan informasi departemen/jabatan user
    const [userRows] = await db.query('SELECT entitas_id, department, position FROM users WHERE id = ?', [user_id]);
    const userRow = userRows.length > 0 ? userRows[0] : {};
    const entId = userRow.entitas_id || null;
    const userDept = (department_division || userRow.department || userRow.position || '').trim();

    // 3. Ambil approver dari entity_approval_rules dengan sistem hierarki dinamis:
    //    Prioritas 1: Entitas cocok AND Departemen/Divisi cocok
    //    Prioritas 2: Entitas cocok AND Departemen IS NULL (Aturan umum per entitas)
    //    Prioritas 3: Entitas IS NULL AND Departemen cocok (Aturan umum departemen)
    //    Prioritas 4: Entitas IS NULL AND Departemen IS NULL (Aturan global)
    //    Prioritas 5: Default Pak Jogi (user_id 15)
    let rules = [];

    // Prioritas 1: Entitas + Departemen spesifik
    if (entId && userDept) {
      const [p1Rules] = await db.query(`
        SELECT r.step_order, r.approver_user_id,
               COALESCE(r.approver_name, u.name, CONCAT('Approver ', r.approver_user_id)) AS approver_name,
               COALESCE(r.approver_email, u.username, '') AS approver_email
        FROM entity_approval_rules r
        LEFT JOIN users u ON r.approver_user_id = u.id
        WHERE r.entitas_id = ? AND (LOWER(r.department) = LOWER(?) OR LOWER(?) LIKE CONCAT('%', LOWER(r.department), '%'))
        ORDER BY r.step_order ASC
      `, [entId, userDept, userDept]);
      if (p1Rules.length > 0) rules = p1Rules;
    }

    // Prioritas 2: Entitas spesifik (Departemen umum / NULL)
    if (rules.length === 0 && entId) {
      const [p2Rules] = await db.query(`
        SELECT r.step_order, r.approver_user_id,
               COALESCE(r.approver_name, u.name, CONCAT('Approver ', r.approver_user_id)) AS approver_name,
               COALESCE(r.approver_email, u.username, '') AS approver_email
        FROM entity_approval_rules r
        LEFT JOIN users u ON r.approver_user_id = u.id
        WHERE r.entitas_id = ? AND (r.department IS NULL OR r.department = '')
        ORDER BY r.step_order ASC
      `, [entId]);
      if (p2Rules.length > 0) rules = p2Rules;
    }

    // Prioritas 3: Departemen spesifik lintas entitas (Entitas IS NULL)
    if (rules.length === 0 && userDept) {
      const [p3Rules] = await db.query(`
        SELECT r.step_order, r.approver_user_id,
               COALESCE(r.approver_name, u.name, CONCAT('Approver ', r.approver_user_id)) AS approver_name,
               COALESCE(r.approver_email, u.username, '') AS approver_email
        FROM entity_approval_rules r
        LEFT JOIN users u ON r.approver_user_id = u.id
        WHERE r.entitas_id IS NULL AND (LOWER(r.department) = LOWER(?) OR LOWER(?) LIKE CONCAT('%', LOWER(r.department), '%'))
        ORDER BY r.step_order ASC
      `, [userDept, userDept]);
      if (p3Rules.length > 0) rules = p3Rules;
    }

    // Prioritas 4: Aturan global (Entitas NULL AND Departemen NULL)
    if (rules.length === 0) {
      const [p4Rules] = await db.query(`
        SELECT r.step_order, r.approver_user_id,
               COALESCE(r.approver_name, u.name, CONCAT('Approver ', r.approver_user_id)) AS approver_name,
               COALESCE(r.approver_email, u.username, '') AS approver_email
        FROM entity_approval_rules r
        LEFT JOIN users u ON r.approver_user_id = u.id
        WHERE r.entitas_id IS NULL AND (r.department IS NULL OR r.department = '')
        ORDER BY r.step_order ASC
      `);
      if (p4Rules.length > 0) rules = p4Rules;
    }

    // Prioritas 5: Default keamanan: Pak Jogi (user_id 15)
    if (rules.length === 0) {
      rules = [{
        step_order: 1,
        approver_user_id: 15,
        approver_name: 'Pak Jogi Ardyawan',
        approver_email: 'jogi@delmargroup.id'
      }];
    }

    // 4. Masukkan ke leave_request_approvers
    for (const r of rules) {
      await db.query(`
        INSERT INTO leave_request_approvers
          (leave_request_id, step_order, approver_user_id, approver_name, approver_email, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `, [leaveId, r.step_order, r.approver_user_id, r.approver_name, r.approver_email]);
    }

    // 5. Kirim Push Notifikasi FCM ke approver tingkat pertama
    try {
      const firstApproverIds = rules
        .filter(r => r.step_order === 1)
        .map(r => r.approver_user_id)
        .filter(Boolean);

      if (firstApproverIds.length > 0) {
        const notificationService = require('../services/notificationService');
        await notificationService.sendFCMNotification(
          firstApproverIds,
          '📋 Permohonan Persetujuan Baru',
          `${full_name} mengajukan ${formatLeaveTypeLabel(leave_type)} (${start_date} s/d ${return_date}). Ketuk untuk membuka detail.`,
          '',
          {
            type: 'approval',
            screen: 'approval',
            approval_id: `att-leave-${leaveId}`,
            raw_id: String(leaveId),
            source: 'attendance',
            category: 'Izin',
            requester_name: full_name,
            title: `Pengajuan ${formatLeaveTypeLabel(leave_type)}`
          }
        );
      }
    } catch (fcmErr) {
      console.warn('⚠️ Gagal mengirim push notifikasi ke approver:', fcmErr.message);
    }

    return res.status(201).json({
      success: true,
      message: 'Pengajuan izin berhasil dikirim dan menunggu persetujuan.',
      data: {
        id: leaveId,
        user_id,
        full_name,
        leave_type,
        status: 'pending',
        approvers: rules.map(r => r.approver_name)
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, message: 'Gagal mengajukan izin: ' + err.message, error: err.message });
  }
};

// GET /api/approval/leave/my-requests
// Endpoint untuk melihat riwayat izin yang diajukan oleh user yang bersangkutan
exports.getMyLeaveRequests = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'Parameter user_id wajib diisi.' });
    }

    const [rows] = await db.query(`
      SELECT lr.id, lr.user_id, lr.full_name, lr.leave_type, lr.reason, lr.department_division,
             DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
             DATE_FORMAT(lr.return_date, '%Y-%m-%d') AS return_date,
             DATE_FORMAT(lr.submission_date, '%Y-%m-%d') AS submission_date,
             COALESCE(lr.status, 'pending') AS status,
             lr.supporting_doc
      FROM leave_requests lr
      WHERE lr.user_id = ?
      ORDER BY lr.id DESC
      LIMIT 50
    `, [user_id]);

    for (const row of rows) {
      row.leave_type_label = formatLeaveTypeLabel(row.leave_type);
      const [approvers] = await db.query(`
        SELECT step_order, approver_name, status, notes,
               DATE_FORMAT(action_date, '%Y-%m-%d %H:%i') AS action_date
        FROM leave_request_approvers
        WHERE leave_request_id = ?
        ORDER BY step_order ASC
      `, [row.id]);
      row.approvers = approvers;
    }

    return res.json({
      success: true,
      total: rows.length,
      data: rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Shared Core Helper: Mengambil seluruh item approval (Attendance & External)
 * dengan mapping approver berkinerja tinggi (Batch Query) dan status dinamis.
 */
async function fetchApprovalsList(userId, options = {}) {
  const currentUserId = userId ? String(userId) : null;
  const isSuperAdmin = currentUserId && SUPER_ADMIN_IDS.includes(currentUserId);
  const viewAll = isSuperAdmin || options.all === 'true' || options.all === true;
  const queryLimit = parseInt(options.limit, 10) || 500;
  const source = options.source || null;

  let attendanceItems = [];
  let externalItems = [];

  // 1. DATA PENGGAJIAN ATTENDANCE / LEAVE (100% REAL DB)
  if (!source || source === 'attendance') {
    try {
      // Prioritaskan dokumen berstatus 'pending' terlebih dahulu agar tidak terpotong oleh LIMIT!
      const [leaves] = await db.query(`
        SELECT lr.id, lr.user_id, lr.full_name, lr.leave_type, lr.reason, lr.department_division,
               DATE_FORMAT(lr.start_date, '%Y-%m-%d') AS start_date,
               DATE_FORMAT(lr.return_date, '%Y-%m-%d') AS return_date,
               DATE_FORMAT(lr.submission_date, '%Y-%m-%d') AS submission_date,
               COALESCE(lr.status, 'pending') AS doc_status,
               lr.supporting_doc,
               u.position, u.department AS user_department,
               u.entitas_id, e.name AS entity_name
        FROM leave_requests lr
        LEFT JOIN users u ON lr.user_id = u.id
        LEFT JOIN entitas e ON u.entitas_id = e.id
        ORDER BY CASE WHEN lr.status = 'pending' THEN 0 ELSE 1 END, lr.id DESC
        LIMIT ?
      `, [queryLimit]);

      const leaveIds = leaves.map(l => l.id);
      let approversByLeaveId = new Map();

      if (leaveIds.length > 0) {
        const [allApprovers] = await db.query(`
          SELECT id, leave_request_id, step_order, approver_user_id, approver_name, approver_email, status, notes,
                 DATE_FORMAT(action_date, '%Y-%m-%d %H:%i') AS action_date
          FROM leave_request_approvers
          WHERE leave_request_id IN (?)
          ORDER BY step_order ASC
        `, [leaveIds]);

        for (const a of allApprovers) {
          if (!approversByLeaveId.has(a.leave_request_id)) {
            approversByLeaveId.set(a.leave_request_id, []);
          }
          approversByLeaveId.get(a.leave_request_id).push(a);
        }
      }

      for (const lr of leaves) {
        let approvers = approversByLeaveId.get(lr.id) || [];

        // Fallback jika belum terpetakan di leave_request_approvers
        if (approvers.length === 0) {
          approvers = [{
            step_order: 1,
            approver_user_id: 15,
            approver_name: 'Pak Jogi Ardyawan',
            approver_email: 'jogi@delmargroup.id',
            status: lr.doc_status || 'pending'
          }];
        }

        const hasRejected = approvers.some(a => a.status === 'rejected');
        const allApproved = approvers.length > 0 && approvers.every(a => a.status === 'approved');
        const overallStatus = hasRejected ? 'rejected' : (allApproved ? 'approved' : lr.doc_status);

        const isUserApprover = currentUserId && approvers.some(a => String(a.approver_user_id) === currentUserId);
        const canAction = isSuperAdmin
          ? overallStatus === 'pending'
          : (currentUserId && approvers.some(a => String(a.approver_user_id) === currentUserId && a.status === 'pending'));

        let supportingDocs = [];
        if (lr.supporting_doc) {
          const raw = String(lr.supporting_doc).trim();
          if (raw.startsWith('[') && raw.endsWith(']')) {
            try {
              supportingDocs = JSON.parse(raw);
            } catch (_) {
              supportingDocs = [raw];
            }
          } else if (raw) {
            supportingDocs = [raw];
          }
        }

        if (viewAll || isUserApprover) {
          attendanceItems.push({
            id: `att-leave-${lr.id}`,
            raw_id: lr.id,
            code: `IZIN/ATT/${lr.id}`,
            title: `Permohonan ${formatLeaveTypeLabel(lr.leave_type)}`,
            leave_type: lr.leave_type,
            leave_type_label: formatLeaveTypeLabel(lr.leave_type),
            source: 'attendance',
            category: 'Izin Karyawan',
            requester_name: lr.full_name || 'Karyawan',
            department: lr.department_division || lr.user_department || 'General',
            position: lr.position || null,
            entity_name: lr.entity_name || 'Delmar Group',
            submission_date: lr.submission_date || lr.start_date,
            amount: null,
            description: `Alasan: ${lr.reason || '-'}. Periode: ${lr.start_date} s/d ${lr.return_date || lr.start_date}`,
            status: overallStatus,
            supporting_doc: lr.supporting_doc || null,
            supporting_docs: supportingDocs,
            approvers: approvers.map(a => ({
              step: a.step_order,
              user_id: a.approver_user_id,
              name: a.approver_name,
              email: a.approver_email,
              status: a.status,
              notes: a.notes,
              action_date: a.action_date
            })),
            can_action: canAction
          });
        }
      }
    } catch (attErr) {
      console.warn('Error reading attendance leaves from DB:', attErr.message);
    }
  }

  // 2. DATA APPROVAL EKSTERNAL (ODOO, SAP, AQUATRACK, DLL)
  if (!source || source !== 'attendance') {
    try {
      let extQuery = `
        SELECT e.id, e.source, e.doc_type, e.doc_ref, e.external_doc_id, e.title, e.description,
               e.amount, e.currency, e.requester_name, e.department,
               DATE_FORMAT(e.submission_date, '%Y-%m-%d') AS submission_date,
               e.status, e.payload_json, e.callback_url, e.callback_status, e.callback_response,
               DATE_FORMAT(e.callback_executed_at, '%Y-%m-%d %H:%i:%s') AS callback_executed_at,
               COALESCE(s.name, UPPER(e.source)) AS source_label,
               COALESCE(s.badge_color, '#714B67') AS badge_color,
               COALESCE(s.icon_name, 'business') AS icon_name
        FROM external_approvals e
        LEFT JOIN external_systems s ON e.source = s.code
      `;
      const extParams = [];
      if (source && source !== 'external') {
        extQuery += ' WHERE e.source = ?';
        extParams.push(source);
      }
      extQuery += " ORDER BY CASE WHEN e.status = 'pending' THEN 0 ELSE 1 END, e.id DESC LIMIT 100";

      const [externals] = await db.query(extQuery, extParams);
      const extIds = externals.map(e => e.id);
      let extApproversById = new Map();

      if (extIds.length > 0) {
        const [allExtApprovers] = await db.query(`
          SELECT id, approval_id, step_order, approver_user_id, approver_name, approver_email, status, notes,
                 DATE_FORMAT(action_date, '%Y-%m-%d %H:%i') AS action_date
          FROM external_approval_approvers
          WHERE approval_id IN (?)
          ORDER BY step_order ASC
        `, [extIds]);

        for (const ea of allExtApprovers) {
          if (!extApproversById.has(ea.approval_id)) {
            extApproversById.set(ea.approval_id, []);
          }
          extApproversById.get(ea.approval_id).push(ea);
        }
      }

      for (const ext of externals) {
        const approvers = extApproversById.get(ext.id) || [];
        const hasRejected = approvers.some(a => a.status === 'rejected');
        const allApproved = approvers.length > 0 && approvers.every(a => a.status === 'approved');
        const overallStatus = hasRejected ? 'rejected' : (allApproved ? 'approved' : ext.status);

        const isUserApprover = currentUserId && approvers.some(a => String(a.approver_user_id) === currentUserId);
        const canAction = isSuperAdmin
          ? overallStatus === 'pending'
          : (currentUserId && approvers.some(a => String(a.approver_user_id) === currentUserId && a.status === 'pending'));

        let extDocs = [];
        let extPayload = null;
        try {
          extPayload = typeof ext.payload_json === 'string' ? JSON.parse(ext.payload_json) : ext.payload_json;
          if (extPayload) {
            if (Array.isArray(extPayload.supporting_docs)) extDocs = extPayload.supporting_docs;
            else if (Array.isArray(extPayload.attachments)) extDocs = extPayload.attachments;
            else if (extPayload.supporting_doc) extDocs = [extPayload.supporting_doc];
            else if (extPayload.file_url) extDocs = [extPayload.file_url];
          }
        } catch (_) {}

        if (viewAll || isUserApprover) {
          externalItems.push({
            id: `ext-${ext.source}-${ext.id}`,
            raw_id: ext.id,
            code: ext.doc_ref || `DOC/${ext.source.toUpperCase()}/${ext.id}`,
            title: ext.title,
            source: ext.source,
            source_label: ext.source_label,
            badge_color: ext.badge_color,
            icon_name: ext.icon_name,
            category: ext.doc_type ? ext.doc_type.replace(/_/g, ' ').toUpperCase() : 'Dokumen Eksternal',
            requester_name: ext.requester_name,
            department: ext.department || 'Operations',
            position: ext.doc_type ? ext.doc_type.replace(/_/g, ' ') : null,
            entity_name: ext.source_label,
            submission_date: ext.submission_date,
            amount: ext.amount ? `Rp ${Number(ext.amount).toLocaleString('id-ID')}` : null,
            description: ext.description,
            status: overallStatus,
            supporting_doc: extDocs.length > 0 ? extDocs[0] : null,
            supporting_docs: extDocs,
            payload: extPayload,
            callback: {
              url: ext.callback_url || null,
              status: ext.callback_status || 'not_configured',
              executed_at: ext.callback_executed_at || null,
              response: ext.callback_response || null
            },
            approvers: approvers.map(a => ({
              step: a.step_order,
              user_id: a.approver_user_id,
              name: a.approver_name,
              email: a.approver_email,
              status: a.status,
              notes: a.notes,
              action_date: a.action_date
            })),
            can_action: canAction
          });
        }
      }
    } catch (extErr) {
      console.warn('Error reading external approvals from DB:', extErr.message);
    }
  }

  const combined = [...attendanceItems, ...externalItems];
  return {
    currentUserId,
    isSuperAdmin,
    combined
  };
}

// GET /api/approval/list
// Query: ?user_id=23&source=attendance|odoo&status=pending|approved|rejected&all=true
exports.getApprovals = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({
        success: false,
        message: auth.message,
        hint: 'Kirimkan header Authorization: Bearer <token>'
      });
    }

    const { user_id, source, status, all, entity, position } = req.query;
    const { currentUserId, isSuperAdmin, combined } = await fetchApprovalsList(user_id, {
      source,
      all,
      limit: req.query.limit
    });

    // Hitung counts secara konsisten dari seluruh daftar sebelum filter halaman
    const bySource = {};
    for (const item of combined) {
      bySource[item.source] = (bySource[item.source] || 0) + 1;
    }

    const availableEntities = [...new Set(combined.map(i => i.entity_name).filter(Boolean))].sort();
    const availablePositions = [...new Set(combined.map(i => i.position || i.department).filter(Boolean))].sort();

    const counts = {
      all: combined.length,
      attendance: combined.filter(i => i.source === 'attendance').length,
      external: combined.filter(i => i.source !== 'attendance').length,
      odoo: combined.filter(i => i.source === 'odoo').length,
      pending: combined.filter(i => i.status === 'pending').length,
      approved: combined.filter(i => i.status === 'approved').length,
      rejected: combined.filter(i => i.status === 'rejected').length,
      actionable_pending: combined.filter(i => i.status === 'pending' && i.can_action).length,
      by_source: bySource
    };

    let filtered = [...combined];
    if (status && status !== 'all') {
      filtered = filtered.filter(item => item.status === status);
    }
    if (entity && entity !== 'all') {
      filtered = filtered.filter(item => item.entity_name && item.entity_name.toLowerCase().includes(entity.toLowerCase()));
    }
    if (position && position !== 'all') {
      filtered = filtered.filter(item =>
        (item.position && item.position.toLowerCase().includes(position.toLowerCase())) ||
        (item.department && item.department.toLowerCase().includes(position.toLowerCase()))
      );
    }

    res.json({
      success: true,
      user_authority: {
        user_id: currentUserId,
        is_super_admin: isSuperAdmin,
        authority_role: isSuperAdmin ? 'Super Admin IT (Akses Penuh)' : (currentUserId ? 'Approver Terotorisasi' : 'Guest / All')
      },
      total: filtered.length,
      counts,
      filter_options: {
        entities: availableEntities,
        positions: availablePositions
      },
      data: filtered
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/approval/action
// Body: { id, source, action: 'approve'|'reject', notes, user_id }
exports.processApproval = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const { id, source, action, notes, user_id } = req.body;
    if (!id || !action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        message: 'Parameter id dan action (approve/reject) wajib diisi.'
      });
    }

    const approverUserId = user_id ? parseInt(user_id, 10) : 15; // default Pak Jogi
    const isApproved = action === 'approve';
    const newStatus = isApproved ? 'approved' : 'rejected';

    console.log(`[APPROVAL ACTION] User ID ${approverUserId} executed ${action.toUpperCase()} on [${id}] source: ${source}`);

    // ==========================================
    // AKSI UNTUK ITEM EKSTERNAL (ODOO, SAP, AQUATRACK, WMS, DLL)
    // ==========================================
    const isAttendance = source === 'attendance' || id.startsWith('att-');
    if (!isAttendance) {
      // Ambil angka ID dari format apapun: 'ext-odoo-4', 'ext-sap-12', 'odoo-ext-4', dll.
      const rawId = id.split('-').pop();
      const numericId = parseInt(rawId, 10);

      if (!isNaN(numericId)) {
        // Ambil info dokumen dan nama sistemnya
        const [docRows] = await db.query(`
          SELECT e.doc_ref, e.source, COALESCE(s.name, UPPER(e.source)) AS source_label
          FROM external_approvals e
          LEFT JOIN external_systems s ON e.source = s.code
          WHERE e.id = ?
        `, [numericId]);
        const docInfo = docRows[0] || { source: source || 'external', source_label: (source || 'Eksternal').toUpperCase() };

        // 1. Update status approver sesuai step
        const [assignedOdooRow] = await db.query(`
          SELECT id FROM external_approval_approvers
          WHERE approval_id = ? AND approver_user_id = ? AND status = 'pending'
          LIMIT 1
        `, [numericId, approverUserId]);

        if (assignedOdooRow.length > 0) {
          await db.query(`
            UPDATE external_approval_approvers
            SET status = ?, notes = ?, action_date = NOW()
            WHERE id = ?
          `, [newStatus, notes || null, assignedOdooRow[0].id]);
        } else if ([23, 334, '23', '334'].includes(approverUserId)) {
          await db.query(`
            UPDATE external_approval_approvers
            SET status = ?, notes = ?, action_date = NOW()
            WHERE approval_id = ? AND status = 'pending'
            ORDER BY step_order ASC LIMIT 1
          `, [newStatus, notes ? `[Admin IT Override] ${notes}` : '[Admin IT Override]', numericId]);
        } else {
          await db.query(`
            UPDATE external_approval_approvers
            SET status = ?, notes = ?, action_date = NOW()
            WHERE approval_id = ? AND approver_user_id = ?
          `, [newStatus, notes || null, numericId, approverUserId]);
        }

        const [allApps] = await db.query(`
          SELECT status FROM external_approval_approvers WHERE approval_id = ?
        `, [numericId]);

        const hasRejected = allApps.some(a => a.status === 'rejected');
        const allDone = allApps.length > 0 && allApps.every(a => a.status === 'approved');
        const finalDocStatus = hasRejected ? 'rejected' : (allDone ? 'approved' : 'pending');

        await db.query(`
          UPDATE external_approvals
          SET status = ?, final_approved_at = ${finalDocStatus === 'approved' ? 'NOW()' : 'NULL'}
          WHERE id = ?
        `, [finalDocStatus, numericId]);

        // Push notification ke approver tingkat berikutnya jika multi-step
        if (isApproved && !allDone) {
          try {
            const [nextExtApp] = await db.query(`
              SELECT approver_user_id FROM external_approval_approvers
              WHERE approval_id = ? AND status = 'pending'
              ORDER BY step_order ASC LIMIT 1
            `, [numericId]);

            if (nextExtApp.length > 0) {
              const notificationService = require('../services/notificationService');
              const [extRows] = await db.query('SELECT title, doc_ref, requester_name FROM external_approvals WHERE id = ?', [numericId]);
              const extInfo = extRows[0] || {};

              await notificationService.sendFCMNotification(
                [nextExtApp[0].approver_user_id],
                `📋 Permohonan Persetujuan: ${extInfo.title || docInfo.source_label}`,
                `Dokumen ${extInfo.doc_ref || id} dari ${extInfo.requester_name || 'Eksternal'} menunggu giliran persetujuan Anda. Ketuk untuk membuka detail.`,
                '',
                {
                  type: 'approval',
                  screen: 'approval',
                  approval_id: id,
                  raw_id: String(numericId),
                  source: docInfo.source || 'external',
                  category: 'Dokumen Eksternal',
                  requester_name: extInfo.requester_name || '',
                  title: extInfo.title || ''
                }
              );
            }
          } catch (extNotifErr) {
            console.warn('⚠️ Gagal kirim notifikasi ke approver eksternal berikutnya:', extNotifErr.message);
          }
        }

        // 🔥 Webhook: Hit endpoint/backend sistem eksternal (Odoo, SAP, AquaTrack, dll)
        const callbackResult = await triggerExternalCallback(numericId, {
          action,
          approverUserId,
          notes
        });

        return res.json({
          success: true,
          message: `Dokumen [${docInfo.doc_ref || id}] dari sistem [${docInfo.source_label}] berhasil di-${isApproved ? 'setujui' : 'tolak'}.${callbackResult.success && !callbackResult.skipped ? ' Webhook eksternal berhasil ditembak.' : ''}`,
          data: {
            id,
            source: docInfo.source || 'external',
            source_label: docInfo.source_label,
            action,
            status: newStatus,
            doc_status: finalDocStatus,
            timestamp: new Date().toISOString(),
            callback: callbackResult
          }
        });
      }

      return res.status(400).json({ success: false, message: 'Invalid external approval ID' });
    }

    // ==========================================
    // AKSI UNTUK ITEM ATTENDANCE / LEAVE
    // ==========================================
    const rawLeaveId = parseInt(id.replace('att-leave-', ''), 10);
    if (!isNaN(rawLeaveId)) {
      // 1. Update status di tabel leave_request_approvers sesuai step
      const [assignedRow] = await db.query(`
        SELECT id FROM leave_request_approvers 
        WHERE leave_request_id = ? AND approver_user_id = ? AND status = 'pending'
        LIMIT 1
      `, [rawLeaveId, approverUserId]);

      if (assignedRow.length > 0) {
        await db.query(`
          UPDATE leave_request_approvers
          SET status = ?, notes = ?, action_date = NOW()
          WHERE id = ?
        `, [newStatus, notes || null, assignedRow[0].id]);
      } else if ([23, 334, '23', '334'].includes(approverUserId)) {
        // Super Admin IT override: setujui step pending terawal jika tidak terdaftar langsung
        await db.query(`
          UPDATE leave_request_approvers
          SET status = ?, notes = ?, action_date = NOW()
          WHERE leave_request_id = ? AND status = 'pending'
          ORDER BY step_order ASC LIMIT 1
        `, [newStatus, notes ? `[Admin IT Override] ${notes}` : '[Admin IT Override]', rawLeaveId]);
      } else {
        await db.query(`
          UPDATE leave_request_approvers
          SET status = ?, notes = ?, action_date = NOW()
          WHERE leave_request_id = ? AND approver_user_id = ?
        `, [newStatus, notes || null, rawLeaveId, approverUserId]);
      }

      // 2. Periksa apakah seluruh approver telah menyetujui
      const [allApprovers] = await db.query(`
        SELECT status FROM leave_request_approvers WHERE leave_request_id = ?
      `, [rawLeaveId]);

      const hasRejected = allApprovers.some(a => a.status === 'rejected');
      const allApproved = allApprovers.length > 0 && allApprovers.every(a => a.status === 'approved');

      if (hasRejected) {
        // Jika ditolak oleh salah satu approver:
        await db.query("UPDATE leave_requests SET status = 'rejected' WHERE id = ?", [rawLeaveId]);

        // Notifikasi ke pemohon bahwa permohonan ditolak
        try {
          const [lrRows] = await db.query('SELECT user_id, leave_type FROM leave_requests WHERE id = ?', [rawLeaveId]);
          if (lrRows.length > 0) {
            const notificationService = require('../services/notificationService');
            await notificationService.sendFCMNotification(
              [lrRows[0].user_id],
              '❌ Permohonan Izin Ditolak',
              `Permohonan ${formatLeaveTypeLabel(lrRows[0].leave_type)} Anda ditolak${notes ? ': ' + notes : '.'}`,
              '',
              {
                type: 'leave_status',
                screen: 'pengajuan_izin',
                status: 'rejected',
                approval_id: `att-leave-${rawLeaveId}`,
                leave_id: String(rawLeaveId),
                initial_tab: '1',
                notes: notes || ''
              }
            );
          }
        } catch (notifErr) {
          console.warn('⚠️ Gagal kirim notifikasi penolakan ke pemohon:', notifErr.message);
        }

      } else if (allApproved) {
        // JIKA SEMUA APPROVER TELAH MENYETUJUI:
        // A. Update status di tabel leave_requests menjadi 'approved'
        await db.query("UPDATE leave_requests SET status = 'approved', approved_at = NOW() WHERE id = ?", [rawLeaveId]);

        // B. Sinkronkan dan UPDATE langsung ke tabel attendance!
        await syncLeaveToAttendance(rawLeaveId);

        // Notifikasi ke pemohon bahwa permohonan disetujui sepenuhnya
        try {
          const [lrRows] = await db.query('SELECT user_id, leave_type FROM leave_requests WHERE id = ?', [rawLeaveId]);
          if (lrRows.length > 0) {
            const notificationService = require('../services/notificationService');
            await notificationService.sendFCMNotification(
              [lrRows[0].user_id],
              '✅ Permohonan Izin Disetujui',
              `Permohonan ${formatLeaveTypeLabel(lrRows[0].leave_type)} Anda telah disetujui sepenuhnya.`,
              '',
              {
                type: 'leave_status',
                screen: 'pengajuan_izin',
                status: 'approved',
                approval_id: `att-leave-${rawLeaveId}`,
                leave_id: String(rawLeaveId),
                initial_tab: '1'
              }
            );
          }
        } catch (notifErr) {
          console.warn('⚠️ Gagal kirim notifikasi persetujuan ke pemohon:', notifErr.message);
        }

      } else if (isApproved) {
        // Jika masih ada approver tingkat berikutnya yang pending
        try {
          const [nextApp] = await db.query(`
            SELECT approver_user_id FROM leave_request_approvers
            WHERE leave_request_id = ? AND status = 'pending'
            ORDER BY step_order ASC LIMIT 1
          `, [rawLeaveId]);

          if (nextApp.length > 0) {
            const notificationService = require('../services/notificationService');
            const [lrRows] = await db.query('SELECT full_name, leave_type FROM leave_requests WHERE id = ?', [rawLeaveId]);
            const requester = lrRows.length > 0 ? lrRows[0].full_name : 'Karyawan';
            const lType = lrRows.length > 0 ? formatLeaveTypeLabel(lrRows[0].leave_type) : 'Izin';

            await notificationService.sendFCMNotification(
              [nextApp[0].approver_user_id],
              '📋 Permohonan Persetujuan Baru',
              `Permohonan ${lType} dari ${requester} menunggu giliran persetujuan Anda. Ketuk untuk membuka detail.`,
              '',
              {
                type: 'approval',
                screen: 'approval',
                approval_id: `att-leave-${rawLeaveId}`,
                raw_id: String(rawLeaveId),
                source: 'attendance',
                category: 'Izin',
                requester_name: requester
              }
            );
          }
        } catch (notifErr) {
          console.warn('⚠️ Gagal kirim notifikasi ke approver berikutnya:', notifErr.message);
        }
      }
    }

    return res.json({
      success: true,
      message: `Permohonan Izin [${id}] berhasil di-${isApproved ? 'setujui' : 'tolak'}. Data kehadiran & leave request telah diperbarui.`,
      data: {
        id,
        source: 'attendance',
        action,
        status: newStatus,
        timestamp: new Date().toISOString()
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/approval/external/sync
exports.syncExternalDocument = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const {
      source = 'odoo',
      doc_type,
      doc_ref,
      external_doc_id,
      title,
      description,
      amount,
      currency = 'IDR',
      requester_name,
      department,
      approver_user_ids = [15],
      callback_url,
      callback_method = 'POST',
      callback_headers,
      payload
    } = req.body;

    if (!doc_type || !doc_ref || !title || !requester_name) {
      return res.status(400).json({
        success: false,
        message: 'Field doc_type, doc_ref, title, dan requester_name wajib diisi.'
      });
    }

    // Resolve target callback url jika dikirimkan di payload
    const resolvedCallbackUrl = callback_url || (payload && (payload.callback_url || payload.webhook_url)) || null;

    const [result] = await db.query(`
      INSERT INTO external_approvals 
        (source, doc_type, doc_ref, external_doc_id, title, description, amount, currency, requester_name, department, callback_url, callback_method, callback_headers, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      source, doc_type, doc_ref, external_doc_id || null, title,
      description || null, amount || null, currency, requester_name, department || null,
      resolvedCallbackUrl,
      callback_method || 'POST',
      callback_headers ? JSON.stringify(callback_headers) : null,
      JSON.stringify(payload || {})
    ]);

    const approvalId = result.insertId;

    for (let i = 0; i < approver_user_ids.length; i++) {
      const uid = parseInt(approver_user_ids[i], 10);
      const [u] = await db.query('SELECT name FROM users WHERE id = ?', [uid]).catch(() => [[]]);
      const name = u.length > 0 ? u[0].name : `Approver ${uid}`;

      await db.query(`
        INSERT INTO external_approval_approvers
          (approval_id, approver_user_id, approver_name, step_order, status)
        VALUES (?, ?, ?, ?, 'pending')
      `, [approvalId, uid, name, i + 1]);
    }

    // Kirim notifikasi ke approver tingkat pertama
    try {
      if (approver_user_ids.length > 0) {
        const targetUids = approver_user_ids.map(u => parseInt(u, 10)).filter(Boolean);
        const notificationService = require('../services/notificationService');
        await notificationService.sendFCMNotification(
          targetUids,
          `📋 Permohonan Persetujuan: ${title}`,
          `Dokumen ${doc_ref} (${doc_type || 'Umum'}) dari ${requester_name} membutuhkan persetujuan Anda.`,
          '',
          {
            type: 'approval',
            screen: 'approval',
            approval_id: `ext-${source}-${approvalId}`,
            raw_id: String(approvalId),
            source: source,
            category: doc_type || 'Umum',
            requester_name: requester_name,
            title: title
          }
        );
      }
    } catch (fcmErr) {
      console.warn('⚠️ Gagal mengirim push notifikasi ke approver eksternal:', fcmErr.message);
    }

    res.status(201).json({
      success: true,
      message: 'Dokumen eksternal berhasil disinkronkan ke antrian approval mobile.',
      data: {
        id: `odoo-ext-${approvalId}`,
        doc_ref,
        callback_configured: !!resolvedCallbackUrl,
        callback_url: resolvedCallbackUrl,
        approvers_count: approver_user_ids.length
      }
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/approval/external/:id/retry-callback
// Endpoint untuk mengetes / menembak ulang webhook callback ke backend eksternal secara manual
exports.retryExternalCallback = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const { id } = req.params;
    const rawId = id.replace('odoo-ext-', '').replace('odoo-', '');
    const numericId = parseInt(rawId, 10);
    if (isNaN(numericId)) {
      return res.status(400).json({ success: false, message: 'Invalid external approval ID' });
    }

    const result = await triggerExternalCallback(numericId, {
      action: req.body.action || 'manual_retry',
      approverUserId: req.body.user_id || 23,
      notes: req.body.notes || 'Manual trigger from API/Admin'
    });

    return res.json({
      success: result.success,
      message: result.success
        ? 'Webhook callback ke backend eksternal berhasil ditembak.'
        : 'Webhook callback ke backend eksternal gagal dikirim.',
      callback: result
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/approval/entity-rules
exports.getEntityRules = async (req, res) => {
  try {
    const [rules] = await db.query(`
      SELECT r.id, r.entitas_id, e.name AS entity_name, r.department, r.module, r.step_order,
             r.approver_user_id, r.approver_name, r.approver_email, r.is_required
      FROM entity_approval_rules r
      LEFT JOIN entitas e ON r.entitas_id = e.id
      ORDER BY r.entitas_id ASC, r.department ASC, r.step_order ASC
    `);

    res.json({
      success: true,
      total: rules.length,
      data: rules
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/approval/external/systems
// Mengambil daftar sistem eksternal yang terdaftar & aktif (Odoo, SAP, AquaTrack, WMS, dll)
exports.getExternalSystems = async (req, res) => {
  try {
    const [systems] = await db.query(`
      SELECT id, code, name, category, badge_color, icon_name, default_callback_url
      FROM external_systems
      WHERE is_active = 1
      ORDER BY id ASC
    `);

    res.json({
      success: true,
      total: systems.length,
      data: systems
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// POST /api/approval/upload-document
// Endpoint khusus untuk upload file dokumen pendukung secara terpisah
exports.uploadDocument = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    // 1. Jika dikirim melalui multipart/form-data (req.files atau req.file)
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length > 0) {
      const uploaded = files.map(f => {
        const ext = path.extname(f.originalname || f.filename).toLowerCase();
        const isPdf = ext === '.pdf' || f.mimetype === 'application/pdf';
        return {
          file_url: `/uploads/leave_docs/${f.filename}`,
          file_name: f.originalname || f.filename,
          file_size_kb: Math.round(f.size / 1024),
          mimetype: f.mimetype,
          is_pdf: isPdf
        };
      });

      return res.status(201).json({
        success: true,
        message: `${uploaded.length} berkas dokumen berhasil diunggah.`,
        files: uploaded,
        file_url: uploaded[0].file_url,
        file_name: uploaded[0].file_name,
        file_size_kb: uploaded[0].file_size_kb,
        is_pdf: uploaded[0].is_pdf
      });
    }

    // 2. Jika dikirim melalui JSON base64
    const { file_base64, file_name, user_id } = req.body;
    if (file_base64) {
      const savedPath = saveBase64Document(file_base64, user_id || 'anonymous');
      if (savedPath) {
        const isPdf = savedPath.toLowerCase().endsWith('.pdf');
        return res.status(201).json({
          success: true,
          message: 'Berkas base64 berhasil disimpan.',
          file_url: savedPath,
          file_name: file_name || path.basename(savedPath),
          file_size_kb: Math.round(Buffer.byteLength(file_base64, 'utf8') / 1024),
          is_pdf: isPdf
        });
      }
    }

    return res.status(400).json({
      success: false,
      message: 'Tidak ada berkas yang diunggah (gunakan multipart field "file" / "files" atau body "file_base64").'
    });
  } catch (err) {
    console.error('Upload document error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/approval/badge-count?user_id=15
exports.getBadgeCount = async (req, res) => {
  try {
    const auth = verifyApprovalToken(req);
    if (!auth.valid) {
      return res.status(401).json({ success: false, message: auth.message });
    }

    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ success: false, message: 'user_id is required' });
    }

    // Gunakan fungsi data yang SAMA PERSIS dengan getApprovals sehingga angka badge 100% identik
    const { currentUserId, isSuperAdmin, combined } = await fetchApprovalsList(user_id, {
      all: false,
      limit: 500
    });

    // Badge count adalah jumlah dokumen PENDING yang membutuhkan tindakan / aksi dari user ini
    const actionablePending = combined.filter(i => i.status === 'pending' && i.can_action);
    const pendingAttendance = actionablePending.filter(i => i.source === 'attendance').length;
    const pendingExternal = actionablePending.filter(i => i.source !== 'attendance').length;
    const totalPending = actionablePending.length;

    return res.json({
      success: true,
      user_id: currentUserId,
      is_super_admin: isSuperAdmin,
      badge_count: totalPending,
      attendance_pending: pendingAttendance,
      external_pending: pendingExternal
    });
  } catch (err) {
    console.error('Error fetching badge count:', err);
    return res.status(500).json({ success: false, error: err.message, badge_count: 0 });
  }
};



