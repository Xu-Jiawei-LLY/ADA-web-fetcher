---
description: "Use when running or modifying ADA Web Fetcher workflows, including slot parsing, scrape orchestration, report generation, and AI provider wiring."
---
# ADA Web Fetcher Runbook

## 1. Confirm runtime context

- Verify whether the user wants web UI mode (app/server.js), Shiny mode (shiny/app.R), or both.
- Confirm OS constraints before execution. The scraper runtime currently expects Linux tooling.

## 2. Map user intent to filters

- Translate requests into slots from app/lib/synonyms.js:
  endpoint, disease, population, trial_type, sponsor, topic_type.
- Keep required/optional semantics aligned with synonyms.js.

## 3. Preserve two-pass filtering behavior

- Do not collapse title-anchor and abstract passes.
- Keep reverse-search recovery logic unless user asks to redesign it.

## 4. AI mode handling

- AI mode only affects free-text slot parsing and figure curation.
- Keep deterministic filtering and report generation independent from AI availability.
- Ensure failures in AI calls always degrade to rule-based behavior when possible.

## 5. Reporting requirements

- Report should still include company/compound groupings and source links.
- If data table extraction is enabled, preserve row schema fields used by report.js.

## 6. Change discipline

- Prefer focused edits in app/lib/ai_client.js for provider changes.
- Reflect behavior updates in app/README.md and any user-facing labels.
- Run diagnostics on changed files and call out remaining environmental blockers.
