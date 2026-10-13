const db = require('../db');

async function run() {
  const [cols] = await db.query('DESCRIBE external_approvals');
  const existing = cols.map(c => c.Field);

  if (!existing.includes('callback_url')) {
    await db.query('ALTER TABLE external_approvals ADD COLUMN callback_url VARCHAR(500) DEFAULT NULL');
    console.log('✅ Added callback_url');
  }
  if (!existing.includes('callback_method')) {
    await db.query("ALTER TABLE external_approvals ADD COLUMN callback_method VARCHAR(10) DEFAULT 'POST'");
    console.log('✅ Added callback_method');
  }
  if (!existing.includes('callback_headers')) {
    await db.query('ALTER TABLE external_approvals ADD COLUMN callback_headers JSON DEFAULT NULL');
    console.log('✅ Added callback_headers');
  }
  if (!existing.includes('callback_status')) {
    await db.query("ALTER TABLE external_approvals ADD COLUMN callback_status ENUM('pending', 'success', 'failed') DEFAULT NULL");
    console.log('✅ Added callback_status');
  }
  if (!existing.includes('callback_response')) {
    await db.query('ALTER TABLE external_approvals ADD COLUMN callback_response TEXT DEFAULT NULL');
    console.log('✅ Added callback_response');
  }
  if (!existing.includes('callback_executed_at')) {
    await db.query('ALTER TABLE external_approvals ADD COLUMN callback_executed_at DATETIME DEFAULT NULL');
    console.log('✅ Added callback_executed_at');
  }
  console.log('🎉 Migration callback columns completed successfully!');
  process.exit(0);
}

run().catch(err => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
