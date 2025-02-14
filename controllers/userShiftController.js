const db = require('../db');

// ✅ Get All User Shifts
exports.getUserShifts = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, user_id, shift_id FROM user_shifts');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get User Shift by ID
exports.getUserShiftById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM user_shifts WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'User Shift not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Create User Shift
exports.createUserShift = async (req, res) => {
    try {
        const { user_id, shift_id } = req.body;
        await db.query('INSERT INTO user_shifts (user_id, shift_id) VALUES (?, ?)', 
            [user_id, shift_id]);
        res.status(201).json({ message: 'User Shift created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Delete User Shift
exports.deleteUserShift = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM user_shifts WHERE id = ?', [id]);
        res.json({ message: 'User Shift deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
