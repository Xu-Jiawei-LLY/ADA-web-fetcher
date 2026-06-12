#!/usr/bin/env node

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://diabetesjournals.org';
const ISSUE_URL = `${BASE_URL}/diabetes/issue/75/Supplement_1`;
const ISSUE_ID = 1643;
const CDP_PORT = 9223;
const XVFB_DISPLAY = ':99';

const CHINESE_PHARMA_KEYWORDS = [
  'innovent', 'hua medicine', 'hansoh', 'hengrui', 'cspc', 'zhuhai united',
  'gan & lee', 'gan and lee', 'tonghua dongbao', 'salubris', 'beigene',
  'luye pharma', 'zelgen', 'sciwind', 'sihuan', 'sino biopharm', 'simcere',
  'junshi', 'akeso', 'connect biopharma', 'remegen',
  'ascletis', 'betta pharma', 'bright gene', 'chiatai tianqing', 'chipscreen',
  'fosun pharma', 'genor biopharma', 'grandpharma', 'haisco',
  'hitgen', 'huadong medicine', 'hutchmed', 'jiangsu hengrui', 'jemincare',
  'kelun-biotech', 'kintor pharma', 'laekna', 'lepu medical', 'livzon',
  'mabwell', 'nhwa pharma',
  'qilu pharma', 'shanghai henlius',
  'tasly pharma', 'yabao pharma', 'yichang humanwell',
  'zhimeng', 'zhongshan', 'kanion pharma',
  'hualan', 'shanghai pharma',
  'shenzhen salubris', 'zhejiang medicine', 'hangzhou zhongmei', 'cttq',
  'cstone', 'adagene', 'zai lab', 'i-mab', 'gracell', 'legend biotech',
  'bgm0504', 'dong-a st'
];

const CHINA_POPULATION_KEYWORDS = [
  'china', 'chinese', 'beijing', 'shanghai', 'guangzhou', 'shenzhen',
  'hangzhou', 'nanjing', 'wuhan', 'chengdu', 'chongqing',
  'taiwan', 'taiwanese', 'hong kong'
];

const T2D_KEYWORDS = [
  'type 2 diabetes', 't2d', 'type 2', 't2dm', 'type ii diabetes',
  'niddm', 'non-insulin dependent'
];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.msgId = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('WebSocket error'));
      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      };
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.msgId;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeout = 120000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      timeout
    });
    if (result.result?.result?.value !== undefined) {
      return result.result.result.value;
    }
    if (result.result?.exceptionDetails) {
      throw new Error(`Eval error: ${JSON.stringify(result.result.exceptionDetails)}`);
    }
    return null;
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

async function startBrowser() {
  console.log('[1/6] Starting Xvfb...');
  try { execSync('pkill -f "Xvfb :99"', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -f "chromium.*9223"', { stdio: 'ignore' }); } catch {}
  await delay(1000);

  const xvfb = spawn('Xvfb', [XVFB_DISPLAY, '-screen', '0', '1920x1080x24', '-ac'], {
    stdio: 'ignore', detached: true
  });
  xvfb.unref();
  await delay(2000);

  console.log('[2/6] Launching Chrome...');
  const chrome = spawn('chromium-browser', [
    '--no-sandbox', '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--user-data-dir=/tmp/ada-scraper-profile',
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions',
    'about:blank'
  ], {
    stdio: 'ignore', detached: true,
    env: { ...process.env, DISPLAY: XVFB_DISPLAY }
  });
  chrome.unref();
  await delay(3000);

  const versionUrl = `http://127.0.0.1:${CDP_PORT}/json/version`;
  let version;
  for (let i = 0; i < 10; i++) {
    try {
      const res = await fetch(versionUrl);
      version = await res.json();
      break;
    } catch {
      await delay(1000);
    }
  }
  if (!version) throw new Error('Chrome failed to start');
  console.log(`   Chrome ready: ${version.Browser}`);
  return version;
}

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page');
  if (!page) throw new Error('No page target found');
  return page.webSocketDebuggerUrl;
}

async function navigateAndWait(cdp, url, waitMs = 18000) {
  console.log(`[3/6] Navigating to ${url}`);
  console.log('   Waiting for Cloudflare challenge to resolve...');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url });
  await delay(waitMs);

  const title = await cdp.evaluate('document.title');
  if (title.includes('Just a moment')) {
    console.log('   Still on Cloudflare page, waiting longer...');
    await delay(15000);
  }
  const finalTitle = await cdp.evaluate('document.title');
  console.log(`   Page loaded: "${finalTitle}"`);
  if (finalTitle.includes('Just a moment')) {
    throw new Error('Failed to bypass Cloudflare challenge');
  }
}

async function getAllSections(cdp) {
  console.log('[4/6] Discovering all sections...');
  const sections = JSON.parse(await cdp.evaluate(`
    JSON.stringify(Array.from(document.querySelectorAll('.js-cat-toggle')).map(a => ({
      id: a.dataset.id,
      headingTypeId: a.dataset.headingtypeid,
      title: a.querySelector('h4')?.textContent?.trim() || a.textContent.trim()
    })))
  `));
  console.log(`   Found ${sections.length} top-level sections`);
  return sections;
}

