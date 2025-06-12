const db = require('../db');

// ✅ Get All Employees
exports.getEmployees = async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, username, position, department, phone FROM users');
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Get Employee by ID
exports.getEmployeeById = async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await db.query('SELECT * FROM users WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Employee not found' });
        res.json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Auth
exports.loginAuth = async (req, res) => {
    try {
        const { username, password } = req.body;
        const query = `
                        SELECT 
                            a.id, 
                            a.name, 
                            a.username, 
                            a.position, 
                            a.department, 
                            a.phone,
                            b.start_time as in_time,
                            b.end_time AS out_time,
                            c.latitude, 
                            c.longitude, 
                            c.radius_meters
                        FROM users a 
                        LEFT JOIN shifts b ON a.shift_id=b.id
                        LEFT JOIN locations c ON a.location_id = c.id
                        WHERE username = ? AND password = ?
                    `;

    
        // console.log('Query:', query);
        console.log('Parameters:', [username, password]);

        const [rows] = await db.query(query, [username, password]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'Employee not found' });
        }
        
        res.status(200).json(rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};


// ✅ Create Employee
exports.createEmployee = async (req, res) => {
    try {
        const { name, username, position, department, phone } = req.body;
        await db.query('INSERT INTO users (name, username, position, department, phone) VALUES (?, ?, ?, ?, ?)', 
            [name, username, position, department, phone]);
        res.status(201).json({ message: 'Employee created successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Update Employee
exports.updateEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, username, position, department, phone } = req.body;
        await db.query('UPDATE users SET name = ?, username = ?, position = ?, department = ?, phone = ? WHERE id = ?',
            [name, username, position, department, phone, id]);
        res.json({ message: 'Employee updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ✅ Delete Employee
exports.deleteEmployee = async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM users WHERE id = ?', [id]);
        res.json({ message: 'Employee deleted successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.updateTokenFirebase = async (req, res) => {
    try {
        const { id } = req.params;
        const { token } = req.body;
        await db.query('UPDATE users SET token = ? WHERE id = ?',
            [token, id]);
        res.json({ message: 'Token updated successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};