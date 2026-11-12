// Draws due-soon reminder cards in the bottom-right corner of a page.
// Privacy: everything lives in a CLOSED shadow root, with its styles inside it. The page's own scripts can see an
// empty <msc-reminders> element but can't read the titles or links in it, and the page's CSS can't reach in.
// "var" + reuse: this file can be loaded twice on the extra Canvas address (see settings.js).
var mscReminderUI = globalThis.mscReminderUI || (() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  let host = null;
  let stack = null;
  let shownUrls = new Set();

  const STYLE = `
    :host { all: initial; }
    .stack { display: flex; flex-direction: column; gap: 10px; align-items: flex-end;
      font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .card { box-sizing: border-box; width: 300px; display: grid; grid-template-columns: auto 1fr auto; gap: 10px;
      align-items: start; padding: 12px 10px 12px 12px; border-radius: 12px; background: #ffffff; color: #1f1f1f;
      box-shadow: 0 6px 24px #0000002e, 0 0 0 1px #00000014; }
    .card.enter { animation: slide .22s ease-out; }
    @keyframes slide { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .card.enter { animation: none; } }
    svg { width: 28px; height: 28px; display: block; }
    .text { display: grid; gap: 2px; min-width: 0; }
    .title { font-weight: 650; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
    a.title:hover { text-decoration: underline; }
    .when { color: #c4161f; font-size: 13px; font-weight: 600; }
    .note { color: #5b5b5b; font-size: 12.5px; }
    .x { all: unset; box-sizing: border-box; width: 28px; height: 28px; border-radius: 8px; display: grid;
      place-items: center; cursor: pointer; color: #5b5b5b; font-size: 20px; line-height: 1; }
    .x:hover { background: #0000000f; color: #1f1f1f; }
    :is(.x, a.title):focus-visible { outline: 2px solid #c4161f; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .card { background: #242424; color: #ececec; box-shadow: 0 6px 24px #00000080, 0 0 0 1px #ffffff1a; }
      .when { color: #ff8a8f; }
      .note, .x { color: #b0b0b0; }
      .x:hover { background: #ffffff14; color: #ececec; }
      :is(.x, a.title):focus-visible { outline-color: #ff8a8f; }
    }`;

  // Our own little icon: a red rounded square with a clock face.
  function icon() {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 28 28');
    svg.setAttribute('aria-hidden', 'true');
    const add = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      svg.append(n);
    };
    add('rect', { x: '1', y: '1', width: '26', height: '26', rx: '7', fill: '#e4202e' });
    add('circle', { cx: '14', cy: '14', r: '7.5', fill: 'none', stroke: '#fff', 'stroke-width': '2' });
    add('path', { d: 'M14 9.8V14l2.8 1.8', fill: 'none', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round' });
    return svg;
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('msc-reminders');
    // Inline !important so ordinary page CSS can't move or hide it by accident.
    const pin = { position: 'fixed', right: '16px', bottom: '16px', 'z-index': '2147483647', display: 'block',
      margin: '0', padding: '0', border: '0', background: 'none', width: 'auto', height: 'auto' };
    for (const [k, v] of Object.entries(pin)) host.style.setProperty(k, v, 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    stack = document.createElement('div');
    stack.className = 'stack';
    stack.setAttribute('role', 'region');
    stack.setAttribute('aria-label', 'Canvas reminders');
    shadow.append(style, stack);
    shownUrls = new Set();
    // On <html>, not <body>, so it's not part of the page's body text.
    document.documentElement.append(host);
  }

  // cards: [{ title, when, url (or null), note, onDismiss }]
  function show(cards) {
    if (!cards.length) { clear(); return; }
    ensureHost();
    const nextUrls = new Set();
    stack.textContent = '';
    for (const c of cards) {
      const id = c.url || c.title;
      nextUrls.add(id);
      const card = document.createElement('div');
      card.className = 'card' + (shownUrls.has(id) ? '' : ' enter');
      const text = document.createElement('div');
      text.className = 'text';
      let title;
      if (c.url) {
        title = document.createElement('a');
        title.href = c.url;
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
      } else {
        title = document.createElement('span');
      }
      title.className = 'title';
      title.textContent = c.title;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = c.when;
      text.append(title, when);
      if (c.note) {
        const note = document.createElement('span');
        note.className = 'note';
        note.textContent = c.note;
        text.append(note);
      }
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'x';
      x.setAttribute('aria-label', 'Dismiss reminder');
      x.title = 'Dismiss reminder';
      x.textContent = '×';
      x.addEventListener('click', () => { card.remove(); if (!stack.children.length) clear(); c.onDismiss?.(); });
      card.append(icon(), text, x);
      stack.append(card);
    }
    shownUrls = nextUrls;
  }

  function clear() {
    host?.remove();
    host = null;
    stack = null;
    shownUrls = new Set();
  }

  // "Due in 3 days" / "Due in 5 hours" / "Due in 20 minutes".
  function dueText(due, now = Date.now()) {
    const ms = due - now;
    if (ms <= 0) return 'Due now';
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    if (ms < 3600e3) return 'Due in ' + plural(Math.max(1, Math.round(ms / 60e3)), 'minute');
    if (ms < 86400e3 * 1.5) return 'Due in ' + plural(Math.round(ms / 3600e3), 'hour');
    return 'Due in ' + plural(Math.round(ms / 86400e3), 'day');
  }

  // Which saved reminders to show now: not dismissed and due within ~12 days,
  // or dismissed once and due within 2 hours. Soonest first, at most 3.
  function pick(items, now = Date.now()) {
    return (Array.isArray(items) ? items : [])
      .filter((r) => r && typeof r.title === 'string' && typeof r.url === 'string' && r.url.startsWith('https://') && r.due > now)
      .filter((r) => (r.hidden === 0 && r.due - now <= 12 * 86400e3) || (r.hidden === 1 && r.due - now <= 2 * 3600e3))
      .sort((a, b) => a.due - b.due)
      .slice(0, 3);
  }

  // Dismiss button: count up "hidden" on the saved record (0 -> 1 shows again 2 hours before, 1 -> 2 never again).
  async function dismiss(url) {
    const { reminders } = await browser.storage.sync.get('reminders');
    if (!reminders || reminders.v !== 2 || !Array.isArray(reminders.items)) return;
    const items = reminders.items.map((r) => (r.url === url && r.hidden >= 0 ? { ...r, hidden: r.hidden + 1 } : r));
    await browser.storage.sync.set({ reminders: { v: 2, items } });
  }

  return { show, clear, dueText, pick, dismiss };
})();