async function expandAndCollectArticles(cdp) {
  console.log('[5/6] Collecting articles via AJAX API...');

  // First get all top-level section IDs
  const topSectionsJson = await cdp.evaluate(`
    JSON.stringify(Array.from(document.querySelectorAll('.parent-category-container > a.js-cat-toggle[data-id]')).map(a => ({
      id: a.getAttribute('data-id'),
      title: (a.querySelector('h4') || a).textContent.trim()
    })).filter((v, i, arr) => arr.findIndex(x => x.id === v.id) === i))
  `);
  const topSections = JSON.parse(topSectionsJson);
  console.log(`   Found ${topSections.length} top-level sections to process`);

  const allArticles = [];
  const seenUrls = new Set();

  // Recursive function that fetches one heading and returns its children/articles
  async function fetchHeading(headingId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await cdp.evaluate(`
          (async function() {
            const resp = await fetch('/diabetes/IssueVolume/MeetingAbstractIssueChildHeadings?headingId=${headingId}&issueId=${ISSUE_ID}&headingTypeId=2');
            if (!resp.ok) return JSON.stringify({articles: [], subs: [], status: resp.status});
            const html = await resp.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');

            const articles = [];
            const articleItems = doc.querySelectorAll('.al-article-items');
            for (const item of articleItems) {
              const titleEl = item.querySelector('h3.item-title a, h5.customLink a, h3 a');
              const authorsEl = item.querySelector('.al-authors-list');
              if (titleEl) {
                const href = titleEl.getAttribute('href') || '';
                if (href) articles.push({
                  title: titleEl.textContent.trim(),
                  url: href,
                  authors: authorsEl ? authorsEl.textContent.trim() : ''
                });
              }
            }

            const subs = [];
            const subToggles = doc.querySelectorAll('a.js-cat-toggle[data-id]');
            for (const toggle of subToggles) {
              const subId = toggle.getAttribute('data-id');
              const h4 = toggle.querySelector('h4');
              const subTitle = h4 ? h4.textContent.trim() : toggle.textContent.trim().substring(0, 80);
              if (subId) subs.push({id: subId, title: subTitle});
            }

            return JSON.stringify({articles, subs});
          })()
        `);
        if (result) return JSON.parse(result);
      } catch (e) {}
      await delay(2000);
    }
    return {articles: [], subs: []};
  }

  // Process sections breadth-first to avoid deep recursion in evaluate
  async function processSection(sectionId, sectionTitle) {
    const queue = [{id: sectionId, path: sectionTitle}];
    while (queue.length > 0) {
      const current = queue.shift();
      try {
        const data = await fetchHeading(current.id);

        for (const art of data.articles) {
          if (!seenUrls.has(art.url)) {
            seenUrls.add(art.url);
            allArticles.push({
              ...art,
              url: art.url.startsWith('/') ? BASE_URL + art.url : art.url,
              sectionPath: current.path
            });
          }
        }

        for (const sub of data.subs) {
          queue.push({id: sub.id, path: current.path + ' > ' + sub.title});
        }

        await delay(500);
      } catch (e) {
        // skip failed section
      }
    }
  }

  for (let i = 0; i < topSections.length; i++) {
    const section = topSections[i];
    process.stdout.write(`\r   Processing ${i + 1}/${topSections.length}: ${section.title.substring(0, 50).padEnd(50)}`);
    await processSection(section.id, section.title);
    await delay(500);
  }

  console.log(`\n   Total articles found: ${allArticles.length}`);
  return allArticles;
}

function matchesT2D(text) {
  const lower = text.toLowerCase();
  return T2D_KEYWORDS.some(kw => lower.includes(kw));
}

function matchesPhase23(text) {
  // Accept "phase 2", "phase II", "phase 2/3", "phase IIa/IIb/IIIa/IIIb"
  return /\bphase\s*(2|3|ii|iii|2[ab]?|3[ab]?|2\/3|ii\/iii)\b/i.test(text);
}

function matchesRandomized(text) {
  // RCT signals — phrasing the abstracts use to describe a controlled trial
  return /\b(randomi[sz]ed|double[-\s]?blind|placebo[-\s]?controlled|active[-\s]?controlled|noninferior|non[-\s]?inferior)\b/i.test(text);
}

function matchesHbA1cMention(text) {
  // Relaxed: any mention of HbA1c / A1C is enough.
  return /\bHbA1c\b|\bA1[Cc]\b/i.test(text);
}

function identifyCompany(text) {
  const lower = text.toLowerCase();
  const found = [];
  // Broader global-pharma map (used as a title/author fallback when disclosure parsing missed)
  const companyMap = {
    'Eli Lilly': ['eli lilly', 'lilly diabetes', 'tirzepatide', 'orforglipron'],
    'Novo Nordisk': ['novo nordisk', 'semaglutide', 'liraglutide'],
    'Sanofi': ['sanofi'],
    'AstraZeneca': ['astrazeneca', 'dapagliflozin'],
    'Boehringer Ingelheim': ['boehringer', 'empagliflozin'],
    'Merck': ['merck', 'sitagliptin', 'januvia'],
    'Pfizer': ['pfizer', 'ervogastat'],
    'Bayer': ['bayer', 'finerenone'],
    'Innovent': ['innovent', 'mazdutide'],
    'Hua Medicine': ['hua medicine', 'dorzagliatin'],
    'Hansoh': ['hansoh', 'hrs9531', 'hrs-'],
    'Hengrui': ['hengrui', 'jiangsu hengrui'],
    'Tonghua Dongbao': ['tonghua dongbao', 'thdb'],
    'Sciwind': ['sciwind', 'ecnoglutide'],
    'Sun Pharma': ['sun pharmaceutical', 'utreglutide', 'gl0034'],
    'Eccogene': ['eccogene', 'ecc5004', 'elecoglipron'],
    'Roche': ['roche'],
    'Abbott': ['abbott'],
    'Dexcom': ['dexcom'],
    'Medtronic': ['medtronic']
  };
  for (const [name, keywords] of Object.entries(companyMap)) {
    if (keywords.some(kw => lower.includes(kw))) found.push(name);
  }
  return found.length > 0 ? found.join(', ') : 'Unspecified';
}

