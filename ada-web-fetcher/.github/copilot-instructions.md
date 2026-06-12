# ADA Web Fetcher - Project Guidelines

## Scope

Use this repository to run and evolve the ADA abstract scraping workflow.
Prefer changing deterministic scraper and report code over adding fragile prompt-only logic.

## Architecture

- app/server.js orchestrates chat sessions, scraping stages, and report emission.
- app/lib/scraper.js performs browser/CDP navigation and abstract/disclosure fetches.
- app/lib/synonyms.js is the source of truth for slot definitions and regex mapping.
- app/lib/ai_client.js is provider-pluggable and should remain the only model backend integration point.

## AI provider rules

- Keep server and UI provider-neutral: say "AI" unless provider-specific behavior is required.
- Do not hardcode model family names in workflow text.
- For model changes, prefer env vars over code edits.

## Safety and reliability

- Preserve manual Cloudflare cookie injection behavior.
- Keep rule-based fallback paths intact when AI parsing or vision fails.
- Avoid changing slot canonical keys unless all downstream logic and reports are updated.

## Validation

After edits, run diagnostics on modified JS/R files and summarize user-visible behavior changes.
If local runtime tools are missing, report the blocker and provide exact next commands for the user environment.
