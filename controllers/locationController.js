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
        res.json({ message: 'Location deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
