# Developer notes: More Settings for Canvas 1.1.0

Clean-room rewrite, built 2026-11-12 from the feature spec, Canvas's public API docs and Tim's sibling add-ons only.

## Verified (2026-11-12, headless Firefox 160)

- `node --check` passes on every JS file. `npx web-ext lint`: 0 errors, 0 notices, 2 warnings (the same
  `data_collection_permissions` vs `strict_min_version 128` warnings as the other add-ons).
- `tools/test_canvas.py`: **57/57 checks pass** (re-run 2026-11-12 after the new dark mode). It runs `tools/fake_canvas.py`, a fake Canvas at
  `https://127.0.0.1:8443` (self-signed certificate) with made-up planner/courses/colours data, and saves
  `127.0.0.1` as the extra Canvas address, so the whole dashboard runs against real API-shaped replies:
  - Popup: renders the 3 tabs, switches and slider save to `storage.sync`, power button off/on with the off bar.
  - Migration: old keys (`enabled`, `canvas_host`, `num_assignments` as text, `assignment_date_format` "mm/dd", ...)
    become the new keys and the old ones (incl. `dark_preset`, `custom_*`, old-shape `reminders`) are removed.
  - Extra address: content scripts get registered for it.
  - Dark mode: dark page and cards on the dashboard, card picture and course colour untouched, turns off
    live with no inline changes left, `mscv-dark` flag. On `/darktest` (fake course page): a white box with a hashed
    InstUI-like class, inline `background:#fff;color:#333` content, `.fc`, `.tox` toolbar, a grey button, a box
    added later and a same-origin iframe all turn dark; main text contrast >= 4.5 (measured 12.8-15.3); TinyMCE icons
    light; course card `#e66135`, red danger button, green label, calendar event and a pale-yellow note keep their
    exact computed colours; the image is untouched; turning dark off gives back exactly the original computed colours.
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
- Dark mode on real pages: InstUI parts (modals, popovers, trays), the gradebook, calendar, rich content editor and
  its iframe, LTI tools, course content with its own colours. Pale tints (light yellow/blue notes, gradebook state
  colours) are kept light on purpose; check they don't look out of place.
- The extra address flow in a normal (non-test) Firefox: Save -> Firefox asks -> "Saved. Reload your Canvas tab."
  If the permission prompt closes the popup, the address is still saved and the background registers it once
  access is given.
- Course file downloader end to end (only its message checks were tested).
- Speed on a real Canvas page. On the fake pages dark.js's first pass took ~1 ms on the dashboard (9 elements
  checked, cards come later through the observer) and 80-91 ms of work in 14-16 idle slices (~160 ms wall time) on a
  6,000-element page with 4,000 changes. Set `localStorage['mscv-dark-timing'] = '1'` on a Canvas page and read
  `data-mscv-timing` on `<html>` after load to see the numbers there.

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
- Dark mode (2026-11-12, replaces the old whole-page colour inversion, which shifted course and brand colours): `canvas.css` has
  the "Charcoal" palette (`--msc-page` #161616, `--msc-surface` #1e1e1e, `--msc-raised` #262626, `--msc-border`
  #3a3a3a, `--msc-text` #ececec, `--msc-muted` #a9a9a9, `--msc-link` #7cc4ff) and short rules for the page shell,
  plain elements, jQuery UI, FullCalendar, TinyMCE chrome and SlickGrid. `content/dark.js` only changes backgrounds
  that are near-white (luminance > 0.85, chroma <= 0.06, alpha > 0.5) and greyish text with contrast < 3 on a dark
  background; it never touches media, svg, background images, our own parts or editable content (inline styles there
  would be saved into the user's work). Same-origin iframes with a light page get a small `<style id="mscv-dark-frame">`;
  the rich content editor's text is therefore dark-styled only through that sheet, not inline.
