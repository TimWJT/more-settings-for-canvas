# Store listing: More Settings for Canvas

Copy these into the fields on addons.mozilla.org when you submit.

## Name
More Settings for Canvas

## Summary (max 250 characters)
A calmer Canvas: fast dark mode, upcoming work on each course card, a better to-do list with your own items, dashboard notes, due-soon reminders on other sites and a course file downloader.

## Description
(AMO joins plain lines into one paragraph, so the list uses Markdown "- " bullets with blank lines around it.)

Canvas, with the settings it doesn't give you. Every feature is a switch, and one power button turns it all off.

- **Dark mode** that keeps Canvas's colours: only white and light-grey parts turn dark and text stays readable. Course colours, coloured buttons, photos and videos look exactly as before
- **Work due on each course card**: the next few assignments, quizzes and discussions, as "in 3d" or a date. Click one to cross it off
- **A better to-do list** in the dashboard sidebar: To do and Done views, announcements, labels, cross off, your own to-dos, and a details preview on hover
- **Dashboard notes** that save as you type
- **Compact course cards** and **hide recent feedback**
- **Due-soon reminders** in the corner of other websites, which those sites can't read
- **Download course files** by module from a sidebar, with "only new files" and skipping videos and zips

Works on instructure.com Canvas sites and canvas.sydney.edu.au, plus one other Canvas address you can add.

No data collected. Not affiliated with Instructure.

## Categories
Appearance, Other

## Tags
canvas, instructure, dark mode, students, to-do, university

## License
All Rights Reserved

## Support website
https://github.com/TimWJT/more-settings-for-canvas

## Privacy policy
Leave "This add-on has a Privacy Policy" unticked. It collects nothing.

## Notes for the reviewer
- No build step and no minified code. The files you upload are the source.
- Network requests only go to the user's own Canvas site (same origin as the page), using their existing Canvas session, to read the planner, courses, course colours, item details and file lists. Nothing is sent anywhere else.
- Permissions: `storage` (settings), `scripting` (runs the Canvas scripts on the one extra Canvas address the user types, after Firefox asks them; and lets the downloader read the open course), `downloads` (course files, only https URLs on Canvas hosts, from the add-on's own downloader page). The optional `https://*/*` host permission is only requested for that one address.
- The content script on all https sites (`content/reminders.js`) only reads the add-on's saved reminders and draws them in a closed shadow root. It reads nothing from the page.
- Dark mode is a stylesheet (`canvas.css`, active while `<html>` has `data-mscv-dark`) plus `content/dark.js`, which sets an inline dark background or light text colour only on near-white/light-grey parts the stylesheet doesn't cover, and removes those again when dark mode is turned off. It runs in idle time and only looks at newly added elements after the first pass. `content/canvas.js` keeps a one-character flag (`mscv-dark`) in the Canvas page's localStorage so the page doesn't flash white before settings load.
- HTML from Canvas (item descriptions for the hover preview) is turned into plain text with DOMParser + textContent; no innerHTML is used anywhere.
