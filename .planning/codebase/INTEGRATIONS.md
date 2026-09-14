---
last_mapped_commit: 9d00e31f990696b01cfc743195d7e5b8f553aed4
last_mapped_at: 2026-09-14
---
# External Integrations

**Analysis Date:** 2026-09-14

## APIs & External Services

**AI & Code Generation:**

- Claude (Anthropic) - AI-powered inbox classification, resume card generation, weekly review drafts
  - CLI: `claude.exe` with `-p` flag (subprocess invocation)
  - Auth: OAuth subscription token (managed by `claude` CLI)
  - Invocation file: `main/ai.mjs`
  - Timeout: Default 300 seconds (5 minutes), adjustable
  - Error handling: Distinguishes 529 (server overload), rate limits, auth failures via stdout parsing
  - Usage tracked in `event` table (`ai_call` kind, `ai_fails` detail format)

**Issue Tracking - GitHub:**

- GitHub CLI (`gh`) - Read issue/PR sync for user's repos
  - CLI: `gh issue list`, `gh pr list` with JSON output
  - Auth: Reuses system `gh` CLI authentication (no separate token in app)
  - Scope: Issues authored by or assigned to `@me`, PRs authored or reviewed
  - Invocation file: `main/issues.mjs`
  - JSON fields: number, title, state, updatedAt, url, isDraft
  - Limit: 30 items per query
  - Runs from repo directory so CLI auto-detects remote

**Issue Tracking - GitLab (cloud & self-hosted):**

- GitLab CLI (`glab`) - Read issue/MR sync for user's repos
  - CLI: `glab issue list`, `glab mr list` with JSON output
  - Auth: Reuses system `glab` CLI authentication
  - Scope: Issues authored by or assigned to user, MRs authored or reviewed
  - Invocation file: `main/issues.mjs`
  - User detection: `glab api user` call cached per host to get username
  - JSON fields: iid (not number), title, state, updatedAt, url
  - Limit: 30 items per query
  - Supports self-hosted GitLab (reads from remote URL)

**Calendar:**

- Google Calendar via Apps Script Web App
  - Endpoint: Custom deployed Apps Script web app URL (stored in settings, token-based auth)
  - Protocol: HTTPS GET with query params `back`, `ahead` (days)
  - Response: JSON `{ events: [ { id, title, location, start, end, allDay } ] }`
  - Caching: Results stored in `cal_event` PostgreSQL table
  - Sync: Auto-sync every 15 minutes, manual via settings tab
  - Invocation file: `main/calendar.mjs`
  - Timeout: 20 seconds
  - Error handling: Distinguishes HTTP 401/403 (permission), login page response, malformed JSON

**Version Control:**

- Git - Local repo state scanning and activity collection
  - CLI: `git status`, `git stash list`, `git rev-parse`, `git rev-list`
  - Auth: Via system git credentials/SSH keys
  - Invocation file: `main/repo.mjs`
  - Data collected: Dirty files, stash count + timestamp, ahead commits, branch name
  - Purpose: Identify unfinished work (working copy changes, stashed work, unpushed commits)

## Data Storage

**Databases:**

- PostgreSQL 16 (primary)
  - Connection: `postgresql://whenwork:whenwork@127.0.0.1:5433/whenwork`
  - Client: `pg` npm package
  - Tables: `project`, `item`, `activity`, `issue`, `resume_card`, `cal_event`, `event`, `repo_state`, `review`
  - Deployment: Docker compose (local dev) or external instance
  - Auto-init: Schema created/migrated on first connection via `main/db.mjs`

**File Storage:**

- Local filesystem only (no S3, Azure Blob, etc.)
  - Backup location: `userData/backups/` (JSON files, max 8 kept)
  - Vault location: Obsidian vault path (user-configurable) for weekly review markdown export
  - Settings: `userData/settings.json` (window state, user preferences)
  - Icon cache: `build/icon.png` (app icon used by installer)

**Caching:**

- PostgreSQL tables serve as cache for:
  - GitHub/GitLab issues (read-only, synced every 6 hours)
  - Google Calendar events (read-only, synced every 15 minutes)
  - Git repo state (read-only, synced on demand + background intervals)
  - User-generated resume cards (AI-generated, regenerated as needed)

## Authentication & Identity

**Auth Provider:**

- Custom (CLI-based, delegated to external tools)

**Implementation:**

- `claude.exe` - Managed by Anthropic Claude CLI (`claude login` flows handled externally)
- `gh` - Managed by GitHub CLI (`gh auth login` or env `GITHUB_TOKEN`)
- `glab` - Managed by GitLab CLI (`glab auth login` or env `GITLAB_TOKEN`)
- Google Calendar - Token embedded in Web App URL (static, user provides)
- No centralized auth system; each tool manages its own credentials

