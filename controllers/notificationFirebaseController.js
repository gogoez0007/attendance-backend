// controllers/notificationFirebaseController.js
const notificationService = require('../services/notificationService');

exports.sendFCMNotification = async (req, res) => {
    try {
        const { user_ids, title, body, imageUrl } = req.body;
        const result = await notificationService.sendFCMNotification(user_ids, title, body, imageUrl);

        res.status(200).json({
            message: 'Notification sent successfully',
            result
        });
    } catch (err) {
        console.error('❌ Gagal kirim notifikasi:', err);
        res.status(500).json({ error: err.message });
    }
};