function identifyTrialType(title) {
  const lower = title.toLowerCase();
  if (/phase\s*(1|i)\b/i.test(title) && !/phase\s*(2|ii)/i.test(title)) return 'Phase I';
  if (/phase\s*(2|ii)\b/i.test(title) && !/phase\s*(3|iii)/i.test(title)) return 'Phase II';
  if (/phase\s*(3|iii)\b/i.test(title)) return 'Phase III';
  if (/phase\s*(4|iv)\b/i.test(title)) return 'Phase IV';
  if (lower.includes('rct') || lower.includes('randomized') || lower.includes('randomised')) return 'RCT';
  if (lower.includes('real-world') || lower.includes('real world')) return 'Real-World Study';
  if (lower.includes('meta-analysis') || lower.includes('metaanalysis')) return 'Meta-Analysis';
  if (lower.includes('observational')) return 'Observational';
  if (lower.includes('cohort')) return 'Cohort Study';
  if (lower.includes('cross-sectional') || lower.includes('cross sectional')) return 'Cross-Sectional';
  if (lower.includes('retrospective')) return 'Retrospective';
  if (lower.includes('prospective')) return 'Prospective';
  if (lower.includes('case-control') || lower.includes('case control')) return 'Case-Control';
  if (lower.includes('in vitro') || lower.includes('preclinical') || lower.includes('animal')) return 'Preclinical';
  if (lower.includes('efficacy') || lower.includes('safety') || lower.includes('trial')) return 'Clinical Trial';
  return 'Other';
}

function identifyTopicType(sectionPath) {
  const lower = sectionPath.toLowerCase();
  if (lower.includes('oral presentation')) return 'Oral Presentation';
  if (lower.includes('late breaking poster')) return 'Late-Breaking Poster';
  if (lower.includes('poster presentation')) return 'Poster Presentation';
  if (lower.includes('published only')) return 'Published Only';
  return 'Other';
}

function extractCompound(title) {
  const knownCompounds = {
    'mazdutide': 'Mazdutide',
    'dorzagliatin': 'Dorzagliatin',
    'hrs9531': 'HRS9531',
    'bgm0504': 'BGM0504',
    'htd1801': 'HTD1801',
    'semaglutide': 'Semaglutide',
    'tirzepatide': 'Tirzepatide',
    'liraglutide': 'Liraglutide',
    'dulaglutide': 'Dulaglutide',
    'exenatide': 'Exenatide',
    'dapagliflozin': 'Dapagliflozin',
    'empagliflozin': 'Empagliflozin',
    'canagliflozin': 'Canagliflozin',
    'iglarlixi': 'iGlarLixi',
    'idegasp': 'IDegAsp',
    'berberine ursodeoxycholate': 'Berberine Ursodeoxycholate',
    'ecnoglutide': 'Ecnoglutide',
    'bofanglutide': 'Bofanglutide (GZR18)',
    'gzr18': 'Bofanglutide (GZR18)',
    'gzr4': 'Insulin GZR4',
    'cofrogliptin': 'Cofrogliptin',
    'ray1225': 'RAY1225',
    'ibi3032': 'IBI3032'
  };
  const lower = title.toLowerCase();
  for (const [kw, name] of Object.entries(knownCompounds)) {
    if (lower.includes(kw)) return name;
  }
  // Match drug-code patterns like ABC1234, AB-1234
  const codeMatch = title.match(/\b([A-Z]{2,4}[-\s]?\d{3,5}[A-Za-z]?)\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    // Exclude abstract IDs (e.g., 303-OR, 730-P)
    if (!/^\d+[-–](OR|P|LB|PUB)$/i.test(code)) return code;
  }
  // Match generic drug names (-tide, -gliflozin, -gliptin)
  const genericMatch = title.match(/\b([a-z]{4,}(?:tide|gliflozin|gliptin|glutide))\b/i);
  if (genericMatch) return genericMatch[1];
  return '';
}

async function fetchAbstractForArticle(cdp, articleUrl) {
  const text = await cdp.evaluate(`
    (async function() {
      try {
        const resp = await fetch("${articleUrl}");
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const abstract = doc.querySelector('.abstract, .article-body, section[class*="abstract"]');
        return abstract ? abstract.textContent.trim().substring(0, 2000) : '';
      } catch(e) { return ''; }
    })()
  `);
  return text || '';
}

async function fetchDisclosureAndFunding(cdp, articleUrl) {
  const result = await cdp.evaluate(`
    (async function() {
      try {
        const resp = await fetch("${articleUrl}");
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const bodyText = doc.body?.innerText || doc.body?.textContent || '';
        const disclIdx = bodyText.toLowerCase().indexOf('disclosure');
        const fundIdx = bodyText.toLowerCase().indexOf('funding');
        const disclosure = disclIdx > -1 ? bodyText.substring(disclIdx, Math.min(disclIdx + 800, bodyText.length)) : '';
        const funding = fundIdx > -1 ? bodyText.substring(fundIdx, Math.min(fundIdx + 300, bodyText.length)) : '';
        return JSON.stringify({disclosure, funding});
      } catch(e) { return JSON.stringify({disclosure: '', funding: ''}); }
    })()
  `);
  try { return JSON.parse(result); } catch { return {disclosure: '', funding: ''}; }
}

function filterArticles(articles) {
  console.log('[6/6] Filtering for T2D + Phase 2/3 (relaxed)...');
  const matched = [];          // T2D + Phase 2/3 in title/authors — likely a clinical trial
  const titleOnlyMatched = []; // T2D in title — needs abstract check for phase + HbA1c mention

  for (const art of articles) {
    const combinedText = `${art.title} ${art.authors}`;
    if (!matchesT2D(combinedText)) continue;
    if (matchesPhase23(combinedText)) {
      matched.push(art);
    } else {
      titleOnlyMatched.push(art);
    }
  }

  console.log(`   Direct matches (T2D + Phase 2/3 in title): ${matched.length}`);
  console.log(`   T2D articles needing abstract check: ${titleOnlyMatched.length}`);
  return { matched, titleOnlyMatched };
}

