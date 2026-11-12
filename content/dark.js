// Dark mode for Canvas pages (top frame). canvas.css does most of it through the data-mscv-dark attribute on <html>.
// This file recolours what the stylesheet can't know about: InstUI parts with hashed class names and course content
// with inline white backgrounds or dark text. Only near-white/light-grey backgrounds and dark grey text are changed;
// saturated colours (course colours, brand buttons, labels), pictures and anything with a background image are left
// exactly as they are. Every change is an inline style marked with data-mscv-rc, so turning dark mode off undoes it.
// Speed (see Browser Extensions/DESIGN.md): one first pass in idle-time slices of ~5 ms, then a MutationObserver that
// only queues added nodes (capped) and runs ~200 ms later. Our own style changes don't trigger it (it only watches
// added nodes). Same-origin iframes with a light page get a small dark stylesheet; cross-origin ones are left alone.
// "var" + reuse: this file can be loaded twice on the extra Canvas address (see settings.js).
var mscDark = globalThis.mscDark || (() => {
  'use strict';
  const root = document.documentElement;
  const ATTR = 'data-mscv-dark';
  const MARK = 'data-mscv-rc';
  const FRAME_STYLE = 'mscv-dark-frame';
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SKIP = new Set(['IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'SCRIPT',
    'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR', 'MSC-REMINDERS']);
  // Our own dashboard parts are styled by canvas.css already.
  const OWN = '.mscv-due, .mscv-todo, .mscv-notes, msc-reminders';
  const SLICE_MS = 5;
  const QUEUE_CAP = 400;

  let active = false;
  let observer = null;
  let roots = [];          // subtrees waiting to be checked
  let walker = null;       // the subtree being checked now
  let bgCache = new Map(); // element -> effective background [r,g,b] (or null = unknown), for one run
  let idleId = 0;
  let timer = 0;
  let full = false;        // queue overflowed: check the whole page again
  const saved = new WeakMap();   // element -> original inline values we replaced
  const frames = new WeakSet();  // iframes we listen to for (re)loads
  let pal = null;
  const stats = { ms: 0, slices: 0, seen: 0, changed: 0, wall: 0, firstDone: 0 };
  let startedAt = 0;
  let timing = false;
  try { timing = localStorage.getItem('mscv-dark-timing') === '1'; } catch { /* storage blocked */ }

  // ---------- Colour maths ----------
  function parse(text) {
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(text);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  }
  function hex(text) {
    const m = /^#([0-9a-f]{6})$/i.exec(text.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const chroma = (c) => (Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])) / 255;
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  // White or a light grey, not a pale tint (pale yellow/blue state colours keep their meaning).
  const nearWhite = (c) => c[3] > 0.5 && chroma(c) <= 0.06 && lum(c) > 0.85;
  // Text we may lighten: greyish (incl. Canvas's dark blue-grey) or almost black. Coloured text keeps its colour.
  const greyText = (c) => chroma(c) <= 0.25 || lum(c) < 0.03;

  function readPalette() {
    const cs = getComputedStyle(root);
    const get = (name, fallback) => hex(cs.getPropertyValue(name)) || hex(fallback);
    return { page: get('--msc-page', '#161616'), surface: get('--msc-surface', '#1e1e1e'),
      text: get('--msc-text', '#ececec'), link: get('--msc-link', '#7cc4ff') };
  }

  // ---------- Recolouring one element ----------
  function remember(el, prop) {
    let s = saved.get(el);
    if (!s) saved.set(el, (s = {}));
    if (!(prop in s)) s[prop] = [el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)];
  }
  function setInline(el, prop, value) {
    remember(el, prop);
    el.style.setProperty(prop, value, 'important');
    const mark = el.getAttribute(MARK) || '';
    const letter = prop === 'color' ? 'c' : 'b';
    if (!mark.includes(letter)) el.setAttribute(MARK, mark + letter);
    stats.changed++;
  }

  // The background an element's text is drawn on: its own if solid, else its parent's. null = a picture (unknown).
  function backgroundOf(el) {
    if (!el || el === root || el.nodeType !== 1) return pal.page;
    if (bgCache.has(el)) return bgCache.get(el);
    const cs = getComputedStyle(el);
    let bg;
    if (cs.backgroundImage !== 'none') bg = null;
    else {
      const c = parse(cs.backgroundColor);
      bg = c && c[3] > 0.5 ? c : backgroundOf(el.parentElement);
    }
    bgCache.set(el, bg);
    return bg;
  }

  function check(el) {
    stats.seen++;
    const cs = getComputedStyle(el);
    let bg;
    if (cs.backgroundImage !== 'none') {
      bg = null;   // never touch pictures; text on them is left alone too
    } else {
      const c = parse(cs.backgroundColor);
      if (c && nearWhite(c)) {
        setInline(el, 'background-color', 'var(--msc-surface)');
        bg = pal.surface;
      } else {
        bg = c && c[3] > 0.5 ? c : backgroundOf(el.parentElement);
      }
    }
    bgCache.set(el, bg);
    if (!bg) return;
    const fg = parse(cs.color);
    if (fg && fg[3] > 0.3 && greyText(fg) && contrast(fg, bg) < 3 && lum(bg) < 0.2) {
      setInline(el, 'color', el.localName === 'a' ? 'var(--msc-link)' : 'var(--msc-text)');
    }
  }

  // Skips media, svg, our own parts and anything editable (inline styles there would be saved into the content).
  function accept(node) {
    if (node.namespaceURI !== HTML_NS) return NodeFilter.FILTER_REJECT;
    const tag = node.tagName;
    if (SKIP.has(tag)) {
      if (tag === 'IFRAME' || tag === 'FRAME') frame(node);
      return NodeFilter.FILTER_REJECT;
    }
    if (node.isContentEditable || node.matches(OWN)) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }

  // ---------- Same-origin iframes ----------
  function frameCss() {
    return `:root { color-scheme: dark; }
html, body { background-color: var(--msc-page, #161616) !important; color: var(--msc-text, #ececec) !important; }
:root { --msc-page: ${css(pal.page)}; --msc-surface: ${css(pal.surface)}; --msc-text: ${css(pal.text)}; --msc-link: ${css(pal.link)}; }
a:not([style*="color"]) { color: var(--msc-link); }`;
  }
  const css = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

  function frameDoc(iframe) {
    try { return iframe.contentDocument; } catch { return null; }   // cross-origin: leave it alone
  }

  function frame(iframe) {
    if (!frames.has(iframe)) {
      frames.add(iframe);
      iframe.addEventListener('load', () => { if (active) styleFrame(iframe); });
    }
    styleFrame(iframe);
  }

  function styleFrame(iframe) {
    const doc = frameDoc(iframe);
    if (!doc || !doc.documentElement || doc.getElementById(FRAME_STYLE)) return;
    const body = doc.body;
    if (!body) return;   // not loaded yet; the load listener comes back
    // Only light pages: a frame with its own dark or coloured page keeps it.
    const win = doc.defaultView;
    const own = [body, doc.documentElement].map((n) => parse(win.getComputedStyle(n).backgroundColor));
    const solid = own.find((c) => c && c[3] > 0.5);
    if (solid && !nearWhite(solid)) return;
    const style = doc.createElement('style');
    style.id = FRAME_STYLE;
    style.textContent = frameCss();
    (doc.head || doc.documentElement).append(style);
  }

  function unstyleFrames() {
    for (const iframe of document.querySelectorAll('iframe, frame')) frameDoc(iframe)?.getElementById(FRAME_STYLE)?.remove();
  }

  // ---------- Running in idle slices ----------
  function schedule() {
    if (idleId || !active) return;
    idleId = requestIdleCallback(run, { timeout: 1000 });
  }

  function run() {
    idleId = 0;
    if (!active) return;
    const start = performance.now();
    const end = start + SLICE_MS;
    if (full) { full = false; roots = [document.body]; walker = null; }
    let n = 0;
    while (true) {
      if (!walker) {
        const next = roots.shift();
        if (!next) break;
        if (!next.isConnected || next.nodeType !== 1) continue;
        if (next.closest(OWN) || next.closest('[contenteditable=""], [contenteditable="true"]')) continue;
        if (accept(next) !== NodeFilter.FILTER_ACCEPT) continue;
        walker = document.createTreeWalker(next, NodeFilter.SHOW_ELEMENT, accept);
        check(next);
      }
      const el = walker.nextNode();
      if (!el) { walker = null; continue; }
      check(el);
      if ((++n & 7) === 0 && performance.now() > end) break;
    }
    const took = performance.now() - start;
    stats.ms += took;
    stats.slices++;
    if (walker || roots.length) { schedule(); return; }
    bgCache = new Map();   // colours can change between runs
    if (!stats.firstDone) {
      stats.firstDone = 1;
      stats.wall = Math.round(performance.now() - startedAt);
      if (timing) root.setAttribute('data-mscv-timing', JSON.stringify(stats));
    }
  }

  function onMutations(records) {
    for (const r of records) {
      for (const node of r.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (roots.length >= QUEUE_CAP) { full = true; roots = []; break; }
        roots.push(node);
      }
    }
    if (!timer && (roots.length || full)) timer = setTimeout(() => { timer = 0; schedule(); }, 200);
  }

  function start() {
    if (!active || observer || !document.body) return;
    pal = readPalette();
    startedAt = performance.now();
    roots = [document.body];
    walker = null;
    observer = new MutationObserver(onMutations);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (idleId) cancelIdleCallback(idleId);
    clearTimeout(timer);
    idleId = timer = 0;
    roots = [];
    walker = null;
    full = false;
    bgCache = new Map();
    for (const el of document.querySelectorAll(`[${MARK}]`)) {
      const s = saved.get(el) || {};
      for (const prop of ['background-color', 'color']) {
        if (!(prop in s)) continue;
        // Only if the page hasn't replaced our value since.
        if (el.style.getPropertyValue(prop).startsWith('var(--msc-')) {
          const [value, priority] = s[prop];
          if (value) el.style.setProperty(prop, value, priority);
          else el.style.removeProperty(prop);
        }
      }
      if (el.getAttribute('style') === '') el.removeAttribute('style');
      el.removeAttribute(MARK);
      saved.delete(el);
    }
    unstyleFrames();
  }

  // Turns dark mode on or off, live. Safe to call any number of times, also before <body> exists.
  function set(on) {
    root.toggleAttribute(ATTR, on);
    if (on === active) return;
    active = on;
    if (!on) { stop(); return; }
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }

  return { set };
})();
