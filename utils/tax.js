// // utils/tax.js

// // returns true if GST=5% applies for this vehicle
// function isGstApplicable(vehicleType) {
  // if (!vehicleType) return false;
  // const vt = String(vehicleType).trim().toUpperCase();
  // return vt === 'SUV' || vt === 'SEDAN' || vt === 'BIKE';
// }

// // basePaise -> [cgst, sgst] each 2.5%, rounded to nearest paise
// function computeGstPaise(basePaise, vehicleType) {
  // if (!isGstApplicable(vehicleType)) return { cgst: 0, sgst: 0 };

  // // 2.5% each; use paise math to avoid floats
  // const cgst = Math.round(basePaise * 2.5 / 100);
  // const sgst = Math.round(basePaise * 2.5 / 100);
  // return { cgst, sgst };
// }

// // total paise -> rounded rupees (0.50 up)
// function roundedRupeesFromPaise(paise) {
  // return Math.round((Number(paise) || 0) / 100);
// }

// // create a human-readable invoice number; you can swap to a sequence table if you prefer
// function makeInvoiceNumber(id) {
  // const y = new Date().getFullYear();
  // return `INV-${y}-${String(id).padStart(6, '0')}`;
// }

// module.exports = {
  // isGstApplicable,
  // computeGstPaise,
  // roundedRupeesFromPaise,
  // makeInvoiceNumber,
// };



// utils/tax.js

// returns true if GST=5% applies for this vehicle
function isGstApplicable(vehicleType) {
  if (!vehicleType) return false;
  const vt = String(vehicleType).trim().toUpperCase();
  // Updated list for GST applicability (5%): SUV, SEDAN, BIKE, MINI.
  // This implicitly excludes RIKSHAW or any other type not listed.
  return vt === 'SUV' || vt === 'SEDAN' || vt === 'BIKE' || vt === 'MINI';
}

// basePaise -> [cgst, sgst] each 2.5%, rounded to nearest paise
function computeGstPaise(basePaise, vehicleType) {
  if (!isGstApplicable(vehicleType)) return { cgst: 0, sgst: 0 };

  // 2.5% each; calculate in paise and round to nearest paise
  const cgst = Math.round(basePaise * 2.5 / 100);
  const sgst = Math.round(basePaise * 2.5 / 100);
  return { cgst, sgst };
}

/**
 * total paise -> rounded rupees (0.50 up) - Custom half-up implementation
 * This function calculates the final whole rupee amount (rounded_rupees DB column).
 * * Logic: 182.49 -> 182 (rounds down)
 * 182.50 -> 183 (rounds up)
 */
function roundedRupeesFromPaise(paise) {
  // Convert paise to a number in Rupees (e.g., 18249 -> 182.49)
  const rupeesFloat = (Number(paise) || 0) / 100;
  
  // Implements the "round to nearest whole number, where .50 rounds up" rule:
  // Math.floor(x + 0.5)
  return Math.floor(rupeesFloat + 0.5);
}

// create a human-readable invoice number; you can swap to a sequence table if you prefer
function makeInvoiceNumber(id) {
  const y = new Date().getFullYear();
  return `INV-${y}-${String(id).padStart(6, '0')}`;}

module.exports = {
  isGstApplicable,
  computeGstPaise,
  roundedRupeesFromPaise,
  makeInvoiceNumber,
};

