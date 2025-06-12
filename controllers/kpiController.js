const db = require('../db');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
// Multer setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const name = Date.now() + '-' + file.originalname;
        cb(null, name);
    }
});

const upload = multer({ storage });
exports.uploadKpiFile = upload.single('kpi_file');

exports.createKpi = async (req, res) => {
    let masterKpiId;
    try {
        const { user_id, bulan, tahun } = req.body;
        const filePath = req.file.path;

        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawData = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: null });

        if (rawData.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'File Excel kosong atau tidak valid.'
            });
        }

        // Cari baris header
        const headerRowIndex = rawData.findIndex(row =>
            row.includes('Deskripsi') &&
            row.includes('Parameter') &&
            row.includes('Target') &&
            row.includes('Bobot (%)') &&
            row.includes('Realisasi') &&
            row.includes('Score')
        );

        if (headerRowIndex === -1) {
            return res.status(400).json({
                success: false,
                message: 'Baris header tidak ditemukan. Pastikan kolom: Deskripsi, Parameter, Target, Bobot (%), Realisasi, Score ada.'
            });
        }

        const headers = rawData[headerRowIndex];
        const dataRows = rawData.slice(headerRowIndex + 1);

        // Simpan ke master_kpi
        const [result] = await db.query(
            'INSERT INTO master_kpi (user_id, bulan, tahun, file_path) VALUES (?, ?, ?, ?)',
            [user_id, parseInt(bulan), parseInt(tahun), filePath]
        );
        masterKpiId = result.insertId;

        // Simpan ke detail_kpi
        for (const row of dataRows) {
            const rowData = {};
            headers.forEach((key, i) => {
                rowData[key] = row[i] !== '' ? row[i] : null;
            });

            const deskripsi = rowData['Deskripsi'];
            const parameter = rowData['Parameter'];
            const target = rowData['Target'];
            const bobot = rowData['Bobot (%)'] ? parseFloat(rowData['Bobot (%)']) : null;
            const realisassi = rowData['Realisasi'] ? parseFloat(rowData['Realisasi']) : null;
            const score = rowData['Score'] ? parseFloat(rowData['Score']) : null;

            if (deskripsi !== null) {
                await db.query(
                    `INSERT INTO detail_kpi 
                        (master_kpi_id, deskripsi, parameter, target, bobot, realisassi, score, catatan) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [masterKpiId, deskripsi, parameter, target, bobot, realisassi, score, null] // catatan null
                );
            }
        }

        res.status(201).json({
            success: true,
            result: {
                master_kpi_id: masterKpiId
            },
            message: 'File KPI berhasil diproses.'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat memproses KPI',
            error: err.message
        });
    }
};

exports.getAllKpi = async (req, res) => {
    const { page = 1, items = 10 } = req.query;
    const offset = (page - 1) * items;

    try {
        const [rows] = await db.query(
            'SELECT a.id, user_id, bulan, tahun, file_path, b.`name` FROM master_kpi a JOIN users b ON a.user_id = b.id ORDER BY id DESC LIMIT ? OFFSET ?',
            [parseInt(items), parseInt(offset)]
        );

        const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM master_kpi');

        res.status(200).json({
            success: true,
            result: rows,
            pagination: {
                page: parseInt(page),
                pageSize: parseInt(items),
                count: total
            },
            message: rows.length > 0 ? 'Data berhasil diambil' : 'Data kosong'
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            result: [],
            message: 'Database error',
            error: err.message
        });
    }
};

exports.getKpiDetail = async (req, res) => {
    try {
        const { id } = req.params;

        // Ambil data master_kpi
        const [masterRows] = await db.query(
            `SELECT id, user_id, bulan, tahun, file_path
             FROM master_kpi
             WHERE id = ?`,
            [id]
        );
        const master = masterRows[0];

        if (!master) {
            return res.status(404).json({
                success: false,
                result: null,
                message: 'Data master_kpi tidak ditemukan'
            });
        }

        // Ambil detail_kpi
        const [detail] = await db.query(
            `SELECT id, deskripsi, parameter, target, bobot, realisassi, score, catatan
             FROM detail_kpi
             WHERE master_kpi_id = ?
             ORDER BY id`,
            [id]
        );

        // Ambil catatan_kpi
        const [catatan] = await db.query(
            `SELECT id, no_urutan, isi_catatan
             FROM catatan_kpi
             WHERE master_kpi_id = ?
             ORDER BY no_urutan`,
            [id]
        );

        res.status(200).json({
            success: true,
            result: {
                master,
                detail,
                catatan
            },
            message: 'Detail KPI berhasil diambil'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            result: null,
            message: 'Database error',
            error: err.message
        });
    }
};


exports.getDetailKpiByMaster = async (req, res) => {
    try {
        const { masterId } = req.params;

        const [rows] = await db.query(
            'SELECT * FROM detail_kpi WHERE master_kpi_id = ?',
            [masterId]
        );

        res.status(200).json({
            success: true,
            result: rows,
            message: rows.length > 0 ? 'Data berhasil diambil' : 'Data kosong'
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            result: [],
            message: 'Database error',
            error: err.message
        });
    }
};

exports.updateKpi = async (req, res) => {
    const { id } = req.params;
    const { details = [], catatan = [] } = req.body;

    try {

        for (const item of details) {
            const action = item.action;

            if (action === 'add') {
                const { deskripsi, parameter, target, bobot, realisassi, score, catatan } = item;
                await db.query(
                    `INSERT INTO detail_kpi (master_kpi_id, deskripsi, parameter, target, bobot, realisassi, score, catatan)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [id, deskripsi, parameter, target, bobot, realisassi, score, catatan]
                );
            } else if (action === 'edit') {
                const { id, realisassi, score, catatan } = item;
                await db.query(
                    `UPDATE detail_kpi SET realisassi = ?, score = ?, catatan = ? WHERE id = ?`,
                    [realisassi, score, catatan, id]
                );
            } else if (action === 'delete') {
                const { id } = item;
                await db.query(
                    `DELETE FROM detail_kpi WHERE id = ?`,
                    [id]
                );
            }
        }

        let noUrutan = 1;
        for (const item of catatan) {
            const action = item.action;

            if (action === 'add') {
                await db.query(
                    `INSERT INTO catatan_kpi (master_kpi_id, no_urutan, isi_catatan)
                     VALUES (?, ?, ?)`,
                    [id, noUrutan, item.isi_catatan]
                );
                noUrutan++;
            } else if (action === 'edit') {
                await db.query(
                    `UPDATE catatan_kpi SET isi_catatan = ? WHERE id = ?`,
                    [item.isi_catatan, item.id]
                );
            } else if (action === 'delete') {
                await db.query(
                    `DELETE FROM catatan_kpi WHERE id = ?`,
                    [item.id]
                );
            }
        }

        res.status(200).json({
            success: true,
            message: 'Berhasil update detail KPI dan catatan.'
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Terjadi kesalahan saat update KPI',
            error: err.message
        });
    }
};
