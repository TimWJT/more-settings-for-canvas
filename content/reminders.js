// More Settings for Canvas - due-soon reminders on every other https site.
// Waits ~2 s after the page loads, then checks once a minute and whenever the saved reminders change.
// It only redraws when the set of cards (or their "Due in" text) actually changed.
(() => {
  'use strict';
  if (window.top !== window) return;   // top frame only

  let s = null;          // { on, remind, host, reminders }
  let lastKey = null;    // what's on screen now, to skip needless redraws
  let timer = 0;

  function check() {
    if (!s) return;
    // Canvas itself (including the saved extra address) shows its own to-do list instead.
    const skip = s.on === false || !s.remind || location.hostname === s.host || mscIsBuiltInHost(location.hostname);
    const items = skip ? [] : mscReminderUI.pick(s.reminders?.v === 2 ? s.reminders.items : []);
    const now = Date.now();
    const cards = items.map((r) => ({
      title: r.title,
      when: mscReminderUI.dueText(r.due, now),
      url: r.url,
      onDismiss: () => mscReminderUI.dismiss(r.url).catch(() => {}),
    }));
    const key = JSON.stringify(cards.map((c) => [c.url, c.when]));
    if (key === lastKey) return;
    lastKey = key;
    mscReminderUI.show(cards);
  }

  async function start() {
    try {
      s = await browser.storage.sync.get({ on: true, remind: true, host: '', reminders: null });
    } catch {
      return;
    }
    check();
    timer = setInterval(check, 60e3);
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !s) return;
    let relevant = false;
    for (const k of ['on', 'remind', 'host', 'reminders']) {
      if (k in changes) { s[k] = changes[k].newValue ?? (k === 'reminders' ? null : MSC_DEFAULTS[k]); relevant = true; }
    }
    if (relevant) check();
  });

  // Stop the minute timer while the page sits in the back/forward cache.
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = 0; });
  window.addEventListener('pageshow', (e) => { if (e.persisted && s && !timer) { check(); timer = setInterval(check, 60e3); } });

  // document_idle runs after the page has loaded (or nearly); wait 2 s more so we never slow the page down.
  setTimeout(start, 2000);
})();
