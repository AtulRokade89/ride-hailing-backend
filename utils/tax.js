// // returns true if GST=5% applies for this vehicle
// function isGstApplicable(vehicleType) {
  // if (!vehicleType) return false;
  // const vt = String(vehicleType).trim().toUpperCase();
  // // Updated list for GST applicability (5%): SUV, SEDAN, BIKE, MINI.
  // // This implicitly excludes RIKSHAW or any other type not listed.
  // return vt === 'SUV' || vt === 'SEDAN' || vt === 'BIKE' || vt === 'MINI' || vt === 'AUTO';
// }

// function computeBaseFareINR(vehicleType, distanceKm) {
// const vt = String(vehicleType).trim().toUpperCase();

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
	// if (process.env.NODE_ENV !=='production')
	// {
	// console.log('base=',base,'perKM=', perKm);
	// }

  // const km = Math.max(0, Number(distanceKm) || 0);

  // return Math.round((base + perKm * km) * 100) / 100;

// }

// // basePaise -> [cgst, sgst] each 2.5%, rounded to nearest paise
// function computeGstPaise(basePaise, vehicleType) {
  // if (!isGstApplicable(vehicleType)) return { cgst: 0, sgst: 0 };

  // // 2.5% each; calculate in paise and round to nearest paise
  // const cgst = Math.round(basePaise * 2.5 / 100);
  // const sgst = Math.round(basePaise * 2.5 / 100);
  // return { cgst, sgst };
// }

// /**
 // * total paise -> rounded rupees (0.50 up) - Custom half-up implementation
 // * This function calculates the final whole rupee amount (rounded_rupees DB column).
 // * * Logic: 182.49 -> 182 (rounds down)
 // * 182.50 -> 183 (rounds up)
 // */
// function roundedRupeesFromPaise(paise) {
  // // Convert paise to a number in Rupees (e.g., 18249 -> 182.49)
  // const rupeesFloat = (Number(paise) || 0) / 100;
  
  // // Implements the "round to nearest whole number, where .50 rounds up" rule:
  // // Math.floor(x + 0.5)
  // return Math.floor(rupeesFloat + 0.5);
// }

// // create a human-readable invoice number; you can swap to a sequence table if you prefer
// function makeInvoiceNumber(id) {
  // const y = new Date().getFullYear();
  // return `INV-${y}-${String(id).padStart(6, '0')}`;}

// module.exports = {
  // isGstApplicable,
  // computeGstPaise,
  // roundedRupeesFromPaise,
  // makeInvoiceNumber,
  // computeBaseFareINR,
// };



// utils/tax.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for all fare & tax calculations.
// Normal vehicles : BIKE | AUTO | MINI | SEDAN | SUV
// EV vehicles     : EV_BIKE | EV_AUTO | EV_MINI
// ─────────────────────────────────────────────────────────────────────────────

// ---------------------------------------------------------------------------
// Fare table — one place to change prices, nothing else needs editing
// ---------------------------------------------------------------------------
const FARE_TABLE = {
  // ── Normal ──────────────────────────────── base(₹)  perKm(₹)
  BIKE:    { base: 25,  perKm: 7,   isEv: false },
  AUTO:    { base: 35,  perKm: 9,   isEv: false },
  MINI:    { base: 45,  perKm: 11,  isEv: false },
  SEDAN:   { base: 75,  perKm: 16,  isEv: false },
  SUV:     { base: 110, perKm: 21,  isEv: false },

  // ── EV (≈15-20% cheaper) ────────────────── base(₹)  perKm(₹)
  EV_BIKE: { base: 20,  perKm: 6,   isEv: true  },
  EV_AUTO: { base: 28,  perKm: 7.5, isEv: true  },
  EV_MINI: { base: 38,  perKm: 9,   isEv: true  },
};

const DEFAULT_FARE = { base: 45, perKm: 11, isEv: false }; // fallback

// ---------------------------------------------------------------------------
// Helper: normalise vehicleType string
// ---------------------------------------------------------------------------
function normaliseVehicleType(vehicleType) {
  return String(vehicleType || '').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// isEvVehicle — true if this is an EV variant
// Used by socket.js / UI to show green badge etc.
// ---------------------------------------------------------------------------
function isEvVehicle(vehicleType) {
  const vt = normaliseVehicleType(vehicleType);
  return (FARE_TABLE[vt] || DEFAULT_FARE).isEv;
}

// ---------------------------------------------------------------------------
// isGstApplicable — GST 5% applies to all current vehicle types
// ---------------------------------------------------------------------------
function isGstApplicable(vehicleType) {
  if (!vehicleType) return false;
  const vt = normaliseVehicleType(vehicleType);
  return vt in FARE_TABLE; // every listed vehicle attracts GST
}

// ---------------------------------------------------------------------------
// computeBaseFareINR — main fare calculator
// Returns rupees as a float (e.g. 182.50), NOT paise
// ---------------------------------------------------------------------------
function computeBaseFareINR(vehicleType, distanceKm) {
  const vt = normaliseVehicleType(vehicleType);
  const { base, perKm } = FARE_TABLE[vt] || DEFAULT_FARE;
  const km = Math.max(0, Number(distanceKm) || 0);

  if (process.env.NODE_ENV !== 'production') {
    console.log(`[tax] computeBaseFareINR | vehicle=${vt} base=₹${base} perKm=₹${perKm} km=${km}`);
  }

  return Math.round((base + perKm * km) * 100) / 100;
}

// ---------------------------------------------------------------------------
// computeGstPaise — splits 5% GST into CGST 2.5% + SGST 2.5%
// Input : basePaise (integer, paise)
// Output: { cgst, sgst } both in paise, rounded to nearest paise
// ---------------------------------------------------------------------------
function computeGstPaise(basePaise, vehicleType) {
  if (!isGstApplicable(vehicleType)) return { cgst: 0, sgst: 0 };

  const cgst = Math.round(basePaise * 2.5 / 100);
  const sgst = Math.round(basePaise * 2.5 / 100);
  return { cgst, sgst };
}

// ---------------------------------------------------------------------------
// roundedRupeesFromPaise — paise → whole rupees (half-up rounding)
// 18249 paise → ₹182  |  18250 paise → ₹183
// ---------------------------------------------------------------------------
function roundedRupeesFromPaise(paise) {
  const rupeesFloat = (Number(paise) || 0) / 100;
  return Math.floor(rupeesFloat + 0.5);
}

// ---------------------------------------------------------------------------
// makeInvoiceNumber — human-readable invoice ID
// ---------------------------------------------------------------------------
function makeInvoiceNumber(id) {
  const y = new Date().getFullYear();
  return `INV-${y}-${String(id).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// getFareTable — exposes full table (used by quote API & Flutter sync)
// ---------------------------------------------------------------------------
function getFareTable() {
  return FARE_TABLE;
}

// ---------------------------------------------------------------------------
module.exports = {
  isGstApplicable,
  isEvVehicle,
  computeBaseFareINR,
  computeGstPaise,
  roundedRupeesFromPaise,
  makeInvoiceNumber,
  getFareTable,
};

