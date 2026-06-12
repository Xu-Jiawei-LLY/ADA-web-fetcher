// Report generator — produces report.html in the same format as report_t2d_rct.html
// Inputs:
//   articles       — array of {title, url, sectionPath, company?, compound?, ...}
//   dataRows       — optional array of CSV rows (objects keyed by column name)
//   meta           — { title, subtitle, sourceUrl, generatedAt, slotsHumanReadable }
//
// Layout: header → summary bar → company/compound tabs → article tables → optional data table → CSV download.

const fs = require('fs');

const COLORS = ['#e74c3c', '#e67e22', '#27ae60', '#2980b9', '#8e44ad', '#16a085', '#d35400', '#c0392b', '#2c3e50', '#7f8c8d', '#f39c12', '#1abc9c'];

function getAbstractId(title) {
  const m = title.match(/^(\d+[-–][A-Z]+)/);
  return m ? m[1] : '';
}
function typeBadge(topicType) {
  const m = {
    'Oral Presentation': { l: 'Oral', c: '#e67e22' },
    'Late-Breaking Poster': { l: 'LB Poster', c: '#e74c3c' },
    'Poster Presentation': { l: 'Poster', c: '#2980b9' },
    'Published Only': { l: 'Published', c: '#7f8c8d' },
    'Other': { l: 'Other', c: '#95a5a6' }
  }[topicType] || { l: 'Other', c: '#95a5a6' };
  return `<span class="type-badge" style="background:${m.c}">${m.l}</span>`;
}
function topicTypeFromSection(sp = '') {
  const s = sp.toLowerCase();
  if (s.includes('oral presentation')) return 'Oral Presentation';
  if (s.includes('late breaking') || s.includes('late-breaking')) return 'Late-Breaking Poster';
  if (s.includes('poster presentation')) return 'Poster Presentation';
  if (s.includes('published only')) return 'Published Only';
  return 'Other';
}
function highlightCompound(title, compound) {
  if (!compound || compound === 'Other / Unspecified') return title;
  const escaped = compound.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="compound-highlight">$1</span>');
}
function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function generateCSV(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    const vals = headers.map(h => {
      const v = row[h] !== undefined ? String(row[h]) : '';
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    });
    lines.push(vals.join(','));
  }
  return lines.join('\n');
}

