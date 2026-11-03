const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const FileType = require('file-type');
const config = require('../config/env');

// Ensure upload directory exists
if (!fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

// Whitelist of supported extensions
const ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.docx', '.doc',
  '.pptx', '.ppt',
  '.xlsx', '.xls',
  '.jpg', '.jpeg', '.png',
  '.txt'
]);

// Whitelist of verified MIME types
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
  'image/jpeg',
  'image/png',
  'application/zip' // docx, pptx, xlsx are internally zip containers
]);

// Multer storage with randomized filenames
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const safeFilename = `${uuidv4()}${ext}`;
    cb(null, safeFilename);
  }
});

// Initial filter by file extension
const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    const err = new Error(`Unsupported file extension "${ext}". Allowed: PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, JPG, PNG, TXT.`);
    err.status = 400;
    cb(err, false);
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: config.maxFileSizeMB * 1024 * 1024, // e.g. 25MB
    files: 10 // Max 10 files per request
  },
  fileFilter
});

/**
 * Middleware: Verifies the real file signature (magic bytes) using file-type
 * Prevents disguised executables or corrupt files from passing.
 */
async function verifyMagicBytes(req, res, next) {
  if (!req.files || req.files.length === 0) {
    return next();
  }

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();

    // Plain text files have no binary magic bytes
    if (ext === '.txt') {
      try {
        const buffer = fs.readFileSync(file.path, { encoding: 'utf8', flag: 'r' });
        // Check for binary null bytes that indicate a non-text binary
        if (buffer.includes('\0')) {
          fs.unlinkSync(file.path);
          return res.status(400).json({
            success: false,
            error: `File "${file.originalname}" is not a valid text document.`
          });
        }
      } catch (err) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          error: `Error reading text file "${file.originalname}".`
        });
      }
      continue;
    }

    // Binary file type inspection
    try {
      const type = await FileType.fromFile(file.path);

      if (!type) {
        // Some older legacy OLE Microsoft Office docs (.doc, .ppt, .xls) might be detected as generic application/x-cfb
        if (['.doc', '.ppt', '.xls'].includes(ext)) {
          // Allow legacy office if extension matches
          continue;
        }

        fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          error: `File "${file.originalname}" failed signature verification. The file content does not match its extension.`
        });
      }

      // Check against allowed MIME types
      if (!ALLOWED_MIME_TYPES.has(type.mime)) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          error: `File "${file.originalname}" is detected as "${type.mime}", which is not allowed.`
        });
      }
    } catch (err) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        error: `Failed to inspect file "${file.originalname}": ${err.message}`
      });
    }
  }

  next();
}

module.exports = {
  upload,
  verifyMagicBytes
};

