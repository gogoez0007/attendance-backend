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
 * @param {Object} data - custom payload data untuk deep link
 * @returns {Promise<Array>} hasil pengiriman FCM
 */
exports.sendFCMNotification = async (userIds, title, body, imageUrl = '', data = {}) => {
    if (!userIds || !title || !body) {
        throw new Error('userIds, title, dan body wajib diisi');
    }

    const idList = Array.isArray(userIds) ? userIds : [userIds];
    if (idList.length === 0) return [];

    // Ambil token dari DB
    const [rows] = await db.query(
        'SELECT id, name, token FROM users WHERE id IN (?)',
        [idList]
    );

    const tokens = rows.map(row => row.token).filter(Boolean);
    if (tokens.length === 0) {
        console.log('⚠️ Tidak ada token valid untuk user:', idList);
        return [];
    }

    // Format data menjadi string key-value untuk FCM
    const stringData = {};
    if (data && typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            if (v !== undefined && v !== null) {
                stringData[k] = String(v);
            }
        }
    }
    stringData['click_action'] = 'FLUTTER_NOTIFICATION_CLICK';

    // Hitung badge launcher icon (app icon badge di launcher HP)
    let badgeNum = data && (data.badge !== undefined ? Number(data.badge) : (data.badge_count !== undefined ? Number(data.badge_count) : null));

    if ((badgeNum === null || isNaN(badgeNum)) && idList.length === 1) {
        try {
            const uid = idList[0];
            const [appLeaves] = await db.query(
                "SELECT COUNT(DISTINCT lra.leave_request_id) AS cnt FROM leave_request_approvers lra JOIN leave_requests lr ON lra.leave_request_id = lr.id WHERE lra.approver_user_id = ? AND lra.status = 'pending' AND lr.status = 'pending'",
                [uid]
            );
            const [appExts] = await db.query(
                "SELECT COUNT(DISTINCT eaa.approval_id) AS cnt FROM external_approval_approvers eaa JOIN external_approvals ea ON eaa.approval_id = ea.id WHERE eaa.approver_user_id = ? AND eaa.status = 'pending' AND ea.status = 'pending'",
                [uid]
            );
            badgeNum = (appLeaves[0]?.cnt || 0) + (appExts[0]?.cnt || 0);
        } catch (_) {}
    }

    if (badgeNum !== null && !isNaN(badgeNum)) {
        stringData['badge'] = String(badgeNum);
        stringData['badge_count'] = String(badgeNum);
    }

    // Payload FCM
    const message = {
        notification: {
            title,
            body,
            image: imageUrl || undefined,
        },
        data: stringData,
        android: {
            priority: 'high',
            notification: {
                channelId: 'attendance_high_channel',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                notificationCount: (badgeNum !== null && !isNaN(badgeNum)) ? badgeNum : undefined,
            }
        },
        apns: {
            payload: {
                aps: {
                    badge: (badgeNum !== null && !isNaN(badgeNum)) ? badgeNum : undefined,
                }
            }
        }
    };

    // Kirim ke semua token secara paralel dan aman
    const results = await Promise.allSettled(
        tokens.map(token => admin.messaging().send({ ...message, token }))
    );

    const successful = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
        console.warn(`⚠️ ${failed.length} token FCM gagal dikirim:`, failed.map(f => f.reason?.message));
    }

    console.log(`✅ FCM terkirim ke ${successful} dari ${tokens.length} token`);
    return results;
};
