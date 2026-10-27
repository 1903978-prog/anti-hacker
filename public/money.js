/* global module */
// Costs above this many US dollars get a red oval on the Usage tab.
const COST_ALERT_USD = 2;
const isBigCost = (n) => Number(n) > COST_ALERT_USD;
if (typeof module !== "undefined") module.exports = { COST_ALERT_USD, isBigCost };
