// Regenerator for the T2D Phase 2/3 RCT report.
const fs = require('fs');
const path = require('path');

const scraperSrc = fs.readFileSync(path.join(__dirname, 'ada_scraper_t2d_rct.js'), 'utf8');
const trimmed = scraperSrc.replace(/\nmain\(\)\.catch\([\s\S]*$/, '\n');
const wrapped = trimmed + `
module.exports = { generateHTMLReport, generateDataTableHTML, generateCSV, ISSUE_URL };
`;
const tmpFile = path.join(__dirname, '.scraper_lib_t2d.js');
fs.writeFileSync(tmpFile, wrapped);
const lib = require(tmpFile);

const articles = JSON.parse(fs.readFileSync('raw_results_t2d_rct.json', 'utf8'));

const csvText = fs.readFileSync('hba1c_data_t2d_rct.csv', 'utf8');
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
fs.writeFileSync('report_t2d_rct.html', html);
console.log(`Wrote report_t2d_rct.html (${html.length} bytes) with ${articles.length} articles, ${hba1cData.length} HbA1c rows from ${new Set(hba1cData.map(r => r.study_ind)).size} studies`);

fs.unlinkSync(tmpFile);
