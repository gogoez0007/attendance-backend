const db = require('../db');

async function migrate() {
  console.log('🚀 Starting migration for Multi-Approver & External Approvals...');

  try {
    // 1. Tambah kolom is_active di users jika belum ada
    const [cols] = await db.query('DESCRIBE users');
    const hasIsActive = cols.some(c => c.Field === 'is_active');
    if (!hasIsActive) {
      console.log('➕ Adding is_active column to users...');
      await db.query('ALTER TABLE users ADD COLUMN is_active TINYINT(1) DEFAULT 1');
      await db.query('UPDATE users SET is_active = 1 WHERE is_active IS NULL');
      console.log('✅ Column is_active added successfully.');
    } else {
      console.log('ℹ️ Column is_active already exists in users.');
    }

    // 2. Buat tabel entity_approval_rules (Master Approver per Entitas)
    await db.query(`
      CREATE TABLE IF NOT EXISTS entity_approval_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entitas_id INT DEFAULT NULL,
        entity_name VARCHAR(100) NOT NULL,
        module VARCHAR(50) DEFAULT 'HR_LEAVE',
        step_order INT DEFAULT 1,
        approver_user_id INT NOT NULL,
        approver_name VARCHAR(100) NOT NULL,
        approver_email VARCHAR(100) DEFAULT NULL,
        is_required TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Table entity_approval_rules verified/created.');

    // 3. Buat tabel leave_request_approvers (Multi Approver per Dokumen Izin)
    await db.query(`
      CREATE TABLE IF NOT EXISTS leave_request_approvers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        leave_request_id INT NOT NULL,
        step_order INT DEFAULT 1,
        approver_user_id INT NOT NULL,
        approver_name VARCHAR(100) NOT NULL,
        approver_email VARCHAR(100) DEFAULT NULL,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        notes TEXT DEFAULT NULL,
        action_date DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lra_leave (leave_request_id),
        INDEX idx_lra_approver (approver_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Table leave_request_approvers verified/created.');

    // 3b. Pastikan leave_requests memiliki kolom status, supporting_doc, approved_at
    const [lrCols] = await db.query('DESCRIBE leave_requests');
    if (!lrCols.some(c => c.Field === 'status')) {
      await db.query("ALTER TABLE leave_requests ADD COLUMN status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending'");
      await db.query("UPDATE leave_requests SET status = 'approved' WHERE status IS NULL");
      console.log('✅ Added status column to leave_requests.');
    }
    if (!lrCols.some(c => c.Field === 'supporting_doc')) {
      await db.query('ALTER TABLE leave_requests ADD COLUMN supporting_doc VARCHAR(255) DEFAULT NULL');
      console.log('✅ Added supporting_doc column to leave_requests.');
    }
    if (!lrCols.some(c => c.Field === 'approved_at')) {
      await db.query('ALTER TABLE leave_requests ADD COLUMN approved_at DATETIME DEFAULT NULL');
      console.log('✅ Added approved_at column to leave_requests.');
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS external_approvals (
        id INT AUTO_INCREMENT PRIMARY KEY,
        source VARCHAR(50) NOT NULL DEFAULT 'odoo',
        doc_type VARCHAR(50) NOT NULL,
        doc_ref VARCHAR(100) NOT NULL,
        external_doc_id VARCHAR(100) DEFAULT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT DEFAULT NULL,
        amount DECIMAL(15,2) DEFAULT NULL,
        currency VARCHAR(10) DEFAULT 'IDR',
        requester_name VARCHAR(100) NOT NULL,
        department VARCHAR(100) DEFAULT NULL,
        submission_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        final_approved_at DATETIME DEFAULT NULL,
        payload_json JSON DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ea_source (source),
        INDEX idx_ea_doc_ref (doc_ref),
        INDEX idx_ea_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Table external_approvals verified/created.');

    // 5. Buat tabel external_approval_approvers (Daftar Approver per Dokumen Odoo)
    await db.query(`
      CREATE TABLE IF NOT EXISTS external_approval_approvers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        approval_id INT NOT NULL,
        approver_user_id INT NOT NULL,
        approver_name VARCHAR(100) DEFAULT NULL,
        approver_email VARCHAR(100) DEFAULT NULL,
        step_order INT DEFAULT 1,
        status ENUM('pending', 'approved', 'rejected') DEFAULT 'pending',
        notes TEXT DEFAULT NULL,
        action_date DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_eaa_approval (approval_id),
        INDEX idx_eaa_approver (approver_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Table external_approval_approvers verified/created.');

    // Cek entitas & user Pak Jogi
    const [entities] = await db.query('SELECT * FROM entitas').catch(() => [[]]);
    console.log(`ℹ️ Total entitas found: ${entities.length}`);

    const [jogiUsers] = await db.query("SELECT id, name, username FROM users WHERE name LIKE '%jogi%' OR username LIKE '%jogi%'").catch(() => [[]]);
    console.log('ℹ️ User matching Jogi:', jogiUsers);

    // Ambil default Jogi ID (jika ada gunakan, jika belum ada default ID 1 atau buat dummy jika belum ada)
    const jogiId = jogiUsers.length > 0 ? jogiUsers[0].id : 1;
    const jogiName = jogiUsers.length > 0 ? jogiUsers[0].name : 'Pak Jogi';

    // Seed default approval rule jika masih kosong: "semua entitas approvernya pak jogi"
    const [rulesCount] = await db.query('SELECT COUNT(*) AS count FROM entity_approval_rules');
    if (rulesCount[0].count === 0) {
      console.log('🌱 Seeding default approval rules for all entities (Default Approver: Pak Jogi)...');
      if (entities.length > 0) {
        for (const ent of entities) {
          await db.query(`
            INSERT INTO entity_approval_rules 
              (entitas_id, entity_name, module, step_order, approver_user_id, approver_name, approver_email, is_required)
            VALUES (?, ?, 'HR_LEAVE', 1, ?, ?, 'jogi@delmargroup.id', 1)
          `, [ent.id, ent.name || `Entitas ${ent.id}`, jogiId, jogiName]);
        }
      } else {
        // Fallback global rule
        await db.query(`
          INSERT INTO entity_approval_rules 
            (entitas_id, entity_name, module, step_order, approver_user_id, approver_name, approver_email, is_required)
          VALUES (NULL, 'Semua Entitas (Global)', 'HR_LEAVE', 1, ?, ?, 'jogi@delmargroup.id', 1)
        `, [jogiId, jogiName]);
      }
      console.log('✅ Default approval rules seeded.');
    }

    // Seed contoh data Odoo approvals jika external_approvals kosong
    const [extCount] = await db.query('SELECT COUNT(*) AS count FROM external_approvals');
    if (extCount[0].count === 0) {
      console.log('🌱 Seeding initial Odoo approval documents...');
      const sampleOdoo = [
        {
          source: 'odoo',
          doc_type: 'purchase_order',
          doc_ref: 'PO/2026/0089',
          external_doc_id: '1089',
          title: 'Purchase Order Pakan Udang 5 Ton',
          description: 'Pengadaan pakan udang CP Prima Grobest untuk Tambak Blok B. Vendor: PT Charoen Pokphand.',
          amount: 45000000.00,
          currency: 'IDR',
          requester_name: 'Budi Santoso',
          department: 'Procurement & Farm',
          status: 'pending',
          approvers: [jogiId, 23, 334] // Pak Jogi, User 23, User 334
        },
        {
          source: 'odoo',
          doc_type: 'expense_claim',
          doc_ref: 'EXP/2026/0214',
          external_doc_id: '2214',
          title: 'Reimbursement Biaya Operasional Tambak & BBM',
          description: 'BBM genset pompa air tambak 450 Liter dan logistik teknisi lapangan.',
          amount: 6750000.00,
          currency: 'IDR',
          requester_name: 'Dewi Lestari',
          department: 'Operasional Lapangan',
          status: 'pending',
          approvers: [jogiId, 23, 334]
        },
        {
          source: 'odoo',
          doc_type: 'time_off',
          doc_ref: 'LEAVE/ODOO/0045',
          external_doc_id: '3045',
          title: 'Cuti Tahunan ERP - 3 Hari',
          description: 'Pengajuan hak cuti tahunan terintegrasi Odoo HR.',
          amount: null,
          currency: 'IDR',
          requester_name: 'Ahmad Fauzi',
          department: 'Finance & Accounting',
          status: 'pending',
          approvers: [jogiId, 23, 334]
        }
      ];

      for (const item of sampleOdoo) {
        const [res] = await db.query(`
          INSERT INTO external_approvals 
            (source, doc_type, doc_ref, external_doc_id, title, description, amount, currency, requester_name, department, status, payload_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          item.source, item.doc_type, item.doc_ref, item.external_doc_id, item.title,
          item.description, item.amount, item.currency, item.requester_name, item.department,
          item.status, JSON.stringify(item)
        ]);
        
        const appId = res.insertId;
        for (let i = 0; i < item.approvers.length; i++) {
          const uid = item.approvers[i];
          const aName = uid === jogiId ? jogiName : (uid === 23 ? 'Admin IT (User 23)' : 'Admin IT (User 334)');
          await db.query(`
            INSERT INTO external_approval_approvers
              (approval_id, approver_user_id, approver_name, approver_email, step_order, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
          `, [appId, uid, aName, uid === jogiId ? 'jogi@delmargroup.id' : null, i + 1]);
        }
      }
      console.log('✅ Seeded Odoo external approvals with multi-approver mappings.');
    }

    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
