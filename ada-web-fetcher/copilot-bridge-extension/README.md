# ADA Copilot Bridge Extension

This extension exposes a local HTTP bridge so `app/lib/ai_client.js` can use the
GitHub Copilot Business model session from VS Code without requiring an API key.

## Endpoints

- `GET /health`
- `POST /chat`
- `POST /json`
- `POST /vision`
- `POST /vision-json`

Default bridge URL: `http://127.0.0.1:42175`

## Commands

- `ADA Copilot Bridge: Start`
- `ADA Copilot Bridge: Stop`
- `ADA Copilot Bridge: Status`
- `ADA Copilot Bridge: Authorize Copilot Access`

Run **Authorize Copilot Access** once after installation to grant language model
consent for this extension.

## Notes

- Requires sign-in to GitHub Copilot Business in VS Code.
- Bridge traffic is local only (`127.0.0.1` by default).
