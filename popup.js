'use strict';

// Every setting, grouped into tabs and cards. Short cards first, long ones last (two columns).
// switches: [key, label, hint]  ·  checks: [key, label] (sub-options of the card's switch)  ·  range: [key, label]
const TABS = [
  {
    id: 'dashboard', label: 'Dashboard',
    cards: [
      {
        title: 'Look',
        switches: [
          ['dark', 'Dark mode', 'Photos keep their colours'],
          ['compactCards', 'Compact cards', 'Shorter course card tops'],
        ],
      },
      { title: 'Notes', switches: [['notes', 'Show notes', 'A notes box above your courses']] },
      {
        wide: true,
        title: 'Course cards',
        switches: [['cardDue', 'Show work due', 'Upcoming work under each course card']],
        checks: [
          ['cardRelative', 'Show "in 3d" instead of dates'],
          ['cardDayFirst', 'Write dates as day/month'],
          ['cardPastDue', 'Include past-due work'],
        ],
        range: ['cardCount', 'Items per card'],
      },
    ],
  },
  {
    id: 'todo', label: 'To-do',
    cards: [
      { title: 'Feedback', switches: [['hideFeedback', 'Hide feedback', 'The "Recent feedback" block']] },
      {
        wide: true,
        title: 'To-do list',
        switches: [['todo', 'Show to-do list', 'Replaces the right sidebar on the dashboard']],
        checks: [
          ['todoPreview', 'Preview details on hover'],
          ['todoHideDone', 'Hide submitted work'],
          ['todoPastDue', 'Show past-due work'],
          ['todo24h', 'Use 24-hour times'],
          ['todoColours', 'Colour titles by course'],
        ],
        range: ['todoCount', 'Items shown'],
      },
    ],
  },
  {
    id: 'more', label: 'More',
    cards: [
      { title: 'Reminders', switches: [['remind', 'Show reminders', 'On other sites when work is due soon']] },
      { title: 'Course files', files: true },
      { wide: true, title: 'Canvas address', host: true },
    ],
  },
];

const $ = (id) => document.getElementById(id);
const save = (obj) => browser.storage.sync.set(obj);
let current = { ...MSC_DEFAULTS };
let canvasTab = null;     // the active tab, if it's a Canvas page
let startedOn = true;     // power state when the popup opened

function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}

// Inputs stay in sync with storage (another window can change a setting while the popup is open).
const bound = new Map();
function bind(key, input) {
  bound.set(key, [...(bound.get(key) || []), input]);
  return input;
}
function bindCheckbox(input, key) {
  input.checked = !!current[key];
  input.addEventListener('change', () => save({ [key]: input.checked }));
  return bind(key, input);
}

function switchRow([key, label, hint]) {
  const input = bindCheckbox(h('input', { type: 'checkbox', role: 'switch' }), key);
  return h('label', { class: 'row' },
    h('span', { class: 'switch' }, input, h('span', { 'aria-hidden': 'true' })),
    h('span', { class: 'label' },
      h('span', { class: 'name' }, label),
      hint ? h('small', {}, hint) : null));
}

function checkRow([key, label]) {
  const input = bindCheckbox(h('input', { type: 'checkbox' }), key);
  return h('label', { class: 'check' }, input, h('span', { class: 'box', 'aria-hidden': 'true' }), h('span', {}, label));
}

// Slider from 1 to 10 with the number next to it.
function rangeRow([key, label]) {
  const id = 'range-' + key;
  const input = h('input', { type: 'range', id, min: '1', max: '10', step: '1' });
  const out = h('output', { for: id, 'aria-hidden': 'true' });
  input.value = current[key];
  out.textContent = current[key];
  input.addEventListener('input', () => { out.textContent = input.value; });
  input.addEventListener('change', () => save({ [key]: Number(input.value) }));
  bind(key, input);
  bind(key, out);
  return h('div', { class: 'step-field' }, h('label', { for: id }, label), h('span', { class: 'range' }, input, out));
}

// "Download course files": opens the downloader in Firefox's sidebar, straight from the click.
function filesBlock() {
  return h('div', { class: 'files' },
    h('button', {
      type: 'button', class: 'btn primary big',
      onclick: () => { browser.sidebarAction.open(); window.close(); },
    }, 'Download course files'),
    h('small', { class: 'note' }, 'Open a course in Canvas first. The list opens in the sidebar.'));
}

// The one extra Canvas address (for schools not on instructure.com).
function hostBlock() {
  const input = h('input', {
    type: 'text', id: 'host-input', placeholder: 'canvas.school.edu', spellcheck: 'false', autocomplete: 'off',
    'aria-describedby': 'host-status',
  });
  input.value = current.host;
  const status = h('p', { class: 'host-status', id: 'host-status', role: 'status' });
  const setStatus = (text, bad = false) => { status.textContent = text; status.classList.toggle('bad', bad); };

  const saveHost = () => {
    const host = mscCleanHost(input.value);
    if (host === null) return setStatus('Type just the address, like canvas.school.edu', true);
    if (host === '') {
      save({ host: '' });
      return setStatus('Removed. Only instructure.com and canvas.sydney.edu.au are used now.');
    }
    if (mscIsBuiltInHost(host)) {
      input.value = host;
      return setStatus('That address already works. Nothing to add.');
    }
    input.value = host;
    // Ask Firefox first, straight from the click (it only allows the question during a click).
    // Save at the same time: if Firefox closes the popup for its question, the background still picks it up.
    const asked = browser.permissions.request({ origins: [`https://${host}/*`] });
    save({ host });
    asked.then((ok) => {
      if (ok) setStatus('Saved. Reload your Canvas tab.');
      else setStatus("Firefox access wasn't allowed, so it can't run there. Click Save to ask again.", true);
    }, () => setStatus("Firefox access wasn't allowed, so it can't run there. Click Save to ask again.", true));
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveHost(); });

  // Show where things stand when the popup opens.
  if (current.host && !mscIsBuiltInHost(current.host)) {
    browser.permissions.contains({ origins: [`https://${current.host}/*`] }).then((ok) => {
      if (!status.textContent) {
        if (ok) setStatus('Works on ' + current.host + '.');
        else setStatus("Firefox access wasn't allowed, so it can't run there. Click Save to ask again.", true);
      }
    }, () => {});
  }

  return h('div', { class: 'host' },
    h('label', { for: 'host-input', class: 'note' }, 'For schools not on instructure.com. Just the address, no https://.'),
    h('div', { class: 'host-row' }, input, h('button', { type: 'button', class: 'btn primary', onclick: saveHost }, 'Save')),
    status);
}

