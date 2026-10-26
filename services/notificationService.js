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
    // 1. Jika userIds adalah 'all', '*', atau tidak diisi: otomatis jalankan broadcast
    const isBroadcast = !userIds || userIds === 'all' || userIds === '*' || (Array.isArray(userIds) && (userIds.length === 0 || userIds.includes('all')));
    if (isBroadcast) {
        if (!title || !body) {
            throw new Error('title dan body wajib diisi untuk broadcast notifikasi.');
        }
        return exports.broadcastFCMNotification(title, body, imageUrl, data);
    }

    if (!title || !body) {
        throw new Error('title dan body wajib diisi');
    }

    const idList = (Array.isArray(userIds) ? userIds : [userIds]).filter(id => id !== null && id !== undefined && id !== '');
    if (idList.length === 0) {
        return exports.broadcastFCMNotification(title, body, imageUrl, data);
    }

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

/**
 * Broadcast notifikasi ke seluruh user aktif yang memiliki token FCM
 * @param {String} title
 * @param {String} body
 * @param {String} imageUrl
 * @param {Object} data - custom payload data
 * @returns {Promise<Object>} hasil pengiriman FCM
 */
exports.broadcastFCMNotification = async (title, body, imageUrl = '', data = {}) => {
    if (!title || !body) {
        throw new Error('title dan body wajib diisi untuk broadcast');
    }

    // Ambil seluruh token user aktif dari DB
    const [rows] = await db.query(
        "SELECT id, name, token FROM users WHERE (is_active = 1 OR is_active IS NULL) AND token IS NOT NULL AND token != ''"
    );

    const tokens = rows.map(r => r.token).filter(Boolean);
    if (tokens.length === 0) {
        console.log('⚠️ Tidak ada user dengan token FCM aktif untuk di-broadcast');
        return { total: 0, successful: 0, failed: 0 };
    }

    console.log(`📢 Memulai broadcast notifikasi ke ${tokens.length} user...`);

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

    const baseMessage = {
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
            }
        },
        apns: {
            payload: {
                aps: {
                    sound: 'default',
                }
            }
        }
    };

    // Firebase sendEachForMulticast mendukung hingga 500 token per batch
    const batchSize = 500;
    let totalSuccess = 0;
    let totalFailed = 0;
    const failedErrors = [];

    for (let i = 0; i < tokens.length; i += batchSize) {
        const batchTokens = tokens.slice(i, i + batchSize);
        try {
            const response = await admin.messaging().sendEachForMulticast({
                ...baseMessage,
                tokens: batchTokens,
            });
            totalSuccess += response.successCount;
            totalFailed += response.failureCount;
            response.responses.forEach(resp => {
                if (!resp.success) {
                    failedErrors.push(resp.error?.message);
                }
            });
        } catch (batchErr) {
            console.error('❌ Gagal kirim batch FCM:', batchErr);
            totalFailed += batchTokens.length;
        }
    }

    console.log(`✅ Broadcast selesai: ${totalSuccess} berhasil, ${totalFailed} gagal dari total ${tokens.length} token.`);
    return {
        total: tokens.length,
        successful: totalSuccess,
        failed: totalFailed,
        sampleFailedErrors: failedErrors.slice(0, 5)
    };
};