async function checkAbstracts(cdp, articles) {
  // Pull the abstract for every T2D candidate (no cap).
  // Relaxed gating: Phase 2/3 mention + ANY HbA1c/A1C mention.
  const additionalMatches = [];
  let checked = 0;
  const toCheck = articles;
  for (const art of toCheck) {
    checked++;
    if (checked % 20 === 0) {
      process.stdout.write(`\r   Checking abstracts: ${checked}/${toCheck.length}`);
    }
    const abstractText = await fetchAbstractForArticle(cdp, art.url);
    const hasPhase = matchesPhase23(abstractText);
    const hasHba1c = matchesHbA1cMention(abstractText);
    if (hasPhase && hasHba1c) {
      art.abstractSnippet = abstractText.substring(0, 400);
      additionalMatches.push(art);
    }
    await delay(1000);
  }
  if (checked > 0) console.log('');
  console.log(`   Additional matches from abstract check: ${additionalMatches.length}`);
  return additionalMatches;
}

function categorizeResults(articles) {
  return articles.map(art => {
    // Prefer disclosure-based company identification
    let company = art.disclosureCompany || identifyCompany(`${art.title} ${art.authors} ${art.abstractSnippet || ''}`);
    return {
      ...art,
      company,
      compound: extractCompound(art.title),
      trialType: identifyTrialType(art.title),
      topicType: identifyTopicType(art.sectionPath)
    };
  });
}

function extractCompanyFromDisclosure(disclosure, funding) {
  const combined = `${funding} ${disclosure}`.toLowerCase();
  const companyPatterns = [
    { name: 'Eli Lilly', patterns: ['eli lilly', 'lilly diabetes'] },
    { name: 'Novo Nordisk', patterns: ['novo nordisk'] },
    { name: 'Sanofi', patterns: ['sanofi'] },
    { name: 'AstraZeneca', patterns: ['astrazeneca'] },
    { name: 'Innovent Biologics', patterns: ['innovent'] },
    { name: 'Hansoh Pharma', patterns: ['hansoh', 'jiangsu hansoh'] },
    { name: 'Hengrui Pharma', patterns: ['hengrui', 'jiangsu hengrui'] },
    { name: 'BrightGene Bio-Medical', patterns: ['brightgene', 'bright gene'] },
    { name: 'Hua Medicine', patterns: ['hua medicine'] },
    { name: 'CSPC Pharma', patterns: ['cspc'] },
    { name: 'Gan & Lee', patterns: ['gan & lee', 'gan and lee'] },
    { name: 'Tonghua Dongbao', patterns: ['tonghua dongbao'] },
    { name: 'Fosun Pharma', patterns: ['fosun'] },
    { name: 'HUTCHMED', patterns: ['hutchmed'] },
    { name: 'Zai Lab', patterns: ['zai lab'] },
    { name: 'Kelun-Biotech', patterns: ['kelun'] },
    { name: 'Sciwind Biosciences', patterns: ['sciwind'] },
    { name: 'Merck', patterns: ['merck'] },
    { name: 'Boehringer Ingelheim', patterns: ['boehringer'] },
    { name: 'Pfizer', patterns: ['pfizer'] },
    { name: 'Bayer', patterns: ['bayer'] },
    { name: 'Abbott', patterns: ['abbott'] },
    { name: 'Dexcom', patterns: ['dexcom'] },
    { name: 'Medtronic', patterns: ['medtronic'] },
  ];

  // Check funding first (most specific)
  const fundingLower = (funding || '').toLowerCase();
  for (const { name, patterns } of companyPatterns) {
    if (patterns.some(p => fundingLower.includes(p))) return name;
  }

  // Then check for "Employee; CompanyName" pattern in disclosure
  const employeeMatch = disclosure.match(/Employee;\s*([^.]+?)(?:\.|$)/i);
  if (employeeMatch) {
    const employerText = employeeMatch[1].trim();
    for (const { name, patterns } of companyPatterns) {
      if (patterns.some(p => employerText.toLowerCase().includes(p))) return name;
    }
    // Return the raw employer name if not in our known list but it's Chinese-sounding
    if (employerText.length > 3 && employerText.length < 80) return employerText;
  }

  // Check for "Research Support; CompanyName" as secondary signal
  const supportMatch = disclosure.match(/Research Support;\s*([^.]+?)(?:\.|,)/i);
  if (supportMatch) {
    const supportText = supportMatch[1].trim();
    for (const { name, patterns } of companyPatterns) {
      if (patterns.some(p => supportText.toLowerCase().includes(p))) return name;
    }
  }

  return null;
}

