# ADA Diabetes Journal Web Scraper — Complete Skill Documentation

## Overview

This skill scrapes the ADA Scientific Sessions abstracts (Diabetes journal supplement) from `diabetesjournals.org`, finds Type 2 Diabetes topics related to Chinese pharmaceutical companies or Chinese populations, generates a categorized HTML report with compound-based tabs, and extracts structured HbA1c clinical trial data (including from figures/tables embedded in articles) into a downloadable CSV.

**Final outputs from a successful run:**
- `report.html` — Interactive report with 26 articles across 12 compound tabs + 30-row HbA1c data table
- `hba1c_data.csv` — Structured clinical data (10 studies, 30 treatment arms)
- `raw_results.json` — Full metadata for all matched articles

---

## Prerequisites

- **Node.js v24+** (uses built-in `WebSocket` and `fetch` — no npm packages needed)
- **Chromium/Chrome** browser installed (tested with Chrome 148)
- **Xvfb** (X Virtual Framebuffer) — for running Chrome non-headless on a headless server
- **Claude Code** (or equivalent multimodal AI) — for reading figure images and extracting tabular data

---

## Complete Workflow (Step by Step)

### Step 1: Run the Scraper

```bash
cd <install-dir>            # the directory containing app/ and all_articles_cache.json
node ada_scraper.js
```

The script performs these stages automatically:

#### 1a. Browser Setup (Cloudflare Bypass)

The site is behind **Cloudflare Turnstile** which blocks curl, headless Chrome, and Python requests. The only working bypass:

```
Xvfb :99 (virtual display)
  └── Chrome non-headless on :99, port 9223
       └── Node.js connects via built-in WebSocket → CDP (Chrome DevTools Protocol)
```

Key Chrome flags:
- `--no-sandbox --disable-gpu`
- `--disable-blink-features=AutomationControlled` (anti-detection)
- `--remote-debugging-port=9223`
- `--user-data-dir=/tmp/ada-scraper-profile` (persists cookies for repeat runs)

After navigation, wait **18 seconds** for Cloudflare challenge to auto-resolve.

#### 1b. Section Discovery & Article Collection

The issue page (`/diabetes/issue/74/Supplement_1`) has a multi-level expandable tree:
- 30 top-level sections (Oral, Poster, Late-Breaking, Published Only × topics)
- Each top-level section has 5–15 sub-sections
- Each sub-section has 20–80+ individual abstracts

The AJAX API pattern (called from within the browser page context to stay same-origin):
```
/diabetes/IssueVolume/MeetingAbstractIssueChildHeadings?headingId={ID}&issueId=1609&headingTypeId=2
```

The script uses **breadth-first traversal** — one `fetch()` per heading, with 500ms delay and 3 retries per request. Each response returns HTML with either article listings or sub-section toggle links.

**Result**: ~2,000+ abstracts collected (when site is not throttling).

#### 1c. Filtering for T2D + China/Chinese Pharma

Two-pass filtering:

**Pass 1 — Title/Authors match** (fast):
- T2D keywords: `type 2 diabetes`, `t2d`, `type 2`, `t2dm`, `type ii diabetes`, `niddm`
- China keywords (word-boundary regex): `china`, `chinese`, `beijing`, `shanghai`, `taiwan`, `hong kong`, etc.
- Pharma keywords: `innovent`, `hansoh`, `hengrui`, `bgm0504`, `mazdutide`, `hrs9531`, etc.

**Pass 2 — Abstract check** (for T2D articles not matching China in title):
- Fetch up to 100 article pages via in-browser `fetch()`
- Check full abstract text for China/pharma mentions
- 1.5s delay between requests to avoid rate limiting

**Result**: ~25 matched articles.

#### 1d. Deep Company Identification (Disclosure/Funding)

For each matched article, fetch the full page and extract:

1. **Funding section**: Text after `"Funding"` keyword (e.g., "Eli Lilly and Company")
2. **Disclosure section**: Text after `"Disclosure"` — look for `"Employee; CompanyName"` patterns

