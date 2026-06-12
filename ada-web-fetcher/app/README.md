# ADA Web Fetcher - Chat Agent

ADA Web Fetcher is a web chat app that scrapes ADA Scientific Sessions abstract
supplements from diabetesjournals.org, filters studies by natural-language
criteria, and generates a structured HTML report. Optionally, it can extract
arm-level efficacy rows from article figures and abstract free text using AI curation.

This app supports two AI operation modes:
- openai_compatible (direct API key)
- copilot_business (keyless mode for users logged into GitHub Copilot)

## Quick start

```bash
cd app
PORT=9876 node server.js
```

Then open the printed URL.

## Platform notes

- The scraper runtime in lib/scraper.js currently expects Linux tooling:
  Xvfb, chromium-browser, pkill, and /tmp paths.
- On Windows, the app needs an adaptation layer (or WSL/Linux container)
  before full scraping can run.

## Main modes

1. Prompt mode
- User describes a topic in natural language.
- App maps text to slot filters, asks for missing required slots, then runs.

2. Reference mode
- User uploads a file containing abstract IDs (for example 1133-OR).
- App resolves those IDs from the supplement and reports matched entries.

## AI mode behavior

The AI toggle controls two tasks only:
- Free-text to slot parsing (/api/ai/parse)
- Figure + abstract text to structured row extraction (AI curation)

For table traceability, `data.csv` now includes:
- `abstract_id` (for example `1225-OR`)
- `source` (`figure`, `abstract`, or `figure,abstract` when duplicate rows were merged)

Article collection, filtering, and report generation remain deterministic
regex/scraper logic.

When AI is unavailable, the app falls back to rule-based slot parsing.

## AI provider configuration

Configuration is in lib/ai_client.js.

### 1) copilot_business (no API key)

```bash
ADA_AI_PROVIDER=copilot_business
```

Behavior in this mode:
- Requires active sign-in to GitHub Copilot in the same runtime environment.
- The web app remains fully runnable.
- AI parsing and vision extraction are served by a local bridge process.
- If the bridge is down or not authorized, parsing falls back to rule-based logic.
- Manual fallback remains available via Copilot prompt `/ADA Web Fetcher GPT Run`.

Bridge option A: VS Code extension (existing flow)
1. Open folder `copilot-bridge-extension` in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. In the Extension Development Host, run command `ADA Copilot Bridge: Authorize Copilot Access`.
4. Keep that Extension Development Host running while using the web app.

Bridge option B: Copilot CLI bridge (no VS Code required)

From project root:

```bash
gh copilot -- login
node copilot-cli-bridge/server.js
```

Or if you are already in `app/`:

```bash
node ../copilot-cli-bridge/server.js
```

Notes:
- Run both commands on the same host where `app/server.js` runs.
- Default bridge URL is `http://127.0.0.1:42175`.
- If port 42175 is occupied, set `COPILOT_BRIDGE_PORT` when starting the bridge and set matching `COPILOT_BRIDGE_URL` for the app.

Optional bridge URL override:

```bash
COPILOT_BRIDGE_URL=http://127.0.0.1:42175
```

### 2) openai_compatible

```bash
ADA_AI_PROVIDER=openai_compatible
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=<your_api_key>
OPENAI_MODEL=gpt-5.3
OPENAI_MODEL_OPUS=gpt-5.3
OPENAI_MODEL_SONNET=gpt-5.3
OPENAI_MODEL_HAIKU=gpt-5.3
```

Notes:
- OPENAI_MODEL_* names are role aliases used by the app's existing call sites.
- For providers with different model IDs, set OPENAI_MODEL_* accordingly.
- If no OPENAI_API_KEY is set and ADA_AI_PROVIDER is unset, the app defaults to
  copilot_business mode.

## API endpoints

- GET /
- GET /static/<file>
- POST /api/start-session
- POST /api/parse
- POST /api/ai/parse
- GET /api/ai/health
- POST /api/run
- GET /api/events/:sessionId
- GET /api/poll/:sessionId
- POST /api/cookies
- POST /api/upload-ref
- GET /api/report/:sessionId
- POST /api/cancel

## File layout

```text
app/
  server.js
  README.md
  public/
    index.html
    style.css
    app.js
  lib/
    synonyms.js
    scraper.js
    report.js
    ai_client.js
  runs/<sessionId>/
```

## Copilot GPT transplant package

This repository now includes workspace Copilot customizations under .github/:
- .github/copilot-instructions.md
- .github/prompts/ada-web-fetcher-gpt53.prompt.md
- .github/instructions/ada-web-fetcher-runbook.instructions.md

Purpose:
- Let users run the workflow from GitHub Copilot chat with GPT-5.3-style models.
- Keep deterministic scraping/report logic in code, while Copilot handles guided
  orchestration and operator prompts.

## Limits

- Single-user process model (in-memory sessions).
- One scraper browser instance per server.
- Manual Cloudflare cookie injection remains intentionally manual.

## Stop

Press Ctrl+C in the terminal running server.js.