function generateHTMLReport(results, hba1cData = []) {
  // Group by compound
  const byCompound = {};
  for (const r of results) {
    const key = r.compound || 'Other / Unspecified';
    (byCompound[key] = byCompound[key] || []).push(r);
  }

  // Sort compounds by count (descending)
  const compoundEntries = Object.entries(byCompound).sort((a, b) => b[1].length - a[1].length);

  // Assign colors to compounds
  const colors = ['#e74c3c', '#e67e22', '#27ae60', '#2980b9', '#8e44ad', '#16a085', '#d35400', '#c0392b', '#2c3e50', '#7f8c8d', '#f39c12', '#1abc9c'];

  // Collect unique companies
  const allCompanies = [...new Set(results.map(r => r.company))];

  // Extract abstract ID from title (e.g., "303-OR" from "303-OR: Efficacy...")
  const getAbstractId = (title) => {
    const match = title.match(/^(\d+[-–][A-Z]+)/);
    return match ? match[1] : '';
  };

  // Get presentation type badge
  const getTypeBadge = (topicType) => {
    const typeMap = {
      'Oral Presentation': { label: 'Oral', color: '#e67e22' },
      'Late-Breaking Poster': { label: 'LB Poster', color: '#e74c3c' },
      'Poster Presentation': { label: 'Poster', color: '#2980b9' },
      'Published Only': { label: 'Published', color: '#7f8c8d' },
      'Other': { label: 'Other', color: '#95a5a6' }
    };
    const t = typeMap[topicType] || typeMap['Other'];
    return `<span class="type-badge" style="background:${t.color}">${t.label}</span>`;
  };

  // Highlight compound name in title
  const highlightCompound = (title, compound) => {
    if (!compound || compound === 'Other / Unspecified') return title;
    const escaped = compound.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return title.replace(new RegExp(`(${escaped})`, 'gi'), '<span class="compound-highlight">$1</span>');
  };

  const tabButtons = compoundEntries.map(([compound, items], idx) => {
    const color = colors[idx % colors.length];
    return `<button class="tab-btn${idx === 0 ? ' active' : ''}" data-tab="tab-${idx}" style="--tab-color:${color}">${compound} <span class="tab-count">${items.length}</span></button>`;
  }).join('\n      ');

  const tabPanels = compoundEntries.map(([compound, items], idx) => {
    // Group items by topic type within this compound
    const byType = {};
    for (const item of items) {
      (byType[item.topicType] = byType[item.topicType] || []).push(item);
    }
    const typeOrder = ['Oral Presentation', 'Late-Breaking Poster', 'Poster Presentation', 'Published Only', 'Other'];
    const sections = typeOrder
      .filter(t => byType[t])
      .map(t => {
        const typeItems = byType[t];
        const rows = typeItems.map(r => `
          <tr>
            <td class="col-id"><a href="${r.url}" target="_blank">${getAbstractId(r.title)}</a></td>
            <td class="col-type">${getTypeBadge(r.topicType)}</td>
            <td class="col-title">${highlightCompound(r.title.replace(/^\d+[-–][A-Z]+:\s*/, ''), compound)}</td>
            <td class="col-company">${r.company}</td>
            <td class="col-trial">${r.trialType}</td>
          </tr>`).join('');
        return `
        <div class="section-group">
          <h4>${t} — ${typeItems.length} item${typeItems.length > 1 ? 's' : ''}</h4>
          <table class="article-table">
            <thead><tr><th>ID</th><th>Type</th><th>Title</th><th>Company / Sponsor</th><th>Trial Type</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
      }).join('');

    return `<div class="tab-panel${idx === 0 ? ' active' : ''}" id="tab-${idx}">${sections}</div>`;
  }).join('\n    ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ADA 2026 - T2D Phase 2/3 RCTs with HbA1c Reduction</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 2rem; color: #333; background: #f5f7fa; }
    h1 { color: #1a5276; margin-bottom: 0.3rem; }
    .subtitle { color: #666; margin-bottom: 1.5rem; }

    .summary-bar {
      background: white; border-radius: 10px; padding: 1rem 1.5rem;
      margin-bottom: 1.5rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      display: flex; align-items: center; flex-wrap: wrap; gap: 1rem;
    }
    .summary-bar .total { font-weight: 600; color: #2c3e50; margin-right: 1rem; }
    .company-dot { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem; color: #555; }
    .company-dot::before { content: ''; width: 10px; height: 10px; border-radius: 50%; display: inline-block; }

    .tabs-container {
      background: white; border-radius: 10px; padding: 1.5rem;
      box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    }
    .tab-bar {
      display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 1.5rem;
      border-bottom: 2px solid #eee; padding-bottom: 1rem;
    }
    .tab-btn {
      border: none; background: #f0f0f0; color: #555;
      padding: 8px 16px; border-radius: 20px; cursor: pointer;
      font-size: 0.9rem; font-weight: 500; transition: all 0.2s;
    }
    .tab-btn:hover { background: #e0e0e0; }
    .tab-btn.active { background: var(--tab-color, #2980b9); color: white; }
    .tab-count { background: rgba(255,255,255,0.3); border-radius: 10px; padding: 1px 7px; margin-left: 4px; font-size: 0.8rem; }
    .tab-btn.active .tab-count { background: rgba(255,255,255,0.3); }
    .tab-btn:not(.active) .tab-count { background: rgba(0,0,0,0.08); }

    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    .section-group { margin-bottom: 1.5rem; }
    .section-group h4 { color: #34495e; margin-bottom: 0.5rem; font-size: 0.95rem; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }

    .article-table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    .article-table th { background: #f8f9fa; color: #555; text-align: left; padding: 8px 10px; font-weight: 600; border-bottom: 2px solid #eee; }
    .article-table td { padding: 10px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
    .article-table tr:hover { background: #f8fbff; }
    .col-id { width: 80px; font-weight: 600; white-space: nowrap; }
    .col-id a { color: #c0392b; text-decoration: none; }
    .col-id a:hover { text-decoration: underline; }
    .col-type { width: 80px; }
    .col-company { width: 160px; font-size: 0.82rem; color: #666; }
    .col-trial { width: 100px; font-size: 0.82rem; color: #666; }

    .type-badge {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      color: white; font-size: 0.75rem; font-weight: 600;
    }
    .compound-highlight { color: #e74c3c; font-weight: 600; }

    a { color: #2980b9; text-decoration: none; }
    a:hover { text-decoration: underline; }

    .data-section { background: white; border-radius: 10px; padding: 1.5rem; margin-top: 2rem; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
    .data-section h2 { color: #1a5276; margin-bottom: 0.5rem; }
    .download-btn { background: #27ae60; color: white; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 0.9rem; margin: 0.5rem 0 1rem; }
    .download-btn:hover { background: #219a52; }
    .table-scroll { overflow-x: auto; }
    .data-table { border-collapse: collapse; font-size: 0.82rem; width: 100%; min-width: 1000px; }
    .data-table th { background: #34495e; color: white; padding: 6px 8px; text-align: left; white-space: nowrap; }
    .data-table td { padding: 5px 8px; border-bottom: 1px solid #eee; }
    .data-table tr:nth-child(even) { background: #f8f9fa; }
    .data-table .col-comments { max-width: 200px; font-size: 0.75rem; word-break: break-all; }
  </style>
</head>
<body>
  <h1>ADA 86th Scientific Sessions (2026) — Type 2 Diabetes Phase 2/3 RCTs</h1>
  <p class="subtitle">All T2D randomized controlled trials reporting an HbA1c reduction (no geographic/sponsor restriction) | <a href="${ISSUE_URL}" target="_blank">Source</a> | Generated: ${new Date().toISOString().split('T')[0]}</p>

  <div class="summary-bar">
    <span class="total">${allCompanies.length} companies | ${results.length} reports total</span>
    ${allCompanies.slice(0, 8).map((c, i) => `<span class="company-dot" style="--dot-color:${colors[i % colors.length]}">${c} ${results.filter(r => r.company === c).length}</span>`).join(' ')}
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

  ${generateDataTableHTML(hba1cData)}

</body>
</html>`;

  return html;
}

async function fetchFullAbstractText(cdp, articleUrl) {
  const result = await cdp.evaluate(`
    (async function() {
      try {
        const resp = await fetch("${articleUrl}");
        const html = await resp.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const content = doc.querySelector('.widget-ArticleFulltext') || doc.querySelector('.article-body') || doc.querySelector('main');
        if (!content) return '';
        let text = content.innerHTML || '';
        // Decode HTML entities first
        text = text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        // Convert li tags to bullet points
        text = text.replace(/<li[^>]*>/gi, '\\n• ').replace(/<\\/li>/gi, '');
        // Remove remaining HTML tags
        text = text.replace(/<[^>]+>/g, ' ');
        // Normalize whitespace but keep newlines
        text = text.replace(/[ \\t]+/g, ' ').replace(/\\n\\s*\\n/g, '\\n');
        return text.trim().substring(0, 6000);
      } catch(e) { return ''; }
    })()
  `);
  return result || '';
}

function parseHbA1cFromAbstract(text, article) {
  const rows = [];
  if (!text || text.length < 100) return rows;

  // Normalize unicode dashes and special chars
  text = text.replace(/−/g, '-').replace(/–/g, '-').replace(/—/g, '-').replace(/±/g, '±');

  // Extract study name/alias
  const studyNameMatch = text.match(/\b(DREAMS[-\s]?\d*|SoliD|SURPASS[-\s]?\d*|SUSTAIN[-\s]?\d*|AMPLITUDE[-\s]?\w*|STEP[-\s]?\w*|GLORY[-\s]?\d*|[Ss]ymphony[-\s]?\d*|REBUILDING[-\s]?\d*)\b/) ||
                         text.match(/(?:trial|study)\s*(?:\()?([A-Z][\w-]{2,15})\)?/);
  const studyName = studyNameMatch ? studyNameMatch[1].trim() : (article.title.match(/^(\d+[-][A-Z]+)/)?.[1] || '');

  // Extract baseline HbA1c
  const baselineMatch = text.match(/(?:baseline|mean)\s*HbA1c\s*(?:of\s*|was\s*|:?\s*)?(\d+\.?\d*)\s*%/i) ||
                        text.match(/HbA1c\s*(?:of\s*)?(\d+\.?\d*)\s*%/i) ||
                        text.match(/mean\s*(?:baseline\s*)?HbA1c[:\s]*(\d+\.?\d*)/i);
  const baseline = baselineMatch ? parseFloat(baselineMatch[1]) : null;

  // Extract duration (weeks)
  const weeksMatch = text.match(/(?:at|to)\s*week\s*(\d+)/i) ||
                     text.match(/(\d+)\s*[-]?\s*week(?:s)?\s*(?:of\s*)?(?:treatment|once[-\s]?weekly)/i) ||
                     text.match(/(\d+)\s*[-]?\s*week\s*(?:double[-\s]?blind|placebo[-\s]?controlled|randomized)/i);
  const weeks = weeksMatch ? parseInt(weeksMatch[1]) : null;

  // Extract phase
  const phaseMatch = text.match(/phase\s*(\d+[ab]?|[IViv]+[ab]?)/i);
  let phase = article.trialType || '';
  if (phaseMatch) {
    let p = phaseMatch[1].toUpperCase();
    p = p.replace(/^IV$/,'4').replace(/^III$/,'3').replace(/^II$/,'2').replace(/^I$/,'1');
    phase = 'Phase ' + p;
  }

  const compound = article.compound || '';

  // Extract n= values from methods
  const nPattern = /(\w[\w\s./-]*?)\s*\(n\s*=\s*(\d+)\)/gi;
  const armSizes = {};
  let nMatch;
  while ((nMatch = nPattern.exec(text)) !== null) {
    const name = nMatch[1].trim();
    const n = parseInt(nMatch[2]);
    if (n > 0 && n < 5000 && name.length < 60) armSizes[name.toLowerCase()] = n;
  }

  // Also try "n = X" patterns with different formatting
  const nPattern2 = /(\d+)\s*(?:patients|participants|subjects)\s*(?:were\s*)?(?:randomized|assigned|allocated)\s*(?:to\s*)?(\w[\w\s]*?)(?:\s*group|\s*arm)?/gi;

  const arms = [];

  // Split on bullet points or list items
  const lines = text.split(/[•\n]/);

  for (const line of lines) {
    // Pattern: "5 mg group: -1.82% (-2.83 to -0.81)"
    const armMatch = line.match(/(\d+\.?\d*\s*mg\s*(?:group|dose)?|[Pp]lacebo|[Ss]emaglutide\s*[\d.]*\s*mg|[Ll]iraglutide\s*[\d.]*\s*mg|[Tt]irzepatide\s*[\d.]*\s*mg|[Mm]etformin)[:\s]*-\s*(\d+\.?\d+)\s*%?\s*(?:±\s*(\d+\.?\d+)|\(\s*-?\s*([\d.]+)\s*(?:to|,)\s*-?\s*([\d.]+)\s*\))?/i);
    if (armMatch) {
      const armName = armMatch[1].trim();
      const change = -Math.abs(parseFloat(armMatch[2]));
      let se = armMatch[3] ? parseFloat(armMatch[3]) : null;
      if (!se && armMatch[4] && armMatch[5]) {
        const ciLow = parseFloat(armMatch[4]);
        const ciHigh = parseFloat(armMatch[5]);
        se = Math.abs(ciHigh - ciLow) / 3.92;
      }
      arms.push({ treat: armName, y: change, se: se ? parseFloat(se.toFixed(3)) : null });
    }
  }

  // If no per-arm bullet data found, look for overall LSM difference
  if (arms.length === 0) {
    const resultsIdx = text.toLowerCase().indexOf('results');
    const resultsText = resultsIdx > -1 ? text.substring(resultsIdx, resultsIdx + 2000) : text;

    // LSM treatment difference pattern
    const lsmMatches = [...resultsText.matchAll(/(?:LSM|LS\s*mean)\s*(?:treatment\s*)?difference[^.]*?-\s*(\d+\.?\d+)\s*%?\s*(?:\[|\()\s*(?:95%?\s*CI[:\s]*)?\s*-?\s*([\d.]+)\s*(?:to|,)\s*-?\s*([\d.]+)\s*(?:\]|\))/gi)];
    if (lsmMatches.length > 0) {
      for (const m of lsmMatches) {
        const diff = -Math.abs(parseFloat(m[1]));
        const ciLow = parseFloat(m[2]);
        const ciHigh = parseFloat(m[3]);
        const se = Math.abs(ciHigh - ciLow) / 3.92;
        arms.push({ treat: compound || 'Active', y: diff, se: parseFloat(se.toFixed(3)), isVsPlacebo: true });
      }
    }

    // Alternative: "change in HbA1c from baseline ... -X.XX%"
    if (arms.length === 0) {
      const changeMatch = resultsText.match(/(?:change|reduction)\s*(?:in\s*)?(?:HbA1c|A1[cC])\s*(?:from\s*baseline)?[^.]*?-\s*(\d+\.?\d+)\s*%?\s*(?:±\s*(\d+\.?\d+)|\(\s*(?:95%?\s*CI[:\s]*)?\s*-?\s*([\d.]+)\s*(?:to|,)\s*-?\s*([\d.]+)\s*\))?/i);
      if (changeMatch) {
        const change = -Math.abs(parseFloat(changeMatch[1]));
        let se = changeMatch[2] ? parseFloat(changeMatch[2]) : null;
        if (!se && changeMatch[3] && changeMatch[4]) {
          se = Math.abs(parseFloat(changeMatch[4]) - parseFloat(changeMatch[3])) / 3.92;
        }
        arms.push({ treat: compound || 'Active', y: change, se: se ? parseFloat(se.toFixed(3)) : null });
      }
    }
  }

  // Match n values to arms
  for (const arm of arms) {
    const armLower = arm.treat.toLowerCase();
    for (const [key, n] of Object.entries(armSizes)) {
      if (armLower.includes(key.replace(/\s*group/i, '').trim()) ||
          key.includes(armLower.replace(/\s*group/i, '').trim())) {
        arm.n = n;
        break;
      }
    }
  }

  // Build rows
  if (arms.length > 0) {
    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      const comments = [];
      if (arm.isVsPlacebo) comments.push('LSM difference vs. placebo');
      comments.push(article.url);

      rows.push({
        compound: compound,
        treat: arm.treat,
        n: arm.n || '',
        y: arm.y,
        se: arm.se || '',
        base: baseline || '',
        weeks: weeks || '',
        Phase: phase,
        study: studyName,
        comments: comments.join('; ')
      });
    }
  }

  return rows;
}

async function extractHbA1cData(cdp, articles) {
  console.log('\n[7/7] Extracting HbA1c data from articles...');
  const allRows = [];
  let studyInd = 0;

  for (let i = 0; i < articles.length; i++) {
    process.stdout.write(`\r   Extracting data: ${i + 1}/${articles.length}`);
    const text = await fetchFullAbstractText(cdp, articles[i].url);
    const rows = parseHbA1cFromAbstract(text, articles[i]);

    if (rows.length > 0) {
      studyInd++;
      for (let armIdx = 0; armIdx < rows.length; armIdx++) {
        allRows.push({
          study_ind: studyInd,
          arm_ind: armIdx + 1,
          ...rows[armIdx]
        });
      }
    }
    await delay(1500);
  }

  console.log(`\n   Extracted ${allRows.length} data rows from ${studyInd} studies`);
  return allRows;
}

function generateCSV(hba1cData) {
  const headers = ['study_ind', 'arm_ind', 'compound', 'treat', 'n', 'y', 'se', 'base', 'weeks', 'Phase', 'study', 'comments'];
  const csvRows = [headers.join(',')];
  for (const row of hba1cData) {
    const values = headers.map(h => {
      const val = row[h] !== undefined ? String(row[h]) : '';
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    });
    csvRows.push(values.join(','));
  }
  return csvRows.join('\n');
}

function generateDataTableHTML(hba1cData) {
  if (hba1cData.length === 0) return '<p>No HbA1c data could be extracted from the available abstracts.</p>';

  const csvContent = generateCSV(hba1cData).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const tableRows = hba1cData.map(r => `
    <tr>
      <td>${r.study_ind}</td><td>${r.arm_ind}</td><td>${r.compound}</td>
      <td>${r.treat}</td><td>${r.n}</td><td>${r.y}</td><td>${r.se}</td>
      <td>${r.base}</td><td>${r.weeks}</td><td>${r.Phase}</td>
      <td>${r.study}</td><td class="col-comments">${r.comments.replace(/(https?:\/\/[^\s;]+)/g, '<a href="$1" target="_blank">link</a>')}</td>
    </tr>`).join('');

  return `
  <div class="data-section">
    <h2>HbA1c Data Analysis</h2>
    <p>${hba1cData.length} data rows extracted from ${new Set(hba1cData.map(r => r.study_ind)).size} studies</p>
    <button class="download-btn" onclick="downloadCSV()">Download CSV</button>
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr><th>study_ind</th><th>arm_ind</th><th>compound</th><th>treat</th><th>n</th><th>y</th><th>se</th><th>base</th><th>weeks</th><th>Phase</th><th>study</th><th>comments</th></tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>
  <script>
    function downloadCSV() {
      const csv = ${JSON.stringify(generateCSV(hba1cData))};
      const blob = new Blob([csv], {type: 'text/csv'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'hba1c_data.csv'; a.click();
      URL.revokeObjectURL(url);
    }
  </script>`;
}

async function main() {
  const outputDir = path.dirname(process.argv[1]) || '.';
  const RAW_FILE = 'raw_results_t2d_rct.json';
  const CSV_FILE = 'hba1c_data_t2d_rct.csv';
  const HTML_FILE = 'report_t2d_rct.html';
  console.log('=== ADA 2026 T2D Phase 2/3 RCT Scraper ===\n');

  await startBrowser();
  const wsUrl = await getPageTarget();
  const cdp = new CDPClient(wsUrl);
  await cdp.connect();

  // Article-list cache: the section traversal returns ~1953 articles for this issue
  // and the result is deterministic. Reuse it across filter-tuning runs.
  // Only cache if the run looks complete (>1500 articles) — site throttling can
  // truncate the traversal and we don't want to persist a poisoned dataset.
  const ARTICLES_CACHE = path.join(outputDir, 'all_articles_cache.json');
  const ARTICLES_CACHE_MIN = 1500;
  let articles;
  if (fs.existsSync(ARTICLES_CACHE)) {
    articles = JSON.parse(fs.readFileSync(ARTICLES_CACHE, 'utf8'));
    console.log(`[4-5/6] Loaded ${articles.length} articles from cache (${ARTICLES_CACHE})`);
    // Still need a live page for abstract fetches via in-page fetch() (Cloudflare).
    await navigateAndWait(cdp, ISSUE_URL);
  } else {
    await navigateAndWait(cdp, ISSUE_URL);
    articles = await expandAndCollectArticles(cdp);
    if (articles.length >= ARTICLES_CACHE_MIN) {
      fs.writeFileSync(ARTICLES_CACHE, JSON.stringify(articles));
      console.log(`   Cached: ${ARTICLES_CACHE}`);
    } else {
      console.log(`   WARN: only ${articles.length} articles found (< ${ARTICLES_CACHE_MIN}); not caching (likely throttled).`);
    }
  }

  const { matched, titleOnlyMatched } = filterArticles(articles);
  const abstractMatches = await checkAbstracts(cdp, titleOnlyMatched);

  const allMatched = [...matched, ...abstractMatches];

  // Deep-fetch disclosure/funding for all matched articles
  console.log(`   Fetching disclosure/funding for ${allMatched.length} articles...`);
  for (let i = 0; i < allMatched.length; i++) {
    if ((i + 1) % 5 === 0) process.stdout.write(`\r   Fetching disclosures: ${i + 1}/${allMatched.length}`);
    const { disclosure, funding } = await fetchDisclosureAndFunding(cdp, allMatched[i].url);
    allMatched[i].disclosure = disclosure;
    allMatched[i].funding = funding;
    // Try to identify company from disclosure
    const disclosureCompany = extractCompanyFromDisclosure(disclosure, funding);
    if (disclosureCompany) allMatched[i].disclosureCompany = disclosureCompany;
    await delay(1500);
  }
  console.log(`\r   Fetching disclosures: ${allMatched.length}/${allMatched.length} done`);

  const categorized = categorizeResults(allMatched);

  console.log(`\n   Final results: ${categorized.length} articles`);

  // Extract HbA1c data - use existing curated CSV if available, else auto-extract
  let hba1cData = [];
  const existingCsv = path.join(outputDir, CSV_FILE);
  if (fs.existsSync(existingCsv)) {
    console.log('\n[7/7] Loading existing curated HbA1c data from CSV...');
    const csvText = fs.readFileSync(existingCsv, 'utf8');
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',');
    for (let i = 1; i < lines.length; i++) {
      // Handle CSV with quoted fields containing commas
      const values = [];
      let current = '';
      let inQuotes = false;
      for (const char of lines[i]) {
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { values.push(current); current = ''; }
        else { current += char; }
      }
      values.push(current);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
      hba1cData.push(row);
    }
    console.log(`   Loaded ${hba1cData.length} rows from ${new Set(hba1cData.map(r => r.study_ind)).size} studies`);
  } else {
    hba1cData = await extractHbA1cData(cdp, categorized);
    if (hba1cData.length > 0) {
      fs.writeFileSync(existingCsv, generateCSV(hba1cData));
      console.log(`   Saved: ${existingCsv}`);
    }
  }

  const rawPath = path.join(outputDir, RAW_FILE);
  // Only overwrite if we found more or equal articles than before (protect against throttled runs)
  let existingCount = 0;
  if (fs.existsSync(rawPath)) {
    try { existingCount = JSON.parse(fs.readFileSync(rawPath)).length; } catch {}
  }
  if (categorized.length >= existingCount) {
    fs.writeFileSync(rawPath, JSON.stringify(categorized, null, 2));
    console.log(`   Saved: ${rawPath}`);
  } else if (categorized.length > 0) {
    console.log(`   Warning: Found fewer articles (${categorized.length}) than existing (${existingCount}). Keeping previous results.`);
  }

  // For report generation, use the best available data
  let reportArticles = categorized;
  if (categorized.length < existingCount && fs.existsSync(rawPath)) {
    try { reportArticles = JSON.parse(fs.readFileSync(rawPath)); } catch {}
  }

  const html = generateHTMLReport(reportArticles, hba1cData);
  const htmlPath = path.join(outputDir, HTML_FILE);
  fs.writeFileSync(htmlPath, html);
  console.log(`   Saved: ${htmlPath}`);

  cdp.close();
  try { execSync('pkill -f "chromium.*9223"', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -f "Xvfb :99"', { stdio: 'ignore' }); } catch {}
  console.log('\n=== Done! ===');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  try { execSync('pkill -f "chromium.*9223"', { stdio: 'ignore' }); } catch {}
  try { execSync('pkill -f "Xvfb :99"', { stdio: 'ignore' }); } catch {}
  process.exit(1);
});
