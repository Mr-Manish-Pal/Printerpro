const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { convertToPdf } = require('../services/converterService');
const { getPageCount } = require('../services/pdfService');

/**
 * Handles multi-file upload, format conversion to PDF, and page count detection.
 */
async function handleUpload(req, res, next) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files uploaded. Please select at least one document or image.'
      });
    }

    const processedFiles = [];

    for (const file of req.files) {
      try {
        // Step 1: Convert file to standardized PDF (native for images/PDFs, LibreOffice for office docs)
        const { storedPdfFilename, convertedPdfPath } = await convertToPdf(file.path, file.originalname);

        // Step 2: Read PDF page count accurately
        const pageCount = await getPageCount(convertedPdfPath);

        // Step 3: Assign a unique temporary session identifier
        const tempFileId = uuidv4();

        // Step 4: Record in order_files table (order_id will be bound when payment/order is created)
        const stmt = db.prepare(`
          INSERT INTO order_files (
            temp_file_id,
            original_filename,
            stored_pdf_filename,
            file_type,
            raw_page_count,
            page_range,
            effective_pages,
            copies,
            color_mode,
            sides,
            paper_size,
            orientation,
            file_subtotal
          ) VALUES (?, ?, ?, ?, ?, 'all', ?, 1, 'mono', 'one-sided', 'A4', 'portrait', 0.0)
        `);

        stmt.run(
          tempFileId,
          file.originalname,
          storedPdfFilename,
          file.mimetype || 'application/octet-stream',
          pageCount,
          pageCount
        );

        // Clean up the raw upload file if it was converted to a separate stored PDF
        if (file.path !== convertedPdfPath && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }

        processedFiles.push({
          tempFileId,
          originalFilename: file.originalname,
          storedPdfFilename,
          rawPageCount: pageCount,
          effectivePages: pageCount,
          pageRange: 'all',
          copies: 1,
          colorMode: 'mono',
          sides: 'one-sided',
          paperSize: 'A4',
          orientation: 'portrait'
        });
      } catch (fileErr) {
        // Clean up failed file
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(500).json({
          success: false,
          error: `Failed to process "${file.originalname}": ${fileErr.message}`
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: `Successfully processed ${processedFiles.length} file(s).`,
      files: processedFiles
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  handleUpload
};

