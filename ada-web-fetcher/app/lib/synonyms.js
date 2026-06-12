// Slot-filling synonym dictionary for ADA web fetcher.
// Each slot is one filter dimension. The chat flow walks through them in order, asking
// the user to specify or accept the default. matchSlot() returns the canonical key
// for free-text input, e.g. "type 2 diabetes" -> "t2d".

const SLOTS = {
  // ───────────────────────── ENDPOINT ─────────────────────────
  // What the trial is measuring as primary efficacy outcome
  endpoint: {
    label: 'Endpoint',
    label_zh: '主要终点',
    askIfMissing: true,                 // required slot — always ask
    default: null,
    hint: 'e.g., HbA1c reduction, weight loss, blood pressure, LDL change',
    options: {
      hba1c: {
        canonical: 'HbA1c reduction',
        synonyms: ['hba1c', 'a1c', 'hemoglobin a1c', 'glycated hemoglobin', 'glycaemic control', 'glycemic control', 'blood sugar', 'glucose lowering'],
        // Tolerate the journal's text-extraction quirks: subscript renders as
        // separate spans → "HbA 1c" or even "HbA 1 c" with stray spaces.
        // Also: glycaemic (UK) / glycemic (US) control are functional equivalents
        // of "HbA1c" in efficacy abstracts where the metric isn't named.
        regex: '\\bHbA\\s*1\\s*[Cc]\\b|\\bA\\s*1\\s*[Cc]\\b|h[ae]moglobin\\s*A\\s*1\\s*c|glycated\\s*h[ae]moglobin|glyca?emic\\s*control|glyca?emic\\s*reduction'
      },
      weight: {
        canonical: 'Weight reduction',
        synonyms: ['weight loss', 'weight reduction', 'body weight', 'weight change', 'bmi', 'bw', '%cfb body weight', 'kg loss', 'obesity treatment'],
        regex: '\\bweight\\b|\\bBW\\b|\\bBMI\\b|body\\s*weight|kg.{0,15}loss'
      },
      bp: {
        canonical: 'Blood pressure',
        synonyms: ['blood pressure', 'bp', 'sbp', 'dbp', 'systolic', 'diastolic', 'hypertension'],
        regex: '\\b[SD]BP\\b|blood\\s*pressure|systolic|diastolic'
      },
      lipid: {
        canonical: 'Lipid profile',
        synonyms: ['ldl', 'hdl', 'cholesterol', 'triglycerides', 'tg', 'tc', 'lipid', 'lipids'],
        regex: '\\bLDL\\b|\\bHDL\\b|\\bTG\\b|cholesterol|triglycer'
      },
      kidney: {
        canonical: 'Kidney / renal function',
        synonyms: ['kidney', 'renal', 'egfr', 'uacr', 'albuminuria', 'ckd', 'nephropathy'],
        regex: '\\beGFR\\b|\\bUACR\\b|kidney|renal|albuminuri'
      },
      cv: {
        canonical: 'Cardiovascular',
        synonyms: ['cardiovascular', 'cv outcomes', 'mace', 'heart failure', 'stroke', 'mi'],
        regex: '\\bMACE\\b|cardiovascular|heart\\s*failure'
      },
      liver: {
        canonical: 'Liver / MASLD / MASH',
        synonyms: ['liver', 'hepatic', 'masld', 'mash', 'nash', 'nafld', 'liver fat', 'steatosis'],
        regex: '\\bMASLD\\b|\\bMASH\\b|\\bNASH\\b|\\bNAFLD\\b|liver\\s*fat|steatosis'
      },
      safety: {
        canonical: 'Safety / tolerability / PK',
        synonyms: ['safety', 'tolerability', 'pk', 'pharmacokinetic', 'adverse event', 'tolerated'],
        regex: '\\bsafety\\b|\\btolerabilit|pharmacokinet|adverse\\s*event'
      }
    }
  },

  // ───────────────────────── DISEASE ─────────────────────────
  // The disease/condition under study
  disease: {
    label: 'Disease',
    label_zh: '疾病',
    askIfMissing: false,                // optional — defaults to broad scope
    default: 'any',
    hint: 'e.g., type 2 diabetes, obesity, type 1 diabetes',
    options: {
      t2d: {
        canonical: 'Type 2 diabetes',
        synonyms: ['type 2 diabetes', 't2d', 't2dm', 'type 2', 'type ii diabetes', 'niddm', 'non-insulin dependent'],
        regex: 'type\\s*2\\s*diabetes|\\bT2D[Mm]?\\b|type\\s*II\\s*diabetes|\\bNIDDM\\b'
      },
      t1d: {
        canonical: 'Type 1 diabetes',
        synonyms: ['type 1 diabetes', 't1d', 't1dm', 'iddm'],
        regex: 'type\\s*1\\s*diabetes|\\bT1D[Mm]?\\b|\\bIDDM\\b'
      },
      obesity: {
        canonical: 'Obesity / overweight',
        synonyms: ['obesity', 'obese', 'overweight', 'weight management'],
        regex: '\\bobes(e|ity)\\b|overweight'
      },
      pcos: {
        canonical: 'PCOS',
        synonyms: ['pcos', 'polycystic ovary'],
        regex: '\\bPCOS\\b|polycystic\\s*ovary'
      },
      ckd: {
        canonical: 'CKD',
        synonyms: ['ckd', 'chronic kidney disease'],
        regex: '\\bCKD\\b|chronic\\s*kidney'
      },
      any: {
        canonical: '(any disease)',
        synonyms: ['any', 'no filter', 'all', 'whatever'],
        regex: '.*'
      }
    }
  },

  // ───────────────────────── POPULATION ─────────────────────────
  // Geographic or demographic gating on the trial population
  population: {
    label: 'Population',
    label_zh: '研究人群',
    askIfMissing: false,
    default: 'any',
    hint: 'e.g., Chinese, US, adolescent, no filter',
    options: {
      chinese: {
        canonical: 'Chinese / Mainland China',
        synonyms: ['chinese', 'china', 'beijing', 'shanghai', 'guangzhou', 'shenzhen', 'hangzhou', 'mainland china'],
        regex: '\\bChina\\b|\\bChinese\\b|Beijing|Shanghai|Guangzhou|Shenzhen|Hangzhou|Wuhan|Chengdu|Chongqing'
      },
      taiwan_hk: {
        canonical: 'Taiwan / Hong Kong',
        synonyms: ['taiwan', 'taiwanese', 'hong kong', 'hk'],
        regex: '\\bTaiwan\\b|\\bTaiwanese\\b|Hong\\s*Kong'
      },
      us: {
        canonical: 'United States',
        synonyms: ['us', 'usa', 'united states', 'american'],
        regex: '\\bU\\.?S\\.?A?\\b|United\\s*States|\\bAmerican\\b'
      },
      eu: {
        canonical: 'Europe / EU',
        synonyms: ['europe', 'european', 'eu', 'german', 'french', 'uk', 'british'],
        regex: '\\bEurope\\b|\\bEuropean\\b|\\bUK\\b|British|German'
      },
      asia: {
        canonical: 'Asia / Asian',
        synonyms: ['asia', 'asian', 'japan', 'korea', 'korean', 'japanese'],
        regex: '\\bAsia\\b|\\bAsian\\b|Japan|Korea'
      },
      adolescent: {
        canonical: 'Adolescent / pediatric',
        synonyms: ['adolescent', 'pediatric', 'paediatric', 'adolescents', 'children', 'kids', 'youth', 'minors'],
        regex: 'adolescent|pediatric|paediatric|children'
      },
      adult: {
        canonical: 'Adult',
        synonyms: ['adult', 'adults'],
        regex: '\\badult'
      },
      any: {
        canonical: '(any population — no geographic filter)',
        synonyms: ['any', 'no filter', 'global', 'worldwide', 'all'],
        regex: '.*'
      }
    }
  },

  // ───────────────────────── TRIAL TYPE ─────────────────────────
  // What kind of study design / phase
  trial_type: {
    label: 'Trial type',
    label_zh: '试验类型',
    askIfMissing: false,
    default: 'any',
    hint: 'e.g., Phase 2/3 RCT, real-world, all',
    options: {
      phase23_rct: {
        canonical: 'Phase 2/3 randomized trials',
        synonyms: ['phase 2/3', 'phase 2 or 3', 'phase ii/iii', 'rct', 'randomized trials', 'phase 2 phase 3'],
        regex: '\\bphase\\s*(2|3|ii|iii|2[ab]?|3[ab]?|2\\/3|ii\\/iii)\\b'
      },
      phase23: {
        canonical: 'Phase 2/3 (any design)',
        synonyms: ['phase 2', 'phase 3', 'phase ii', 'phase iii'],
        regex: '\\bphase\\s*(2|3|ii|iii|2[ab]?|3[ab]?|2\\/3|ii\\/iii)\\b'
      },
      phase1: {
        canonical: 'Phase 1 / first-in-human',
        synonyms: ['phase 1', 'phase i', 'first in human', 'fih', 'sad', 'mad'],
        regex: '\\bphase\\s*(1|i|1[ab]?)\\b|first.?in.?human'
      },
      rct: {
        canonical: 'RCT (any phase)',
        synonyms: ['rct', 'randomized', 'randomised', 'controlled trial'],
        regex: 'randomi[sz]ed|double[-\\s]?blind|placebo[-\\s]?controlled|active[-\\s]?controlled'
      },
      realworld: {
        canonical: 'Real-world / observational',
        synonyms: ['real world', 'real-world', 'rwe', 'observational', 'cohort', 'retrospective'],
        regex: 'real[-\\s]?world|observational|cohort|retrospective'
      },
      meta: {
        canonical: 'Meta-analysis',
        synonyms: ['meta', 'meta-analysis', 'metaanalysis', 'systematic review'],
        regex: 'meta[-\\s]?analysis|systematic\\s*review'
      },
      preclinical: {
        canonical: 'Preclinical / animal',
        synonyms: ['preclinical', 'pre-clinical', 'animal', 'in vitro', 'mouse', 'rat'],
        regex: 'preclinical|in\\s*vitro|animal\\s*(model|stud)'
      },
      any: {
        canonical: '(any trial type)',
        synonyms: ['any', 'no filter', 'all'],
        regex: '.*'
      }
    }
  },

  // ───────────────────────── SPONSOR / GEOGRAPHIC ─────────────────────────
  // Who sponsors the trial (the company / sponsor's home country)
  sponsor: {
    label: 'Sponsor / Pharma',
    label_zh: '申办方/药企',
    askIfMissing: false,
    default: 'any',
    hint: 'e.g., Chinese pharma, global pharma, Innovent, Eli Lilly',
    options: {
      chinese_pharma: {
        canonical: 'Chinese pharmaceutical companies',
        synonyms: ['chinese pharma', 'china pharma', 'chinese companies', 'innovent', 'hengrui', 'huadong', 'hua medicine', 'gan & lee', 'tonghua dongbao', 'sciwind', 'eccogene', 'cspc', 'fosun', 'hutchmed', 'beigene', 'zai lab', 'jiangsu hengrui', 'salubris', 'kelun', 'hansoh', 'brightgene'],
        regex: 'innovent|hengrui|huadong|hua\\s*medicine|gan\\s*[&]\\s*lee|tonghua|sciwind|eccogene|cspc|fosun|hutchmed|beigene|zai\\s*lab|hansoh|hightide|brightgene|salubris|kelun'
      },
      global_pharma: {
        canonical: 'Global pharma (Lilly, Novo, Sanofi, etc.)',
        synonyms: ['global pharma', 'novo nordisk', 'eli lilly', 'sanofi', 'astrazeneca', 'merck', 'pfizer', 'boehringer', 'bayer', 'roche'],
        regex: 'eli\\s*lilly|novo\\s*nordisk|sanofi|astrazeneca|boehringer|\\bmerck\\b|\\bpfizer\\b|\\bbayer\\b|\\broche\\b'
      },
      // Specific compound mentions get folded into sponsor automatically
      any: {
        canonical: '(any sponsor)',
        synonyms: ['any', 'no filter', 'all'],
        regex: '.*'
      }
    }
  },

  // ───────────────────────── TOPIC TYPE / PRESENTATION ─────────────────────────
  // The presentation venue inside the supplement
  topic_type: {
    label: 'Presentation type',
    label_zh: '报告类型',
    askIfMissing: false,
    default: 'any',
    hint: 'e.g., Oral, Poster, Late-Breaking, Published Only, all',
    options: {
      oral: {
        canonical: 'Oral Presentations',
        synonyms: ['oral', 'oral presentation', 'or'],
        regex: 'Oral\\s*Presentations'
      },
      poster: {
        canonical: 'Poster Presentations',
        synonyms: ['poster', 'p'],
        regex: 'Poster\\s*Presentations'
      },
      late_breaking: {
        canonical: 'Late-Breaking',
        synonyms: ['late breaking', 'late-breaking', 'lb'],
        regex: 'Late\\s*Breaking|Late-Breaking'
      },
      published_only: {
        canonical: 'Published Only',
        synonyms: ['published only', 'pub'],
        regex: 'Published\\s*Only'
      },
      any: {
        canonical: '(all presentation types)',
        synonyms: ['any', 'all', 'no filter'],
        regex: '.*'
      }
    }
  }
};

