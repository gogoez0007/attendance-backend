const db = require('../db');

// ✅ Get All Locations
exports.getLocations = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, latitude, longitude, radius_meters FROM locations');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get Location Rules & Work Schedule Types
exports.getLocationRules = async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT lr.id, lr.location_id, lr.location_name, lr.work_day_type, lr.is_5_days, lr.is_operational_tambak, lr.description,
                   l.latitude, l.longitude, l.radius_meters
            FROM location_rules lr
            JOIN locations l ON lr.location_id = l.id
            ORDER BY lr.location_id ASC
        `);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get Location by ID
exports.getLocationById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM locations WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Location not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Create Location
exports.createLocation = async (req, res) => {
    try {
        const { name, latitude, longitude, radius_meters } = req.body;
        await db.query('INSERT INTO locations (name, latitude, longitude, radius_meters) VALUES (?, ?, ?, ?)', 
            [name, latitude, longitude, radius_meters]);
        res.status(201).json({ message: 'Location created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Update Location
exports.updateLocation = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, latitude, longitude, radius_meters } = req.body;
        await db.query('UPDATE locations SET name = ?, latitude = ?, longitude = ?, radius_meters = ? WHERE id = ?',
            [name, latitude, longitude, radius_meters, id]);
        res.json({ message: 'Location updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Delete Location
exports.deleteLocation = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM locations WHERE id = ?', [id]);
        await db.query('DELETE FROM location_rules WHERE location_id = ?', [id]);
        res.json({ message: 'Location deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Update Location Rule (Konfigurasi Hari Kerja Lokasi: 5_DAYS, 6_DAYS, 7_DAYS)
exports.updateLocationRule = async (req, res) => {
    try {
        const location_id = req.params.location_id || req.params.id;
        const { work_day_type, description, is_operational_tambak } = req.body;

        const validTypes = ['5_DAYS', '6_DAYS', 'FIXED_6_DAYS', 'ROSTER_6_DAYS', '7_DAYS'];
        const normalizedType = validTypes.includes(String(work_day_type || '').toUpperCase())
            ? String(work_day_type).toUpperCase()
            : '5_DAYS';
        const is5Days = normalizedType === '5_DAYS' ? 1 : 0;

        // Cek apakah lokasi ada
        const [loc] = await db.query('SELECT name FROM locations WHERE id = ?', [location_id]);
        if (loc.length === 0) return res.status(404).json({ message: 'Location not found' });

        await db.query(`
            INSERT INTO location_rules (location_id, location_name, work_day_type, is_5_days, is_operational_tambak, description)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              work_day_type = VALUES(work_day_type),
              is_5_days = VALUES(is_5_days),
              description = COALESCE(VALUES(description), description),
              is_operational_tambak = COALESCE(VALUES(is_operational_tambak), is_operational_tambak)
        `, [
            location_id,
            loc[0].name,
            normalizedType,
            is5Days,
            is_operational_tambak !== undefined ? Number(is_operational_tambak) : 0,
            description || (normalizedType === '7_DAYS' ? 'Operasional (7 Hari Kerja)' : normalizedType === '6_DAYS' ? 'Operasional (6 Hari Kerja)' : 'Kantor (5 Hari Kerja, Sabtu-Minggu Libur)')
        ]);

        res.json({
            message: 'Location rule updated successfully',
            location_id: Number(location_id),
            location_name: loc[0].name,
            work_day_type: normalizedType,
            is_5_days: is5Days
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
