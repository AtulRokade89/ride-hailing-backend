// utils/money.js

function paiseToRupeesNumber(paise) {
  if (paise == null) return 0;
  return Number(paise) / 100; // e.g. 16185 -> 161.85
}

function paiseToRupeesString(paise) {
  return `₹${paiseToRupeesNumber(paise).toFixed(2)}`; // "₹161.85"
}

function paiseToRoundedRupees(paise) {
  // .50 rounds up
  return Math.round((Number(paise) || 0) / 100); // 161.49->161, 161.50->162
}

module.exports = {
  paiseToRupeesNumber,
  paiseToRupeesString,
  paiseToRoundedRupees,
};