Company identification priority:
1. Funding section (most specific — directly names the sponsor)
2. Disclosure "Employee; X" pattern (identifies the pharma employer)
3. Disclosure "Research Support; X" pattern (secondary signal)
4. Title/author pharma keyword match (from known compounds list)
5. Fallback: "Chinese Population Study" (academic studies with no pharma link)

**Companies identified in practice**: Sanofi, Eli Lilly, BrightGene Bio-Medical, Innovent Biologics, Hansoh Pharma, Hengrui Pharma, Guangdong Raynovent Biotech, HighTide Therapeutics, Abbott, Roche Diagnostics.

#### 1e. Report Generation (Compound-Tabbed Layout)

Produces `report.html` with:
- **Summary bar** at top: "N companies | M reports total" + colored dots per company with counts
- **Compound tab bar**: clickable pill buttons, one per compound (sorted by article count), plus "Other/Unspecified" for non-drug articles
- **Within each tab**: articles grouped by presentation type (Oral Presentation, Late-Breaking Poster, Poster Presentation, Published Only)
- **Each article row**: Abstract ID (red, clickable link to source), type badge (colored), title with highlighted compound name, company/sponsor, trial type
- **HbA1c Data Analysis section** (bottom): interactive table + CSV download button

#### 1f. Data Protection

The script protects against throttled/partial runs:
- If a new run finds **fewer articles** than the existing `raw_results.json`, it keeps the previous data and logs a warning
- The report is always generated from the best available dataset
- `hba1c_data.csv` is loaded as-is if it exists (manual curation is preserved)

---

### Step 2: Extract HbA1c Data from Article Figures

Many ADA abstracts present primary efficacy results in **embedded figures/tables** (not inline text). The automated regex extraction catches some data from text, but figures require multimodal reading.

#### 2a. Identify Articles with Figures

All articles have at least one figure. Focus on articles with identified compounds (clinical trials most likely to have HbA1c tables):
```bash
# From raw_results.json, filter to compound articles
node -e "const d=require('./raw_results.json'); d.filter(a=>a.compound).forEach(a=>console.log(a.compound, a.url))"
```

#### 2b. Download Full-Size Figures

From each article page, find the "View large" link (class `fig-view-orig at-figureViewLarge`):
```
https://ada.silverchair-cdn.com/ada/content_public/journal/diabetes/74/supplement_1/10.2337_db25-{ID}/{VER}/g{NUM}_1.jpeg?Expires=...&Signature=...&Key-Pair-Id=...
```

Download:
```bash
mkdir -p figures
curl -sL "<view-large-URL>" -o figures/fig_<compound>.jpg
```

The script can collect figure URLs automatically by querying each article page for `a.fig-view-orig` links.

#### 2c. Read Figures with Claude (Multimodal Vision)

Use Claude's image reading capability:
```
Read figures/fig_<name>.jpg
```

For each figure that contains a results table, extract:
- Treatment arm names and doses (every arm including placebo/comparator)
- N (sample size) per arm
- Baseline HbA1c (%) per arm
- Change from baseline (y) — look for "CFB", "Δ at Week X", "Change from baseline", "HbA1c change"
- SE or SD — look for "±" values next to the change numbers
- Timepoint (weeks) — from column headers or footnotes

**Example figure data (730-P, SURPASS-CN-INS):**
```
Arms: Tirzepatide 5mg (N=64), 10mg (N=65), 15mg (N=63), Placebo (N=63)
Baseline: 8.66±0.13, 8.64±0.13, 8.76±0.13, 8.83±0.13
CFB (LSM±SE): -2.11±0.12, -2.39±0.13, -2.37±0.13, -0.91±0.12
Weeks: 40
```

#### 2d. Build/Update the CSV (`hba1c_data.csv`)

Format:
```csv
study_ind,arm_ind,compound,treat,n,y,se,base,weeks,Phase,study,comments
```

**Column definitions:**

