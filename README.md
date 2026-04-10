# TPC Preflight Tool — Deployment Guide

## What this is
A web app for The Print Company sales team to check client PDF files before sending to Pre-Press.
- Upload PDF → get instant preflight report → emailed to sales person
- Checks: resolution, colour mode, bleed, font embedding, page size

---

## Setup: Step by Step

### Step 1 — Get your API keys

**Anthropic (Claude)**
1. Go to console.anthropic.com
2. Create an account / log in
3. Go to API Keys → Create Key
4. Copy it — you'll need it in Step 3


---

### Step 2 — Put code on GitHub

1. Create a free GitHub account at github.com if you don't have one
2. Create a new repository called `tpc-preflight`
3. Upload all these files to the repo (or use git if you know how)

---

### Step 3 — Deploy to Render

1. Go to render.com → sign up free
2. Click **New** → **Web Service**
3. Connect your GitHub account → select `tpc-preflight` repo
4. Configure:
   - **Name:** tpc-preflight
   - **Region:** Singapore (closest to NZ)
   - **Runtime:** Node
   - **Build Command:** `apt-get update && apt-get install -y ghostscript poppler-utils && npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Starter ($7 USD/month)

5. Add Environment Variables (click "Environment"):
   ```
   ANTHROPIC_API_KEY    = [your Anthropic key]
   SENDGRID_API_KEY     = [your SendGrid key]
   FROM_EMAIL           = preflight@theprintcompany.co.nz
   APP_USERNAME         = tpc
   APP_PASSWORD         = [choose a strong password]
   SESSION_SECRET       = [any long random string]
   ```

6. Click **Deploy**
7. Wait ~3 minutes for it to build

---

### Step 4 — Add your domain (optional)

In Render → your service → Settings → Custom Domains
Add: `preflight.theprintcompany.co.nz`

Then in your DNS (wherever theprintcompany.co.nz is managed):
Add a CNAME record pointing to your Render URL.

---

## Giving sales team access

Share the URL and login:
- URL: `https://preflight.theprintcompany.co.nz` (or your Render URL)
- Username: tpc (or whatever you set)
- Password: [what you set in APP_PASSWORD]

All staff share the same login. Sessions last 8 hours.

---

## What it checks

| Check | How |
|-------|-----|
| Page size & dimensions | pdfinfo |
| Embedded image resolution (DPI) | pdfimages |
| Colour mode (RGB/CMYK) | pdfimages |
| Font embedding | pdffonts |
| Bleed estimation | Page dimensions vs standard sizes |
| Bleed box in PDF metadata | Ghostscript |
| Overall verdict | Claude AI analysis |
| Plain English report | Claude AI |
| Email report | SendGrid |

---

## Costs (per month approx)

| Service | Cost |
|---------|------|
| Render Starter | USD ~$7 |
| Anthropic API | USD ~$2–5 (depending on volume) |
| SendGrid | Free up to 100 emails/day |
| **Total** | **~USD $10–15/month** |

---

## Changing the password

Update `APP_PASSWORD` in Render environment variables → Redeploy.

---

## Troubleshooting

**"Analysis failed" error**
- Check Render logs for the actual error
- Most common: Ghostscript/poppler not installed → check build command includes `apt-get install -y ghostscript poppler-utils`

**Emails not sending**
- Check SendGrid sender is verified
- Check SENDGRID_API_KEY is set correctly in Render

**File won't upload**
- Must be PDF
- Max 50MB
- Try a different PDF to rule out file corruption
