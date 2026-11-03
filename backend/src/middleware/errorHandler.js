const multer = require('multer');

/**
 * Centralized application error handling middleware.
 */
function errorHandler(err, req, res, next) {
  console.error('[Error]', err.stack || err.message);

  // Handle Multer upload errors
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum allowed size is 25 MB per file.'
      });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({
        success: false,
        error: 'Too many files uploaded at once. Maximum allowed is 10 files.'
      });
    }
    return res.status(400).json({
      success: false,
      error: `Upload error: ${err.message}`
    });
  }

  // Handle custom status errors
  const status = err.status || 500;
  const message = err.message || 'An unexpected internal server error occurred.';

  return res.status(status).json({
    success: false,
    error: message
  });
}

module.exports = errorHandler;

