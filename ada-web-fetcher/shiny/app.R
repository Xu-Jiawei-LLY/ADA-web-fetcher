# ADA Web Fetcher — Shiny chat UI
# Hybrid app: Shiny owns the front-end; the existing Node backend at app/server.js
# handles the Cloudflare-bypassed scraping. Run via "Run App" in RStudio/Workbench
# or `shiny::runApp()`. The Node backend auto-starts if not already running.
#
# Required packages: shiny, httr2, jsonlite, htmltools

library(shiny)
library(httr2)
library(jsonlite)
library(htmltools)

# Null-coalescing helper used throughout
`%||%` <- function(a, b) if (is.null(a) || (is.atomic(a) && length(a) == 0)) b else a

# ─────────────────────── CONFIG ───────────────────────
# Resolve PROJECT_ROOT robustly across launch contexts:
#   - "Run App" in RStudio: getSrcDirectory(function(){}) returns the app.R dir
#   - shiny::runApp("/path"): same — dir of the running app.R
#   - Rscript fallback: hardcoded
.app_dir <- tryCatch(
  {
    d <- getSrcDirectory(function() {})
    if (length(d) > 0 && nzchar(d) && file.exists(file.path(d, "app.R"))) d
    else NA_character_
  },
  error = function(e) NA_character_
)
if (is.na(.app_dir) || !nzchar(.app_dir)) {
  # Final fallback
  .app_dir <- "/home/l033717/ADA web fetcher/shiny"
}
PROJECT_ROOT <- normalizePath(file.path(.app_dir, ".."), mustWork = FALSE)
NODE_PORT    <- 9876
NODE_BASE    <- sprintf("http://127.0.0.1:%d", NODE_PORT)
NODE_SCRIPT  <- file.path(PROJECT_ROOT, "app", "server.js")

# Ensure the runs dir exists before addResourcePath normalizes it
.runs_dir <- file.path(PROJECT_ROOT, "app", "runs")
dir.create(.runs_dir, showWarnings = FALSE, recursive = TRUE)

# Expose the project's existing reports/figures as Shiny resources so the in-app
# "View Report" link works through the Workbench session-proxy URL.
addResourcePath("ada_runs",  .runs_dir)
addResourcePath("ada_static", PROJECT_ROOT)

# ─────────────────────── BACKEND BOOTSTRAP ───────────────────────
backend_alive <- function() {
  res <- tryCatch(
    request(file.path(NODE_BASE, "/")) |> req_timeout(2) |> req_perform(),
    error = function(e) NULL
  )
  !is.null(res) && resp_status(res) == 200
}

ensure_backend <- function() {
  if (backend_alive()) return(TRUE)
  message("Starting Node backend on port ", NODE_PORT, "...")
  log_path <- tempfile("ada-backend-", fileext = ".log")
  cmd <- sprintf("cd %s && PORT=%d nohup node %s > %s 2>&1 &",
                 shQuote(PROJECT_ROOT), NODE_PORT, shQuote(NODE_SCRIPT), shQuote(log_path))
  system(cmd, wait = FALSE)
  for (i in 1:15) {
    Sys.sleep(0.6)
    if (backend_alive()) {
      message("Backend ready on ", NODE_BASE)
      return(TRUE)
    }
  }
  warning("Backend did not become ready within 9 s. Check ", log_path)
  FALSE
}

# Convenience wrappers around the Node API
node_get <- function(path, query = list()) {
  r <- request(file.path(NODE_BASE, path)) |>
    req_url_query(!!!query) |>
    req_timeout(60) |>
    req_perform()
  resp_body_json(r)
}
node_post <- function(path, body = list(), headers = list()) {
  req <- request(file.path(NODE_BASE, path)) |>
    req_method("POST") |>
    req_timeout(60)
  if (length(headers) > 0) req <- do.call(req_headers, c(list(.req = req), headers))
  if (is.character(body) && length(body) == 1) {
    req <- req_body_raw(req, body, type = "text/plain")
  } else if (length(body) > 0) {
    req <- req_body_json(req, body, auto_unbox = TRUE)
  }
  r <- req_perform(req)
  resp_body_json(r)
}

