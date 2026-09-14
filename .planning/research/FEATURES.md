# Feature Research

**Domain:** Personal quick-capture / GTD-style to-do tray (menu bar) app for non-developers, offline-first, Windows + macOS, Korean UI, unsigned public release
**Researched:** 2026-09-14
**Confidence:** MEDIUM (web ecosystem survey = LOW-confidence individually but cross-corroborated across 2+ sources; Electron platform-behavior claims = MEDIUM, sourced from official Electron docs via context7)

## Feature Landscape

### Table Stakes (Users Expect These)

Features a non-developer assumes exist on first run of any quick-capture tray/menu-bar app. Missing these = the app feels broken or untrustworthy, not just "basic."

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sub-3-second single-line quick capture via global hotkey | Things 3, Todoist, TickTick all hit "type and Enter" under 3 seconds; this is the entire value proposition of the category, not a nice-to-have | LOW (already built) | WHENWORK already does this (M1). Keep as-is. |
| Hotkey conflict detection + rebinding UI | Electron's `globalShortcut.register()` **silently fails** (returns `false`, no exception, no OS error) when another app already owns the combo — this is OS-intended behavior, not an Electron bug. Raycast's onboarding is the reference pattern: real-time conflict detection while recording, highlight the owning command, offer "pick another" or "override." A silent failure with no UI is the #1 way a non-developer concludes "the app doesn't work" | MEDIUM | **Currently a gap.** WHENWORK must check the boolean return of `register()` at startup and on every rebind attempt, and show an explicit "hotkey unavailable, pick another" state — not just fail silently into a dead hotkey. |
| Tray/menu-bar icon that is easy to find | Windows 11 hides most tray icons in the overflow/chevron by default; macOS puts them in the menu-bar-extras area which has finite width and can be pushed off-screen by other apps. First-run guidance ("look for the icon, or drag it out of the overflow arrow") is standard, not optional | LOW–MEDIUM | Add a first-run tooltip/toast pointing at the tray icon location, phrased per-OS. On Windows, tell users they may need to drag the icon out of the hidden-icons overflow to keep it visible. |
| Launch at login, as an explicit opt-in toggle | Every reference menu-bar app (Raycast, and general macOS guidance) exposes this as a visible settings toggle rather than enabling it invisibly; macOS itself now pops a system notification whenever a login item registers, so users are primed to expect an explicit toggle they control | MEDIUM–HIGH (macOS risk) | **Critical dependency risk:** Electron's official docs state `app.setLoginItemSettings()` on macOS requires the app to be **code-signed and notarized** to work reliably — unsigned/unpackaged apps may see `openAtLogin` silently fail to take effect. WHENWORK ships unsigned. This must be verified on the actual signed-less macOS build before claiming the feature works; if it's flaky, the toggle needs a "may require re-enabling after update" caveat in the UI, not silence. |
| First-run "it just works" capture — no setup screens before first capture | Category expectation across all competitors: install → hotkey → type → done. Any mandatory account creation, folder picker, or config screen before first capture breaks the core promise | LOW (already true for capture; must stay true after storage swap) | Directly matches PROJECT.md's "설치 파일 하나를 받아 실행한 사람이 ... 절대 잃지 않는다." Do not let the embedded-storage migration introduce a first-run wizard. |
| macOS notification permission handled gracefully | macOS requires explicit user permission for native notifications; Electron's `Notification` class exposes a `failed` event for exactly this failure mode. A morning-brief feature that silently never fires because permission was denied looks like a bug forever | MEDIUM | Morning brief must listen for the `failed` event (or equivalent) and fall back to an in-app indicator, not assume delivery succeeded. |
| Data export for backup/portability | Every mainstream app in this space (Todoist, Toodledo, Reminders-adjacent tools) ships CSV and/or JSON export; it is the default way non-developers understand "my data is safe" without configuring sync | LOW–MEDIUM | Matches PROJECT.md's Active requirement (human-readable export/import in Settings). CSV must be **UTF-8** to avoid mojibake on reimport (relevant given the project's own known BOM/encoding pitfall). |
| Unsigned-app install instructions in README (SmartScreen / Gatekeeper) | Common, well-documented pattern for indie unsigned Electron apps: Windows — "SmartScreen may warn; click More info → Run anyway"; macOS — "Gatekeeper blocks by default; move to Applications, then System Settings → Privacy & Security → Open Anyway" (or right-click → Open) | LOW (docs only) | Not a code feature but a **required deliverable**. Missing this turns "unsigned but free" into "looks malicious, uninstall." Put screenshots, not just text, since the target audience is non-technical. |
| Keyboard-first interaction once the capture/today window is open | Things 3 and Todoist both treat keyboard shortcuts as primary, mouse as secondary, inside their quick-entry and list views | LOW (already built) | WHENWORK already does this (숫자 키 분류, Shift+↑↓ 순서 변경). Keep. |