| Column | Description |
|--------|-------------|
| `study_ind` | Auto-incremented study index (1, 2, 3...) |
| `arm_ind` | Arm index within study (1, 2, 3... resets per study) |
| `compound` | Drug/compound name (e.g., "Tirzepatide", "Mazdutide") |
| `treat` | Full treatment arm label (e.g., "Tirzepatide 5 mg", "Placebo") |
| `n` | Sample size for this arm |
| `y` | HbA1c(%) change from baseline (negative = improvement) |
| `se` | Standard error of y. Use SD if SE unavailable. From CI: SE=(upper−lower)/3.92 |
| `base` | Baseline HbA1c(%) for this arm. If only overall, apply to all arms |
| `weeks` | Primary endpoint timepoint (e.g., 12, 16, 24, 40) |
| `Phase` | Trial phase (e.g., "Phase 2", "Phase 3") |
| `study` | **Study name or trial alias** — use the actual trial name (e.g., "SURPASS-CN-INS", "DREAMS-1", "SoliD", "Symphony 1"), NOT the abstract ID |
| `comments` | Data type note (e.g., "LSM±SE", "CFB LSM(95%CI)") + source URL. Do NOT put study names here |

**Important rules:**
- Include **every treatment arm** including placebo and active comparators
- The `study` column must contain the **actual trial name** (SURPASS-CN-INS, DREAMS-1, SoliD, Symphony 1, REBUILDING-1, CTR20232464, etc.), not the abstract ID (730-P, 306-OR, etc.). Look for trial names in the abstract title, text, or figure captions. If no trial name exists, use the abstract ID as fallback.
- The `comments` column should only contain: data-type notes + the source article URL. No study names here.

---

### Step 3: Regenerate Report with Curated Data

After building/updating `hba1c_data.csv`, re-run:
```bash
node ada_scraper.js
```

The script detects the existing CSV and loads it directly (no re-extraction). The `report.html` will include the full interactive data table with a "Download CSV" button.

---

## Output Files

| File | Description |
|------|-------------|
| `ada_scraper.js` | Main script (self-contained Node.js, zero external dependencies) |
| `raw_results.json` | All matched articles with full metadata (company, compound, disclosure) |
| `report.html` | Interactive HTML: compound tabs (26 articles) + HbA1c data table (30 rows) + CSV download |
| `hba1c_data.csv` | Structured HbA1c efficacy data (10 studies, 30 arms) |
| `figures/` | Downloaded full-size figure images for data extraction |
| `skill.md` | This documentation |

---

## Runtime

~8–12 minutes for automated pipeline:
- ~20s: Browser startup + Cloudflare bypass
- ~3–4 min: Section traversal (~200 AJAX calls, 500ms delay each)
- ~2.5 min: Abstract checking (100 pages, 1.5s delay each)
- ~40s: Disclosure/funding fetching (25 pages, 1.5s delay each)
- ~30s: Figure URL collection (if triggered)

Manual phase (one-time, after first successful run):
- ~15–30 min: Download figures, read with Claude, curate CSV

**Note on rate limiting**: The site may throttle after repeated runs. The script has a protection mechanism — if a run finds fewer articles than the existing `raw_results.json`, it preserves the previous data. Wait 30+ minutes between full runs.

---

## Technical Architecture

```
ada_scraper.js
├── CDPClient class              — WebSocket wrapper for Chrome DevTools Protocol
├── startBrowser()               — Launch Xvfb + Chrome, verify CDP connection
├── getPageTarget()              — Find page WebSocket URL via CDP /json/list
├── navigateAndWait()            — Navigate + wait for Cloudflare (18s + retry)
├── expandAndCollectArticles()   — BFS section traversal via AJAX API
│   └── fetchHeading()           — Single heading fetch with 3 retries, 2s backoff
├── filterArticles()             — T2D + China keyword matching (title/authors)
├── checkAbstracts()             — Fetch article pages for abstract-level China matching
├── fetchDisclosureAndFunding()  — Extract Disclosure/Funding text from article page
├── extractCompanyFromDisclosure() — Parse funding/employee patterns → company name
├── categorizeResults()          — Assign company (prefer disclosure), compound, trialType, topicType
├── fetchFullAbstractText()      — Fetch page, decode HTML entities, convert <li> to bullets
├── extractHbA1cData()           — Automated regex extraction (fallback if no CSV)
├── parseHbA1cFromAbstract()     — Regex: bullet arms, LSM diffs, n=, baseline, weeks
├── generateHTMLReport()         — Compound-tabbed report with data table section
│   ├── Tab bar (compound pills with counts)
│   ├── Tab panels (articles by presentation type)
│   └── Data Analysis section (from generateDataTableHTML)
├── generateDataTableHTML()      — Interactive HbA1c table + CSV download JS
├── generateCSV()                — CSV serialization with proper quoting
└── main()                       — Orchestrator with data protection logic
```

