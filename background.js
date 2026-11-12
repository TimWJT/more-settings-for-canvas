'use strict';
// More Settings for Canvas - background (event page).
// Three jobs: move old settings to the new names once, run the Canvas scripts on the extra address the user saved,
// and start downloads for the course file downloader. No work happens on wake-up other than these listeners.

// ---------- 1. One-time migration of the old add-on's settings ----------

// Makes an old value fit the new setting's type (old versions may have stored strings).
function convertOld(newKey, value) {
  const def = MSC_DEFAULTS[newKey];
  if (typeof def === 'number') return mscClamp(value, 1, 10, def);
  if (typeof def === 'string') return typeof value === 'string' ? value : def;
  if (typeof def === 'boolean') {
    if (typeof value === 'boolean') return value;
    // Date order may have been stored as text like "dd/mm" or "mm/dd".
    if (newKey === 'cardDayFirst' && typeof value === 'string') return /^d/i.test(value.trim());
    if (value === 'true' || value === 1) return true;
    if (value === 'false' || value === 0) return false;
    return def;
  }
  return value;
}

async function migrate() {
  const all = await browser.storage.sync.get(null);
  const add = {};
  const remove = [];
  for (const [oldKey, newKey] of Object.entries(MSC_OLD_KEYS)) {
    if (!(oldKey in all)) continue;
    if (newKey === 'host') {
      const clean = mscCleanHost(all[oldKey]);
      add.host = clean || '';
    } else {
      add[newKey] = convertOld(newKey, all[oldKey]);
    }
    if (oldKey !== newKey) remove.push(oldKey);
  }
  for (const key of Object.keys(all)) {
    if (MSC_DROP_KEYS.includes(key) || MSC_DROP_PREFIXES.some((p) => key.startsWith(p))) remove.push(key);
  }
  // "reminders" in the old shape (anything that isn't our { v: 2, items } object) is dropped.
  const r = all.reminders;
  if (r !== undefined && !(r && r.v === 2 && Array.isArray(r.items))) remove.push('reminders');

  if (Object.keys(add).length) await browser.storage.sync.set(add);
  if (remove.length) await browser.storage.sync.remove(remove);
}

// ---------- 2. Canvas scripts on the extra address ----------

const EXTRA_ID = 'extra-canvas';

// Makes the registered scripts match the saved address (or removes them). Safe to call any number of times.
async function syncExtraHost() {
  const { host } = await browser.storage.sync.get({ host: '' });
  const clean = mscCleanHost(host);
  let wanted = null;
  if (clean && !mscIsBuiltInHost(clean)) {
    const origin = `https://${clean}/*`;
    // Only register where Firefox has given us access, otherwise registering fails or does nothing.
    if (await browser.permissions.contains({ origins: [origin] })) wanted = origin;
  }
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [EXTRA_ID] });
  if (existing.length) {
    if (wanted && existing[0].matches.length === 1 && existing[0].matches[0] === wanted) return;
    await browser.scripting.unregisterContentScripts({ ids: [EXTRA_ID] });
  }
  if (!wanted) return;
  await browser.scripting.registerContentScripts([{
    id: EXTRA_ID,
    matches: [wanted],
    css: ['canvas.css'],
    js: ['settings.js', 'content/reminder-card.js', 'content/dark.js', 'content/canvas.js'],
    runAt: 'document_start',
    allFrames: false,
  }]);
}

function logError(e) { console.error('More Settings for Canvas:', e); }

browser.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install' || details.reason === 'update') await migrate().catch(logError);
  syncExtraHost().catch(logError);
});
browser.runtime.onStartup.addListener(() => syncExtraHost().catch(logError));
browser.permissions.onAdded.addListener(() => syncExtraHost().catch(logError));
browser.permissions.onRemoved.addListener(() => syncExtraHost().catch(logError));
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && 'host' in changes) syncExtraHost().catch(logError);
});

// ---------- 3. Downloads for the course file downloader ----------

// Each part of "Canvas/CODE/01 Module/file.pdf" must be a real name: not empty, not "." or "..".
function safeFilename(name) {
  if (typeof name !== 'string' || !name || name.length > 400) return false;
  if (name.startsWith('/') || name.includes('\\') || /^[a-z]:/i.test(name)) return false;
  return name.split('/').every((part) => part.trim() !== '' && part !== '.' && part !== '..');
}

async function handleDownload(msg) {
  const failed = [];
  const done = [];
  let queued = 0;
  const courseId = String(msg.courseId ?? '');
  if (!/^\d+$/.test(courseId) || !Array.isArray(msg.files)) return { queued, failed: ['(bad request)'], done };
  const { host } = await browser.storage.sync.get({ host: '' });
  const extra = mscCleanHost(host) || '';

  for (const f of msg.files.slice(0, 3000)) {
    const filename = typeof f?.filename === 'string' ? f.filename : '(no name)';
    let url = null;
    try { url = new URL(f.url); } catch { /* bad url */ }
    const ok = url && url.protocol === 'https:' && mscIsCanvasHost(url.hostname, extra) && safeFilename(f.filename);
    if (!ok) { failed.push(filename); continue; }
    try {
      await browser.downloads.download({ url: url.href, filename, conflictAction: 'uniquify', saveAs: false });
      queued++;
      if (f.id != null && /^\d+$/.test(String(f.id))) done.push(f.id);
    } catch {
      failed.push(filename);
    }
  }

  // Remember which files were downloaded, so the list can tick them next time.
  if (done.length) {
    const key = 'done_' + courseId;
    const before = (await browser.storage.local.get(key))[key] || [];
    await browser.storage.local.set({ [key]: [...new Set([...before, ...done])] });
  }
  return { queued, failed, done };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'download') return undefined;
  // Only the downloader page inside this add-on may ask for downloads.
  const page = browser.runtime.getURL('html/downloader.html');
  if (sender.id !== browser.runtime.id || typeof sender.url !== 'string' || !sender.url.startsWith(page)) return undefined;
  return handleDownload(msg);
});