// Slot order in which the chat asks
const SLOT_ORDER = ['endpoint', 'disease', 'population', 'trial_type', 'sponsor', 'topic_type'];

/**
 * matchSlot(slotName, freeText) → option key (e.g. 'hba1c') or null.
 * Case-insensitive substring match against synonyms; longest synonym wins to avoid
 * "any" greedily matching "anything".
 */
function matchSlot(slotName, freeText) {
  const slot = SLOTS[slotName];
  if (!slot) return null;
  const text = String(freeText || '').toLowerCase().trim();
  if (!text) return slot.default;
  if (text === 'skip' || text === 'default' || text === '-' || text === 'any' || text === 'no filter') {
    return slot.default;
  }

  // Build (key, synonym) pairs sorted by descending length so multi-word synonyms beat single tokens
  const candidates = [];
  for (const [key, opt] of Object.entries(slot.options)) {
    for (const syn of opt.synonyms) {
      candidates.push({ key, syn: syn.toLowerCase(), len: syn.length });
    }
  }
  candidates.sort((a, b) => b.len - a.len);

  for (const c of candidates) {
    // For short synonyms (≤3 chars), require a word boundary to avoid
    // false matches inside other words (e.g. "or" inside "Sponsor").
    if (c.len <= 3) {
      const re = new RegExp('\\b' + c.syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b');
      if (re.test(text)) return c.key;
    } else if (text.includes(c.syn)) {
      return c.key;
    }
  }
  return null;
}

/**
 * parseFreeText(input) → partial slots dict.
 * Lets the user dump everything in one prompt; we extract what we can recognize.
 *
 * Note: any "keyword (syn1; syn2; ...)" parenthesized synonym lists are stripped
 * before slot-matching so they don't confuse `matchSlot`. The synonym lists
 * themselves are returned by parseUserSynonyms() (a separate call) and then
 * merged into the per-slot regex via slotsToRegexes(slots, userSynonyms).
 */
function parseFreeText(input) {
  const cleaned = stripUserSynonyms(input);
  const result = {};
  for (const slotName of SLOT_ORDER) {
    const m = matchSlot(slotName, cleaned);
    if (m && m !== SLOTS[slotName].default) result[slotName] = m;
  }
  return result;
}

/**
 * Strip the "(syn1; syn2; ...)" portions from a free-text input so that
 * matchSlot/parseFreeText see only the canonical keywords.
 *   "Type 2 Diabetes (T2D; T2DM); HbA1c (A1C); Phase 2/3"
 *   → "Type 2 Diabetes ; HbA1c ; Phase 2/3"
 */
function stripUserSynonyms(input) {
  return String(input || '').replace(/\([^()]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * parseUserSynonyms(input) → { slotName: [regexFragment, ...] }.
 *
 * Recognizes the syntax "keyword (syn1; syn2; syn3); keyword2 (syn4); keyword3"
 * — any keyword without parens just contributes no extra synonyms. Each
 * keyword is matched against the existing slot dictionary via matchSlot()
 * to figure out which slot the user-supplied synonyms belong to.
 *
 * The returned values are ALREADY regex-escaped so the caller can OR them
 * straight into the slot regex without re-escaping.
 *
 * Returns {} if the input has no parenthesized lists.
 */
function parseUserSynonyms(input) {
  const out = {};
  const text = String(input || '');
  // Match "keyword (synonyms)" where keyword is some chars before "(", and
  // synonyms is the inside of the parens (no nested parens). Greedy across the
  // string by global flag.
  // Keyword is everything from the previous separator (";"|","|"|" or start)
  // up to the "(" — trim and use as the slot lookup key.
  const re = /([^();,]+?)\s*\(([^()]*)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const keyword = m[1].trim();
    if (!keyword) continue;
    const slot = (function findSlot() {
      for (const slotName of SLOT_ORDER) {
        const k = matchSlot(slotName, keyword);
        if (k && k !== SLOTS[slotName].default) return slotName;
      }
      return null;
    })();
    if (!slot) continue;   // keyword unrecognized — silently ignore extras
    const syns = m[2].split(/[;,|]/).map(s => s.trim()).filter(Boolean);
    if (!syns.length) continue;
    if (!out[slot]) out[slot] = [];
    for (const s of syns) out[slot].push(escapeRegex(s));
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert a filled-in slot map back into regex strings the scraper can use to filter
 * abstracts. Slots set to "any" / their default contribute no constraint.
 *
 * If userSynonyms is provided (the output of parseUserSynonyms), each slot's
 * regex gets `|<user-syn-1>|<user-syn-2>|...` appended. The user's synonyms
 * augment the built-in dictionary — they don't replace it. Word boundaries
 * are added around each user-supplied fragment so partial matches stay safe.
 */
function slotsToRegexes(slots, userSynonyms = {}) {
  const out = {};
  for (const [name, key] of Object.entries(slots)) {
    if (!key) continue;
    const opt = SLOTS[name]?.options?.[key];
    if (!opt || key === SLOTS[name].default || key === 'any') continue;
    let regex = opt.regex;
    const extras = userSynonyms[name];
    if (extras && extras.length) {
      // Each extra is already regex-escaped by parseUserSynonyms. Wrap each in
      // word boundaries so "T2D" doesn't false-match "T2DM" inside other words.
      // Drop boundaries for tokens with non-word leading/trailing chars
      // (e.g. "Phase 3a") because \b behaves oddly there.
      const wrapped = extras.map(e => {
        const head = /^\w/.test(e) ? '\\b' : '';
        const tail = /\w$/.test(e) ? '\\b' : '';
        return head + e + tail;
      });
      regex = regex + '|' + wrapped.join('|');
    }
    out[name] = regex;
  }
  return out;
}

/**
 * humanReadable(slots) → "{canonical1} • {canonical2} • ..."
 */
function humanReadable(slots) {
  const parts = [];
  for (const slotName of SLOT_ORDER) {
    const key = slots[slotName];
    if (!key) continue;
    const opt = SLOTS[slotName].options[key];
    if (opt) parts.push(`${SLOTS[slotName].label}: ${opt.canonical}`);
  }
  return parts.join(' · ');
}

module.exports = { SLOTS, SLOT_ORDER, matchSlot, parseFreeText, parseUserSynonyms, stripUserSynonyms, slotsToRegexes, humanReadable };
