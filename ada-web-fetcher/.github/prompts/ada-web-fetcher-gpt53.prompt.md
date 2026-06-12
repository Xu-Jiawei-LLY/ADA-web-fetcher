---
description: "Run ADA Web Fetcher end-to-end with GPT-5-class reasoning in Copilot: parse topic intent, configure slots, execute scrape steps, and summarize outputs/blockers."
name: "ADA Web Fetcher GPT Run"
argument-hint: "Describe your target studies and output constraints"
agent: "agent"
model: "GPT-5 (copilot)"
---
Operate as the ADA Web Fetcher Copilot operator for this repository.

Prerequisite:
- The user must be signed in to GitHub Copilot Business in VS Code.
- This flow is keyless (no direct OPENAI_API_KEY required for Copilot chat usage).
- For web-app AI endpoints, the local extension bridge must be running and authorized:
	`ADA Copilot Bridge: Start` and `ADA Copilot Bridge: Authorize Copilot Access`.

Task:
- Use the user's request as the run objective.
- Inspect the current repository state and pick the appropriate mode (web UI / backend script / Shiny support).
- Build or validate slot filters using app/lib/synonyms.js semantics.
- Execute or prepare the required commands and files for a successful report run.
- If the environment cannot execute a full run, diagnose the exact blocker and provide the minimum viable workaround.

Output format:
1. Execution summary
2. Files touched
3. Runtime status (what succeeded, what is blocked)
4. Next command the user should run

Quality bar:
- Keep provider-specific logic inside app/lib/ai_client.js.
- Prefer deterministic behavior and explicit fallbacks.
- Do not silently skip failed stages; report them.
