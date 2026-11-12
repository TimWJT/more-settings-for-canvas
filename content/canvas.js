// More Settings for Canvas - runs on Canvas pages (top frame, from document_start).
// Dark mode, compact cards and hiding feedback are attributes on <html> that canvas.css acts on.
// On the dashboard it also adds: upcoming work under each course card, a to-do list in the right sidebar and a
// notes box. Everything follows the popup live through storage changes; nothing needs a page reload.
(() => {
  'use strict';
  if (window.top !== window) return;

  const root = document.documentElement;
  const ORIGIN = location.origin;
  const IS_DASHBOARD = location.pathname === '/';
  const DARK_FLAG = 'mscv-dark';
  // Exact opposite of the page filter in canvas.css (used on our reminder card, which sits on top of the page).
  const UNDO_DARK = 'hue-rotate(180deg) invert(1) contrast(1.2086)';
  const WORK = new Set(['assignment', 'quiz', 'discussion_topic']);
  // Short prefixes for item ids so assignment 12 and quiz 12 don't share saved state.
  const PREFIX = { assignment: 'a', quiz: 'q', discussion_topic: 'd', announcement: 'n', wiki_page: 'w',
    planner_note: 'p', calendar_event: 'e', assessment_request: 'r', sub_assignment: 's' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DAY = 86400e3;

  // ---------- First paint: dark mode before Canvas draws anything ----------
  // The page's localStorage is read synchronously, so there's no white flash. storage.sync confirms it a moment later.
  let darkCached = true;
  try { darkCached = localStorage.getItem(DARK_FLAG) !== '0'; } catch { /* storage blocked */ }
  root.toggleAttribute('data-mscv-dark', darkCached);

  // ---------- Settings and saved data ----------
  let s = { ...MSC_DEFAULTS };
  const data = { courses: {}, itemState: {}, myTodos: [], reminders: null };
  let loaded = false;
  const on = () => s.on !== false;

  function readSetting(key, value) {
    const def = MSC_DEFAULTS[key];
    if (value === undefined) return def;
    if (key === 'cardCount' || key === 'todoCount') return mscClamp(value, 1, 10, def);
    if (typeof def === 'boolean') return !!value;
    return typeof value === 'string' ? value : def;
  }

  function readMyTodos(all) {
    const keys = Object.keys(all).filter((k) => /^myTodos\d?$/.test(k)).sort();
    const now = Date.now();
    return keys.flatMap((k) => (Array.isArray(all[k]) ? all[k] : []))
      .filter((t) => t && typeof t.t === 'string' && typeof t.i === 'string' && Number.isFinite(t.d) && t.d > now);
  }

  function takeData(all) {
    for (const key of Object.keys(MSC_DEFAULTS)) if (key in all) s[key] = readSetting(key, all[key]);
    if ('courses' in all) data.courses = all.courses && typeof all.courses === 'object' ? all.courses : {};
    if ('itemState' in all) data.itemState = all.itemState && typeof all.itemState === 'object' ? all.itemState : {};
    if ('reminders' in all) data.reminders = all.reminders?.v === 2 ? all.reminders : null;
  }

  const save = (obj) => browser.storage.sync.set(obj).catch((e) => console.warn('More Settings for Canvas:', e));

  // ---------- Applying settings ----------
  function apply() {
    const dark = on() && s.dark;
    root.toggleAttribute('data-mscv-dark', dark);
    if (dark !== darkCached) {
      darkCached = dark;
      try { localStorage.setItem(DARK_FLAG, dark ? '1' : '0'); } catch { /* storage blocked */ }
    }
    root.toggleAttribute('data-mscv-compact', on() && s.compactCards);
    root.toggleAttribute('data-mscv-nofeedback', on() && s.hideFeedback);
    if (IS_DASHBOARD) {
      root.toggleAttribute('data-mscv-todo', on() && s.todo);
      if (document.readyState !== 'loading') dashboard();
    } else if (on() && s.remind) {
      refreshRemindersLater();
    }
  }

  // ---------- Canvas API ----------
  // Canvas may start JSON with "while(1);" to stop other sites reading it; strip that before parsing.
  async function getJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Canvas said ' + r.status);
    const text = (await r.text()).replace(/^while\(1\);/, '');
    return { body: JSON.parse(text), link: r.headers.get('Link') };
  }

  // The "next page" link from Canvas's Link header, only if it stays on this Canvas site.
  function nextLink(header) {
    for (const part of (header || '').split(',')) {
      const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
      if (!m) continue;
      try {
        const u = new URL(m[1], ORIGIN);
        if (u.origin === ORIGIN) return u.href;
      } catch { /* bad link */ }
    }
    return null;
  }

  // All pages of a list (up to 10 pages).
  async function getAll(path) {
    const out = [];
    let url = new URL(path, ORIGIN).href;
    for (let page = 0; url && page < 10; page++) {
      const { body, link } = await getJson(url);
      if (!Array.isArray(body)) throw new Error('Unexpected reply');
      out.push(...body);
      url = nextLink(link);
    }
    return out;
  }

  // A Canvas link turned into a full address on this site, or null if it points anywhere else.
  function sameOriginUrl(href) {
    if (typeof href !== 'string' || !href) return null;
    try {
      const u = new URL(href, ORIGIN);
      return u.origin === ORIGIN ? u.href : null;
    } catch { return null; }
  }

  // ---------- Planner items (shared by course cards, the to-do list and reminders) ----------
  const planner = { state: 'idle', items: [] };   // state: idle | loading | ok | fail

  function fromPlanner(p) {
    if (!p || typeof p !== 'object' || !p.plannable) return null;
    const type = String(p.plannable_type || '');
    const pid = String(p.plannable_id ?? p.plannable.id ?? '');
    if (!/^\d+$/.test(pid)) return null;
    const date = Date.parse(p.plannable_date || '');
    const course = p.course_id != null ? String(p.course_id) : '';
    return {
      key: (PREFIX[type] || type) + pid,
      type,
      pid,
      title: String(p.plannable.title || p.plannable.name || 'Untitled'),
      url: sameOriginUrl(p.html_url),
      course: /^\d+$/.test(course) ? course : '',
      courseName: String(p.context_name || ''),
      date: Number.isFinite(date) ? date : null,
      submitted: !!(p.submissions && p.submissions.submitted),
      complete: !!(p.planner_override && p.planner_override.marked_complete),
    };
  }

  function loadPlanner() {
    if (planner.state !== 'idle') return;
    planner.state = 'loading';
    const start = new Date(Date.now() - 7 * DAY).toISOString();
    getAll(`/api/v1/planner/items?start_date=${encodeURIComponent(start)}&per_page=75`)
      .then((raw) => {
        planner.items = raw.map(fromPlanner).filter(Boolean);
        planner.state = 'ok';
      })
      .catch(() => { planner.state = 'fail'; })
      .then(() => {
        if (IS_DASHBOARD) { refreshCards(); refreshTodo(); }
        saveReminders();
      });
  }

  // ---------- Courses: code + colour for up to 25 courses (add form, course names, title colours) ----------
  let coursesLoading = false;

  function cardCourseIds() {
    return [...document.querySelectorAll('#DashboardCard_Container a.ic-DashboardCard__link')]
      .map((a) => (a.getAttribute('href') || '').match(/\/courses\/(\d+)/)?.[1]).filter(Boolean);
  }

  function loadCourses() {
    if (coursesLoading) return;
    coursesLoading = true;
    Promise.all([
      getAll('/api/v1/courses?per_page=100&enrollment_state=active'),
      getJson(new URL('/api/v1/users/self/colors', ORIGIN).href).then((r) => r.body).catch(() => ({})),
    ]).then(([list, colours]) => {
      const custom = (colours && colours.custom_colors) || {};
      const onCards = new Set(cardCourseIds());
      // Courses on the dashboard first, then the newest terms.
      const usable = list.filter((c) => c && /^\d+$/.test(String(c.id)) && (c.course_code || c.name));
      usable.sort((a, b) => (onCards.has(String(b.id)) - onCards.has(String(a.id)))
        || ((b.enrollment_term_id || 0) - (a.enrollment_term_id || 0)));
      const courses = {};
      for (const c of usable.slice(0, 25)) {
        const colour = custom['course_' + c.id];
        courses[c.id] = {
          code: String(c.course_code || c.name).slice(0, 40),
          colour: /^#[0-9a-f]{3,8}$/i.test(colour || '') ? colour : '',
        };
      }
      if (JSON.stringify(courses) !== JSON.stringify(data.courses)) {
        data.courses = courses;
        if (mscItemSize('courses', courses) <= MSC_ITEM_LIMIT) save({ courses });
        refreshTodo();
      }
    }).catch(() => { /* keep the saved list */ });
  }

  // ---------- Per-item state: crossed off (x), removed from to-do (r), label (l), expiry (e, in seconds) ----------
  const itemState = (key) => data.itemState[key] || {};

  function setItemState(key, patch, date) {
    const next = { ...data.itemState };
    const cur = { ...(next[key] || {}), ...patch };
    for (const k of ['x', 'r', 'l']) if (!cur[k]) delete cur[k];
    if (cur.x || cur.r || cur.l) {
      // Forget the state 60 days after the item's date.
      cur.e = Math.round(((date ?? Date.now()) + 60 * DAY) / 1000);
      next[key] = cur;
    } else {
      delete next[key];
    }
    // Drop expired entries, then the oldest ones while the item is near the 8 KB sync limit.
    const nowSec = Date.now() / 1000;
    for (const [k, v] of Object.entries(next)) if (!v || !(v.e > nowSec)) delete next[k];
    const byAge = Object.keys(next).sort((a, b) => next[a].e - next[b].e);
    while (byAge.length && mscItemSize('itemState', next) > MSC_ITEM_LIMIT) delete next[byAge.shift()];
    data.itemState = next;
    save({ itemState: next });
  }

  // ---------- Your own to-dos, split over myTodos, myTodos1 ... myTodos9 to fit the per-item limit ----------
  async function saveMyTodos(list) {
    const now = Date.now();
    list = list.filter((t) => t.d > now);
    const chunks = [[]];
    for (const t of list) {
      const cur = chunks[chunks.length - 1];
      cur.push(t);
      if (mscItemSize('myTodos' + (chunks.length - 1 || ''), cur) > MSC_ITEM_LIMIT) {
        cur.pop();
        if (chunks.length === 10) return false;   // full
        chunks.push([t]);
      }
    }
    const out = {};
    chunks.forEach((c, i) => { out['myTodos' + (i || '')] = c; });
    const stale = [];
    for (let i = chunks.length; i < 10; i++) stale.push('myTodos' + i);
    data.myTodos = list;
    await browser.storage.sync.set(out);
    await browser.storage.sync.remove(stale);
    return true;
  }

  function fromMine(t) {
    const course = /^\d+$/.test(t.c || '') ? t.c : '';
    return { key: 'u' + t.i, id: t.i, type: 'mine', pid: '', title: t.t, url: null, course,
      courseName: data.courses[course]?.code || '', date: t.d, submitted: false, complete: false, mine: true };
  }

  // ---------- Text for dates ----------
  function clock(d) {
    const h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    return s.todo24h ? `${String(h).padStart(2, '0')}:${m}` : `${h % 12 || 12}:${m}${h < 12 ? 'am' : 'pm'}`;
  }
  // "in 3d" / "2h ago"
  function shortRelative(ms) {
    const a = Math.abs(ms);
    const v = a < 3600e3 ? Math.max(1, Math.round(a / 60e3)) + 'm' : a < DAY ? Math.round(a / 3600e3) + 'h' : Math.round(a / DAY) + 'd';
    return ms >= 0 ? 'in ' + v : v + ' ago';
  }
  // "in 2 days" / "5 hours ago"
  function longRelative(ms) {
    const a = Math.abs(ms);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    const v = a < 3600e3 ? plural(Math.max(1, Math.round(a / 60e3)), 'minute')
      : a < 1.5 * DAY ? plural(Math.round(a / 3600e3), 'hour') : plural(Math.round(a / DAY), 'day');
    return ms >= 0 ? 'in ' + v : v + ' ago';
  }
  // "Mar 3 at 5:00pm (in 2 days)"
  function longDate(t) {
    const d = new Date(t);
    return `${MONTHS[d.getMonth()]} ${d.getDate()} at ${clock(d)} (${longRelative(t - Date.now())})`;
  }
  function cardDate(t) {
    if (s.cardRelative) return shortRelative(t - Date.now());
    const d = new Date(t);
    return s.cardDayFirst ? `${d.getDate()}/${d.getMonth() + 1}` : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // ---------- Small DOM helpers ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function button(cls, text, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function loadingBars(n) {
    const wrap = el('div', 'mscv-bars');
    wrap.setAttribute('aria-label', 'Loading');
    wrap.setAttribute('role', 'status');
    for (let i = 0; i < n; i++) wrap.append(el('div', 'mscv-bar'));
    return wrap;
  }

  // Our own small icons (20x20, drawn with lines).
  const NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    assignment: ['M5 2.5h6.5l3.5 3.5v11.5H5z', 'M11.5 2.5V6H15', 'M7.5 10h5M7.5 13h5'],
    quiz: ['M5.5 3.5h9v14h-9z', 'M8 3.5V2h4v1.5', 'M7.8 10.5l1.8 1.8 3-3.6'],
    discussion_topic: ['M2.5 3.5h10v7h-6l-3 2.5v-2.5h-1z', 'M14.5 7.5h3v7h-1v2.5l-3-2.5h-5v-2'],
    announcement: ['M3 8v4h3l6 4V4L6 8z', 'M15 7.2a3.5 3.5 0 0 1 0 5.6'],
    other: ['M10 2.8a7.2 7.2 0 1 1 0 14.4a7.2 7.2 0 1 1 0-14.4z', 'M6.8 10.2l2.2 2.2 4.2-4.6'],
  };
  function icon(type) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'mscv-icon');
    for (const d of ICONS[type] || ICONS.other) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.append(p);
    }
    return svg;
  }
  const TYPE_NAMES = { assignment: 'Assignment', quiz: 'Quiz', discussion_topic: 'Discussion', announcement: 'Announcement',
    mine: 'Your to-do', planner_note: 'To-do', wiki_page: 'Page', calendar_event: 'Event' };

  // ================= Dashboard =================
  const dash = { observer: null, timer: 0, giveUp: 0 };

  // Called when settings load or change, and while Canvas is still drawing the dashboard.
  function dashboard() {
    if (on() && (s.cardDue || s.todo || s.remind)) loadPlanner();
    if (on() && s.todo) loadCourses();
    mountNotes();
    mountCards();
    mountTodo();
    if (on() && (s.cardDue || s.notes || s.todo) && !dashboardReady()) watchDashboard();
    else stopWatching();
  }

  // Are all the places we add things to on the page yet?
  function dashboardReady() {
    const cards = !(s.cardDue || s.notes) || document.querySelector('#DashboardCard_Container .ic-DashboardCard');
    const side = !s.todo || document.getElementById('right-side');
    return !!(cards && side);
  }

  // Canvas draws the cards with React after the page loads, so watch for them with one observer,
  // debounced, and switch it off as soon as everything is in place (or after 30 s).
  function watchDashboard() {
    if (dash.observer || !document.body) return;
    dash.observer = new MutationObserver(() => {
      if (dash.timer) return;
      dash.timer = setTimeout(() => {
        dash.timer = 0;
        mountNotes();
        mountCards();
        mountTodo();
        if (dashboardReady()) stopWatching();
      }, 250);
    });
    dash.observer.observe(document.body, { childList: true, subtree: true });
    dash.giveUp = setTimeout(stopWatching, 30000);
  }

  function stopWatching() {
    dash.observer?.disconnect();
    dash.observer = null;
    clearTimeout(dash.timer);
    clearTimeout(dash.giveUp);
    dash.timer = 0;
  }

  // ---------- Notes box ----------
  let notes = null;   // { wrap, area, timer }

  function mountNotes() {
    if (!(on() && s.notes)) {
      if (notes) { flushNotes(); notes.wrap.remove(); notes = null; }
      return;
    }
    if (notes?.wrap.isConnected) return;
    const container = document.getElementById('DashboardCard_Container');
    if (!container?.parentNode) return;
    const wrap = el('div', 'mscv-notes');
    const area = el('textarea', 'mscv-notes-text');
    area.setAttribute('aria-label', 'Dashboard notes');
    area.placeholder = 'Notes';
    area.rows = 1;
    area.maxLength = 3000;
    area.spellcheck = true;
    area.value = s.notesText;
    notes = { wrap, area, timer: 0 };
    area.addEventListener('input', () => {
      growNotes();
      clearTimeout(notes.timer);
      notes.timer = setTimeout(flushNotes, 1000);   // save 1 s after typing stops
    });
    area.addEventListener('blur', flushNotes);
    wrap.append(area);
    container.parentNode.insertBefore(wrap, container);
    growNotes();
  }

  function growNotes() {
    if (!notes) return;
    notes.area.style.height = 'auto';
    notes.area.style.height = notes.area.scrollHeight + 2 + 'px';
  }

  function flushNotes() {
    if (!notes) return;
    clearTimeout(notes.timer);
    notes.timer = 0;
    let text = notes.area.value;
    if (text === s.notesText) return;
    // Trim (rarely needed) so the note always fits in one storage item.
    while (mscItemSize('notesText', text) > MSC_ITEM_LIMIT) text = text.slice(0, -100);
    s.notesText = text;
    save({ notesText: text });
  }
  window.addEventListener('pagehide', flushNotes);

  // ---------- Upcoming work on course cards ----------
  function courseIdOf(card) {
    const a = card.querySelector('a.ic-DashboardCard__link');
    return (a?.getAttribute('href') || '').match(/\/courses\/(\d+)/)?.[1] || null;
  }

  function cardItems(courseId) {
    const now = Date.now();
    return planner.items
      .filter((it) => it.course === courseId && WORK.has(it.type) && !it.complete && it.date != null)
      .filter((it) => it.date >= now || (s.cardPastDue && !it.submitted))
      .sort((a, b) => a.date - b.date)
      .slice(0, s.cardCount);
  }

  function fillCardBox(box, courseId) {
    box.textContent = '';
    box.append(el('div', 'mscv-due-head', 'Due'));
    if (planner.state !== 'ok') { box.append(loadingBars(2)); return; }
    const items = cardItems(courseId);
    if (!items.length) { box.append(el('p', 'mscv-due-none', 'Nothing due')); return; }
    const list = el('ul', 'mscv-due-list');
    for (const it of items) {
      const li = el('li', 'mscv-due-item');
      const crossed = !!itemState(it.key).x;
      li.classList.toggle('mscv-crossed', crossed);
      li.classList.toggle('mscv-late', it.date < Date.now());
      const title = it.url ? el('a', 'mscv-due-title', it.title) : el('span', 'mscv-due-title', it.title);
      if (it.url) title.href = it.url;
      const when = cardDate(it.date);
      const toggle = button('mscv-due-when', when, () => setItemState(it.key, { x: !itemState(it.key).x }, it.date));
      toggle.setAttribute('aria-pressed', String(crossed));
      toggle.setAttribute('aria-label', `Due ${when}. Cross off ${it.title}`);
      toggle.title = crossed ? 'Uncross' : 'Cross off';
      li.append(title, toggle);
      list.append(li);
    }
    box.append(list);
  }

  // Adds a "Due" box to any card that doesn't have one yet.
  function mountCards() {
    const want = on() && s.cardDue && planner.state !== 'fail';
    const cards = document.querySelectorAll('#DashboardCard_Container .ic-DashboardCard');
    for (const card of cards) {
      const box = card.querySelector(':scope > .mscv-due');
      if (!want) { box?.remove(); continue; }
      if (box) continue;
      const courseId = courseIdOf(card);
      if (!courseId) continue;
      const nb = el('div', 'mscv-due');
      nb.dataset.course = courseId;
      fillCardBox(nb, courseId);
      card.append(nb);
    }
  }

  // Redraws every card's box (after the planner loads or a setting changes).
  function refreshCards() {
    mountCards();
    for (const box of document.querySelectorAll('#DashboardCard_Container .mscv-due')) fillCardBox(box, box.dataset.course);
  }

  // ---------- To-do list in the right sidebar ----------
  const todo = { el: null, view: 'todo', extra: 0, annExtra: 0, formOpen: false, menuKey: null, labelKey: null,
    previewTimer: 0, previewKey: null, parts: null };
  const details = new Map();   // item key -> Promise of plain text

  function mountTodo() {
    const want = on() && s.todo;
    if (!want) {
      if (todo.el) { todo.el.remove(); todo.el = null; }
      return;
    }
    if (todo.el?.isConnected) return;
    const side = document.getElementById('right-side');
    if (!side) return;
    if (!todo.el) buildTodo();
    side.prepend(todo.el);
    refreshTodo();
  }

  function buildTodo() {
    const sec = el('section', 'mscv-todo');
    sec.id = 'mscv-todo';
    sec.setAttribute('aria-labelledby', 'mscv-todo-h');

    const head = el('div', 'mscv-todo-head');
    const h = el('h2', 'mscv-h', 'To do');
    h.id = 'mscv-todo-h';
    const seg = el('div', 'mscv-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Show');
    const segTodo = button('mscv-seg-btn', 'To do', () => setView('todo'));
    const segDone = button('mscv-seg-btn', 'Done', () => setView('done'));
    seg.append(segTodo, segDone);
    const add = button('mscv-add-btn', '+ Add', () => { todo.formOpen = !todo.formOpen; refreshForm(true); });
    add.setAttribute('aria-expanded', 'false');
    add.setAttribute('aria-controls', 'mscv-add-form');
    head.append(h, seg, add);

    const form = buildForm();
    const status = el('p', 'mscv-status');
    status.setAttribute('role', 'status');
    const list = el('ul', 'mscv-list');
    list.setAttribute('aria-labelledby', 'mscv-todo-h');
    const more = button('mscv-more', 'View more', () => { todo.extra += 3; refreshTodo(); });

    const annH = el('h2', 'mscv-h mscv-ann-h', 'Announcements');
    annH.id = 'mscv-ann-h';
    const annList = el('ul', 'mscv-list');
    annList.setAttribute('aria-labelledby', 'mscv-ann-h');
    const annMore = button('mscv-more', 'View more', () => { todo.annExtra += 3; refreshTodo(); });

    const preview = el('div', 'mscv-preview');
    preview.id = 'mscv-preview';
    preview.setAttribute('role', 'tooltip');
    preview.hidden = true;

    sec.append(head, form, status, list, more, annH, annList, annMore, preview);
    todo.el = sec;
    todo.parts = { segTodo, segDone, add, form, status, list, more, annH, annList, annMore, preview };

    // Close an open menu when clicking anywhere else.
    document.addEventListener('click', (e) => {
      if (todo.menuKey && !e.target.closest?.('.mscv-menu, .mscv-menu-btn')) { todo.menuKey = null; refreshTodo(); }
    }, true);
  }

  function setView(view) {
    todo.view = view;
    todo.extra = 0;
    todo.menuKey = null;
    refreshTodo();
  }

  // "+ Add" form: name, course, date, time.
  function buildForm() {
    const form = el('form', 'mscv-form');
    form.id = 'mscv-add-form';
    form.hidden = true;
    const field = (label, input) => {
      const l = el('label', 'mscv-field');
      l.append(el('span', null, label), input);
      return l;
    };
    const name = el('input');
    name.type = 'text';
    name.required = true;
    name.maxLength = 100;
    name.name = 'name';
    const course = el('select');
    course.name = 'course';
    const date = el('input');
    date.type = 'date';
    date.required = true;
    date.name = 'date';
    const time = el('input');
    time.type = 'time';
    time.value = '23:59';
    time.name = 'time';
    const error = el('p', 'mscv-form-error');
    error.setAttribute('role', 'alert');
    const actions = el('div', 'mscv-form-actions');
    const ok = el('button', 'mscv-btn mscv-primary', 'Add to-do');
    ok.type = 'submit';
    const cancel = button('mscv-btn', 'Cancel', () => { todo.formOpen = false; refreshForm(); todo.parts.add.focus(); });
    actions.append(ok, cancel);
    form.append(field('Name', name), field('Course', course), field('Date', date), field('Time', time), error, actions);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = name.value.trim();
      const when = date.value ? new Date(`${date.value}T${time.value || '23:59'}`).getTime() : NaN;
      if (!title) { error.textContent = 'Type a name.'; name.focus(); return; }
      if (!Number.isFinite(when)) { error.textContent = 'Pick a date.'; date.focus(); return; }
      if (when <= Date.now()) { error.textContent = 'Pick a time in the future.'; date.focus(); return; }
      const t = { i: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), t: title, c: course.value, d: when };
      const okSaved = await saveMyTodos([...data.myTodos, t]).catch(() => false);
      if (!okSaved) { error.textContent = "Couldn't save. Remove some to-dos and try again."; return; }
      name.value = '';
      date.value = '';
      time.value = '23:59';
      error.textContent = '';
      todo.formOpen = false;
      if (todo.view !== 'todo') todo.view = 'todo';
      refreshTodo();
      todo.parts.add.focus();
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { todo.formOpen = false; refreshForm(); todo.parts.add.focus(); }
    });
    return form;
  }

  function refreshForm(focus = false) {
    const { form, add } = todo.parts;
    form.hidden = !todo.formOpen;
    add.setAttribute('aria-expanded', String(todo.formOpen));
    const select = form.querySelector('select');
    const keep = select.value;
    select.textContent = '';
    const none = el('option', null, 'No course');
    none.value = '';
    select.append(none);
    for (const [id, c] of Object.entries(data.courses)) {
      const o = el('option', null, c.code);
      o.value = id;
      select.append(o);
    }
    select.value = keep in data.courses ? keep : '';
    if (focus && todo.formOpen) form.querySelector('input').focus();
  }

  function todoItems() {
    const now = Date.now();
    const all = [...planner.items, ...data.myTodos.map(fromMine)].filter((it) => it.type !== 'announcement');
    const isDone = (it) => !!itemState(it.key).r || it.complete || (it.submitted && s.todoHideDone);
    if (todo.view === 'done') return all.filter(isDone).sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
    return all.filter((it) => !isDone(it))
      .filter((it) => it.date == null || it.date >= now || (s.todoPastDue && !it.submitted))
      .sort((a, b) => (a.date ?? Infinity) - (b.date ?? Infinity));
  }

  function announcementItems() {
    return planner.items.filter((it) => it.type === 'announcement' && !itemState(it.key).r)
      .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  }

  // Redraws the lists. Keeps keyboard focus on the same item's control after redrawing.
  function refreshTodo() {
    if (!todo.el?.isConnected) return;
    const p = todo.parts;
    const focused = document.activeElement;
    const focusItem = focused && todo.el.contains(focused) ? focused.closest('[data-key]') : null;
    const focusWhat = focusItem ? (focused.dataset.role || '') : '';
    const focusKey = focusItem?.dataset.key;

    p.segTodo.setAttribute('aria-pressed', String(todo.view === 'todo'));
    p.segDone.setAttribute('aria-pressed', String(todo.view === 'done'));
    hidePreview();
    refreshForm();

    p.status.textContent = planner.state === 'fail' ? "Couldn't load from Canvas. Reload the page to try again." : '';
    p.list.textContent = '';
    p.annList.textContent = '';
    if (planner.state === 'loading' || planner.state === 'idle') {
      p.list.append(el('li', 'mscv-loading-li'));
      p.list.lastChild.append(loadingBars(3));
      p.more.hidden = true;
      p.annList.append(el('li', 'mscv-loading-li'));
      p.annList.lastChild.append(loadingBars(2));
      p.annMore.hidden = true;
      return;
    }

    const items = todoItems();
    const limit = s.todoCount + todo.extra;
    for (const it of items.slice(0, limit)) p.list.append(itemRow(it));
    if (!items.length) p.list.append(el('li', 'mscv-empty', todo.view === 'done' ? 'Nothing done yet' : 'Nothing to do'));
    p.more.hidden = items.length <= limit;

    const anns = announcementItems();
    const annLimit = s.todoCount + todo.annExtra;
    for (const it of anns.slice(0, annLimit)) p.annList.append(itemRow(it));
    if (!anns.length) p.annList.append(el('li', 'mscv-empty', planner.state === 'fail' ? '' : 'No announcements this week'));
    p.annMore.hidden = anns.length <= annLimit;

    if (focusKey) {
      const row = todo.el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      const target = row?.querySelector(`[data-role="${focusWhat}"]`) || row?.querySelector('[data-role="menu-btn"]');
      target?.focus();
    }
  }

  function itemRow(it) {
    const st = itemState(it.key);
    const li = el('li', 'mscv-item');
    li.dataset.key = it.key;
    li.classList.toggle('mscv-crossed', !!st.x);
    const now = Date.now();
    const soon = it.type !== 'announcement' && !it.submitted && it.date != null && it.date - now < 6 * 3600e3;
    li.classList.toggle('mscv-soon', soon);

    const body = el('div', 'mscv-body');
    const title = it.url ? el('a', 'mscv-title', it.title) : el('span', 'mscv-title', it.title);
    title.dataset.role = 'title';
    if (it.url) title.href = it.url;
    const colour = data.courses[it.course]?.colour;
    if (s.todoColours && colour) title.style.color = colour;
    const line1 = el('div', 'mscv-line');
    line1.append(title);
    if (st.l) line1.append(el('span', 'mscv-label', st.l));
    body.append(line1);
    const courseName = it.courseName || data.courses[it.course]?.code || '';
    if (courseName) body.append(el('div', 'mscv-course', courseName));
    if (it.date != null) body.append(el('div', 'mscv-date', longDate(it.date)));
    if (todo.labelKey === it.key) body.append(labelEditor(it));

    const menuBtn = button('mscv-menu-btn', '⋯', () => {
      todo.menuKey = todo.menuKey === it.key ? null : it.key;
      refreshTodo();
      if (todo.menuKey) todo.el.querySelector('.mscv-menu [role="menuitem"]')?.focus();
    });
    menuBtn.dataset.role = 'menu-btn';
    menuBtn.setAttribute('aria-label', 'Options for ' + it.title);
    menuBtn.setAttribute('aria-haspopup', 'menu');
    menuBtn.setAttribute('aria-expanded', String(todo.menuKey === it.key));

    li.append(icon(it.type === 'mine' || !ICONS[it.type] ? 'other' : it.type), body, menuBtn);
    if (todo.menuKey === it.key) li.append(itemMenu(it, menuBtn));

    // Hover (or keyboard focus) preview after ~300 ms.
    li.addEventListener('mouseenter', () => schedulePreview(li, it));
    li.addEventListener('mouseleave', hidePreview);
    title.addEventListener('focus', () => schedulePreview(li, it));
    title.addEventListener('blur', hidePreview);
    return li;
  }

  function itemMenu(it, menuBtn) {
    const st = itemState(it.key);
    const menu = el('div', 'mscv-menu');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Options for ' + it.title);
    const close = () => { todo.menuKey = null; };
    const entry = (text, fn) => {
      const b = button('mscv-menu-item', text, () => { close(); fn(); refreshTodo(); });
      b.setAttribute('role', 'menuitem');
      b.dataset.role = 'menu-btn';   // focus returns to the item's menu button after the redraw
      b.tabIndex = -1;
      menu.append(b);
    };
    if (it.type === 'announcement') entry(st.r ? 'Put back' : 'Hide', () => setItemState(it.key, { r: !st.r }, it.date));
    else entry(st.r ? 'Put back in To do' : 'Remove', () => setItemState(it.key, { r: !st.r }, it.date));
    entry(st.x ? 'Uncross' : 'Cross off', () => setItemState(it.key, { x: !st.x }, it.date));
    entry(st.l ? 'Change label' : 'Label', () => { todo.labelKey = it.key; });
    if (it.mine) entry('Delete', () => { saveMyTodos(data.myTodos.filter((t) => t.i !== it.id)); setItemState(it.key, { x: 0, r: 0, l: '' }); });

    // Arrow keys move through the menu, Escape closes it.
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus();
      else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus();
      else if (e.key === 'Home') items[0].focus();
      else if (e.key === 'End') items[items.length - 1].focus();
      else if (e.key === 'Escape' || e.key === 'Tab') {
        close();
        refreshTodo();
        todo.el.querySelector(`[data-key="${CSS.escape(it.key)}"] .mscv-menu-btn`)?.focus();
        if (e.key === 'Tab') return;
      } else return;
      e.preventDefault();
    });
    return menu;
  }

  // Small inline box for an item's label (up to 20 characters; empty removes it).
  function labelEditor(it) {
    const form = el('form', 'mscv-label-form');
    const input = el('input');
    input.type = 'text';
    input.maxLength = 20;
    input.value = itemState(it.key).l || '';
    input.setAttribute('aria-label', 'Label for ' + it.title);
    input.placeholder = 'Label';
    input.dataset.role = 'label';
    const ok = el('button', 'mscv-btn mscv-primary', 'Save');
    ok.type = 'submit';
    const done = (value) => {
      todo.labelKey = null;
      if (value !== null) setItemState(it.key, { l: value.trim().slice(0, 20) }, it.date);
      refreshTodo();
      todo.el.querySelector(`[data-key="${CSS.escape(it.key)}"] .mscv-menu-btn`)?.focus();
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); done(input.value); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(null); } });
    form.append(input, ok);
    setTimeout(() => input.focus(), 0);
    return form;
  }

  // ---------- Hover preview ----------
  function htmlToText(html) {
    // DOMParser makes an inert document: no scripts run and no images load.
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    // Code and styles aren't readable text.
    for (const n of doc.querySelectorAll('script, style, noscript, template')) n.remove();
    const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > 300 ? text.slice(0, 297).trimEnd() + '…' : text;
  }

  function loadDetails(it) {
    if (details.has(it.key)) return details.get(it.key);
    let p;
    const base = `/api/v1/courses/${it.course}`;
    if (it.mine) p = Promise.resolve('Your to-do');
    else if (!it.course || !it.pid) p = Promise.resolve('');
    else if (it.type === 'assignment') p = getJson(new URL(`${base}/assignments/${it.pid}`, ORIGIN).href).then((r) => htmlToText(r.body.description));
    else if (it.type === 'quiz') p = getJson(new URL(`${base}/quizzes/${it.pid}`, ORIGIN).href).then((r) => htmlToText(r.body.description));
    else if (it.type === 'discussion_topic' || it.type === 'announcement') p = getJson(new URL(`${base}/discussion_topics/${it.pid}`, ORIGIN).href).then((r) => htmlToText(r.body.message));
    else p = Promise.resolve('');
    p = p.catch(() => { details.delete(it.key); return "Couldn't load the details."; });
    details.set(it.key, p);
    return p;
  }

  function schedulePreview(li, it) {
    clearTimeout(todo.previewTimer);
    if (!s.todoPreview || todo.menuKey || todo.labelKey) return;
    todo.previewTimer = setTimeout(() => showPreview(li, it), 300);
  }

  function showPreview(li, it) {
    const box = todo.parts.preview;
    if (!li.isConnected) return;
    todo.previewKey = it.key;
    box.textContent = '';
    box.append(el('div', 'mscv-preview-type', TYPE_NAMES[it.type] || 'Item'), el('div', 'mscv-preview-title', it.title));
    const text = el('div', 'mscv-preview-text', it.mine ? 'Your to-do' : 'Loading details…');
    box.append(text);
    box.style.top = li.offsetTop + li.offsetHeight + 'px';
    box.hidden = false;
    li.setAttribute('aria-describedby', box.id);
    if (!it.mine) {
      loadDetails(it).then((t) => {
        if (todo.previewKey === it.key) text.textContent = t || 'No details.';
      });
    }
  }

  function hidePreview() {
    clearTimeout(todo.previewTimer);
    todo.previewKey = null;
    if (todo.parts) todo.parts.preview.hidden = true;
    todo.el?.querySelector('[aria-describedby="mscv-preview"]')?.removeAttribute('aria-describedby');
  }

  // ================= Reminders =================
  // Saves unsubmitted work due in the next 10 days so the reminder script can show it on other sites.
  function saveReminders() {
    if (planner.state !== 'ok' || !on() || !s.remind) return;
    browser.storage.local.set({ remindersAt: Date.now() }).catch(() => {});
    const now = Date.now();
    const old = new Map((data.reminders?.items || []).map((r) => [r.url, r]));
    let items = planner.items
      .filter((it) => WORK.has(it.type) && !it.complete && it.url && it.date > now && it.date <= now + 10 * DAY)
      .sort((a, b) => a.date - b.date)
      .slice(0, 25)
      .map((it) => {
        const prev = old.get(it.url);
        const hidden = it.submitted ? -1 : prev && prev.hidden >= 0 ? prev.hidden : 0;
        return { due: it.date, title: it.title.slice(0, 90), url: it.url, hidden };
      });
    while (items.length && mscItemSize('reminders', { v: 2, items }) > MSC_ITEM_LIMIT) items = items.slice(0, -1);
    const next = { v: 2, items };
    if (JSON.stringify(next) === JSON.stringify(data.reminders)) return;
    data.reminders = next;
    save({ reminders: next });
  }

  // Away from the dashboard: refresh the reminders at most once an hour, a few seconds after the page loads.
  let reminderCheckStarted = false;
  function refreshRemindersLater() {
    if (reminderCheckStarted) return;
    reminderCheckStarted = true;
    setTimeout(async () => {
      if (!on() || !s.remind) { reminderCheckStarted = false; return; }
      const { remindersAt } = await browser.storage.local.get({ remindersAt: 0 }).catch(() => ({ remindersAt: 0 }));
      if (Date.now() - remindersAt > 3600e3) loadPlanner();
    }, 4000);
  }

  // Turning reminders on in the popup shows an example card on the Canvas tab you're looking at.
  let exampleTimer = 0;
  function showExampleReminder() {
    if (document.visibilityState !== 'visible') return;
    mscReminderUI.show([{
      title: 'This is an example reminder',
      when: 'Due in 3 days',
      note: 'Shows up on other sites when something is due soon',
      url: null,
    }], root.hasAttribute('data-mscv-dark') ? UNDO_DARK : '');
    clearTimeout(exampleTimer);
    exampleTimer = setTimeout(() => mscReminderUI.clear(), 8000);
  }

  // ================= Start =================
  const pending = {};
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const wasRemind = on() && s.remind;
    const flat = {};
    for (const [k, { newValue }] of Object.entries(changes)) flat[k] = newValue;
    if (!loaded) { Object.assign(pending, flat); return; }
    // Missing values (removed keys) fall back to defaults.
    for (const k of Object.keys(flat)) if (flat[k] === undefined && k in MSC_DEFAULTS) flat[k] = MSC_DEFAULTS[k];
    takeData(flat);
    const mineChanged = Object.keys(changes).some((k) => /^myTodos\d?$/.test(k));
    if (mineChanged) {
      browser.storage.sync.get(null).then((all) => { data.myTodos = readMyTodos(all); refreshTodo(); }).catch(() => {});
    }
    if (!wasRemind && on() && s.remind && 'remind' in changes) showExampleReminder();
    if (('on' in changes || 'remind' in changes) && !(on() && s.remind)) mscReminderUI.clear();
    // Don't overwrite the notes box while you're typing in it.
    if ('notesText' in changes && notes && document.activeElement !== notes.area) {
      notes.area.value = s.notesText;
      growNotes();
    }
    apply();
    if (IS_DASHBOARD && document.readyState !== 'loading') { refreshCards(); refreshTodo(); }
    if ('remind' in changes || 'on' in changes) saveReminders();
  });

  browser.storage.sync.get(null).then((all) => {
    takeData(all);
    data.myTodos = readMyTodos(all);
    takeData(pending);
    loaded = true;
    apply();
  }).catch(() => { loaded = true; apply(); });

  // The dashboard parts need the page's body, so they start at DOMContentLoaded (if settings are in by then).
  document.addEventListener('DOMContentLoaded', () => { if (loaded) apply(); }, { once: true });

  // Show real colours in fullscreen (videos, presentations).
  document.addEventListener('fullscreenchange', () => {
    root.toggleAttribute('data-mscv-fs', !!document.fullscreenElement);
  });
})();
