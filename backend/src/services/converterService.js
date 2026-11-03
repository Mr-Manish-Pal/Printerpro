const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const { v4: uuidv4 } = require('uuid');
const config = require('../config/env');

// Ensure destination converted directory exists
if (!fs.existsSync(config.convertedDir)) {
  fs.mkdirSync(config.convertedDir, { recursive: true });
}

/**
 * Converts any supported uploaded file to a standardized PDF.
 * Returns the stored PDF filename located in config.convertedDir.
 *
 * @param {string} inputFilePath - Path to the uploaded raw file
 * @param {string} originalName - Original user-facing filename
 * @returns {Promise<{ storedPdfFilename: string, convertedPdfPath: string }>}
 */
async function convertToPdf(inputFilePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const outputId = uuidv4();
  const storedPdfFilename = `${outputId}.pdf`;
  const convertedPdfPath = path.join(config.convertedDir, storedPdfFilename);

  // Case 1: File is already a PDF
  if (ext === '.pdf') {
    fs.copyFileSync(inputFilePath, convertedPdfPath);
    return { storedPdfFilename, convertedPdfPath };
  }

  // Case 2: Image files (JPG / PNG) -> Fast native PDF generation via pdf-lib
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    return await convertImageToPdf(inputFilePath, convertedPdfPath, storedPdfFilename, ext);
  }

  // Case 3: Office documents & Text files -> LibreOffice Headless (soffice)
  return await convertOfficeToPdf(inputFilePath, convertedPdfPath, storedPdfFilename);
}

/**
 * Converts an image (JPG/PNG) into a high-quality single-page A4 PDF using pdf-lib.
 */
async function convertImageToPdf(inputFilePath, convertedPdfPath, storedPdfFilename, ext) {
  const imageBytes = fs.readFileSync(inputFilePath);
  const pdfDoc = await PDFDocument.create();

  // Standard A4 dimensions in PDF points (72 points per inch)
  const A4_WIDTH = 595.28;
  const A4_HEIGHT = 841.89;

  let image;
  if (ext === '.png') {
    image = await pdfDoc.embedPng(imageBytes);
  } else {
    image = await pdfDoc.embedJpg(imageBytes);
  }

  // Scale image to fit within A4 margins (0.5 inch / 36 pt margin)
  const margin = 36;
  const maxWidth = A4_WIDTH - (margin * 2);
  const maxHeight = A4_HEIGHT - (margin * 2);

  const imgDims = image.scale(1);
  const scale = Math.min(maxWidth / imgDims.width, maxHeight / imgDims.height, 1);
  const scaledWidth = imgDims.width * scale;
  const scaledHeight = imgDims.height * scale;

  // Center on A4 page
  const x = margin + ((maxWidth - scaledWidth) / 2);
  const y = margin + ((maxHeight - scaledHeight) / 2);

  const page = pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  page.drawImage(image, {
    x,
    y,
    width: scaledWidth,
    height: scaledHeight
  });

  const pdfBytes = await pdfDoc.save();
  fs.writeFileSync(convertedPdfPath, pdfBytes);

  return { storedPdfFilename, convertedPdfPath };
}

/**
 * Converts DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT using headless LibreOffice.
 * Isolated user installation environment flag prevents concurrency lockups.
 */
function convertOfficeToPdf(inputFilePath, targetPdfPath, storedPdfFilename) {
  return new Promise((resolve, reject) => {
    // Unique temporary profile folder to avoid locks during concurrent LibreOffice runs
    const tempProfileDir = path.join('/tmp', `soffice_prof_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
    const tempOutputDir = path.join('/tmp', `soffice_out_${Date.now()}_${Math.floor(Math.random() * 10000)}`);

    if (!fs.existsSync(tempOutputDir)) {
      fs.mkdirSync(tempOutputDir, { recursive: true });
    }

    const args = [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', tempOutputDir,
      `-env:UserInstallation=file://${tempProfileDir}`,
      inputFilePath
    ];

    // Execute soffice with 45s timeout
    execFile('soffice', args, { timeout: 45000 }, (error, stdout, stderr) => {
      // Clean up temporary LibreOffice user profile
      try {
        if (fs.existsSync(tempProfileDir)) {
          fs.rmSync(tempProfileDir, { recursive: true, force: true });
        }
      } catch (e) {
        // Ignore cleanup warnings
      }

      if (error) {
        try {
          if (fs.existsSync(tempOutputDir)) fs.rmSync(tempOutputDir, { recursive: true, force: true });
        } catch (e) {}
        return reject(new Error(`LibreOffice conversion failed: ${error.message} (Stderr: ${stderr})`));
      }

      // Identify the generated PDF in tempOutputDir
      const generatedFiles = fs.readdirSync(tempOutputDir).filter(f => f.endsWith('.pdf'));
      if (generatedFiles.length === 0) {
        try {
          if (fs.existsSync(tempOutputDir)) fs.rmSync(tempOutputDir, { recursive: true, force: true });
        } catch (e) {}
        return reject(new Error('LibreOffice conversion succeeded but no PDF output was produced.'));
      }

      const generatedPdfPath = path.join(tempOutputDir, generatedFiles[0]);

      // Move into target location
      fs.copyFileSync(generatedPdfPath, targetPdfPath);

      // Clean up temp output dir
      try {
        fs.rmSync(tempOutputDir, { recursive: true, force: true });
      } catch (e) {}

      resolve({ storedPdfFilename, convertedPdfPath: targetPdfPath });
    });
  });
}

module.exports = {
  convertToPdf
};