function card(c) {
  const checks = c.checks ? h('div', { class: 'checks', 'data-parent': c.switches[0][0] }, ...c.checks.map(checkRow)) : null;
  const range = c.range ? rangeRow(c.range) : null;
  if (range && c.switches) range.dataset.parent = c.switches[0][0];
  return h('section', { class: 'card' + (c.wide ? ' wide' : '') },
    c.title ? h('h2', {}, c.title) : null,
    ...(c.switches || []).map(switchRow),
    checks,
    range,
    c.files ? filesBlock() : null,
    c.host ? hostBlock() : null);
}

// Sub-options look quieter while their main switch is off.
function renderInactive() {
  for (const el of document.querySelectorAll('[data-parent]')) el.classList.toggle('inactive', !current[el.dataset.parent]);
}

// ---------- tabs ----------
function selectTab(id, focus = false) {
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.id === id;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    if (on && focus) t.focus();
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.id !== id;
  try { localStorage.setItem('mscv-tab', id); } catch { /* ignore */ }
}

function render() {
  const tabs = $('tabs');
  const panels = $('panels');
  for (const tab of TABS) {
    tabs.append(h('button', {
      type: 'button', class: 'tab', role: 'tab', id: 'tab-' + tab.id, 'data-id': tab.id,
      'aria-controls': 'panel-' + tab.id, onclick: () => selectTab(tab.id),
    }, tab.label));
    panels.append(h('div', {
      class: 'panel', role: 'tabpanel', id: 'panel-' + tab.id, 'data-id': tab.id, 'aria-labelledby': 'tab-' + tab.id,
    }, ...tab.cards.map(card)));
  }
  tabs.addEventListener('keydown', (e) => {
    const ids = TABS.map((t) => t.id);
    const i = ids.indexOf(document.activeElement?.dataset?.id);
    if (i < 0) return;
    if (e.key === 'ArrowRight') selectTab(ids[(i + 1) % ids.length], true);
    else if (e.key === 'ArrowLeft') selectTab(ids[(i - 1 + ids.length) % ids.length], true);
    else if (e.key === 'Home') selectTab(ids[0], true);
    else if (e.key === 'End') selectTab(ids[ids.length - 1], true);
    else return;
    e.preventDefault();
  });
  let start = null;
  try { start = localStorage.getItem('mscv-tab'); } catch { /* ignore */ }
  selectTab(TABS.some((t) => t.id === start) ? start : TABS[0].id);
  renderInactive();
}

// ---------- Power button (round, icon only: the add-on works on Canvas only) ----------
// Canvas tabs switch over live. "Reload page" is offered for a fresh start when the active tab is Canvas.
function showPower() {
  const on = current.on !== false;
  $('power').setAttribute('aria-checked', String(on));
  $('power').title = on ? 'Turn the add-on off' : 'Turn the add-on on';
  document.body.classList.toggle('off', !on);
  $('rest').inert = !on;
  const changed = !!canvasTab && on !== startedOn;
  $('off-msg').textContent = on ? (changed ? 'On again.' : '') : 'Off. Nothing is changed on Canvas.';
  $('reload').hidden = !changed;
  $('off-bar').hidden = on && !changed;
}
$('power').addEventListener('click', () => {
  current.on = current.on === false;
  showPower();
  save({ on: current.on });
});
$('reload').addEventListener('click', () => {
  if (canvasTab) browser.tabs.reload(canvasTab.id);
  window.close();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (!(k in MSC_DEFAULTS)) continue;
    current[k] = newValue ?? MSC_DEFAULTS[k];
    for (const el of bound.get(k) || []) {
      if (el.tagName === 'OUTPUT') el.textContent = current[k];
      else if (el.type === 'range') el.value = current[k];
      else el.checked = !!current[k];
    }
  }
  renderInactive();
  showPower();
});

Promise.all([
  browser.storage.sync.get(MSC_DEFAULTS).catch(() => ({ ...MSC_DEFAULTS })),
  browser.tabs.query({ active: true, currentWindow: true }).catch(() => []),
]).then(([s, [tab]]) => {
  current = { ...MSC_DEFAULTS, ...s };
  current.cardCount = mscClamp(current.cardCount, 1, 10, 4);
  current.todoCount = mscClamp(current.todoCount, 1, 10, 4);
  startedOn = current.on !== false;
  try {
    const u = tab?.url ? new URL(tab.url) : null;
    if (u && u.protocol === 'https:' && mscIsCanvasHost(u.hostname, current.host)) canvasTab = tab;
  } catch { /* not a normal page */ }
  render();
  showPower();
});