**Multi-Account Support:**

- GitHub: Known issue (`#5` in docs) — `gh` CLI supports multi-account but app may select wrong account
  - Workaround mentioned: Manual remote URL config with account specification
- GitLab: No multi-account issue noted (same `glab` config per host)

## Monitoring & Observability

**Error Tracking:**

- None (no Sentry, DataDog, etc.)

**Logs:**

- Console output during `npm start` (development)
- Electron debug logs in `userData/logs/` (if enabled via environment)
- App tracks events in `event` PostgreSQL table (`kind`: ai_call, ai_call_fail, resume_open, project_switch, etc.)

**Metrics Collected:**

- Event log table contains timestamped events for KPI calculation
- Weekly stats aggregated from `event`, `item`, `activity`, `cal_event` tables
- Metrics: captured count, done count, commits, resume opens, project switches, ai_calls, ai_fails, meeting hours

## CI/CD & Deployment

**Hosting:**

- Desktop application (no cloud hosting)
- Installed locally via Windows NSIS installer
- Exe location: `%LOCALAPPDATA%/Programs/WHENWORK/` (per-user install)
- Launcher: Auto-start entry in Windows (if enabled)

**Build Process:**

- `npm run build` — Runs electron-builder to create NSIS .exe in `dist/`
- Icon generation: `node tools/make-icon.mjs` (runs on `postinstall` and `npm run icons`)
- No CI/CD pipeline detected (GitHub Actions, Travis, etc. not configured)

**Distribution:**

- Manual: Build locally, share .exe file or run installer
- Auto-update: Not detected (no electron-updater)
- Single instance: App enforces single running instance via Electron's `requestSingleInstanceLock()`

## Environment Configuration

**Required env vars:**

- None hardcoded; all use defaults or user config
- Optional: `GITHUB_TOKEN` (gh CLI uses if set)
- Optional: `GITLAB_TOKEN` (glab CLI uses if set)
- Optional: `CLAUDE_API_KEY` (claude CLI uses if set)

**Secrets location:**

- PostgreSQL password: Hardcoded default in dev (`main/db.mjs` line 188), env override supported
- GitHub token: Managed by `gh` CLI (typically `~/.config/gh/` on Windows)
- GitLab token: Managed by `glab` CLI (typically `~/.config/glab/` on Windows)
- Claude token: Managed by `claude` CLI
- Calendar token: Stored in `userData/settings.json` (masked in UI but readable from file)

## Webhooks & Callbacks

**Incoming:**

- None (app is purely pull-based, no server listening for webhooks)

**Outgoing:**

- None detected

## Background Tasks & Scheduled Operations

**Collection (Background):**

- Interval: Every 6 hours (`COLLECT_MS = 6 * 60 * 60 * 1000`)
- Delayed start: 30 seconds after app launch (`COLLECT_DELAY_MS`)
- Tasks: Git activity + repo state scan, GitHub/GitLab issue/PR sync
- Files: `main/collect.mjs`, `main/issues.mjs`, `main/repo.mjs`

**Resume Card Generation (Background):**

- Trigger: After each collection cycle
- Scope: Projects with new commits since last card generation
- Stale threshold: 24 hours (cards older than this are eligible for regeneration)
- AI call: Uses `claude.exe` to generate 3-field resume (`last_work`, `stuck_point`, `next_action`)
- Fallback: If AI call fails, card stale but app continues (no blocking)

**Calendar Sync:**

- Interval: Every 15 minutes (manual via settings tab)
- Auto-sync: On app startup (after 30s delay) + periodic
- Source: Google Apps Script web app URL

**Backup:**

- Interval: Daily (auto-triggered once per calendar day)
- Manual: Triggered from tray menu or settings tab
- Scope: All PostgreSQL tables (full export)
- Location: `userData/backups/` with timestamp filename
- Retention: Max 8 most recent backups

**Weekly Review:**

- Trigger: Automatic at end of week (checked daily)
- Condition: If last week's review missing or incomplete (made before Sunday)
- Export: Markdown file to Obsidian vault (`00_業務日誌/YYYY年/MM月/00_週間レビュー_YYYY-Www.md`)
- Fallback: DB-only if vault path not found/configured
- Manual: Triggered from tray menu

**Purge Deleted Items:**

- Interval: On app startup (once)
- Scope: Items marked deleted > 30 days ago (`PURGE_DAYS = 30`)
- Soft delete: Items are marked `deleted_at` but not removed immediately

**Morning Briefing:**

- Trigger: Once per day at configured time (default 09:00)
- Output: Tray notification
- Content: Inbox count, overdue/due today items, stale waiting items, open issues (if active projects), repo state warnings

---

*Integration audit: 2026-09-14*
