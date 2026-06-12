// Standalone report regenerator: loads raw_results.json + hba1c_data.csv and writes report.html.
// Reuses generateHTMLReport / generateDataTableHTML from ada_scraper.js by light eval-injection.
const fs = require('fs');
const path = require('path');

const scraperSrc = fs.readFileSync(path.join(__dirname, 'ada_scraper.js'), 'utf8');

// Strip the trailing `main().catch(...)` invocation. Anchor on a newline
// to avoid matching `async function main()` (line 999).
const trimmed = scraperSrc.replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');

// Inject a global export of the helpers we need
const wrapped = trimmed + `
module.exports = { generateHTMLReport, generateDataTableHTML, generateCSV, ISSUE_URL };
`;

const tmpFile = path.join(__dirname, '.scraper_lib.js');
fs.writeFileSync(tmpFile, wrapped);
const lib = require(tmpFile);

const articles = JSON.parse(fs.readFileSync('raw_results.json', 'utf8'));

const csvText = fs.readFileSync('hba1c_data.csv', 'utf8');
const lines = csvText.trim().split('\n');
const headers = lines[0].split(',');
const hba1cData = [];
for (let i = 1; i < lines.length; i++) {
  const values = [];
  let current = '', inQuotes = false;
  for (const ch of lines[i]) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { values.push(current); current = ''; }
    else current += ch;
  }
  values.push(current);
  const row = {};
  headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
  hba1cData.push(row);
}

const html = lib.generateHTMLReport(articles, hba1cData);
fs.writeFileSync('report.html', html);
console.log(`Wrote report.html (${html.length} bytes) with ${articles.length} articles, ${hba1cData.length} HbA1c rows from ${new Set(hba1cData.map(r => r.study_ind)).size} studies`);

fs.unlinkSync(tmpFile);