# ─────────────────────── UI ───────────────────────
ui <- fluidPage(
  tags$head(
    tags$title("ADA Web Fetcher"),
    tags$link(rel = "stylesheet", href = "styles.css"),
    tags$meta(name = "viewport", content = "width=device-width, initial-scale=1.0")
  ),
  div(class = "ada-app",
    # Header
    div(class = "ada-header",
      div(class = "brand",
        span(class = "logo", "📚"),
        div(
          h1("ADA Web Fetcher"),
          p(class = "tag", "Chat-driven scraper for diabetesjournals.org abstract supplements")
        )
      ),
      div(class = "header-status",
        textOutput("backend_status", inline = TRUE)
      )
    ),

    # Chat thread
    div(class = "ada-chat", id = "ada-chat",
      uiOutput("chat_thread")
    ),

    # Input row
    div(class = "ada-input",
      div(class = "action-row", uiOutput("action_buttons")),
      div(class = "text-row",
        textAreaInput("user_text", label = NULL, placeholder = "Type your answer here…",
                      width = "100%", rows = 2, resize = "none"),
        actionButton("send_btn", "Send", class = "send-btn"),
        actionButton("file_btn", "📎", class = "file-btn", title = "Upload a reference HTML/CSV"),
        fileInput("file_input", label = NULL, multiple = FALSE,
                  accept = c(".html", ".htm", ".csv", ".txt"),
                  buttonLabel = "Pick file", placeholder = "")
      )
    )
  ),

  # Cookie modal (hidden until needed)
  conditionalPanel(
    condition = "output.show_cookie_modal == true",
    div(class = "ada-modal",
      div(class = "ada-modal-card",
        h2("Cloudflare Cookie Bypass"),
        p(class = "muted", "The site is showing a 'Validate User' challenge. Solve it once in your own browser, copy the cookies, and paste them here. (One-time step per ~30 minutes.)"),
        tags$ol(
          tags$li("Open ", uiOutput("cf_url_link", inline = TRUE), " in a regular browser tab."),
          tags$li("If a 'Validate User' page appears, click ", strong("Take me to my Content"), " and complete the puzzle."),
          tags$li("Wait until the issue page actually loads with the section list."),
          tags$li("Open ", strong("DevTools"), " (", tags$kbd("F12"), ") → ", strong("Network"), " tab."),
          tags$li("Refresh the page (", tags$kbd("Ctrl+R"), "). In the filtered list, click the first row (a ", tags$code("document"), " request to ", tags$code("Supplement_1"), ")."),
          tags$li("In the right pane, scroll to ", strong("Request Headers"), " → find the line starting with ", tags$code("cookie:"), " → right-click → ", strong("Copy value"), "."),
          tags$li("Paste below. The relevant cookies are ", tags$code("cf_clearance"), " and ", tags$code("__cf_bm"), " — anything else is harmless.")
        ),
        textAreaInput("cookie_input", label = NULL, rows = 6, width = "100%",
                      placeholder = "cf_clearance=...; __cf_bm=...; ..."),
        div(class = "modal-actions",
          actionButton("cookie_cancel", "Cancel", class = "btn-secondary"),
          actionButton("cookie_submit", "Inject & Resume", class = "btn-primary")
        )
      )
    )
  )
)

# ─────────────────────── CHAT STATE MACHINE ───────────────────────
# The conversation is driven by `state` which is one of:
#   "welcome"       — initial choice (prompt vs reference)
#   "ask_source"    — asking for the issue URL
#   "ask_topic"     — asking for free-text topic description
#   "fill_<slot>"   — slot-filling for a particular dimension
#   "ask_optional"  — offering to add more optional filters
#   "ask_table"     — asking whether to include data table
#   "confirm"       — final summary + Run/Cancel
#   "running"       — scrape in progress, polling for events
#   "awaiting_cookies" — Cloudflare hit; modal up
#   "done" / "failed" / "cancelled"
#
# `messages` is a list of {role, html} entries. `actions` is a list of
# {label, value} the user can click as quick buttons.

