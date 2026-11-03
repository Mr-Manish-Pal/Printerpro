const db = require('../config/db');
const { getActiveRates, calculateOrderPricing } = require('../services/pricingService');
const { parsePageRange } = require('../services/pdfService');

/**
 * Returns current rates for display on mobile UI
 */
function getRates(req, res, next) {
  try {
    const rates = getActiveRates();
    return res.status(200).json({
      success: true,
      rates: {
        bwPerPage: rates.bw_per_page,
        colorPerPage: rates.color_per_page,
        duplexDiscountPerSheet: rates.duplex_discount_per_sheet,
        minOrderAmount: rates.min_order_amount,
        serviceCharge: rates.service_charge
      }
    });
  } catch (error) {
    next(error);
  }
}

/**
 * Calculates a verified, authoritative price quote for a list of files and chosen options.
 */
function calculateQuote(req, res, next) {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "items" array in request body.'
      });
    }

    const verifiedItems = [];

    for (const item of items) {
      if (!item.tempFileId) {
        return res.status(400).json({
          success: false,
          error: 'Each item must include a valid "tempFileId".'
        });
      }

      // Look up authentic document metadata in SQLite
      const fileRecord = db.prepare('SELECT * FROM order_files WHERE temp_file_id = ?').get(item.tempFileId);

      if (!fileRecord) {
        return res.status(404).json({
          success: false,
          error: `File reference "${item.tempFileId}" not found or expired.`
        });
      }

      // Validate & compute effective page count from user's pageRange
      const rangeResult = parsePageRange(item.pageRange, fileRecord.raw_page_count);
      if (!rangeResult.isValid) {
        return res.status(400).json({
          success: false,
          error: `Error in file "${fileRecord.original_filename}": ${rangeResult.error}`
        });
      }

      const copies = Math.max(1, parseInt(item.copies, 10) || 1);
      const colorMode = item.colorMode === 'color' ? 'color' : 'mono';
      const sides = item.sides === 'two-sided-long-edge' ? 'two-sided-long-edge' : 'one-sided';
      const paperSize = ['Letter', 'Legal'].includes(item.paperSize) ? item.paperSize : 'A4';
      const orientation = item.orientation === 'landscape' ? 'landscape' : 'portrait';

      verifiedItems.push({
        tempFileId: item.tempFileId,
        filename: fileRecord.original_filename,
        rawPageCount: fileRecord.raw_page_count,
        effectivePages: rangeResult.effectiveCount,
        normalizedRange: rangeResult.normalizedRange,
        copies,
        colorMode,
        sides,
        paperSize,
        orientation
      });
    }

    // Server-side recalculation
    const quote = calculateOrderPricing(verifiedItems);

    return res.status(200).json({
      success: true,
      quote
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getRates,
  calculateQuote
};

