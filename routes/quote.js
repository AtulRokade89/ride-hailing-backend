// // D:/ride-hailing-project/ride-hailing-backend/routes/quote.js

// const express = require('express');
// const router = express.Router();
// const pool = global.pool; // uses same pool as other modules

// async function countRecentPings(lat, lng, radiusMeters = 300, windowMinutes = 15) {
  // const q = `
    // SELECT COUNT(*) AS cnt
      // FROM rider_demand_pings
     // WHERE ping_time > NOW() - INTERVAL '${windowMinutes} minutes'
       // AND ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
  // `;
  // const params = [lng, lat, radiusMeters];
  // const { rows } = await pool.query(q, params);
  // return Number(rows[0].cnt || 0);
// }

// // Map ping counts -> surge multiplier (tune thresholds)
// function pingsToSurge(count) {
  // if (count >= 20) return 2.0;
  // if (count >= 15) return 1.8;
  // if (count >= 10) return 1.5;
  // if (count >= 5) return 1.2;
  // return 1.0;
// }

// // --- FARE COMPUTATION LOGIC ---

// // Base fare logic for a normal "Ride Now" //08032026  enhance some values
// // function computeBaseFare(vehicleType, distanceKm) {
  // // const vt = String(vehicleType || '').toUpperCase();
  // // const base = vt === 'BIKE' ? 20 : vt === 'MINI' ? 40 : vt === 'SEDAN' ? 70 : vt === 'SUV' ? 100 : 40;
  // // const perKm = vt === 'BIKE' ? 6 : vt === 'MINI' ? 10 : vt === 'SEDAN' ? 15 : vt === 'SUV' ? 20 : 10;
  // // const km = Math.max(0, Number(distanceKm) || 0);
  // // return base + perKm * km;
// // }

// function computeBaseFare(vehicleType, distanceKm) {
  // const vt = String(vehicleType || '').toUpperCase();
  // const km = Math.max(0, Number(distanceKm) || 0);

  // const base =
    // vt === 'BIKE' ? 25 :
    // vt === 'AUTO' ? 35 :
    // vt === 'MINI' ? 45 :
    // vt === 'SEDAN' ? 75 :
    // vt === 'SUV' ? 110 : 45;

  // const perKm =
    // vt === 'BIKE' ? 7 :
    // vt === 'AUTO' ? 9 :
    // vt === 'MINI' ? 11 :
    // vt === 'SEDAN' ? 16 :
    // vt === 'SUV' ? 21 : 11;

  // return Math.round(base + km * perKm);
// }

// // Fare logic for a scheduled ride (applies a premium)
// function computeScheduledFare(vehicleType, distanceKm) {
  // const normalFare = computeBaseFare(vehicleType, distanceKm);
  // const SCHEDULED_RIDE_PREMIUM = 1.15; // 15% premium
  // return normalFare * SCHEDULED_RIDE_PREMIUM;
// }

// // --- GST and Rounding LOGIC ---
// const GST_RATE = 0.05; // 5%

// function isGstApplicable(vehicleType) {
    // return ['BIKE','AUTO', 'MINI', 'SEDAN', 'SUV'].includes(String(vehicleType).toUpperCase());
// }



// // --- THE MAIN QUOTE ENDPOINT ---
// router.get('/', async (req, res) => {
  // try {
    // const { vehicleType, distanceKm, latitude, longitude, isScheduled } = req.query;
    // const distance = parseFloat(distanceKm);
    // const lat = parseFloat(latitude);
    // const lon = parseFloat(longitude);

    // if (!vehicleType || isNaN(distance) || distance <= 0 || isNaN(lat) || isNaN(lon)) {
      // return res.status(400).json({ message: 'Invalid vehicleType, distanceKm, latitude or longitude.' });
    // }

    // // compute base fare (scheduled or normal)
    // const baseFare = (isScheduled === 'true')
      // ? computeScheduledFare(vehicleType, distance)
      // : computeBaseFare(vehicleType, distance);

    // // --- NEW: compute surge from recent demand pings ---
    // const radiusMeters = 300;   // tune: meters to consider nearby demand
    // const windowMinutes = 15;   // tune: how recent pings must be

    // let pingCount = 0;
    // try {
      // pingCount = await countRecentPings(lat, lon, radiusMeters, windowMinutes);
    // } catch (err) {
      // console.warn('quote: countRecentPings failed, defaulting to 0', err);
      // pingCount = 0;
    // }

    // const computedSurge = pingsToSurge(pingCount);

    // // Apply surge to base fare BEFORE GST
    // const surgedBase = baseFare * computedSurge;

    // // Apply GST logic as before
    // let finalAmount = surgedBase;
    // let cgst = 0;
    // let sgst = 0;
    // if (isGstApplicable(vehicleType)) {
        // cgst = surgedBase * (GST_RATE / 2);
        // sgst = surgedBase * (GST_RATE / 2);
        // finalAmount = surgedBase + cgst + sgst;
    // }

    // res.json({
        // base_rupees: surgedBase.toFixed(2),
        // cgst_rupees: cgst.toFixed(2),
        // sgst_rupees: sgst.toFixed(2),
        // total_rupees: finalAmount.toFixed(2),
        // final_amount: Math.round(finalAmount),
        // gst_rate_percent: isGstApplicable(vehicleType) ? 5.0 : 0.0,
        // surge_multiplier: computedSurge,
        // demand_count: pingCount // useful for debugging/metrics
    // });
  // } catch (e) {
    // console.error('quote error', e);
    // res.status(500).json({ message: 'Internal server error' });
  // }
