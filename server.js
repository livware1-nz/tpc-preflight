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
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  }
});

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'preflight@theprintcompany.co.nz';
const SESSION_SECRET = process.env.SESSION_SECRET || 'tpc-preflight-secret-2024';
const APP_USERNAME = process.env.APP_USERNAME || 'tpc';
const APP_PASSWORD = process.env.APP_PASSWORD || 'printready2024';

console.log('Starting server...');
console.log('ANTHROPIC_API_KEY set:', !!ANTHROPIC_API_KEY);
console.log('SENDGRID_API_KEY set:', !!SENDGRID_API_KEY);

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

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

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });
app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/preflight', requireAuth, upload.single('pdf'), async (req, res) => {
  console.log('--- Preflight request received ---');
  
  if (!req.file) {
    console.log('ERROR: No file uploaded');
    return res.status(400).json({ error: 'No PDF uploaded' });
  }

  console.log('File received:', req.file.originalname, req.file.size, 'bytes');
  
  const filePath = req.file.path;
  const originalName = req.file.originalname;
  const salesEmail = req.body.email;

  // Set a response timeout of 55 seconds
  res.setTimeout(55000, () => {
    console.log('ERROR: Request timed out');
    res.status(504).json({ error: 'Analysis timed out — try a smaller file' });
  });

  try {
    console.log('Step 1: Running PDF analysis...');
    const analysis = await analyzePDF(filePath, originalName);
    console.log('Step 1 complete. Pages:', analysis.pageCount, 'Images:', analysis.imageCount);
    
    console.log('Step 2: Generating Claude report...');
    const report = await generateReport(analysis, originalName);
    console.log('Step 2 complete. Report length:', report.length);

    if (salesEmail && SENDGRID_API_KEY) {
      console.log('Step 3: Sending email to', salesEmail);
      try {
        await sendReportEmail(salesEmail, originalName, report);
        console.log('Step 3 complete: Email sent');
      } catch (emailErr) {
        console.error('Step 3 ERROR - Email failed:', emailErr.message);
        // Don't fail the whole request if email fails
      }
    }

    fs.unlink(filePath, () => {});
    console.log('--- Preflight complete ---');

    res.json({ 
      success: true, 
      report,
      analysis,
      emailSent: !!(salesEmail && SENDGRID_API_KEY)
    });

  } catch (err) {
    fs.unlink(filePath, () => {});
    console.error('PREFLIGHT FAILED:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

async function runCmd(cmd, label) {
  console.log(`Running ${label}...`);
  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 20000 });
    console.log(`${label} complete`);
    return stdout;
  } catch (e) {
    console.error(`${label} failed:`, e.message);
    return '';
  }
}

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

  // pdfinfo
  const pdfinfo = await runCmd(`pdfinfo "${filePath}" 2>/dev/null || true`, 'pdfinfo');
  const pageMatch = pdfinfo.match(/Pages:\s+(\d+)/);
  if (pageMatch) results.pageCount = parseInt(pageMatch[1]);
  const sizeMatch = pdfinfo.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
  if (sizeMatch) {
    results.pageWidthPt = parseFloat(sizeMatch[1]);
    results.pageHeightPt = parseFloat(sizeMatch[2]);
    results.pageWidthMm = Math.round(results.pageWidthPt * 0.352778 * 10) / 10;
    results.pageHeightMm = Math.round(results.pageHeightPt * 0.352778 * 10) / 10;
  }

  // pdfimages
  const imageList = await runCmd(`pdfimages -list "${filePath}" 2>/dev/null || true`, 'pdfimages');
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
      results.images.push({ width, height, xppi, yppi, colorspace });
      if (colorspace.toLowerCase().includes('rgb') || colorspace === 'srgb') {
        if (!results.colorSpaces.includes('RGB')) results.colorSpaces.push('RGB');
      }
      if (colorspace.toLowerCase().includes('cmyk')) {
        if (!results.colorSpaces.includes('CMYK')) results.colorSpaces.push('CMYK');
      }
      const effectiveDpi = Math.min(xppi, yppi);
      if (effectiveDpi > 0 && effectiveDpi < 150) {
        lowResCount++;
        results.errors.push(`Low resolution image: ${effectiveDpi} DPI (300 DPI required)`);
      } else if (effectiveDpi >= 150 && effectiveDpi < 250) {
        results.warnings.push(`Borderline resolution: ${effectiveDpi} DPI (300 DPI recommended)`);
      }
    }
  }
  results.imageCount = results.images.length;
  results.lowResCount = lowResCount;

  // pdffonts
  const fontList = await runCmd(`pdffonts "${filePath}" 2>/dev/null || true`, 'pdffonts');
  const fontLines = fontList.split('\n').slice(2).filter(l => l.trim());
  for (const line of fontLines) {
    const parts = line.trim().split(/\s{2,}/);
    if (parts.length >= 4) {
      const fontName = parts[0];
      const embedded = line.includes('yes');
      results.fonts.push({ name: fontName, embedded });
      if (!embedded) results.errors.push(`Font not embedded: "${fontName}"`);
    }
  }
  results.fontCount = results.fonts.length;

  // Bleed estimate from page size
  if (results.pageWidthMm && results.pageHeightMm) {
    results.bleedEstimate = estimateBleed(results.pageWidthMm, results.pageHeightMm);
  }

  return results;
}

function estimateBleed(widthMm, heightMm) {
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
    if (Math.abs(widthMm - std.w) < TOLERANCE && Math.abs(heightMm - std.h) < TOLERANCE) {
      return { matchedSize: std.name, hasBleed: false, bleedMm: 0, note: `Matches ${std.name} exactly — no bleed detected` };
    }
    if (Math.abs(widthMm - (std.w + BLEED * 2)) < TOLERANCE && Math.abs(heightMm - (std.h + BLEED * 2)) < TOLERANCE) {
      return { matchedSize: std.name, hasBleed: true, bleedMm: 3, note: `${std.name} with 3mm bleed ✓` };
    }
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
2. File Summary (pages, page dimensions)
3. Colour Mode check (RGB vs CMYK — flag RGB as a warning, CMYK preferred for print)
4. Resolution check (300 DPI minimum — flag anything under 300)
5. Bleed check (3mm standard — flag if missing or insufficient)
6. Fonts check (all fonts must be embedded)
7. Issues Found (list errors clearly)
8. Recommended Action (one clear sentence)

Keep language plain and professional. No jargon.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    messages: [{ role: 'user', content: prompt }]
  });

  return response.content[0].text;
}

async function sendReportEmail(toEmail, filename, report) {
  const html = `<div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
    <div style="background: #1a1a1a; padding: 24px; border-radius: 8px 8px 0 0;">
      <h1 style="color: white; margin: 0; font-size: 20px;">Print Preflight Report</h1>
      <p style="color: #999; margin: 4px 0 0; font-size: 14px;">${filename}</p>
    </div>
    <div style="background: #f8f8f8; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e0e0e0; border-top: none;">
      <pre style="white-space: pre-wrap; font-family: Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #333;">${report}</pre>
      <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 24px 0;">
      <p style="color: #999; font-size: 12px; margin: 0;">Generated by The Print Company Preflight System · ${new Date().toLocaleString('en-NZ')}</p>
    </div>
  </div>`;

  await sgMail.send({
    to: toEmail,
    from: FROM_EMAIL,
    subject: `Preflight Report — ${filename}`,
    html,
    text: report
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Preflight server running on port ${PORT}`));
