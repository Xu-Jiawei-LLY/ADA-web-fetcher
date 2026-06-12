# ADA Copilot CLI Bridge

Local HTTP bridge for `app/lib/ai_client.js` using GitHub Copilot CLI (`gh copilot`) instead of VS Code extension APIs.

## Endpoints

- `GET /health`
- `POST /chat`
- `POST /json`
- `POST /vision`
- `POST /vision-json`

Default URL: `http://127.0.0.1:42175`

## Start

```bash
gh copilot -- login
node copilot-cli-bridge/server.js
```

Run this on the same machine where ADA Web Fetcher server runs.

## Environment variables

- `COPILOT_BRIDGE_HOST` (default `127.0.0.1`)
- `COPILOT_BRIDGE_PORT` (default `42175`)
- `COPILOT_CLI_MODEL` (optional; defaults to Copilot auto model selection)
- `COPILOT_CLI_TIMEOUT_MS` (default `120000`)