---

## Customization Guide

### Change target issue/conference
Edit constants at the top of `ada_scraper.js`:
```js
const ISSUE_URL = 'https://diabetesjournals.org/diabetes/issue/74/Supplement_1';
const ISSUE_ID = 1609;
```

### Add/modify pharma company keywords
Two places to update:
1. `CHINESE_PHARMA_KEYWORDS` array — for title/author matching during filtering
2. `extractCompanyFromDisclosure()` → `companyPatterns` array — for disclosure/funding parsing

### Add known compound names
Update `extractCompound()` → `knownCompounds` object (maps lowercase keyword → display name). E.g.:
```js
'mazdutide': 'Mazdutide',
'gzr18': 'Bofanglutide (GZR18)',
```

### Change filter criteria
- `T2D_KEYWORDS` — disease keywords
- `CHINA_POPULATION_KEYWORDS` — geographic keywords (word-boundary matched)
- `matchesT2D()` / `matchesChina()` — matching functions

### Increase abstract check coverage
In `checkAbstracts()`: change `articles.slice(0, 100)` to a higher number (adds ~1.5s per additional article).

### Force re-extraction of HbA1c data
Delete or rename `hba1c_data.csv` before running — the script will fall back to automated regex extraction.

---

## Data Extraction Rules (for Manual Figure Reading)

When reading figures/tables from article pages to populate `hba1c_data.csv`:

1. **Identify the HbA1c results row**: Look for "Change from baseline", "CFB", "Δ HbA1c", "HbA1c change from baseline to Week X"
2. **SE vs SD**:
   - Header says "LSM ± SE" or "estimate ± SE" → use as SE directly
   - Header says "Mean (SD)" → use SD, note `SD used` in comments
   - Only 95% CI provided → compute `SE = (CI_upper − CI_lower) / 3.92`
3. **Baseline**: Take per-arm baseline if available; otherwise use overall mean for all arms
4. **Weeks/Timepoint**: Look in footnotes ("All changes from baseline to week X"), table headers, or title
5. **Placebo arm**: Always include — even if y ≈ 0 or slightly negative (e.g., -0.14, -0.91)
6. **Active comparator arms** (e.g., Semaglutide 1mg, Degludec): Include as separate arms with their own data
7. **LSM vs. raw mean**: Note in comments which is reported (`LSM(SE)` vs `Mean(SD)`); prefer LSM when both available
8. **Study name**: Extract the trial acronym (SURPASS-CN-INS, DREAMS-1, SoliD, etc.) from the abstract title, body text, or figure caption. Do NOT use the abstract ID (730-P, 306-OR).

---

## Reproducibility Checklist

To reproduce this entire workflow from scratch on a new system:

1. **Environment**: Ensure Node.js v24+, Chromium, and Xvfb are installed
2. **Files needed**: `ada_scraper.js` and optionally `skill.md`
3. **First run**: `node ada_scraper.js`
   - Produces `raw_results.json` (all matched articles) and initial `report.html`
   - If site is throttling (< expected articles), wait 30+ min and retry
4. **Figure extraction** (manual, one-time):
   - From `raw_results.json`, identify compound articles with clinical trial data
   - Collect "View large" figure URLs from each article page (class `fig-view-orig`)
   - Download figures: `curl -sL "<URL>" -o figures/fig_<name>.jpg`
   - Read each figure with Claude's vision and extract arm-level HbA1c data
   - Write data to `hba1c_data.csv` following the column format and rules above
5. **Final report**: Re-run `node ada_scraper.js`
   - Loads existing CSV automatically
   - Generates complete `report.html` with both compound tabs and data table
6. **Verify**: Open `report.html` in browser
   - Check compound tabs show all 26 articles grouped correctly
   - Check "HbA1c Data Analysis" section shows data table with correct study names
   - Click "Download CSV" to verify export works
