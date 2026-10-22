const db = require('../db');

async function migrate() {
  console.log('🚀 Setting up dynamic external systems registry...');

  try {
    // 1. Buat tabel external_systems (Master Sistem Eksternal Dinamis)
    await db.query(`
      CREATE TABLE IF NOT EXISTS external_systems (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        category VARCHAR(50) DEFAULT 'ERP',
        badge_color VARCHAR(20) DEFAULT '#714B67',
        icon_name VARCHAR(50) DEFAULT 'business',
        default_callback_url VARCHAR(500) DEFAULT NULL,
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('✅ Table external_systems verified/created.');

    // 2. Seed initial multi-systems jika belum ada
    const initialSystems = [
      {
        code: 'odoo',
        name: 'Odoo ERP',
        category: 'ERP & Finance',
        badge_color: '#714B67',
        icon_name: 'business_center'
      },
      {
        code: 'sap',
        name: 'SAP Enterprise',
        category: 'ERP & SCM',
        badge_color: '#0284C7',
        icon_name: 'account_balance'
      },
      {
        code: 'aquatrack',
        name: 'AquaTrack IoT',
        category: 'Aquaculture & Farm',
        badge_color: '#059669',
        icon_name: 'water'
      },
      {
        code: 'wms',
        name: 'WMS Cold Storage',
        category: 'Logistics & Warehouse',
        badge_color: '#D97706',
        icon_name: 'inventory_2'
      },
      {
        code: 'trade',
        name: 'Trade Portal',
        category: 'Trading & Commerce',
        badge_color: '#4F46E5',
        icon_name: 'shopping_cart'
      },
      {
        code: 'kemitraan',
        name: 'Kemitraan Driver',
        category: 'Logistik & Armada',
        badge_color: '#059669',
        icon_name: 'account_balance'
      }
    ];

    for (const sys of initialSystems) {
      await db.query(`
        INSERT INTO external_systems (code, name, category, badge_color, icon_name, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          category = VALUES(category),
          badge_color = VALUES(badge_color),
          icon_name = VALUES(icon_name)
      `, [sys.code, sys.name, sys.category, sys.badge_color, sys.icon_name]);
    }

    console.log('✅ Seeded dynamic external systems:', initialSystems.map(s => s.code).join(', '));
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
}

migrate();
