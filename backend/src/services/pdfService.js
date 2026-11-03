const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/**
 * Reads a PDF file and returns the total number of pages.
 * @param {string} pdfFilePath - Absolute path to the PDF file
 * @returns {Promise<number>}
 */
async function getPageCount(pdfFilePath) {
  try {
    const fileBytes = fs.readFileSync(pdfFilePath);
    const pdfDoc = await PDFDocument.load(fileBytes, {
      ignoreEncryption: true,
      parseSpeed: 1
    });
    return pdfDoc.getPageCount();
  } catch (error) {
    throw new Error(`Failed to read PDF page count: ${error.message}`);
  }
}

/**
 * Parses and validates a page range string (e.g. "1-3,5", "all", "2").
 * Returns an object with:
 *  - isValid: boolean
 *  - error: string|null
 *  - pages: number[] (unique list of selected 1-based page numbers)
 *  - effectiveCount: number (how many pages will be printed)
 *  - normalizedRange: string (clean formatted range string for CUPS -o page-ranges)
 *
 * @param {string} rangeStr - The raw range string entered by user
 * @param {number} totalPages - Total pages available in document
 */
function parsePageRange(rangeStr, totalPages) {
  if (!rangeStr || rangeStr.trim().toLowerCase() === 'all') {
    return {
      isValid: true,
      error: null,
      pages: Array.from({ length: totalPages }, (_, i) => i + 1),
      effectiveCount: totalPages,
      normalizedRange: 'all'
    };
  }

  const cleanStr = rangeStr.replace(/\s+/g, '');
  // Validate basic format: numbers, commas, and hyphens only
  if (!/^([0-9]+(-[0-9]+)?)(,[0-9]+(-[0-9]+)?)*$/.test(cleanStr)) {
    return {
      isValid: false,
      error: 'Invalid page range format. Example formats: "1-3,5", "2", or "all".',
      pages: [],
      effectiveCount: 0,
      normalizedRange: ''
    };
  }

  const parts = cleanStr.split(',');
  const selectedPages = new Set();

  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);

      if (isNaN(start) || isNaN(end) || start < 1 || end < start) {
        return {
          isValid: false,
          error: `Invalid range interval "${part}". Start must be >= 1 and end >= start.`,
          pages: [],
          effectiveCount: 0,
          normalizedRange: ''
        };
      }

      if (end > totalPages) {
        return {
          isValid: false,
          error: `Page range "${part}" exceeds total document pages (${totalPages}).`,
          pages: [],
          effectiveCount: 0,
          normalizedRange: ''
        };
      }

      for (let p = start; p <= end; p++) {
        selectedPages.add(p);
      }
    } else {
      const pageNum = parseInt(part, 10);
      if (isNaN(pageNum) || pageNum < 1) {
        return {
          isValid: false,
          error: `Invalid page number "${part}".`,
          pages: [],
          effectiveCount: 0,
          normalizedRange: ''
        };
      }

      if (pageNum > totalPages) {
        return {
          isValid: false,
          error: `Page ${pageNum} exceeds total document pages (${totalPages}).`,
          pages: [],
          effectiveCount: 0,
          normalizedRange: ''
        };
      }

      selectedPages.add(pageNum);
    }
  }

  const sortedPages = Array.from(selectedPages).sort((a, b) => a - b);
  if (sortedPages.length === 0) {
    return {
      isValid: false,
      error: 'No pages selected in the specified range.',
      pages: [],
      effectiveCount: 0,
      normalizedRange: ''
    };
  }

  return {
    isValid: true,
    error: null,
    pages: sortedPages,
    effectiveCount: sortedPages.length,
    normalizedRange: cleanStr
  };
}

module.exports = {
  getPageCount,
  parsePageRange
};

