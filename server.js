const express = require('express');
const multer = require('multer');
const session = require('express-session');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const sgMail = require('@sendgrid/mail');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const upload = multer({ 
  dest: 'uploads/',
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  }
});

// Config
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'preflight@theprintcompany.co.nz';
const SESSION_SECRET = process.env.SESSION_SECRET || 'tpc-preflight-secret-2024';
const APP_USERNAME = process.env.APP_USERNAME || 'tpc';
const APP_PASSWORD = process.env.APP_PASSWORD || 'printready2024';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 hours
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

// Routes
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === APP_USERNAME && password === APP_PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Main preflight endpoint
app.post('/preflight', requireAuth, upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF uploaded' });

  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const salesEmail = req.body.email;

  try {
    // Run PDF analysis
    const analysis = await analyzePDF(filePath, originalName);
    
    // Get Claude to write the report
    const report = await generateReport(analysis, originalName);
    
    // Send email if address provided
    if (salesEmail && SENDGRID_API_KEY) {
      await sendReportEmail(salesEmail, originalName, report);
    }

    // Cleanup
    fs.unlink(filePath, () => {});

    res.json({ 
      success: true, 
      report,
      analysis,
      emailSent: !!(salesEmail && SENDGRID_API_KEY)
    });

  } catch (err) {
    fs.unlink(filePath, () => {});
    console.error('Preflight error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

async function analyzePDF(filePath, filename) {
  const results = {
    filename,
    timestamp: new Date().toISOString(),
    pageCount: null,
    pages: [],
    fonts: [],
    colorSpaces: [],
    hasTransparency: false,
    errors: [],
    warnings: []
  };

  // Get page count and basic info via pdfinfo
  try {
    const { stdout: pdfinfo } = await execAsync(`pdfinfo "${filePath}" 2>/dev/null || true`);
    const pageMatch = pdfinfo.match(/Pages:\s+(\d+)/);
    if (pageMatch) results.pageCount = parseInt(pageMatch[1]);
    
    const sizeMatch = pdfinfo.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
    if (sizeMatch) {
      results.pageWidthPt = parseFloat(sizeMatch[1]);
      results.pageHeightPt = parseFloat(sizeMatch[2]);
      results.pageWidthMm = Math.round(results.pageWidthPt * 0.352778 * 10) / 10;
      results.pageHeightMm = Math.round(results.pageHeightPt * 0.352778 * 10) / 10;
    }
  } catch (e) {
    results.warnings.push('Could not read PDF info');
  }

  // Extract images and check resolution via pdfimages
  try {
    const { stdout: imageList } = await execAsync(`pdfimages -list "${filePath}" 2>/dev/null || true`);
    const lines = imageList.split('\n').filter(l => l.match(/^\s+\d+/));
    
    results.images = [];
    let lowResCount = 0;

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 9) {
        const width = parseInt(parts[3]);
        const height = parseInt(parts[4]);
        const xppi = parseInt(parts[12]) || parseInt(parts[11]) || 0;
        const yppi = parseInt(parts[13]) || parseInt(parts[12]) || 0;
        const colorspace = parts[6] || 'unknown';
        
        const imgInfo = { width, height, xppi, yppi, colorspace };
        results.images.push(imgInfo);

        if (colorspace && (colorspace.toLowerCase().includes('rgb') || colorspace === 'srgb')) {
          if (!results.colorSpaces.includes('RGB')) results.colorSpaces.push('RGB');
        }
        if (colorspace && colorspace.toLowerCase().includes('cmyk')) {
          if (!results.colorSpaces.includes('CMYK')) results.colorSpaces.push('CMYK');
        }

        const effectiveDpi = Math.min(xppi, yppi);
        if (effectiveDpi > 0 && effectiveDpi < 150) {
          lowResCount++;
          results.errors.push(`Low resolution image detected: ${effectiveDpi} DPI (minimum 300 DPI required)`);
        } else if (effectiveDpi >= 150 && effectiveDpi < 250) {
          results.warnings.push(`Borderline resolution image: ${effectiveDpi} DPI (300 DPI recommended)`);
        }
      }
    }

    results.imageCount = results.images.length;
    results.lowResCount = lowResCount;

  } catch (e) {
    results.warnings.push('Could not analyse embedded images');
  }

  // Check fonts via pdffonts
  try {
    const { stdout: fontList } = await execAsync(`pdffonts "${filePath}" 2>/dev/null || true`);
    const fontLines = fontList.split('\n').slice(2).filter(l => l.trim());
    
    for (const line of fontLines) {
      const parts = line.trim().split(/\s{2,}/);
      if (parts.length >= 4) {
        const fontName = parts[0];
        const embedded = line.includes('yes');
        const subset = parts[3] === 'yes';
        
        results.fonts.push({ name: fontName, embedded, subset });
        
        if (!embedded) {
          results.errors.push(`Font not embedded: "${fontName}" — text may reflow or substitute on press`);
        }
      }
    }
    results.fontCount = results.fonts.length;

  } catch (e) {
    results.warnings.push('Could not analyse fonts');
  }

  // Check bleed using Ghostscript — look at MediaBox vs BleedBox/TrimBox
  try {
    const gsCmd = `gs -dNOPAUSE -dBATCH -dNODISPLAY -sFile="${filePath}" -c "
      (${filePath}) (r) file runpdfbegin
      1 pdfgetpage /MediaBox get == 
      1 pdfgetpage /BleedBox knownoget { == } { (no bleedbox) = } ifelse
      1 pdfgetpage /TrimBox knownoget { == } { (no trimbox) = } ifelse
    " 2>/dev/null || true`;
    
    const { stdout: gsOut } = await execAsync(gsCmd);
    
    results.hasBleedBox = gsOut.includes('[') && !gsOut.includes('no bleedbox');
    results.hasTrimBox = !gsOut.includes('no trimbox');
    
    // Check if bleed is adequate (3mm = ~8.5pt)
    if (!results.hasBleedBox) {
      results.warnings.push('No BleedBox defined in PDF — bleed cannot be verified from PDF metadata');
    }

  } catch (e) {
    // Fallback: estimate bleed from page size
    results.warnings.push('Could not verify bleed box from PDF metadata');
  }

  // Estimate bleed from page dimensions against standard sizes
  if (results.pageWidthMm && results.pageHeightMm) {
    results.bleedEstimate = estimateBleed(results.pageWidthMm, results.pageHeightMm);
  }

  // Check for transparency using Ghostscript
  try {
    const { stdout: transCheck } = await execAsync(
      `gs -dNOPAUSE -dBATCH -sDEVICE=bbox "${filePath}" 2>&1 | grep -i "transparency\|blend\|alpha" | head -5 || true`
    );
    results.hasTransparency = transCheck.length > 10;
  } catch (e) {}

  return results;
}

function estimateBleed(widthMm, heightMm) {
  // Standard sizes with 3mm bleed
  const standards = [
    { name: 'A4', w: 210, h: 297 },
    { name: 'A5', w: 148, h: 210 },
    { name: 'A4 Landscape', w: 297, h: 210 },
    { name: 'A5 Landscape', w: 210, h: 148 },
    { name: 'DL', w: 99, h: 210 },
    { name: 'Business Card', w: 90, h: 55 },
    { name: 'A3', w: 297, h: 420 },
    { name: 'A6', w: 105, h: 148 },
  ];

  const BLEED = 3;
  const TOLERANCE = 2;

  for (const std of standards) {
    // Check exact
    if (Math.abs(widthMm - std.w) < TOLERANCE && Math.abs(heightMm - std.h) < TOLERANCE) {
      return { matchedSize: std.name, hasBleed: false, bleedMm: 0, note: `Matches ${std.name} exactly — no bleed detected` };
    }
    // Check with 3mm bleed on all sides
    if (Math.abs(widthMm - (std.w + BLEED * 2)) < TOLERANCE && Math.abs(heightMm - (std.h + BLEED * 2)) < TOLERANCE) {
      return { matchedSize: std.name, hasBleed: true, bleedMm: 3, note: `${std.name} with 3mm bleed ✓` };
    }
    // Check with other bleed amounts
    for (let b = 1; b <= 6; b++) {
      if (Math.abs(widthMm - (std.w + b * 2)) < TOLERANCE && Math.abs(heightMm - (std.h + b * 2)) < TOLERANCE) {
        return { matchedSize: std.name, hasBleed: true, bleedMm: b, note: `${std.name} with ${b}mm bleed` };
      }
    }
  }

  return { matchedSize: 'Custom/Unknown', hasBleed: null, bleedMm: null, note: `Custom size: ${widthMm} × ${heightMm}mm — verify bleed manually` };
}

async function generateReport(analysis, filename) {
  const prompt = `You are a professional print prepress technician at The Print Company in New Zealand. 
Analyse the following PDF preflight data and write a clear, professional report for a sales person (not a technical expert).

PDF Data:
${JSON.stringify(analysis, null, 2)}

Write a preflight report with:
1. Overall STATUS: PASS, PASS WITH WARNINGS, or FAIL (bold, at the top)
2. File Summary (size, pages, page dimensions)
3. Colour Mode check (RGB vs CMYK — flag RGB as a warning, CMYK preferred for print)
4. Resolution check (300 DPI minimum — flag anything under 300)
5. Bleed check (3mm standard — flag if missing or insufficient)
6. Fonts check (all fonts must be embedded)
7. Issues Found (list errors clearly — what's wrong and what the sales person should tell the client)
8. Recommended Action (one clear sentence: "File is print ready", "Send back to client for X fix", or "Escalate to Pre-Press")

Keep language plain and professional. No jargon the sales team won't understand. Be direct and concise.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

async function sendReportEmail(toEmail, filename, report) {
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
      <div style="background: #1a1a1a; padding: 24px; border-radius: 8px 8px 0 0;">
        <h1 style="color: white; margin: 0; font-size: 20px;">Print Preflight Report</h1>
        <p style="color: #999; margin: 4px 0 0; font-size: 14px;">${filename}</p>
      </div>
      <div style="background: #f8f8f8; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0; border-top: none;">
        <pre style="white-space: pre-wrap; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">${report}</pre>
        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
        <p style="color: #999; font-size: 12px; margin: 0;">Generated by The Print Company Preflight System · ${new Date().toLocaleString('en-NZ')}</p>
      </div>
    </div>
  `;

  await sgMail.send({
    to: toEmail,
    from: FROM_EMAIL,
    subject: `Preflight Report — ${filename}`,
    html,
    text: report
  });
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Preflight server running on port ${PORT}`));
