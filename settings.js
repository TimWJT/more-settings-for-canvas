// Shared by the background, the popup and the content scripts: default settings and small helpers.
// Everything here is a plain top-level name starting with "msc" so the scripts that load it can use it.
// "var", not "const": on the extra Canvas address this file can be loaded twice into the same page (once with the
// Canvas scripts, once with the reminder script), and "var" makes the second load harmless.

// Settings live in storage.sync. These are the defaults (see README for what each one does).
var MSC_DEFAULTS = {
  on: true,              // power button: false = the add-on changes nothing
  host: '',              // one extra Canvas address the user typed, hostname only
  dark: true,
  cardDue: true,
  cardDayFirst: true,
  cardPastDue: true,
  cardRelative: true,
  cardCount: 4,
  todo: true,
  todoPreview: true,
  todoHideDone: false,
  todo24h: false,
  todoPastDue: false,
  todoColours: false,
  todoCount: 4,
  notes: true,
  notesText: '',
  compactCards: false,
  hideFeedback: false,
  remind: true,
};

// Firefox refuses storage.sync items bigger than 8 KB, so we stay a bit under that.
var MSC_ITEM_LIMIT = 7600;

// Size of one storage.sync item the way Firefox counts it (key + JSON text, in bytes).
function mscItemSize(key, value) {
  return new TextEncoder().encode(key + JSON.stringify(value)).length;
}

// Whole number between min and max, or the fallback if it isn't a number.
function mscClamp(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Canvas hosts that always work, without asking Firefox for more access.
function mscIsBuiltInHost(hostname) {
  return hostname.endsWith('.instructure.com') || hostname === 'canvas.sydney.edu.au';
}

// Is this hostname Canvas (built in, or the extra address the user saved)?
function mscIsCanvasHost(hostname, extraHost) {
  return mscIsBuiltInHost(hostname) || (!!extraHost && hostname === extraHost);
}

// Turns what the user typed ("https://canvas.uni.edu/courses", "Canvas.Uni.edu") into a bare hostname,
// or returns null when it isn't a usable address (ports, IP-less names, spaces...).
function mscCleanHost(typed) {
  let text = String(typed || '').trim().toLowerCase();
  if (!text) return '';
  if (!/^[a-z]+:\/\//.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = url.hostname;
  // Needs at least one dot and only normal hostname characters.
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}

// Turns the old add-on's key names into the new ones (used once, by the background, on install/update).
var MSC_OLD_KEYS = {
  enabled: 'on',
  canvas_host: 'host',
  dark_mode: 'dark',
  assignments_due: 'cardDue',
  assignment_date_format: 'cardDayFirst',
  card_overdues: 'cardPastDue',
  relative_dues: 'cardRelative',
  num_assignments: 'cardCount',
  better_todo: 'todo',
  hover_preview: 'todoPreview',
  hide_completed: 'todoHideDone',
  todo_hr24: 'todo24h',
  todo_overdues: 'todoPastDue',
  todo_colors: 'todoColours',
  num_todo_items: 'todoCount',
  dashboard_notes: 'notes',
  dashboard_notes_text: 'notesText',
  condensed_cards: 'compactCards',
  hide_feedback: 'hideFeedback',
  remind: 'remind',
};
// Old keys that are simply removed.
var MSC_DROP_KEYS = ['dark_preset', 'custom_cards', 'assignment_states'];
var MSC_DROP_PREFIXES = ['custom_assignments'];
