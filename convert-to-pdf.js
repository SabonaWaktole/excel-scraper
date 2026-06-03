const fs = require('fs');
const path = require('path');
const playwright = require('playwright');

// Helper to scan directory recursively
function getTxtFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      getTxtFiles(filePath, fileList);
    } else if (filePath.endsWith('.txt')) {
      // Exclude generic link/meta files if desired, e.g. "link.txt" or "video-links.txt"
      const name = path.basename(filePath).toLowerCase();
      if (!name.includes('link') && !name.includes('video')) {
        fileList.push(filePath);
      }
    }
  }
  return fileList;
}

// Convert plain text to beautiful HTML
function textToHtml(title, text) {
  const lines = text.split('\n');
  let bodyHtml = '';
  let inParagraph = false;

  for (let line of lines) {
    line = line.trim();
    if (!line) {
      if (inParagraph) {
        bodyHtml += '</p>\n';
        inParagraph = false;
      }
      continue;
    }

    // Heuristics to identify headers:
    // 1. Short lines (less than 60 chars) that are likely headings
    // 2. Lines that don't end with a period
    const looksLikeHeading = line.length < 60 && !line.endsWith('.') && !line.includes(':') && !line.includes(',') && !line.includes(';');

    if (looksLikeHeading) {
      if (inParagraph) {
        bodyHtml += '</p>\n';
        inParagraph = false;
      }
      bodyHtml += `<h2>${line}</h2>\n`;
    } else {
      if (!inParagraph) {
        bodyHtml += '<p>';
        inParagraph = true;
      } else {
        bodyHtml += ' '; // join lines within a paragraph
      }
      bodyHtml += line;
    }
  }
  if (inParagraph) {
    bodyHtml += '</p>\n';
  }

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
    
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #1f2937;
      line-height: 1.6;
      font-size: 11pt;
      margin: 0;
      padding: 0;
      background-color: #ffffff;
    }
    
    .container {
      max-width: 800px;
      margin: 0 auto;
    }

    h1 {
      font-size: 24pt;
      font-weight: 700;
      color: #111827;
      margin-top: 0;
      margin-bottom: 24px;
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 12px;
    }

    h2 {
      font-size: 16pt;
      font-weight: 600;
      color: #111827;
      margin-top: 28px;
      margin-bottom: 12px;
      page-break-after: avoid;
    }

    p {
      margin-top: 0;
      margin-bottom: 16px;
      text-align: justify;
      color: #374151;
    }

    /* Print styling to ensure high quality output */
    @media print {
      body {
        font-size: 10.5pt;
      }
      h2 {
        page-break-after: avoid;
      }
      p {
        orphans: 3;
        widows: 3;
      }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    ${bodyHtml}
  </div>
</body>
</html>
  `;
}

async function convertAll() {
  const outputDir = path.join(__dirname, 'output');
  console.log(`Scanning directory: ${outputDir}`);
  const txtFiles = getTxtFiles(outputDir);
  
  if (txtFiles.length === 0) {
    console.log('No text files found to convert.');
    return;
  }

  console.log(`Found ${txtFiles.length} files to convert. Launching browser...`);
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  for (let i = 0; i < txtFiles.length; i++) {
    const txtPath = txtFiles[i];
    let pdfPath = txtPath.replace(/\.txt$/, '.pdf');
    
    // Extract a nice title from the filename
    const filename = path.basename(txtPath, '.txt');
    // Remove the prefix numbers and replace underscores/dashes with spaces
    const cleanTitle = filename
      .replace(/^\d+_/g, '')
      .replace(/__/g, ': ')
      .replace(/[_-]/g, ' ')
      .trim();

    console.log(`[${i + 1}/${txtFiles.length}] Converting: ${path.basename(txtPath)}`);

    try {
      const text = fs.readFileSync(txtPath, 'utf8');
      
      // If content has a video url, just rename the txt file and skip PDF conversion
      if (text.toLowerCase().includes('video url')) {
        const dir = path.dirname(txtPath);
        const base = path.basename(txtPath, '.txt');
        if (!base.toLowerCase().includes('video')) {
          const newTxtPath = path.join(dir, `${base}-video.txt`);
          fs.renameSync(txtPath, newTxtPath);
          console.log(`Skipped PDF conversion for ${base}.txt (contains video URL). Renamed to ${path.basename(newTxtPath)}`);
        } else {
          console.log(`Skipped PDF conversion for ${base}.txt (contains video URL).`);
        }
        continue;
      }

      const htmlContent = textToHtml(cleanTitle, text);

      // Set the page content
      await page.setContent(htmlContent);
      
      // Save as PDF with beautiful styling and standard margins
      await page.pdf({
        path: pdfPath,
        format: 'A4',
        margin: {
          top: '60px',
          right: '60px',
          bottom: '60px',
          left: '60px'
        },
        printBackground: true
      });
      
      // Remove the old .txt file after successful conversion
      fs.unlinkSync(txtPath);
    } catch (err) {
      console.error(`Failed to convert ${path.basename(txtPath)}:`, err.message);
    }
  }

  await browser.close();
  console.log('\nAll files converted successfully to premium PDFs!');
}

convertAll();