### Differentiators (Competitive Advantage)

Not required for the category, but where WHENWORK can stand apart for its specific audience (non-developer, offline, no-account, single-machine).

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Append-only local capture queue (crash/storage-outage proof) | Nobody else in this research surfaced a competitor explicitly marketing "capture cannot be lost even if the backend is unavailable" — most cloud apps just retry a network call. A guarantee that capture always succeeds locally first is a genuine differentiator for an offline-first, no-account app | LOW (already built) | Already implemented (M1, `main/queue.mjs`). This is arguably WHENWORK's single strongest differentiator — the "core value" in PROJECT.md. Preserve through the storage-engine swap without exception. |
| `#약어` inline project tagging at capture time | This is **not actually a novel feature** — it matches Todoist's Quick Add syntax almost exactly (`#ProjectName` assigns a project inline). Framing it as a differentiator would be wrong; it is industry-standard convention that non-developers already half-expect from any modern capture box, which is good news: it needs no re-education | LOW (already built) | **Re-classify from "custom feature" to "table stakes, already correctly implemented."** Confidence: the `#` = project convention is corroborated by official Todoist docs. Keep the `#` symbol as-is; do not invent a different sigil. |
| Manual-only inbox triage (no AI classification) | Current research on AI email/task triage explicitly flags a trust problem: AI systems only work "when they extend agency rather than erode it with opaque logic," and one bad auto-classification can cost more trust than the time saved. For a small personal inbox (not 50-500 items/day), manual numeric-key classification is fast enough that AI's speed advantage doesn't apply, while its trust cost still does | LOW (already built) | Directly supports the PROJECT.md decision to drop AI classification. This is a legitimate differentiator to state positively in marketing copy: "no AI decides for you" as a feature, not an absence. |
| Waiting-for as a first-class cross-project view (not just a tag) | Things does this with a plain tag; OmniFocus with a tag + dedicated perspective. WHENWORK already has a *dedicated view*, which is closer to OmniFocus's more structured approach than Things' lighter tag-only approach, without OmniFocus's overall complexity/cost | LOW (already built) | Keep and market plainly as "기다리는 중" or similarly transparent Korean label — the underlying pattern (separate cross-project view) is validated by two major GTD apps, so no structural change is needed, only a rename check (see WHENWORK Feature Mapping below). |
| Morning brief with graceful empty-state fallback | The project's own dogfooding notes (12.8절) already identified the right bar: an automatic feature must "say something useful even when input is empty." No competitor researched does exactly this one-line daily brief; it's a genuine differentiator if the fallback logic holds up | MEDIUM | Already designed with a fallback (say open-item count when nothing urgent). Keep; this is the kind of small, honest automation that fits a no-AI positioning. |
| No account, no sync, no server — single-file/local-store ownership | Positioned correctly against the category's move toward cloud accounts (Todoist, TickTick, Superlist all assume login). For a privacy- and simplicity-conscious non-developer audience, "nothing leaves your machine, nothing to sign up for" is a real selling point, not just cost-cutting | LOW (already true) | State this explicitly in README/marketing — indie/local-first apps researched here explicitly use "your data stays on your device unless you export it" as a trust pitch. |

### Anti-Features (Commonly Requested, Often Problematic)

