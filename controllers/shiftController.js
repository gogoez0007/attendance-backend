const db = require('../db');

// ✅ Get All Shifts
exports.getShifts = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, start_time, end_time FROM shifts');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get Shift by ID
exports.getShiftById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM shifts WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Shift not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Create Shift
exports.createShift = async (req, res) => {
    try {
        const { name, start_time, end_time } = req.body;
        await db.query('INSERT INTO shifts (name, start_time, end_time) VALUES (?, ?, ?)', 
            [name, start_time, end_time]);
        res.status(201).json({ message: 'Shift created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Update Shift
exports.updateShift = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, start_time, end_time } = req.body;
        await db.query('UPDATE shifts SET name = ?, start_time = ?, end_time = ? WHERE id = ?',
            [name, start_time, end_time, id]);
        res.json({ message: 'Shift updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Delete Shift
exports.deleteShift = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM shifts WHERE id = ?', [id]);
        res.json({ message: 'Shift deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
