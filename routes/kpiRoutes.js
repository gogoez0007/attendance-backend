const express = require('express');
const router = express.Router();
const kpiCtrl = require('../controllers/kpiController');

router.post('/kpi', kpiCtrl.uploadKpiFile, kpiCtrl.createKpi);
router.get('/kpi', kpiCtrl.getAllKpi);
router.get('/kpi/:id', kpiCtrl.getKpiDetail);
router.put('/kpi/:id', kpiCtrl.updateKpi);

module.exports = router;
