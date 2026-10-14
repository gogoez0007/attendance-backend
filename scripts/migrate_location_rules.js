const db = require('../db');

async function migrate() {
  console.log('🚀 Memulai migrasi location_rules & attendance location_name...');

  try {
    // 1. Buat table location_rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS location_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        location_id INT NOT NULL UNIQUE,
        location_name VARCHAR(150) NOT NULL,
        work_day_type VARCHAR(50) NOT NULL DEFAULT '5_DAYS',
        is_5_days TINYINT(1) NOT NULL DEFAULT 1,
        is_operational_tambak TINYINT(1) NOT NULL DEFAULT 0,
        description VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_loc (location_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ Tabel location_rules berhasil dibuat / sudah ada');

    // 2. Ambil seluruh data dari locations
    const [locations] = await db.query('SELECT * FROM locations');
    console.log(`📌 Ditemukan ${locations.length} lokasi di tabel locations.`);

    // Klasifikasi:
    // Tambak operasional murni (DMI [2], Seru [3], DMV [4], MBP [7], MBP NEW [8], Joyo Boyo [11]) -> 7_DAYS, is_5_days=0, is_operational_tambak=1
    // NUSEA Security [19] -> 7_DAYS, is_5_days=0, is_operational_tambak=0
    // Lainnya (Head Office, Tanggulangin, FOI, Anywhere, PMMP, Delmar, Rumah Pak Rizky, dll.) -> 5_DAYS, is_5_days=1, is_operational_tambak=0
    const tambakIds = [2, 3, 4, 7, 8, 11];
    const securityIds = [19];

    for (const loc of locations) {
      let workDayType = '5_DAYS';
      let is5Days = 1;
      let isTambak = 0;
      let desc = 'Kantor / Non-Tambak (5 Hari Kerja, Sabtu-Minggu Libur)';

      if (tambakIds.includes(loc.id)) {
        workDayType = '7_DAYS';
        is5Days = 0;
        isTambak = 1;
        desc = 'Operasional Tambak (Jadwal 7 Hari Kerja Operasional Lapangan)';
      } else if (securityIds.includes(loc.id)) {
        workDayType = '7_DAYS';
        is5Days = 0;
        isTambak = 0;
        desc = 'Security / Shift Khusus (Operasional Mengikuti Jadwal Shift)';
      }

      await db.query(`
        INSERT INTO location_rules (location_id, location_name, work_day_type, is_5_days, is_operational_tambak, description)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          location_name = VALUES(location_name),
          work_day_type = VALUES(work_day_type),
          is_5_days = VALUES(is_5_days),
          is_operational_tambak = VALUES(is_operational_tambak),
          description = VALUES(description)
      `, [loc.id, loc.name, workDayType, is5Days, isTambak, desc]);
    }
    console.log('✅ Seluruh konfigurasi aturan lokasi berhasil dimasukkan ke tabel location_rules');

    // 3. Tambahkan kolom location_name ke tabel attendance jika belum ada
    const [attCols] = await db.query('DESCRIBE attendance');
    const colNames = attCols.map(c => c.Field);
    if (!colNames.includes('location_name')) {
      await db.query(`
        ALTER TABLE attendance
        ADD COLUMN location_name VARCHAR(150) NULL AFTER check_in_longitude
      `);
      console.log('✅ Kolom location_name berhasil ditambahkan ke tabel attendance');
    } else {
      console.log('ℹ️ Kolom location_name sudah ada di tabel attendance');
    }

    // 4. Backfill data absen lama yang location_name nya masih NULL
    const [backfillResult] = await db.query(`
      UPDATE attendance a
      JOIN users u ON a.user_id = u.id
      JOIN locations l ON u.location_id = l.id
      SET a.location_name = l.name
      WHERE a.location_name IS NULL OR a.location_name = ''
    `);
    console.log(`✅ Backfill selesai: ${backfillResult.affectedRows} baris diupdate dengan nama lokasi pengguna.`);

    // 5. Cek data sampel location_rules
    const [rules] = await db.query('SELECT * FROM location_rules');
    console.log('📋 Data location_rules saat ini:');
    console.table(rules);

    process.exit(0);
  } catch (err) {
    console.error('❌ Terjadi kesalahan migrasi:', err);
    process.exit(1);
  }
}

migrate();
