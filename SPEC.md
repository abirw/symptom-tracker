PERSONAL SYMPTOM TRACKER - PROJECT SPEC

OVERVIEW
A private, personal-use iPhone web app (PWA) for logging health symptoms over time, with tag-based quick entry, free-text notes, and trend visualization. Built to be added to the iOS home screen - no App Store, no Apple Developer account, no backend server, no accounts or logins.

CORE PRINCIPLES
- Local-first, privacy-first. All data stays on-device (IndexedDB). No network calls, no analytics, no third-party services. Nothing to leak.
- Fast to log. Logging an entry should take a few seconds - tag(s), optional severity, optional note. Never require every field.
- Grow as you go. Tags and conditions aren't a fixed list; new ones can be created inline while logging.
- Export anytime. A manual export button that outputs all data as a portable file (JSON and/or CSV) for backup and for analysis on a laptop.

TECH STACK
- Plain HTML/CSS/JS (or a lightweight framework if Claude Code prefers - keep it simple, no build complexity required for a personal single-user app)
- IndexedDB for storage (via a small wrapper library like idb, or hand-rolled - Claude Code's call)
- A charting library for the trend view (e.g. Chart.js - lightweight, good iOS Safari support)
- Web App Manifest + Service Worker for installability and offline support
- Hosted on GitHub Pages (or Netlify/Vercel) over HTTPS - required for "Add to Home Screen" to behave correctly
- Important: manifest display must be set to "standalone" or "fullscreen" - this exempts the app's local storage from Safari's 7-day inactivity data-clearing policy (only applies to plain browser tabs, not home-screen apps with this display mode)

DATA MODEL

Entry
- id: string (uuid)
- timestamp: ISO 8601 datetime (auto-captured at creation, but editable in case logging is retrospective)
- tags: string array (one or more; free-growing list, see below)
- condition: string or null (which consultant/issue this relates to, free-growing list, see below)
- severity: integer 1 to 5, or null (single value per entry, optional)
- note: string (free text, optional but usually the main content)

Tag (grows as you go)
- name: string
- firstUsed: ISO date (auto-set when tag is first created)
- color: optional, for visual distinction in timeline/charts
Store firstUsed per tag - this is what powers the "don't make it look like sudden onset" requirement below.

Condition (grows as you go)
- name: string (e.g. "Neurology - Dr. Smith" or "Migraines")
- createdAt: ISO date

FEATURES (V1)

1. Log Entry Screen
- Tag picker: existing tags as tappable chips, plus text input to type a new one (creates it on the fly).
- Condition picker: same pattern.
- Severity: single 1 to 5 selector, skippable.
- Free text field, multi-line.
- Timestamp: auto-filled to "now," editable for retrospective logging.
- Save button, fast enough to use one-handed.

2. Timeline View
- Reverse-chronological list, "commit history" style - each entry shows date/time, tag chips, severity indicator, note preview.
- Filterable by tag and/or condition.
- Tap an entry to view full note, edit, or delete.

3. Trends View (basic charts)
- Per-tag frequency over time (count per week/month).
- Severity trend line, per tag or overall.
- Critical requirement: each tag's chart must start from that tag's actual firstUsed date, not the earliest possible date - so a symptom you've had for years but only started logging 2 weeks ago doesn't look like sudden onset. Add a visual marker/annotation noting "tracking started" vs implying symptom onset.
- Date range filter (last 30/90/365 days, all time).

4. Export
- One button: export all data as JSON (full fidelity) and/or CSV (for spreadsheet analysis).
- Uses the iOS share sheet (Files, AirDrop, email, etc.).
- No auto-sync, no cloud - export is a deliberate user action.

EXPLICITLY OUT OF SCOPE FOR V1 (FUTURE PHASES)
- Text analysis / NLP on free-text notes for pattern surfacing - planned later, once there's real data.
- Multi-device sync (Google Sheets, iCloud, etc.) - not needed; local plus manual export covers current needs.
- Reminders/notifications to log.
- Any backend, account system, or cloud storage.

NON-FUNCTIONAL REQUIREMENTS
- Must work fully offline after first load.
- Must be installable via "Add to Home Screen" with a proper manifest and icons.
- No external analytics or tracking scripts of any kind.
- Handle limited device storage gracefully - text diary is small, avoid caching unnecessary assets.

SUGGESTED BUILD ORDER FOR CLAUDE CODE
1. Scaffold project (HTML/CSS/JS, manifest, service worker, IndexedDB setup).
2. Build Log Entry screen with tag/condition create-on-the-fly, save to IndexedDB.
3. Build Timeline view reading from IndexedDB, with filters.
4. Add Export (JSON + CSV).
5. Add Trends view with charts, respecting per-tag firstUsed cutoff.
6. Deploy to GitHub Pages, test "Add to Home Screen" on device, confirm offline behavior.
7. Polish UI/UX pass.