const admin = require('firebase-admin');
const db = require('../db');

// Inisialisasi Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(require('../config/serviceAccountKey.json')),
});

exports.sendFCMNotification = async (req, res) => {
    try {
        const { user_ids, title, body, imageUrl } = req.body;

        // Validasi parameter yang wajib ada (kecuali imageUrl)
        if (!user_ids || !title || !body) {
            return res.status(400).json({
                message: 'Missing required fields: user_ids, title, and body are required.',
            });
        }

        // Ambil token dari database berdasarkan user_ids
        const [rows] = await db.query('SELECT token FROM users WHERE id IN (?)', [user_ids]);

        if (rows.length === 0) {
            return res.status(404).json({ message: 'User tidak ditemukan' });
        }

        // Ambil semua token yang ditemukan untuk user_ids
        const tokens = rows.map(row => row.token).filter(token => token);

        if (tokens.length === 0) {
            return res.status(404).json({ message: 'Tidak ada token yang valid untuk user-user ini' });
        }

        // Buat payload pesan FCM dengan gambar
        const message = {
            notification: {
                title: title || 'Notifikasi',
                body: body || 'Ini adalah pesan notifikasi',
                image: imageUrl || '', // URL gambar yang ingin ditambahkan
            }
        };

        // Kirim pesan FCM ke setiap token secara bersamaan menggunakan Promise.all
        const sendPromises = tokens.map(token => 
            admin.messaging().send({
                ...message,
                token: token,
            })
        );

        // Tunggu semua notifikasi terkirim
        const response = await Promise.all(sendPromises);

        res.status(200).json({
            message: 'Notification sent successfully to multiple users',
            response,
        });
    } catch (err) {
        console.log({err})
        res.status(500).json({ error: err.message });
    }
};
