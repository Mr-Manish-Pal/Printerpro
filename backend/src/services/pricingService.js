const db = require('../config/db');

/**
 * Retrieves the current rate card from the SQLite database.
 * @returns {object} Rate configuration
 */
function getActiveRates() {
  const rates = db.prepare('SELECT * FROM rates WHERE id = 1').get();
  if (!rates) {
    throw new Error('Pricing rates not initialized in database.');
  }
  return rates;
}

/**
 * Calculates itemized pricing for a set of file options.
 * This is the SINGLE SOURCE OF TRUTH for pricing on the server.
 *
 * @param {Array<{
 *   tempFileId: string,
 *   rawPageCount: number,
 *   pageRange: string,
 *   effectivePages: number,
 *   copies: number,
 *   colorMode: 'mono'|'color',
 *   sides: 'one-sided'|'two-sided-long-edge'
 * }>} fileItems
 * @returns {object} Full itemized breakdown and total
 */
function calculateOrderPricing(fileItems) {
  const rates = getActiveRates();

  let subtotal = 0;
  const itemizedFiles = [];

  for (const item of fileItems) {
    const copies = Math.max(1, parseInt(item.copies, 10) || 1);
    const effectivePages = Math.max(1, parseInt(item.effectivePages, 10) || 1);
    const isColor = item.colorMode === 'color';
    const isDuplex = item.sides === 'two-sided-long-edge';

    const pageRate = isColor ? rates.color_per_page : rates.bw_per_page;
    const grossPageCost = effectivePages * pageRate;

    // Duplex discount calculation: 1 discount per 2-page sheet pair
    const duplexSheets = isDuplex ? Math.floor(effectivePages / 2) : 0;
    const duplexDiscountPerCopy = duplexSheets * rates.duplex_discount_per_sheet;

    const singleCopyCost = Math.max(0, grossPageCost - duplexDiscountPerCopy);
    const fileTotal = parseFloat((singleCopyCost * copies).toFixed(2));

    subtotal += fileTotal;

    itemizedFiles.push({
      tempFileId: item.tempFileId,
      effectivePages,
      copies,
      colorMode: item.colorMode,
      sides: item.sides,
      pageRate,
      grossCost: parseFloat((grossPageCost * copies).toFixed(2)),
      duplexDiscount: parseFloat((duplexDiscountPerCopy * copies).toFixed(2)),
      fileTotal
    });
  }

  subtotal = parseFloat(subtotal.toFixed(2));
  const serviceCharge = parseFloat((rates.service_charge || 0).toFixed(2));
  const rawTotal = parseFloat((subtotal + serviceCharge).toFixed(2));

  // Enforce minimum order threshold
  const minOrderAmount = parseFloat((rates.min_order_amount || 0).toFixed(2));
  const finalTotal = Math.max(minOrderAmount, rawTotal);
  const minOrderAdjustment = parseFloat((finalTotal - rawTotal).toFixed(2));

  return {
    rates: {
      bwPerPage: rates.bw_per_page,
      colorPerPage: rates.color_per_page,
      duplexDiscountPerSheet: rates.duplex_discount_per_sheet,
      minOrderAmount: rates.min_order_amount,
      serviceCharge: rates.service_charge
    },
    items: itemizedFiles,
    subtotal,
    serviceCharge,
    minOrderAdjustment,
    totalAmount: parseFloat(finalTotal.toFixed(2))
  };
}

module.exports = {
  getActiveRates,
  calculateOrderPricing
};

