// Builds report_weight_chinese.html from chinese_collected.json + weight_data_chinese.csv.
// Mirrors the company-tabbed style of the reference HTML, plus a weight-data analysis section.
const fs = require('fs');

const COMPANY_MAP = {
  'innovent':     { zh: '信达生物', en: 'Innovent',          color: '#1565c0', bg: '#e3eaf5' },
  'hengrui':      { zh: '恒瑞医药', en: 'Hengrui Pharma',    color: '#c62828', bg: '#fbe9e7' },
  'huadong':      { zh: '华东医药', en: 'Huadong Medicine',  color: '#00695c', bg: '#e0f2f1' },
  'huamedicine':  { zh: '华领医药', en: 'Hua Medicine',      color: '#2e7d32', bg: '#e8f5e9' },
  'ganlee':       { zh: '甘李药业', en: 'Gan & Lee',         color: '#0d47a1', bg: '#e3f2fd' },
  'sciwind':      { zh: '先为达',   en: 'Sciwind / Verdiva', color: '#6a1b9a', bg: '#f3e5f5' },
  'thdb':         { zh: '通化东宝', en: 'Tonghua Dongbao',   color: '#4e342e', bg: '#efebe9' },
  'eccogene':     { zh: '诚益生物', en: 'Eccogene',          color: '#006064', bg: '#e0f7fa' }
};

// Map abstract IDs to company slug (per reference HTML)
const ID_TO_COMPANY = {
  // Innovent
  '1133-OR': 'innovent', '1690-P': 'innovent', '2505-P': 'innovent', '1678-P': 'innovent',
  '1693-P': 'innovent', '1733-P': 'innovent', '2620-P': 'innovent', '2543-P': 'innovent',
  // Hengrui
  '1815-P': 'hengrui', '1681-P': 'hengrui', '1712-P': 'hengrui', '2816-LB': 'hengrui',
  // Huadong
  '1034-OR': 'huadong', '1218-OR': 'huadong', '2609-P': 'huadong',
  // Hua Medicine
  '1799-P': 'huamedicine', '1828-P': 'huamedicine', '2874-LB': 'huamedicine',
  // Gan & Lee
  '1745-P': 'ganlee', '1699-P': 'ganlee', '1822-P': 'ganlee', '1720-P': 'ganlee',
  '1805-P': 'ganlee', '1700-P': 'ganlee', '2833-LB': 'ganlee',
  // Sciwind
  '1766-P': 'sciwind', '2849-LB': 'sciwind',
  // Tonghua Dongbao
  '1762-P': 'thdb',
  // Eccogene
  '2844-LB': 'eccogene'
};

const articles = JSON.parse(fs.readFileSync('chinese_collected.json'));

// Parse CSV (handling quoted fields with commas)
const csvText = fs.readFileSync('weight_data_chinese.csv', 'utf8');
const csvLines = csvText.trim().split('\n');
const csvHeaders = csvLines[0].split(',');
const weightData = [];
for (let i = 1; i < csvLines.length; i++) {
  const values = []; let cur = ''; let inQ = false;
  for (const ch of csvLines[i]) {
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { values.push(cur); cur = ''; }
    else cur += ch;
  }
  values.push(cur);
  const row = {};
  csvHeaders.forEach((h, idx) => row[h] = (values[idx] || '').trim());
  weightData.push(row);
}

// Get presentation type from URL/section path or fall back to ID suffix
function getType(id, sectionPath) {
  const sp = (sectionPath || '').toLowerCase();
  if (sp.includes('late breaking') || sp.includes('late-breaking') || /-LB$/.test(id)) return 'Late-Breaking Poster';
  if (sp.includes('oral') || /-OR$/.test(id)) return 'Oral Presentation';
  if (sp.includes('published only')) return 'Published Only';
  if (/-P$/.test(id)) return 'Poster Presentation';
  return 'Other';
}
function typeBadge(t) {
  const m = {
    'Oral Presentation':    { label: 'Oral',    color: '#2e7d32', bg: '#e8f5e9' },
    'Late-Breaking Poster': { label: 'LB',      color: '#e65100', bg: '#fff3e0' },
    'Poster Presentation':  { label: 'Poster',  color: '#1565c0', bg: '#e3f2fd' },
    'Published Only':       { label: 'Pub',     color: '#6a1b9a', bg: '#f3e5f5' },
    'Other':                { label: 'Other',   color: '#616161', bg: '#f5f5f5' }
  }[t] || { label: 'Other', color: '#616161', bg: '#f5f5f5' };
  return `<span class="badge" style="background:${m.bg};color:${m.color}">${m.label}</span>`;
}

