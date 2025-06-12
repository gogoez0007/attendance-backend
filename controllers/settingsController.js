// File: controllers/settingsController.js
const db = require('../db'); // Pastikan ini adalah koneksi mysql2 pool

// ✅ Get All Settings
exports.getSettings = async (req, res) => {
  try {
    const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';
    const [rows] = await db.query(
      `SELECT * FROM settings WHERE removed = FALSE AND isPrivate = FALSE ORDER BY created_at ${sort}`
    );
    if (rows.length > 0) {
      res.status(200).json({ success: true, result: rows, message: 'Successfully found all documents' });
    } else {
      res.status(203).json({ success: false, result: [], message: 'Collection is Empty' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Get Setting by ID
exports.getSettingById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query('SELECT * FROM settings WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Setting not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Create Setting
exports.createSetting = async (req, res) => {
  try {
    const { settingCategory, settingKey, settingValue, valueType, removed, enabled, isPrivate, isCoreSetting } = req.body;
    await db.query(
      `INSERT INTO settings (settingCategory, settingKey, settingValue, valueType, removed, enabled, isPrivate, isCoreSetting) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [settingCategory, settingKey, JSON.stringify(settingValue), valueType, removed, enabled, isPrivate, isCoreSetting]
    );
    res.status(201).json({ message: 'Setting created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Update Setting
exports.updateSetting = async (req, res) => {
  try {
    const { id } = req.params;
    const { settingCategory, settingKey, settingValue, valueType, removed, enabled, isPrivate, isCoreSetting } = req.body;
    await db.query(
      `UPDATE settings SET settingCategory = ?, settingKey = ?, settingValue = ?, valueType = ?, removed = ?, enabled = ?, isPrivate = ?, isCoreSetting = ? WHERE id = ?`,
      [settingCategory, settingKey, JSON.stringify(settingValue), valueType, removed, enabled, isPrivate, isCoreSetting, id]
    );
    res.json({ message: 'Setting updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ✅ Delete Setting
exports.deleteSetting = async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('DELETE FROM settings WHERE id = ?', [id]);
    res.json({ message: 'Setting deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
