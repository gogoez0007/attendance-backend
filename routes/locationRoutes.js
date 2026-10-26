const express = require('express');
const router = express.Router();
const locationController = require('../controllers/locationController');

router.get('/rules', locationController.getLocationRules);
router.put('/rules/:location_id', locationController.updateLocationRule);
router.get('/', locationController.getLocations);
router.get('/:id', locationController.getLocationById);
router.post('/', locationController.createLocation);
router.put('/:id', locationController.updateLocation);
router.delete('/:id', locationController.deleteLocation);

module.exports = router;