// Group articles by company
const byCompany = {};
for (const slug of Object.keys(COMPANY_MAP)) byCompany[slug] = [];
for (const [id, art] of Object.entries(articles)) {
  const slug = ID_TO_COMPANY[id];
  if (!slug) continue;
  byCompany[slug].push({ id, ...art });
}

// Group weight data by company too
const wdByCompany = {};
for (const slug of Object.keys(COMPANY_MAP)) wdByCompany[slug] = [];
for (const r of weightData) {
  const cmap = Object.values(COMPANY_MAP).find(c => c.zh === r.company);
  if (cmap) {
    const slug = Object.keys(COMPANY_MAP).find(k => COMPANY_MAP[k] === cmap);
    wdByCompany[slug].push(r);
  }
}

// Render company tab content
function renderCompanyPanel(slug) {
  const c = COMPANY_MAP[slug];
  const arts = byCompany[slug];
  const wd = wdByCompany[slug];
  // Articles by type
  const byType = {};
  for (const a of arts) {
    const t = getType(a.id, a.sectionPath);
    (byType[t] = byType[t] || []).push(a);
  }
  const typeOrder = ['Oral Presentation','Late-Breaking Poster','Poster Presentation','Published Only','Other'];
  const articleSections = typeOrder.filter(t => byType[t]).map(t => {
    const rows = byType[t].map(a => {
      const titleClean = a.title.replace(/^\d+[-–][A-Z]+:\s*/, '');
      return `
        <tr>
          <td class="abs-id"><a href="${a.url}" target="_blank" style="color:${c.color}">${a.id}</a> ${typeBadge(t)}</td>
          <td class="abs-title">${titleClean.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</td>
        </tr>`;
    }).join('');
    return `
      <div class="category">
        <div class="category-header" style="background:${c.bg};color:${c.color};">${t} &mdash; ${byType[t].length}</div>
        <table>
          <thead><tr><th style="width:140px">编号 ID</th><th>标题 Title</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }).join('');

  // Weight data table for this company
  let wdSection = '';
  if (wd.length > 0) {
    const wdRows = wd.map(r => `
      <tr>
        <td>${r.study_ind}</td><td>${r.arm_ind}</td><td>${r.compound}</td>
        <td>${r.treat}</td><td>${r.n}</td>
        <td class="${parseFloat(r.y_pct) < 0 ? 'pos' : ''}">${r.y_pct || ''}</td>
        <td>${r.kg_change || ''}</td><td>${r.se || ''}</td>
        <td>${r.base_kg || ''}</td><td>${r.weeks || ''}</td>
        <td>${r.Phase}</td><td>${r.study}</td>
      </tr>`).join('');
    wdSection = `
      <div class="category">
        <div class="category-header" style="background:${c.bg};color:${c.color};">体重减轻数据 Weight Reduction Data &mdash; ${wd.length} 治疗组</div>
        <div class="table-scroll">
          <table class="data-table">
            <thead>
              <tr><th>study</th><th>arm</th><th>compound</th><th>treat</th><th>n</th>
                  <th>y (% Δ)</th><th>kg Δ</th><th>se</th><th>base kg</th><th>weeks</th>
                  <th>Phase</th><th>trial</th></tr>
            </thead>
            <tbody>${wdRows}</tbody>
          </table>
        </div>
      </div>`;
  }

  return `<div id="tab-${slug}" class="tab-panel" style="border-top: 3px solid ${c.color};">
    ${articleSections}
    ${wdSection}
  </div>`;
}

const tabButtons = Object.keys(COMPANY_MAP).map((slug, i) => {
  const c = COMPANY_MAP[slug];
  const count = byCompany[slug].length;
  const wdCount = wdByCompany[slug].length;
  return `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="${slug}" data-color="${c.color}" data-bg="${c.bg}" style="background:${i === 0 ? c.color : c.bg};color:${i === 0 ? '#fff' : c.color};${i === 0 ? 'box-shadow:0 -2px 8px ' + c.color + '40;' : ''}" onclick="switchTab('${slug}')">${c.zh}<span class="tab-count">${count}项 / ${wdCount}arms</span></button>`;
}).join('\n');

const panels = Object.keys(COMPANY_MAP).map(slug => renderCompanyPanel(slug));
// First panel is active
panels[0] = panels[0].replace('class="tab-panel"', 'class="tab-panel active"');

const totalArticles = Object.values(byCompany).reduce((s, a) => s + a.length, 0);
const totalArms = weightData.length;
const totalStudies = new Set(weightData.map(r => r.study_ind)).size;

// Full HTML — Chinese-localized like the reference
const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ADA 2026 - 中国公司体重减轻数据汇总</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f7fa; color: #1a1a2e; line-height: 1.6; }
  .header { background: linear-gradient(135deg, #0d47a1, #1565c0, #00695c); color: #fff; padding: 32px 24px; text-align: center; }
  .header h1 { font-size: 1.6em; margin-bottom: 6px; }
  .header p { opacity: 0.9; font-size: 0.95em; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

  .summary-bar { background: #fff; border-radius: 10px; padding: 18px 24px; margin-bottom: 20px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04); display: flex; flex-wrap: wrap; gap: 16px; align-items: center; }
  .summary-item { display: flex; align-items: center; gap: 6px; font-size: 0.9em; }
  .summary-dot { width: 12px; height: 12px; border-radius: 50%; }
  .summary-label { font-weight: 600; }
  .summary-count { color: #616161; }

  .tabs { display: flex; gap: 4px; margin-bottom: 0; overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .tab-btn { padding: 12px 14px; border: none; cursor: pointer; font-size: 0.88em; font-weight: 700; transition: all 0.2s;
    border-radius: 10px 10px 0 0; position: relative; top: 1px; white-space: nowrap; flex-shrink: 0; }
  .tab-btn .tab-count { font-weight: 400; font-size: 0.75em; opacity: 0.85; margin-left: 4px; }
  .tab-btn.active { z-index: 1; }

  .tab-panel { display: none; background: #fff; border-radius: 0 0 10px 10px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); overflow: hidden; }
  .tab-panel.active { display: block; }

  .category { margin: 0; }
  .category-header { padding: 10px 18px; font-weight: 600; font-size: 0.92em; border-bottom: 1px solid #e0e0e0; }

  table { width: 100%; border-collapse: collapse; }
  th { background: #fafafa; text-align: left; padding: 10px 14px; font-size: 0.82em; color: #546e7a;
    text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #e0e0e0; }
  td { padding: 10px 14px; border-bottom: 1px solid #f0f0f0; font-size: 0.9em; vertical-align: top; }
  tr:hover { background: #f8f9ff; }

  .abs-id { font-weight: 700; white-space: nowrap; }
  .abs-id a { text-decoration: none; }
  .abs-id a:hover { text-decoration: underline; }
  .abs-title { line-height: 1.5; }

  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.72em; font-weight: 600; margin-left: 4px; }

  .table-scroll { overflow-x: auto; }
  .data-table { font-size: 0.82em; min-width: 1100px; }
  .data-table th { background: #34495e; color: white; padding: 6px 8px; white-space: nowrap; font-size: 0.78em; }
  .data-table td { padding: 5px 8px; }
  .data-table tr:nth-child(even) { background: #f8f9fa; }
  .data-table .pos { color: #1b5e20; font-weight: 600; }

  .download-row { padding: 14px 18px; background: #fafafa; border-top: 1px solid #e0e0e0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .download-btn { background: #27ae60; color: white; border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-size: 0.9em; font-weight: 600; }
  .download-btn:hover { background: #219a52; }
  .download-info { color: #546e7a; font-size: 0.85em; }

  .note { background: #fff8e1; border-left: 4px solid #ff9800; padding: 12px 16px; margin-bottom: 16px; border-radius: 4px; font-size: 0.88em; color: #5d4037; }

  .footer { text-align: center; padding: 20px; font-size: 0.8em; color: #9e9e9e; }

  @media (max-width: 768px) {
    td, th { padding: 8px 8px; font-size: 0.82em; }
    .tab-btn { font-size: 0.78em; padding: 10px 8px; }
    .summary-bar { padding: 12px 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>ADA 2026 Scientific Sessions</h1>
  <p>中国公司 — 体重减轻临床研究数据汇总</p>
  <p>Chinese Companies — Weight-Reduction Clinical Trial Data</p>
  <p style="margin-top:8px; font-size:0.85em;">New Orleans, LA, USA &bull; June 5-8, 2026 &bull; 数据来源: <a href="https://diabetesjournals.org/diabetes/issue/75/Supplement_1" target="_blank" style="color:#fff; text-decoration:underline;">Diabetes Vol 75 Suppl 1</a></p>
</div>

<div class="container">

<div class="summary-bar">
  <div class="summary-item"><span class="summary-label">${Object.keys(COMPANY_MAP).length} 家公司</span> | <span class="summary-count">${totalArticles} 项报告 (摘要可获)</span> | <span class="summary-count">${totalStudies} 个研究 / ${totalArms} 个治疗组数据</span></div>
  <div style="flex-grow:1"></div>
  ${Object.keys(COMPANY_MAP).map(slug => {
    const c = COMPANY_MAP[slug];
    const n = byCompany[slug].length;
    return `<div class="summary-item"><span class="summary-dot" style="background:${c.color}"></span><span>${c.zh} ${n}</span></div>`;
  }).join('')}
</div>

<div class="note">
  <strong>说明:</strong> y = 体重相对基线的百分比变化 (%); 阴性值表示体重下降. 若摘要仅报告 kg 变化, 已在 comments 列标注换算逻辑. 主要终点为体重减轻的试验已优先收录. 注: 参考报告中 1225-OR (Mazdutide GLORY-2 9 mg) / 1226-OR (DREAMS-3) / 1227-OR (RAY1225 REBUILDING-1) 三项口头报告未在 Diabetes 期刊增刊发表 (可能为禁运迟发数据), 故未收录.
</div>

<div class="tabs">
  ${tabButtons}
</div>
${panels.join('\n')}

<div class="download-row" style="background:#fff; border-radius:10px; margin-top:20px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
  <button class="download-btn" onclick="downloadCSV()">下载完整 CSV (Download Full CSV)</button>
  <span class="download-info">${totalArms} 行数据 · ${totalStudies} 个研究 · 包含所有公司</span>
</div>

</div>

<div class="footer">
  生成时间: ${new Date().toISOString().split('T')[0]} &bull; 主要终点: 体重相对基线 % 变化
</div>

<script>
function switchTab(slug) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.remove('active');
    b.style.background = b.getAttribute('data-bg');
    b.style.color = b.getAttribute('data-color');
    b.style.boxShadow = '';
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  const btn = document.querySelector('.tab-btn[data-tab="' + slug + '"]');
  const color = btn.getAttribute('data-color');
  btn.classList.add('active');
  btn.style.background = color;
  btn.style.color = '#fff';
  btn.style.boxShadow = '0 -2px 8px ' + color + '40';
  document.getElementById('tab-' + slug).classList.add('active');
}
function downloadCSV() {
  const csv = ${JSON.stringify(csvText)};
  const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'weight_data_chinese.csv'; a.click();
  URL.revokeObjectURL(url);
}
</script>

</body>
</html>`;

fs.writeFileSync('report_weight_chinese.html', html);
console.log(`Wrote report_weight_chinese.html (${html.length} bytes)`);
console.log(`  ${totalArticles} articles across ${Object.keys(COMPANY_MAP).length} companies`);
console.log(`  ${totalArms} weight-data rows from ${totalStudies} studies`);