function dataTableSection(dataRows) {
  if (!dataRows || dataRows.length === 0) return '';
  const headers = Object.keys(dataRows[0]);
  const studyCount = new Set(dataRows.map(r => r.study_ind || r.study)).size;
  // Embed the original data as JSON so the CSV export always has the live values.
  const originalJSON = JSON.stringify(dataRows);

  const tbody = dataRows.map((r, rowIdx) =>
    `<tr data-row="${rowIdx}">${headers.map((h, colIdx) => {
      const raw = String(r[h] !== undefined ? r[h] : '');
      const isLink = h === 'comments';
      // Each cell gets contenteditable + data-row/col for change tracking.
      // The cell's plain text is what the user edits; the original value is
      // stashed in data-orig so we can highlight diffs and restore on demand.
      return `<td class="${h === 'comments' ? 'col-comments' : ''} editable-cell" `+
             `data-row="${rowIdx}" data-col="${h}" data-orig="${raw.replace(/"/g,'&quot;')}" `+
             `contenteditable="true" spellcheck="false" `+
             `oninput="onCellEdit(this)">${
               isLink
                 ? raw.replace(/(https?:\/\/[^\s;]+)/g, '<a href="$1" target="_blank">link</a>')
                 : escapeHtml(raw)
             }</td>`;
    }).join('')}</tr>`
  ).join('');

  return `
  <div class="data-section" id="data-section">
    <div class="data-section-header">
      <div>
        <h2>Data Analysis Table</h2>
        <p class="data-meta">${dataRows.length} data rows from ${studyCount} studies
          <span class="edit-hint">— click any cell to edit</span>
          <span id="change-summary" class="change-summary hidden"></span>
        </p>
      </div>
      <div class="data-section-actions">
        <button class="download-btn dl-original" onclick="downloadCSV(false)" title="Download the AI-extracted values without any manual edits">⬇ Original CSV</button>
        <button class="download-btn dl-edited" onclick="downloadCSV(true)" id="dl-edited-btn" title="Download including all your manual edits (highlighted cells)">⬇ Edited CSV</button>
        <button class="undo-btn" onclick="undoLastEdit()" id="undo-btn" disabled title="Undo last edit">↩ Undo</button>
        <button class="reset-btn" onclick="resetAllEdits()" id="reset-btn" disabled title="Revert every cell to the AI-extracted original">✕ Reset all</button>
      </div>
    </div>
    <div class="table-scroll">
      <table class="data-table" id="data-table">
        <thead>
          <tr>
            ${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}
            <th class="col-restore-hdr" title="Restore this row">↩</th>
          </tr>
        </thead>
        <tbody>${tbody.replace(/<\/tr>/g,
          '<td class="col-restore"><button class="row-restore-btn" onclick="restoreRow(this)" title="Revert this row to original">↩</button></td></tr>'
        )}</tbody>
      </table>
    </div>
    <p class="edit-legend">
      <span class="legend-dot changed"></span> Cell edited (hover to see original)
      &nbsp;&nbsp;
      <span class="legend-dot restored"></span> Cell restored to original
    </p>
  </div>

  <script>
  (function() {
    // ── state ──────────────────────────────────────────────────────────────
    const originalData = ${originalJSON};
    const headers      = ${JSON.stringify(headers)};
    // history stack for undo: each entry is {cell, oldVal, newVal}
    const history = [];
    let recording = true;   // pause during programmatic restores

    // ── cell edit handler ──────────────────────────────────────────────────
    window.onCellEdit = function(cell) {
      const orig   = cell.dataset.orig;
      const newVal = cell.innerText.trim();
      const changed = newVal !== orig;
      if (changed) {
        cell.classList.add('changed');
        cell.classList.remove('restored');
        cell.title = 'Original: ' + orig;
      } else {
        cell.classList.remove('changed', 'restored');
        cell.title = '';
      }
      updateSummary();
      updateButtonStates();
    };

    // Track focus to record undo history (on blur, not every keystroke)
    document.addEventListener('focusin', function(e) {
      const c = e.target.closest('.editable-cell');
      if (c) c.dataset.beforeEdit = c.innerText.trim();
    });
    document.addEventListener('focusout', function(e) {
      const c = e.target.closest('.editable-cell');
      if (!c || !recording) return;
      const before = c.dataset.beforeEdit || '';
      const after  = c.innerText.trim();
      if (before !== after) {
        history.push({ cell: c, oldVal: before, newVal: after });
        updateButtonStates();
      }
    });

    // ── undo ───────────────────────────────────────────────────────────────
    window.undoLastEdit = function() {
      if (!history.length) return;
      const { cell, oldVal } = history.pop();
      recording = false;
      cell.innerText = oldVal;
      window.onCellEdit(cell);
      recording = true;
      updateButtonStates();
    };

    // ── restore a single row ───────────────────────────────────────────────
    window.restoreRow = function(btn) {
      const row = btn.closest('tr');
      const rowIdx = parseInt(row.dataset.row, 10);
      recording = false;
      row.querySelectorAll('.editable-cell').forEach(cell => {
        const col  = cell.dataset.col;
        const orig = originalData[rowIdx][col];
        const origStr = orig !== undefined ? String(orig) : '';
        cell.innerText = origStr;
        if (cell.classList.contains('changed')) {
          cell.classList.remove('changed');
          cell.classList.add('restored');
          cell.title = '';
        }
      });
      recording = true;
      updateSummary();
      updateButtonStates();
    };

    // ── reset everything ───────────────────────────────────────────────────
    window.resetAllEdits = function() {
      if (!confirm('Revert ALL edits to the AI-extracted original values?')) return;
      recording = false;
      document.querySelectorAll('.editable-cell').forEach(cell => {
        const orig = cell.dataset.orig;
        cell.innerText = orig;
        cell.classList.remove('changed', 'restored');
        cell.title = '';
      });
      history.length = 0;
      recording = true;
      updateSummary();
      updateButtonStates();
    };

    // ── CSV export ─────────────────────────────────────────────────────────
    // editedOnly=false → original values; editedOnly=true → live cell values
    window.downloadCSV = function(editedOnly) {
      let rows;
      if (!editedOnly) {
        rows = originalData;
      } else {
        rows = [];
        document.querySelectorAll('#data-table tbody tr').forEach((tr, ri) => {
          const rowObj = {};
          tr.querySelectorAll('.editable-cell').forEach(cell => {
            rowObj[cell.dataset.col] = cell.innerText.trim();
          });
          rows.push(rowObj);
        });
      }
      const lines = [headers.join(',')];
      for (const r of rows) {
        const vals = headers.map(h => {
          const v = r[h] !== undefined ? String(r[h]) : '';
          return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        });
        lines.push(vals.join(','));
      }
      const csv  = lines.join('\\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = editedOnly ? 'data_edited.csv' : 'data_original.csv';
      a.click();
      URL.revokeObjectURL(url);
    };

    // ── helpers ────────────────────────────────────────────────────────────
    function updateSummary() {
      const changedCells = document.querySelectorAll('.editable-cell.changed').length;
      const el = document.getElementById('change-summary');
      if (!el) return;
      if (changedCells > 0) {
        el.textContent = '— ' + changedCells + ' cell' + (changedCells > 1 ? 's' : '') + ' edited';
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
    function updateButtonStates() {
      const anyChanged = document.querySelectorAll('.editable-cell.changed').length > 0;
      const undoBtn  = document.getElementById('undo-btn');
      const resetBtn = document.getElementById('reset-btn');
      const dlBtn    = document.getElementById('dl-edited-btn');
      if (undoBtn)  undoBtn.disabled  = history.length === 0;
      if (resetBtn) resetBtn.disabled = !anyChanged;
      if (dlBtn)    dlBtn.classList.toggle('has-edits', anyChanged);
    }
  })();
  </script>`;
}

function generateReport({ articles, dataRows = [], meta = {} }) {
  const title = meta.title || 'ADA Web Fetcher Report';
  const subtitle = meta.subtitle || '';
  const sourceUrl = meta.sourceUrl || '';
  const generatedAt = meta.generatedAt || new Date().toISOString().split('T')[0];

  // Two-level grouping: primary by company/sponsor, secondary by compound.
  //   1st level — Eli Lilly, Novo Nordisk, Hengrui, ..., Other / Unspecified
  //   2nd level — within each company, group by compound (or "Other / Unspecified" if no compound).
  // Articles where company is missing fall under "Other / Unspecified" at the top level.
  const COMPANY_FALLBACK = 'Other / Unspecified';
  const COMPOUND_FALLBACK = 'Other / Unspecified';
  const companyOf  = a => (a.company  && a.company.trim())  ? a.company  : COMPANY_FALLBACK;
  const compoundOf = a => (a.compound && a.compound.trim()) ? a.compound : COMPOUND_FALLBACK;

  // groupedByCompany[company][compound] = [articles...]
  const groupedByCompany = {};
  for (const a of articles) {
    const co  = companyOf(a);
    const cmp = compoundOf(a);
    groupedByCompany[co] = groupedByCompany[co] || {};
    (groupedByCompany[co][cmp] = groupedByCompany[co][cmp] || []).push(a);
  }
  // Sort companies by total article count desc; "Other / Unspecified" always last.
  const companyEntries = Object.entries(groupedByCompany).sort((a, b) => {
    if (a[0] === COMPANY_FALLBACK) return 1;
    if (b[0] === COMPANY_FALLBACK) return -1;
    const aCount = Object.values(a[1]).reduce((s, arts) => s + arts.length, 0);
    const bCount = Object.values(b[1]).reduce((s, arts) => s + arts.length, 0);
    return bCount - aCount;
  });
  const allCompanies = companyEntries.map(([c]) => c);

  function articleRowsTable(items, compoundForHighlight) {
    const byType = {};
    for (const a of items) {
      const t = a.topicType || topicTypeFromSection(a.sectionPath);
      (byType[t] = byType[t] || []).push(a);
    }
    const order = ['Oral Presentation', 'Late-Breaking Poster', 'Poster Presentation', 'Published Only', 'Other'];
    return order.filter(t => byType[t]).map(t => {
      const rows = byType[t].map(a => {
        const cleanTitle = a.title.replace(/^\d+[-–][A-Z]+:\s*/, '');
        return `
          <tr>
            <td class="col-id"><a href="${escapeHtml(a.url)}" target="_blank">${getAbstractId(a.title)}</a></td>
            <td class="col-type">${typeBadge(t)}</td>
            <td class="col-title">${highlightCompound(escapeHtml(cleanTitle), compoundForHighlight)}</td>
            <td class="col-company">${escapeHtml(a.company || '')}</td>
            <td class="col-trial">${escapeHtml(a.trialType || '')}</td>
          </tr>`;
      }).join('');
      return `
        <div class="section-group">
          <h5>${t} — ${byType[t].length} item${byType[t].length > 1 ? 's' : ''}</h5>
          <table class="article-table">
            <thead><tr><th>ID</th><th>Type</th><th>Title</th><th>Company / Sponsor</th><th>Trial Type</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }).join('');
  }

  const tabButtons = companyEntries.map(([co, byCmp], i) => {
    const c = COLORS[i % COLORS.length];
    const total = Object.values(byCmp).reduce((s, arts) => s + arts.length, 0);
    return `<button class="tab-btn${i === 0 ? ' active' : ''}" data-tab="tab-${i}" style="--tab-color:${c}">${escapeHtml(co)} <span class="tab-count">${total}</span></button>`;
  }).join('\n      ');

  const tabPanels = companyEntries.map(([co, byCmp], i) => {
    // Sub-sort compounds by article count desc; fallback last.
    const compoundEntries = Object.entries(byCmp).sort((a, b) => {
      if (a[0] === COMPOUND_FALLBACK) return 1;
      if (b[0] === COMPOUND_FALLBACK) return -1;
      return b[1].length - a[1].length;
    });
    const subSections = compoundEntries.map(([cmp, items], j) => `
      <details class="compound-block"${j === 0 ? ' open' : ''}>
        <summary>
          <span class="compound-name">${escapeHtml(cmp)}</span>
          <span class="compound-count">${items.length} article${items.length > 1 ? 's' : ''}</span>
        </summary>
        <div class="compound-body">
          ${articleRowsTable(items, cmp)}
        </div>
      </details>`).join('');
    return `<div class="tab-panel${i === 0 ? ' active' : ''}" id="tab-${i}">${subSections}</div>`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; color: #333; background: #f5f7fa; }
  h1 { color: #1a5276; margin-bottom: 0.3rem; }
  .subtitle { color: #666; margin-bottom: 1.5rem; }
  .summary-bar { background: white; border-radius: 10px; padding: 1rem 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; }
  .summary-bar .total { font-weight: 600; color: #2c3e50; margin-right: 1rem; }
  .company-dot { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem; color: #555; }
  .company-dot::before { content: ''; width: 10px; height: 10px; border-radius: 50%; display: inline-block; background: var(--dot-color, #888); }
  .tabs-container { background: white; border-radius: 10px; padding: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .tab-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 1.5rem; border-bottom: 2px solid #eee; padding-bottom: 1rem; }
  .tab-btn { border: none; background: #f0f0f0; color: #555; padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: all 0.2s; }
  .tab-btn:hover { background: #e0e0e0; }
  .tab-btn.active { background: var(--tab-color, #2980b9); color: white; }
  .tab-count { background: rgba(0,0,0,0.08); border-radius: 10px; padding: 1px 7px; margin-left: 4px; font-size: 0.8rem; }
  .tab-btn.active .tab-count { background: rgba(255,255,255,0.3); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .section-group { margin-bottom: 1.5rem; }
  .section-group h4 { color: #34495e; margin-bottom: 0.5rem; font-size: 0.95rem; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }
  .section-group h5 { color: #2c3e50; margin: 0.75rem 0 0.4rem; font-size: 0.88rem; font-weight: 500; }
  .compound-block { margin-bottom: 1rem; background: #fafbfc; border: 1px solid #e6e8eb; border-radius: 8px; padding: 0.6rem 1rem; }
  .compound-block + .compound-block { margin-top: 0.6rem; }
  .compound-block > summary { cursor: pointer; padding: 0.35rem 0; font-weight: 600; color: #1a5276; outline: none; user-select: none; list-style: none; display: flex; align-items: center; gap: 0.6rem; }
  .compound-block > summary::-webkit-details-marker { display: none; }
  .compound-block > summary::before { content: '▸'; display: inline-block; width: 0.9rem; color: #888; transition: transform 120ms; }
  .compound-block[open] > summary::before { transform: rotate(90deg); }
  .compound-block > summary:hover { color: #c0392b; }
  .compound-name { font-size: 0.95rem; }
  .compound-count { font-size: 0.78rem; color: #888; font-weight: 400; background: #eef1f4; padding: 1px 8px; border-radius: 10px; }
  .compound-body { padding: 0.4rem 0 0.2rem; }
  .article-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
  .article-table th { background: #f8f9fa; color: #555; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 2px solid #eee; }
  .article-table td { padding: 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  .article-table tr:hover { background: #f8fbff; }
  .col-id { width: 80px; font-weight: 600; white-space: nowrap; }
  .col-id a { color: #c0392b; text-decoration: none; }
  .col-id a:hover { text-decoration: underline; }
  .col-type { width: 100px; }
  .col-company { width: 170px; font-size: 0.82rem; color: #666; }
  .col-trial { width: 110px; font-size: 0.82rem; color: #666; }
  .type-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; color: white; font-size: 0.75rem; font-weight: 600; }
  .compound-highlight { color: #e74c3c; font-weight: 600; }
  a { color: #2980b9; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .data-section { background: white; border-radius: 10px; padding: 1.5rem; margin-top: 2rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .data-section-header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1rem; }
  .data-section h2 { color: #1a5276; margin-bottom: 0.25rem; }
  .data-meta { color: #666; font-size: 0.88rem; margin: 0; }
  .edit-hint { color: #999; font-size: 0.82rem; }
  .change-summary { color: #e67e22; font-weight: 600; }
  .change-summary.hidden { display: none; }
  .data-section-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .download-btn { background: #27ae60; color: white; border: none; padding: 7px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
  .download-btn:hover { background: #219a52; }
  .download-btn.dl-original { background: #7f8c8d; }
  .download-btn.dl-original:hover { background: #6c7a7d; }
  .download-btn.dl-edited.has-edits { background: #e67e22; animation: pulse-btn 1.6s ease-in-out 1; }
  .download-btn.dl-edited.has-edits:hover { background: #d35400; }
  @keyframes pulse-btn { 0%,100%{transform:scale(1)} 40%{transform:scale(1.06)} }
  .undo-btn, .reset-btn { background: #f0f0f0; color: #444; border: 1px solid #ccc; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
  .undo-btn:hover:not(:disabled), .reset-btn:hover:not(:disabled) { background: #e0e0e0; }
  .undo-btn:disabled, .reset-btn:disabled { opacity: 0.38; cursor: not-allowed; }
  .table-scroll { overflow-x: auto; }
  .data-table { border-collapse: collapse; font-size: 0.82rem; width: 100%; min-width: 1000px; }
  .data-table th { background: #34495e; color: white; padding: 6px 8px; text-align: left; white-space: nowrap; }
  .data-table td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  .data-table tr:nth-child(even) { background: #f8f9fa; }
  .data-table .col-comments { max-width: 220px; font-size: 0.75rem; word-break: break-all; }
  /* editable cells */
  .editable-cell { cursor: text; outline: none; min-width: 40px; transition: background 120ms; }
  .editable-cell:hover { background: #f0f7ff !important; }
  .editable-cell:focus { background: #e8f4ff !important; box-shadow: inset 0 0 0 2px #3498db; border-radius: 2px; }
  .editable-cell.changed { background: #fff8e1 !important; border-left: 3px solid #f39c12; font-style: italic; }
  .editable-cell.changed:hover { background: #fff3cd !important; }
  .editable-cell.restored { background: #f0fff4 !important; border-left: 3px solid #2ecc71; }
  /* row-restore button */
  .col-restore-hdr { width: 32px; text-align: center; }
  .col-restore { width: 32px; text-align: center; padding: 2px; }
  .row-restore-btn { background: none; border: none; cursor: pointer; font-size: 0.9rem; color: #aaa; padding: 2px 4px; border-radius: 3px; }
  .row-restore-btn:hover { color: #e74c3c; background: #fef0f0; }
  /* legend */
  .edit-legend { font-size: 0.78rem; color: #888; margin-top: 0.6rem; }
  .legend-dot { display: inline-block; width: 10px; height: 10px; border-radius: 2px; vertical-align: middle; margin-right: 3px; }
  .legend-dot.changed { background: #fff8e1; border: 1px solid #f39c12; border-left: 3px solid #f39c12; }
  .legend-dot.restored { background: #f0fff4; border: 1px solid #2ecc71; border-left: 3px solid #2ecc71; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="subtitle">${escapeHtml(subtitle)}${sourceUrl ? ` | <a href="${escapeHtml(sourceUrl)}" target="_blank">Source</a>` : ''} | Generated: ${escapeHtml(generatedAt)}</p>

<div class="summary-bar">
  <span class="total">${allCompanies.length} companies | ${articles.length} reports total${dataRows.length > 0 ? ` | ${dataRows.length} data rows` : ''}</span>
  ${allCompanies.slice(0, 10).map((c, i) => `<span class="company-dot" style="--dot-color:${COLORS[i % COLORS.length]}">${escapeHtml(c)} ${articles.filter(a => (a.company || 'Unknown') === c).length}</span>`).join(' ')}
</div>

<div class="tabs-container">
  <div class="tab-bar">
    ${tabButtons}
  </div>
  ${tabPanels}
</div>

<script>
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });
</script>

${dataTableSection(dataRows)}

</body>
</html>`;
}

module.exports = { generateReport, generateCSV, topicTypeFromSection };