server <- function(input, output, session) {
  # Make sure the backend is up
  alive <- ensure_backend()

  # Session state
  s <- reactiveValues(
    state         = "welcome",
    messages      = list(),
    actions       = list(),
    slots         = list(),
    sourceUrl     = "",
    mode          = "prompt",
    generateTable = TRUE,
    referenceIds  = NULL,
    nodeSession   = NULL,         # session id from /api/start-session
    pollCursor    = 0,
    awaitingSlot  = NULL,         # name of the slot we're currently asking
    optionalQueue = NULL,         # list of optional slot names yet to ask
    showCookieModal = FALSE,
    cookieSourceUrl = "",
    synonymMeta   = NULL          # cached available slots from /api/parse
  )

  output$backend_status <- renderText({
    if (alive) "● online" else "● offline"
  })

  output$show_cookie_modal <- reactive({ s$showCookieModal })
  outputOptions(output, "show_cookie_modal", suspendWhenHidden = FALSE)

  output$cf_url_link <- renderUI({
    a(href = s$cookieSourceUrl, target = "_blank", s$cookieSourceUrl)
  })

  # ─────── helpers ───────
  bot <- function(html) {
    s$messages <- c(s$messages, list(list(role = "bot", html = html)))
    invisible()
  }
  me  <- function(text) {
    s$messages <- c(s$messages, list(list(role = "user", html = htmlEscape(text))))
    invisible()
  }
  log_line <- function(text) {
    s$messages <- c(s$messages, list(list(role = "log", html = htmlEscape(text))))
    invisible()
  }
  set_actions <- function(...) {
    args <- list(...)
    s$actions <- args
  }
  clear_actions <- function() { s$actions <- list() }

  # Render the chat thread
  output$chat_thread <- renderUI({
    div(
      lapply(s$messages, function(m) {
        cls <- paste0("msg msg-", m$role)
        avatar_text <- switch(m$role, user = "You", bot = "A", log = "·", system = "!", "?")
        avatar_div <- if (m$role == "log") NULL else div(class = "avatar", avatar_text)
        bubble <- div(class = "bubble", HTML(m$html))
        if (m$role == "user") {
          div(class = cls, bubble, avatar_div)
        } else {
          div(class = cls, avatar_div, bubble)
        }
      })
    )
  })

  # Render quick-action buttons
  output$action_buttons <- renderUI({
    if (length(s$actions) == 0) return(NULL)
    div(
      lapply(seq_along(s$actions), function(i) {
        a <- s$actions[[i]]
        actionButton(inputId = paste0("act_", i), label = a$label, class = "ada-action-btn")
      })
    )
  })

  # ─────── action button handlers (delegated through observers) ───────
  observe({
    # Watch up to 8 action slots
    lapply(seq_len(8), function(i) {
      btn_id <- paste0("act_", i)
      observeEvent(input[[btn_id]], {
        if (i > length(s$actions)) return()
        action <- s$actions[[i]]
        clear_actions()
        me(action$label)
        handle_answer(action$value)
      }, ignoreInit = TRUE, ignoreNULL = TRUE)
    })
  })

  # ─────── send button (text answer) ───────
  observeEvent(input$send_btn, {
    text <- isolate(input$user_text)
    if (is.null(text) || !nzchar(trimws(text))) return()
    text <- trimws(text)
    updateTextAreaInput(session, "user_text", value = "")
    me(text)
    handle_answer(text)
  })

  # ─────── file upload for reference mode ───────
  observeEvent(input$file_btn, {
    # Just nudge user — the fileInput sits beneath the button
    bot("Use the file picker below to choose an HTML/CSV/text file containing abstract IDs.")
  })

  observeEvent(input$file_input, {
    f <- input$file_input
    if (is.null(f)) return()
    raw <- readLines(f$datapath, warn = FALSE, encoding = "UTF-8")
    content <- paste(raw, collapse = "\n")
    res <- tryCatch(
      node_post("/api/upload-ref", body = content,
                headers = list(`Content-Type` = "text/plain",
                               `X-Session-Id` = s$nodeSession,
                               `X-Filename` = f$name)),
      error = function(e) list(error = e$message)
    )
    if (!is.null(res$error)) {
      bot(paste0("Upload failed: <code>", htmlEscape(res$error), "</code>"))
      return()
    }
    s$referenceIds <- res$ids
    s$mode <- "reference"
    bot(sprintf("Parsed <strong>%d</strong> abstract IDs from <code>%s</code>.<br>%s%s",
                res$count, htmlEscape(f$name),
                paste(htmlEscape(res$ids[seq_len(min(10, length(res$ids)))]), collapse = ", "),
                if (length(res$ids) > 10) sprintf(" and %d more...", length(res$ids) - 10) else ""))
    advance_to("ask_source")
  })

  # ─────── conversation flow ───────
  start_conversation <- function() {
    res <- tryCatch(node_post("/api/start-session"), error = function(e) NULL)
    if (is.null(res) || is.null(res$sessionId)) {
      bot("⚠ Could not contact the backend. Try restarting the Shiny app.")
      return()
    }
    s$nodeSession <- res$sessionId
    bot("Hi — I'm the ADA Web Fetcher. I can scrape an ADA Scientific Sessions abstract supplement and produce a categorized report.<br><br>How would you like to start?")
    set_actions(
      list(label = "💬 Describe a topic", value = "__mode_prompt__"),
      list(label = "📂 Upload a list of IDs", value = "__mode_reference__")
    )
  }

  advance_to <- function(new_state) {
    s$state <- new_state
    if (new_state == "ask_source") {
      bot(paste0("Which supplement issue should I scrape? Type a URL, or click <em>Use default</em> for the ADA 2026 supplement.<br>",
                 "<code>https://diabetesjournals.org/diabetes/issue/75/Supplement_1</code>"))
      set_actions(list(label = "Use default (Vol 75 Suppl 1)", value = "__default_url__"))
    } else if (new_state == "ask_topic") {
      bot(paste0("What topic would you like to research? Describe it however you like — e.g.:<br>",
                 "• <em>HbA1c reduction in Chinese T2D patients</em><br>",
                 "• <em>weight loss in Phase 2/3 obesity RCTs</em><br>",
                 "• <em>cardiovascular outcomes in T2D</em>"))
    } else if (grepl("^fill_", new_state)) {
      slot_name <- sub("^fill_", "", new_state)
      ask_slot(slot_name)
    } else if (new_state == "ask_optional") {
      remaining <- s$optionalQueue
      if (length(remaining) == 0) {
        advance_to("ask_table")
        return()
      }
      slot_meta <- s$synonymMeta$available[[remaining[[1]]]]
      labels <- sapply(remaining, function(n) s$synonymMeta$available[[n]]$label)
      bot(paste0("Want to narrow further? You can set: <strong>",
                 paste(labels, collapse = ", "),
                 "</strong>. Default is no filter for each."))
      set_actions(
        list(label = "Add more filters", value = "__add_more__"),
        list(label = "Use defaults (no filter)", value = "__skip_optional__")
      )
    } else if (new_state == "ask_table") {
      bot("Should I include a data analysis table in the report? (Efficacy data extracted from abstracts.)")
      set_actions(
        list(label = "Yes — include table", value = "__table_yes__"),
        list(label = "No — articles only", value = "__table_no__")
      )
    } else if (new_state == "confirm") {
      summary_html <- sprintf(
        "<strong>Ready to run:</strong><br>• Mode: <code>%s</code><br>• Source: <code>%s</code><br>• Filters: %s<br>• Data table: %s",
        s$mode, htmlEscape(s$sourceUrl),
        if (length(s$slots) == 0) "none (all articles)" else slots_human_readable(s$slots, s$synonymMeta),
        if (s$generateTable) "yes" else "no"
      )
      bot(paste0(summary_html, "<br><br>Proceed?"))
      set_actions(
        list(label = "▶ Run scrape", value = "__run__"),
        list(label = "Cancel", value = "__cancel__")
      )
    } else if (new_state == "running") {
      bot("Starting scrape... progress will stream in below.")
      kick_off_run()
    }
  }

  ask_slot <- function(slot_name) {
    slot_meta <- s$synonymMeta$available[[slot_name]]
    s$awaitingSlot <- slot_name
    bot(sprintf("What about <strong>%s</strong>? <em>(%s)</em>",
                htmlEscape(slot_meta$label), htmlEscape(slot_meta$hint)))
    opts <- slot_meta$options
    btns <- lapply(names(opts), function(k) list(label = opts[[k]]$canonical, value = paste0("__opt_", k)))
    if (!isTRUE(slot_meta$askIfMissing)) {
      btns <- c(btns, list(list(label = "Skip (use default)", value = "__skip__")))
    }
    do.call(set_actions, btns)
  }

  slots_human_readable <- function(slots, meta) {
    parts <- character()
    for (n in names(slots)) {
      m <- meta$available[[n]]
      if (is.null(m)) next
      v <- m$options[[ slots[[n]] ]]
      if (!is.null(v)) parts <- c(parts, sprintf("%s: %s", m$label, v$canonical))
    }
    paste(parts, collapse = " · ")
  }

  handle_answer <- function(value) {
    cs <- s$state

    # Welcome screen
    if (cs == "welcome") {
      if (value == "__mode_prompt__") {
        s$mode <- "prompt"
        advance_to("ask_source")
      } else if (value == "__mode_reference__") {
        s$mode <- "reference"
        bot("Reference mode selected. Click the 📎 button below to pick an HTML/CSV/text file with the abstract IDs you want.")
      }
      return()
    }

    # Source URL
    if (cs == "ask_source") {
      url <- if (value == "__default_url__") "https://diabetesjournals.org/diabetes/issue/75/Supplement_1" else value
      s$sourceUrl <- url
      bot(sprintf("Source set: <code>%s</code>", htmlEscape(url)))
      if (s$mode == "reference") {
        advance_to("ask_table")
      } else {
        advance_to("ask_topic")
      }
      return()
    }

    # Free-text topic
    if (cs == "ask_topic") {
      res <- tryCatch(
        node_post("/api/parse", body = list(text = value)),
        error = function(e) list(error = e$message)
      )
      if (!is.null(res$error)) {
        bot(paste0("Parse failed: <code>", htmlEscape(res$error), "</code>"))
        return()
      }
      s$synonymMeta <- list(available = res$available, order = unlist(res$order))
      s$slots <- res$slots
      if (length(res$slots) > 0) {
        bot(sprintf("I parsed:<br><strong>%s</strong>", res$humanReadable))
      } else {
        bot("I couldn't auto-detect any filters from that — let me ask one slot at a time.")
      }
      # Walk the required slots first
      required <- Filter(function(n) {
        m <- s$synonymMeta$available[[n]]
        isTRUE(m$askIfMissing) && is.null(s$slots[[n]])
      }, s$synonymMeta$order)
      if (length(required) > 0) {
        advance_to(paste0("fill_", required[[1]]))
      } else {
        # Build optional queue
        s$optionalQueue <- Filter(function(n) {
          m <- s$synonymMeta$available[[n]]
          !isTRUE(m$askIfMissing) && is.null(s$slots[[n]])
        }, s$synonymMeta$order)
        advance_to("ask_optional")
      }
      return()
    }

    # Slot fill
    if (grepl("^fill_", cs)) {
      slot_name <- s$awaitingSlot
      if (value == "__skip__") {
        # leave default
      } else if (startsWith(value, "__opt_")) {
        s$slots[[slot_name]] <- sub("^__opt_", "", value)
      }
      s$awaitingSlot <- NULL
      # Find next required
      required <- Filter(function(n) {
        m <- s$synonymMeta$available[[n]]
        isTRUE(m$askIfMissing) && is.null(s$slots[[n]])
      }, s$synonymMeta$order)
      if (length(required) > 0) {
        advance_to(paste0("fill_", required[[1]]))
      } else if (!is.null(s$optionalQueue) && length(s$optionalQueue) > 0) {
        # We're inside optional flow already
        s$optionalQueue <- s$optionalQueue[-1]
        if (length(s$optionalQueue) > 0) {
          advance_to(paste0("fill_", s$optionalQueue[[1]]))
        } else {
          advance_to("ask_table")
        }
      } else {
        # Build optional queue
        s$optionalQueue <- Filter(function(n) {
          m <- s$synonymMeta$available[[n]]
          !isTRUE(m$askIfMissing) && is.null(s$slots[[n]])
        }, s$synonymMeta$order)
        advance_to("ask_optional")
      }
      return()
    }

    # Optional decision
    if (cs == "ask_optional") {
      if (value == "__add_more__" && length(s$optionalQueue) > 0) {
        advance_to(paste0("fill_", s$optionalQueue[[1]]))
      } else {
        advance_to("ask_table")
      }
      return()
    }

    # Data-table choice
    if (cs == "ask_table") {
      s$generateTable <- (value == "__table_yes__")
      advance_to("confirm")
      return()
    }

    # Confirm
    if (cs == "confirm") {
      if (value == "__run__") advance_to("running")
      else { bot("Cancelled. Refresh the page to start a new session."); s$state <- "cancelled" }
      return()
    }
  }

  # ─────── kick off scrape + start polling ───────
  kick_off_run <- function() {
    res <- tryCatch(
      node_post("/api/run", body = list(
        sessionId     = s$nodeSession,
        slots         = if (length(s$slots)) s$slots else list(),
        sourceUrl     = s$sourceUrl,
        mode          = s$mode,
        generateTable = s$generateTable
      )),
      error = function(e) list(error = e$message)
    )
    if (!is.null(res$error)) {
      bot(paste0("Run failed: <code>", htmlEscape(res$error), "</code>"))
      s$state <- "failed"
      return()
    }
    s$pollCursor <- 0
  }

  # Polling loop — runs every 1.5 s while state is running/awaiting_cookies
  observe({
    if (!(s$state %in% c("running", "awaiting_cookies"))) return()
    invalidateLater(1500, session)
    res <- tryCatch(
      node_get(paste0("/api/poll/", s$nodeSession),
               query = list(cursor = s$pollCursor)),
      error = function(e) NULL
    )
    if (is.null(res)) return()
    s$pollCursor <- res$cursor
    for (evt in res$events) {
      if (is.null(evt$type)) next
      if (evt$type == "log") {
        log_line(evt$msg %||% "")
      } else if (evt$type == "awaiting_cookies") {
        s$cookieSourceUrl <- evt$sourceUrl %||% s$sourceUrl
        s$showCookieModal <- TRUE
        s$state <- "awaiting_cookies"
        bot("⚠ Cloudflare blocked — please paste cookies in the dialog.")
      } else if (evt$type == "cookies_accepted") {
        bot("Cookies accepted. Resuming...")
      } else if (evt$type == "done") {
        report_url <- sprintf("/ada_runs/%s/report.html", s$nodeSession)
        bot(sprintf("Done — scraped <strong>%d</strong> articles.<br><a class='report-link' href='%s' target='_blank'>📄 View Report</a>",
                    evt$articleCount %||% 0, report_url))
        s$state <- "done"
      } else if (evt$type == "error") {
        bot(paste0("⚠ ERROR: <code>", htmlEscape(evt$message %||% ""), "</code>"))
        s$state <- "failed"
      }
    }
    # Catch state-only changes (e.g. Node says state=done but no event in this batch)
    if (res$state == "done" && s$state != "done") {
      s$state <- "done"
      report_url <- sprintf("/ada_runs/%s/report.html", s$nodeSession)
      bot(sprintf("Done. <a class='report-link' href='%s' target='_blank'>📄 View Report</a>", report_url))
    }
  })

  # ─────── cookie modal handlers ───────
  observeEvent(input$cookie_submit, {
    cookies <- isolate(input$cookie_input)
    if (!nzchar(trimws(cookies))) return()
    res <- tryCatch(
      node_post("/api/cookies", body = list(sessionId = s$nodeSession, cookies = trimws(cookies))),
      error = function(e) list(error = e$message)
    )
    if (!is.null(res$error)) {
      bot(paste0("Inject failed: <code>", htmlEscape(res$error), "</code>"))
      return()
    }
    s$showCookieModal <- FALSE
    updateTextAreaInput(session, "cookie_input", value = "")
    bot("Cookies injected. The scrape is resuming.")
  })

  observeEvent(input$cookie_cancel, {
    s$showCookieModal <- FALSE
    bot("Cookie injection cancelled. The scrape will hang until you provide cookies or restart the session.")
  })

  # Kick things off
  start_conversation()
}

# ─────────────────────── HELPER ───────────────────────
# (helper moved to top of file for early use)

shinyApp(ui, server)
