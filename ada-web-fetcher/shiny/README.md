# ADA Web Fetcher — R Shiny chat UI

A Shiny app version of the ADA Web Fetcher, friendlier to launch on Posit Workbench
than the raw HTML chat (`../app/`). Same chat-style flow, same cookie-bypass
workflow, same reports — just wrapped in Shiny so Workbench's "Run App" button
gives you a proxy URL automatically.

## Run it

**Option A — Posit Workbench / RStudio "Run App"**

1. Open `app.R` in the editor.
2. Click the green **▶ Run App** button at the top right of the editor.
3. RStudio launches the app and shows it in either the Viewer pane or a new
   browser tab via the session-proxy URL — no port juggling needed.

**Option B — From the R console**

```r
shiny::runApp("/home/l033717/ADA web fetcher/shiny", launch.browser = FALSE)
```

The console prints the URL once Shiny is up.

**Option C — From bash (Rscript)**

```bash
/opt/R/4.5.2/bin/Rscript -e 'shiny::runApp("/home/l033717/ADA web fetcher/shiny", port = 4321, host = "127.0.0.1")'
```

## What happens on launch

1. Shiny app starts.
2. App checks whether the Node backend is reachable on `127.0.0.1:9876`.
3. If not, it spawns the Node server (`PORT=9876 nohup node app/server.js`) in
   the background and waits ~9 seconds for it to come up.
4. Header shows `● online` once the backend responds.
5. Welcome message renders with two quick-action buttons: **Describe a topic**
   or **Upload a list of IDs**.

## Conversation flow

Same as the HTML version (`../app/`):

| State | What you do |
|---|---|
| Welcome | Pick prompt mode or reference mode |
| Source URL | Type/paste the supplement URL or click *Use default* |
| Topic (prompt mode) | Free-text describe the topic; backend rule-based parser fills slots |
| Slot fill | For any unfilled required slot, click an option button; optional slots can be skipped |
| Data table | Yes / No |
| Confirm | Final summary + Run / Cancel |
| Running | Progress messages stream into the chat every 1.5 s |
| Cookie prompt | Modal pops up with DevTools instructions if Cloudflare blocks |
| Done | "View Report" button appears, links to the generated `report.html` |

## Cookie-bypass workflow

Same as before — when `Validate User` blocks the scraper, a modal appears with
the 7-step DevTools copy guide. Paste your cookie string and click **Inject &
Resume**. The scrape continues automatically.

## Required R packages

```r
install.packages(c("shiny", "httr2", "jsonlite", "htmltools"))
```

All four are already installed under R 4.5.2 on this Workbench.

## File layout

```
shiny/
├── app.R               — single-file Shiny app (UI + server + state machine)
├── www/styles.css      — Claude.ai-style chat layout
└── README.md           — this file
```

## Architecture

```
Browser (Workbench session-proxy URL)
   ↓
Shiny app (R)               ← chat UI, slot-filling state machine, file upload, cookie modal
   ↓ httr2 short-poll       ← every 1.5 s while a scrape is running
Node backend (port 9876)    ← Cloudflare-bypassed Chromium, BFS, abstract fetch
   ↓
diabetesjournals.org
```

The Node backend is reused as-is from `../app/`. Reports land in
`../app/runs/<sessionId>/report.html` and Shiny serves them via the resource
path `/ada_runs/...`, so the **View Report** link works through the same
session-proxy URL the chat is using.

## Known limits

- **Single user / single backend.** All Shiny sessions share one `127.0.0.1:9876`
  Node backend. If two users talk to the app at once, requests interleave but
  responses go to the right session because each session has its own
  `nodeSession` ID.
- **Auto data-table extraction is a stub.** Same as the HTML version — the table
  option is wired through but the extractor returns no rows. Vision-based figure
  curation needs a Claude session.
- **Backend lifecycle.** The Node server keeps running even after you stop the
  Shiny app. To stop it: `pkill -f "node app/server.js"` or just leave it (next
  Shiny launch reuses it).

## Troubleshooting

- **"● offline" in the header.** The Node backend didn't start. Check:
  ```bash
  ls /tmp/ada-backend-*.log     # logs from the spawn attempt
  pgrep -af "node app/server"   # is anything running?
  ```
- **Chat doesn't advance after clicking a button.** Try refreshing the page —
  Shiny session state resets cleanly.
- **Report link 404.** The Shiny `addResourcePath("ada_runs", ...)` only takes
  effect at app startup. If you delete `app/runs/<sid>/` manually mid-session,
  restart Shiny.
