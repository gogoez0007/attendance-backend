// controllers/notificationFirebaseController.js
const notificationService = require('../services/notificationService');

exports.sendFCMNotification = async (req, res) => {
    try {
        const bodyObj = req.body || {};
        
        // Fleksibel menangkap parameter user (mendukung snake_case, camelCase, singular, plural)
        const user_ids = bodyObj.user_ids ?? bodyObj.userIds ?? bodyObj.user_id ?? bodyObj.userId ?? bodyObj.target_users;
        
        // Fleksibel menangkap title
        const title = bodyObj.title || bodyObj.judul || bodyObj.subject;
        
        // Fleksibel menangkap body pesan
        const body = bodyObj.body || bodyObj.pesan || bodyObj.message || bodyObj.isi || bodyObj.deskripsi || bodyObj.content;
        
        // Fleksibel menangkap image URL
        const imageUrl = bodyObj.imageUrl || bodyObj.image_url || bodyObj.image || '';
        
        // Fleksibel payload data
        const data = bodyObj.data || bodyObj.payload || {};

        if (!title || !body) {
            console.warn('⚠️ Request notifikasi ditolak karena title atau body kosong. Payload diterima:', req.body);
            return res.status(400).json({
                error: "Field 'title' (atau 'judul') dan 'body' (atau 'pesan'/'message') wajib diisi.",
                received_payload: req.body
            });
        }

        const result = await notificationService.sendFCMNotification(user_ids, title, body, imageUrl, data);

        res.status(200).json({
            message: 'Notification sent successfully',
            result
        });
    } catch (err) {
        console.error('❌ Gagal kirim notifikasi:', err.message, 'Payload diterima:', req.body);
        res.status(500).json({ error: err.message, received_payload: req.body });
    }
};

exports.broadcastNotification = async (req, res) => {
    try {
        const bodyObj = req.body || {};
        const title = bodyObj.title || bodyObj.judul || bodyObj.subject;
        const body = bodyObj.body || bodyObj.pesan || bodyObj.message || bodyObj.isi || bodyObj.deskripsi || bodyObj.content;
        const imageUrl = bodyObj.imageUrl || bodyObj.image_url || bodyObj.image || '';
        const data = bodyObj.data || bodyObj.payload || {};

        if (!title || !body) {
            return res.status(400).json({
                error: "Field 'title' (atau 'judul') dan 'body' (atau 'pesan'/'message') wajib diisi.",
                received_payload: req.body
            });
        }

        const result = await notificationService.broadcastFCMNotification(title, body, imageUrl, data);

        res.status(200).json({
            message: 'Broadcast notification sent successfully',
            result
        });
    } catch (err) {
        console.error('❌ Gagal broadcast notifikasi:', err.message, 'Payload diterima:', req.body);
        res.status(500).json({ error: err.message });
    }
};

