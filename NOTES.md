# Developer notes: More Settings for Canvas 1.1.0

Clean-room rewrite, built 2026-11-12 from the feature spec, Canvas's public API docs and Tim's sibling add-ons only.

## Verified (2026-11-12, headless Firefox 160)

- `node --check` passes on every JS file. `npx web-ext lint`: 0 errors, 0 notices, 2 warnings (the same
  `data_collection_permissions` vs `strict_min_version 128` warnings as the other add-ons).
- `tools/test_canvas.py`: **47/47 checks pass**. It runs `tools/fake_canvas.py`, a fake Canvas at
  `https://127.0.0.1:8443` (self-signed certificate) with made-up planner/courses/colours data, and saves
  `127.0.0.1` as the extra Canvas address, so the whole dashboard runs against real API-shaped replies:
  - Popup: renders the 3 tabs, switches and slider save to `storage.sync`, power button off/on with the off bar.
  - Migration: old keys (`enabled`, `canvas_host`, `num_assignments` as text, `assignment_date_format` "mm/dd", ...)
    become the new keys and the old ones (incl. `dark_preset`, `custom_*`, old-shape `reminders`) are removed.
  - Extra address: content scripts get registered for it.
  - Dark mode: filter on `<html>`, inverse filter on background-image elements, turns off live, `mscv-dark` flag.
  - Course cards: due list skips Canvas-completed items, shows past-due unsubmitted, "in 3h"/"1d ago", d/m dates,
    count, cross-off saved in `itemState`. Planner pagination via `Link: rel="next"` and the `while(1);` prefix.
  - To-do: items sorted, red when due within 6 h, Canvas sidebar hidden but Recent feedback kept, announcements,
    menu (focus moves into it), Remove -> Done, Label, "+ Add" own to-do (saved in `myTodos`, course list from
    the API), hover preview as plain text (script tags dropped), 24-hour option live.
  - Notes save 1 s after typing. Compact cards and hide feedback apply live.
  - Power off removes everything live; on brings it back.
  - Reminders: saved from the planner (next 10 days, submitted = -1); example card when switching reminders on;
    on https://example.com the card shows, `shadowRoot` is null to the page, and the title is not in
    `document.body.innerText`, `documentElement.innerText` or the host's `outerHTML`. A real mouse click on the
    dismiss button counts `hidden` up and removes the card; storage changes add/remove cards live.
  - Downloads: refused from any page other than `html/downloader.html`; http, non-Canvas hosts, `..` filenames
    and non-digit course ids are refused.
  - No script errors from the add-on in the browser console during the run.
- Screenshots of the popup, dark/light dashboard and the reminder card were checked by eye.

Run it: `python tools/test_canvas.py OUT_DIR cert.pem key.pem` (make the cert with the openssl line in
`fake_canvas.py`). Needs Selenium and geckodriver (see DESIGN.md "Testing").

## Needs Tim to check on real Canvas (no login here)

- Canvas's real dashboard markup: that the "Due" boxes, notes box and to-do list survive Canvas's React redraws
  (the observer stops once cards and `#right-side` exist, or after 30 s).
- That the real `#right-side` children hide nicely and the Recent feedback block is the one kept.
- That real API replies match the fields used (planner `submissions`, `planner_override`, quizzes `description`).
- Dark mode on real pages: which pictures/videos/iframes look right, Canvas Studio and other embedded players.
- The extra address flow in a normal (non-test) Firefox: Save -> Firefox asks -> "Saved. Reload your Canvas tab."
  If the permission prompt closes the popup, the address is still saved and the background registers it once
  access is given.
- Course file downloader end to end (only its message checks were tested).
- Speed was not benchmarked (no real Canvas page to measure on).

## Design choices

- Everything follows the popup live through `storage.onChanged`; the popup still offers "Reload page" when the
  power state changed on a Canvas tab (spec), though the page has already switched over.
- `settings.js` and `content/reminder-card.js` use `var` at top level: on the extra address both the Canvas scripts
  and the all-sites reminder script load them into the same page, and `const` would throw on the second load.
- Reminders refresh on the dashboard every visit and on other Canvas pages at most once an hour (`remindersAt`
  in `storage.local`), so ordinary Canvas pages don't call the planner API.
- `itemState` keys are a type letter + id (`a12`, `q12`) so an assignment and a quiz with the same id don't clash;
  entries expire 60 days after the item's date and the oldest are dropped near the 8 KB item limit.
- Own to-dos also have a "Delete" menu item (not in the spec) so mistakes can be removed before their date passes.
- The downloader's "Back to settings" link points to `html/popup.html`, which doesn't exist; it's hidden in the
  sidebar, which is the only way the page is opened.