// });


// module.exports = router;

//quote.js
const express = require('express');
const router = express.Router();
const pool = global.pool;

const {
  computeBaseFareINR,
  isGstApplicable,
  roundedRupeesFromPaise
} = require('../utils/tax');

async function countRecentPings(lat, lng, radiusMeters = 300, windowMinutes = 15) {
  const q = `
    SELECT COUNT(*) AS cnt
    FROM rider_demand_pings
    WHERE ping_time > NOW() - INTERVAL '${windowMinutes} minutes'
      AND ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
        $3
      )
  `;
  const params = [lng, lat, radiusMeters];
  const { rows } = await pool.query(q, params);
  return Number(rows[0].cnt || 0);
}

// Surge thresholds
function pingsToSurge(count) {
  if (count >= 20) return 2.0;
  if (count >= 15) return 1.8;
  if (count >= 10) return 1.5;
  if (count >= 5) return 1.2;
  return 1.0;
}

// Scheduled ride premium
function computeScheduledFare(vehicleType, distanceKm) {
  const normalFare = computeBaseFareINR(vehicleType, distanceKm);
  return normalFare * 1.15;
}

const GST_RATE = 0.05;

// MAIN QUOTE ENDPOINT
router.get('/', async (req, res) => {
  try {
    const {
      vehicleType,
      distanceKm,
      latitude,
      longitude,
      isScheduled
    } = req.query;

    const distance = parseFloat(distanceKm);
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    if (!vehicleType || isNaN(distance) || distance <= 0 || isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({
        message: 'Invalid vehicleType, distanceKm, latitude or longitude.'
      });
    }

    // Base fare
	if (process.env.NODE_ENV !=='production')
	{
	console.log('quote vehicle=',vehicleType);
	}
    const baseFare = isScheduled === 'true'
      ? computeScheduledFare(vehicleType, distance)
      : computeBaseFareINR(vehicleType, distance);
	  if (process.env.NODE_ENV !=='production')
	{
console.log('base fare=',baseFare);
	}
    // Surge detection
    let pingCount = 0;
    try {
      pingCount = await countRecentPings(lat, lon);
    } catch (err) {
      console.warn('countRecentPings failed:', err);
    }

    const surgeMultiplier = pingsToSurge(pingCount);

    // Apply surge
    const surgedBase = baseFare * surgeMultiplier;

    // GST
    let cgst = 0;
    let sgst = 0;
    let total = surgedBase;

    if (isGstApplicable(vehicleType)) {
      cgst = surgedBase * 0.025;
      sgst = surgedBase * 0.025;
      total = surgedBase + cgst + sgst;
    }

    // Convert to paise for exact rounding
    const totalPaise = Math.round(total * 100);

    // Exact same rounding used everywhere
    const finalAmount = roundedRupeesFromPaise(totalPaise);

    return res.json({
      base_rupees: surgedBase.toFixed(2),
      cgst_rupees: cgst.toFixed(2),
      sgst_rupees: sgst.toFixed(2),
      total_rupees: total.toFixed(2),
      final_amount: finalAmount,
      gst_rate_percent: isGstApplicable(vehicleType) ? 5 : 0,
      surge_multiplier: surgeMultiplier,
      demand_count: pingCount
    });

  } catch (e) {
    console.error('quote error:', e);
    return res.status(500).json({
      message: 'Internal server error'
    });
  }
});

module.exports = router;

