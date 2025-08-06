// services/notificationService.js
const admin = require('firebase-admin');
const db = require('../db');

// Inisialisasi Firebase hanya sekali di awal aplikasi
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(require('../config/serviceAccountKey.json')),
    });
}

/**
 * Kirim notifikasi ke beberapa user
 * @param {Array} userIds
 * @param {String} title
 * @param {String} body
 * @param {String} imageUrl
 * @returns {Promise<Array>} hasil pengiriman FCM
 */
exports.sendFCMNotification = async (userIds, title, body, imageUrl = '') => {
    if (!userIds || !title || !body) {
        throw new Error('userIds, title, dan body wajib diisi');
    }

    // Ambil token dari DB
    const [rows] = await db.query(
        'SELECT token FROM users WHERE id IN (?)',
        [userIds]
    );

    const tokens = rows.map(row => row.token).filter(Boolean);
    if (tokens.length === 0) {
        console.log('⚠️ Tidak ada token valid untuk user:', userIds);
        return [];
    }

    // Payload FCM
    const message = {
        notification: {
            title,
            body,
            image: imageUrl || undefined,
        },
    };

    // Kirim ke semua token paralel
    const responses = await Promise.all(
        tokens.map(token => admin.messaging().send({ ...message, token }))
    );

    console.log(`✅ FCM terkirim ke ${tokens.length} token`);
    return responses;
};