Things that look attractive for this category but would work against WHENWORK's actual audience and constraints.

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| AI-based inbox classification / done-suggestion / resume cards | Superlist and other 2025-2026 competitors are visibly racing toward AI meeting notes, AI task generation, etc., so it looks like "falling behind" not to have it | Requires a subscription/API-key dependency that breaks "install one file, nothing else" for a non-developer; research on AI triage explicitly finds it erodes trust when opaque, and for personal-scale volume (not 50-500 items/day) the manual cost is already low, so AI's main advantage (time savings at volume) doesn't apply | Keep manual inbox classification (numeric-key assignment) — already fast, already trusted, already built. This matches PROJECT.md's explicit Out of Scope decision |
| Full account + cloud sync across devices | Every major competitor (Todoist, TickTick, Superlist) treats this as core; a user who has used those apps may ask "why can't I use it on my phone too?" | Directly conflicts with "no server, no account" positioning and the 1-person-1-PC constraint in PROJECT.md; multi-device sync adds conflict resolution, auth, and a server WHENWORK explicitly rejected | Export/import as manual migration between machines — already an Active requirement; positioned honestly as "move your data yourself," not sync |
| Auto-update mechanism | Users of any modern app expect it to "just update itself" | electron-updater's typical signed-update-channel flow assumes code signing; an unsigned auto-updater is a security smell (arbitrary unsigned binary silently replacing itself) and was explicitly called out as "half of a feature" without signing | Manual re-download from GitHub Releases for now; revisit once code signing is budgeted (already flagged as a future milestone in PROJECT.md) |
| Full CSV/JSON round-trip interoperability with other GTD apps (Todoist, OmniFocus import) | Seems like an obvious "let me switch over easily" feature | Web research shows this is rare even between major commercial apps (e.g., Todoist's own CSV export excludes completed tasks) — building true cross-app schema mapping is a deep, ongoing maintenance burden for a two-person-scale personal tool | Export is positioned as backup/self-migration only (already the correct framing in PROJECT.md); do not promise interoperability with any named competitor's format |
| Calendar integration (Apps Script / OAuth) | Feels like a natural "see everything in one place" upgrade requested by any experienced GTD user | Already correctly identified in PROJECT.md as personal-Workspace-specific and requiring signing/verification cost disproportionate to a personal tray app; also expands the today-view surface area right when the project is trying to shrink scope | None needed for v1; if ever revisited, treat as a separate, clearly-scoped future milestone, not a roadmap phase in this one |
| Rich multi-level subtasks / nested projects (Superlist-style unlimited nesting) | Competitive pressure — some competitors market unlimited subtask nesting as a differentiator | Adds real UI and data-model complexity (renderer/today.js is already flagged as oversized in the codebase map) for a feature that serves power users, not the stated non-developer audience whose core need is "don't lose the one-liner I just typed" | Keep the existing flat item + project + waiting-for + inbox model; do not add nesting depth in this milestone |

## Feature Dependencies

```
Global hotkey quick capture (existing)
    └──requires──> Hotkey conflict detection UI (gap: must add before non-developer release)
                       └──requires──> Rebinding settings screen (gap: must add)

Embedded local storage engine (new, Active)
    └──requires──> Append-only capture queue kept ahead of it (existing, must survive swap)
    └──requires──> Human-readable export/import (Active) ──validates data ownership without sync
                       └──enhances──> Migration path from Postgres (author-only, Active)

Launch-at-login toggle (table stakes)
    └──risks──> Unsigned macOS distribution (Key Decision) — may silently fail per Electron docs
                   └──requires──> Explicit in-UI fallback messaging if verification shows it's flaky on macOS

Morning brief (existing)
    └──requires──> Notifications permission handling (table stakes gap on macOS)
                       └──requires──> Notification 'failed'-event fallback UI (gap: must add)

Manual inbox classification (existing, kept)
    └──conflicts──> AI-based classification (Out of Scope) — trust/dependency tradeoff, do not combine

#약어 inline project tagging (existing)
    └──enhances──> Today view / inbox routing (existing) — already matches Todoist convention, no rename needed
```

### Dependency Notes

- **Hotkey conflict detection requires a rebinding settings screen:** detecting the silent `false` return from `globalShortcut.register()` is useless without a UI path for the user to choose a new combo — these two must land in the same phase, not split across phases.
- **Embedded storage swap requires the capture queue to survive unchanged:** PROJECT.md's core value ("capture is never lost") is anchored in the queue-then-drain pattern; the new storage engine is a drain target, not a replacement for the queue. Any phase that swaps storage must explicitly re-verify queue behavior, not assume it's unaffected.
- **Launch-at-login risks conflicting with the unsigned-distribution decision:** this is a genuine cross-cutting risk, not just a nice-to-have gap — flag it for its own verification step (test the actual unsigned macOS build) before marking the feature "done."
- **Morning brief requires notification-permission handling:** the feature already exists, but shipping it to macOS non-developers without permission-denied handling turns a differentiator into a silent bug report generator.
- **Manual inbox classification conflicts with AI classification:** these are mutually exclusive positioning choices (trust-through-transparency vs. speed-through-automation); PROJECT.md has already chosen manual, so no phase should reintroduce AI-assisted classification as a "quick win."

## MVP Definition

### Launch With (v1 — this milestone)

- [ ] Hotkey capture with conflict detection + rebinding UI — table stakes gap, prevents silent-failure first-run breakage
- [ ] Tray icon with first-run discoverability guidance (per-OS phrasing) — table stakes, cheap, high non-developer trust payoff
- [ ] Launch-at-login toggle, explicitly verified on an actual unsigned macOS build — table stakes, but carries real platform risk that must be tested, not assumed
- [ ] Notification permission handling with graceful fallback for morning brief — table stakes on macOS, existing feature currently under-protected
- [ ] Human-readable export/import (already Active in PROJECT.md) — table stakes for data ownership without sync
- [ ] Unsigned-install README with per-OS screenshots — table stakes, zero code cost, prevents "looks malicious" abandonment
- [ ] Keep as-is: append-only queue, `#약어` capture, today view, inbox manual classification, waiting-for view, morning brief core logic, keyboard-driven UI

### Add After Validation (v1.x)

- [ ] Code signing + notarization — trigger: launch-at-login or Gatekeeper friction proves to materially hurt non-developer adoption in practice
- [ ] Auto-update mechanism — trigger: only after code signing lands (unsigned auto-update is a security anti-pattern per research)
- [ ] Richer export formats or partial interoperability with one specific competitor (e.g., Todoist CSV) — trigger: real user request, not speculative

### Future Consideration (v2+)

- [ ] Multi-device manual "profile export" workflow beyond simple backup — defer until there's evidence single-PC constraint is actually a blocker for real users, not just a theoretical gap
- [ ] Optional, explicitly-labeled AI features behind a user-supplied API key (not bundled) — defer indefinitely per PROJECT.md's `v-personal` tag strategy; only revisit if the non-developer target audience itself asks for it, not because competitors have it

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|----------------------|----------|
| Hotkey conflict detection + rebind UI | HIGH | MEDIUM | P1 |
| Launch-at-login toggle + macOS verification | MEDIUM | HIGH (platform risk) | P1 |
| Tray discoverability first-run hint | MEDIUM | LOW | P1 |
| Notification permission fallback (morning brief) | MEDIUM | MEDIUM | P1 |
| Export/import (human-readable) | HIGH | MEDIUM | P1 |
| Unsigned-install README with screenshots | HIGH | LOW | P1 |
| Keep existing capture/today/inbox/waiting-for/brief | HIGH | LOW (already built) | P1 |
| Code signing + notarization | MEDIUM | HIGH | P3 |
| Auto-update | LOW–MEDIUM | HIGH | P3 |
| Cross-app import interoperability | LOW | HIGH | P3 |
| AI classification / resume cards / weekly review | LOW (for this audience) | HIGH | Rejected (Out of Scope) |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

## WHENWORK Feature Mapping (Keep / Rename / Drop)

Cross-checking existing WHENWORK features (per PROJECT.md Validated section) against the competitive landscape and the non-developer audience.

| Existing Feature | Category | Recognizable to Non-Developer As-Is? | Action |
|---|---|---|---|
| 트레이 상주 + 글로벌 단축키 원라인 캡처 | Table stakes | Yes — matches the entire category (Raycast/Alfred/Things/Todoist quick-add pattern) | **Keep**, but add conflict-detection UI (currently missing per Electron's silent-fail behavior) |
| 로컬 append-only 큐 (캡처 손실 방지) | Differentiator | Invisible to the user by design — they only notice it when it *works* during a crash | **Keep**, do not surface as a UI concept; state it in README/marketing copy instead ("capture never fails") |
| `#약어` 프로젝트 태깅 | Table stakes (mislabeled as custom) | Yes — directly matches Todoist's `#ProjectName` Quick Add convention | **Keep as-is.** No rename needed; the sigil and behavior already match user mental models from the category leader |
| 오늘 뷰 (지연·오늘 마감·예정·인박스) | Table stakes | Yes — every competitor has some form of "today/overdue/upcoming" default view | **Keep.** Korean labels should stay plain ("지연," "오늘," "예정," "인박스") — these already read as ordinary words, not jargon |
| 프로젝트 CRUD + 순서 변경 | Table stakes | Yes — basic list/project management is assumed in the category | **Keep** |
| 인박스 숫자 키 분류 (수동) | Differentiator (vs. AI competitors) | Mechanic (press a number) needs a one-time visual hint on first use, but the concept "put this loose item into a project" is self-explanatory | **Keep**, add a first-run tooltip explaining the numeric-key mapping once, since non-developers won't guess an undocumented keybinding |
| 대기(waiting-for) 추적 | Differentiator | The word "대기" (waiting) is plain Korean and self-explanatory; the underlying pattern matches Things'/OmniFocus' waiting-tag concept closely enough that no user re-education is needed | **Keep**, no rename required — plain-language label already works |
| 아침 브리핑 (하루 한 번 알림) | Differentiator | Yes, but only if notification permission is granted — currently a silent-failure risk on macOS | **Keep**, but must add permission-denied fallback (see Table Stakes gap above) |
| 창 위치 기억 / 드래그 이동 / 투명 라운드 창 | Table stakes (polish) | Yes — expected baseline UI polish for any modern floating capture window | **Keep**, no changes needed |
| 마감 자연어 파싱 (한국어) | Table stakes | Yes — Todoist/TickTick/Things all do NL date parsing; Korean-only scope is a deliberate, reasonable narrowing per PROJECT.md | **Keep** |
| AI 재개 카드 / 인박스 AI 분류 / 완료 제안 / 주간 리뷰 | Anti-feature for this audience | N/A — being removed | **Drop**, per PROJECT.md Out of Scope. Positioned positively in the anti-features table above as "manual, trust-first" rather than "missing AI" |
| git/gh/glab 수집, 캘린더 연동, Obsidian 볼트 출력 | Anti-feature (dependency-heavy) | N/A — being removed | **Drop**, per PROJECT.md Out of Scope. These require CLI/OAuth setup that directly contradicts "install one file, nothing else" |

## Competitor Feature Analysis

| Feature | Things 3 / OmniFocus (established GTD) | Superlist / Godspeed / Amie (2025-26 AI-forward) | WHENWORK Approach |
|---------|------------------------------------------|----------------------------------------------------|--------------------|
| Quick capture speed | Sub-3-second keyboard entry, no AI | Same speed, plus AI meeting-note-to-task generation on top | Sub-3-second capture, no AI layer — matches the established-GTD tier, deliberately skips the AI-forward tier |
| Project/label tagging at capture | Things: tag-based; OmniFocus: project + tag combined | Superlist: NL parsing extracts project/date/label from a sentence | `#약어` inline syntax — closer to Todoist/Superlist's inline-symbol convention than to Things' separate-tag-picker UI; lower implementation cost, equally recognizable |
| Waiting-for tracking | Things: tag + filter; OmniFocus: tag + dedicated perspective | Rarely a named first-class feature; often folded into generic "snooze"/"someday" | Dedicated waiting-for view, closer to OmniFocus's structured approach, without OmniFocus's overall UI complexity |
| AI-assisted triage/classification | None (established GTD apps deliberately avoid this) | Core differentiator (Superlist AI meeting notes, auto-task generation) | None, by explicit choice — positioned as a trust/simplicity differentiator, not a gap |
| Data export | Toodledo/Todoist-style CSV/JSON, positioned as backup, not sync replacement | Same, though some AI-forward apps de-emphasize local export in favor of account-based sync | Human-readable export/import in Settings, no account required — aligns with established-GTD-tier expectations, deliberately rejects the AI-forward tier's push toward cloud accounts |
| Distribution / signing | Sold via App Store or signed direct download (established apps have commercial budget) | Same — commercial apps, signed, often subscription-gated | Unsigned, free, GitHub Releases only — README must compensate for the trust signal that signing normally provides |

## Sources

- [Things vs OmniFocus vs Todoist: A comparison of the best GTD app suites](https://thesweetsetup.com/articles/comparison-best-gtd-apps-things-todoist-omnifocus/) — LOW confidence (web, single source)
- [Things 3 vs Todoist, TickTick, and OmniFocus for Mac](https://blog.apps.deals/things-3-vs-todoist-ticktick-omnifocus-mac) — LOW confidence
- [Command Aliases & Hotkeys — Raycast Manual](https://manual.raycast.com/command-aliases-and-hotkeys) — LOW confidence, but consistent with Raycast's own documented conflict-recorder UI
- [Alfred vs. Raycast: my constant debate](https://joshcollinsworth.com/blog/alfred-raycast) — LOW confidence
- [Add launch at login setting to a macOS app](https://nilcoalescing.com/blog/LaunchAtLoginSetting/) — LOW confidence
- [macOS Ventura: Controlling Login and Background Items](https://www.iru.com/blog/archive/macos-ventura-login-background-items) — LOW confidence
- [GTD - How do you do Waiting For with Things 3?](https://forum.gettingthingsdone.com/threads/gtd-how-do-you-do-waiting-for-with-things-3.17049/) — LOW confidence (forum), corroborated by a second independent source below
- [OmniFocus Tags Directory - Learn OmniFocus](https://learnomnifocus.com/tags/) — LOW confidence
- [Export for Todoist](https://darekkay.com/todoist-export/) — LOW confidence
- [Import or export a project as a CSV file in Todoist](https://www.todoist.com/help/articles/import-or-export-a-project-as-a-csv-file-in-todoist-YC8YvN) — LOW confidence, official Todoist help doc
- [electron-app/docs/UNSIGNED_APPS.md](https://github.com/daltonmenezes/electron-app/blob/main/docs/UNSIGNED_APPS.md) — LOW confidence (community example), directly usable as a README template
- [Gatekeeper warning when installing app on Mac OS · electron-builder#2582](https://github.com/electron-userland/electron-builder/issues/2582) — LOW confidence
- [Use Task Quick Add in Todoist](https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz) — LOW confidence, official Todoist help doc; confirms `#Project` inline syntax
- [Superlist Review 2026](https://efficient.app/apps/superlist) / [Superlist 2025](https://www.theappadvocate.com/superlist-2025-from-premium-to-do-app-to-ai-powered-productivity-powerhouse/) — LOW confidence
- [Godspeed App Review](https://setapp.com/apps/godspeed/customer-reviews) — LOW confidence
- [AI Email Triage Tools Vs Manual Inbox Zero](https://www.alibaba.com/product-insights/ai-email-triage-tools-vs-manual-inbox-zero-does-smart-sorting-actually-reduce-stress.html) / [What Is AI Inbox Triage?](https://get-alfred.ai/blog/what-is-ai-inbox-triage) — LOW confidence, used only to support the trust-in-manual-triage argument, not as a factual claim about WHENWORK's domain
- Electron official docs (`global-shortcut.md`, `tray.md`, `app.md`, `notification.md`) via context7 `/electron/electron` — **MEDIUM confidence**, official source; these are the most load-bearing claims in this document (silent hotkey-conflict failure, macOS login-item signing requirement, Notification `failed` event) and should be treated as authoritative

---
*Feature research for: personal quick-capture GTD-style tray app, non-developer audience*
*Researched: 2026-09-14*
