const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);
const VIDEO = /\.(mp4|mov|mkv|m4v|avi|webm|wmv)$/i;
const BIG = /\.(ova|ovf|zip|7z|rar|iso|vmdk|vdi|qcow2)$/i;

let course = null;      // { id, code, modules: [{ name, files: [...] }] }
let done = new Set();   // file ids downloaded before

// In the sidebar the page stays open while you browse, so it follows whichever course tab you're on.
const inSidebar = new URLSearchParams(location.search).has("sidebar");
if (inSidebar) {
  document.body.classList.add("sidebar");
  $("back").hidden = true;
  api.tabs.onActivated.addListener(refresh);
  api.tabs.onUpdated.addListener((id, info, tab) => { if (tab.active && info.status === "complete") refresh(); });
}

let scanning; // course id being shown; undefined until the first check
refresh();

async function refresh() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const { host } = await api.storage.sync.get("host");
  const m = tab?.url?.match(/^https:\/\/([^/]+)\/courses\/(\d+)/);
  const onCanvas = m && ((m[1].endsWith(".instructure.com") || m[1] === "canvas.sydney.edu.au") || m[1] === host);
  const id = onCanvas ? m[2] : null;
  if (scanning === id) return; // same course as before, so keep your ticks
  scanning = id;
  course = null;
  init(tab, id).catch((e) => setStatus("Error: " + e.message));
}

async function init(tab, courseId) {
  $("title").textContent = "Download course files";
  $("toolbar").hidden = true;
  $("footer").hidden = true;
  $("list").textContent = "";
  if (!courseId) return setStatus(inSidebar ? "Open a Canvas course page and its files will show here." : "Open a Canvas course page first, then click this again.");
  const m = [null, courseId];

  setStatus("Reading modules…");
  const [res] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    world: "ISOLATED", // not the page's own world, so Canvas page scripts can't change the file list or links
    func: scanCourse,
    args: [m[1]],
  });
  if (res.result?.error) throw new Error(res.result.error);
  if (scanning !== courseId) return; // you switched tabs while it was scanning
  course = res.result;

  const key = "done_" + course.id;
  done = new Set((await api.storage.local.get(key))[key] || []);
  render();
}

// Runs inside the Canvas tab (as a content script), so the requests use your Canvas login.
async function scanCourse(courseId) {
  const base = location.origin + "/api/v1";
  async function getAll(url) {
    const out = [];
    while (url) {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error(r.status + " on " + url);
      out.push(...(await r.json()));
      const next = (r.headers.get("Link") || "").match(/<([^>]+)>;\s*rel="next"/);
      url = next ? next[1] : null;
    }
    return out;
  }
  try {
    const info = await (await fetch(`${base}/courses/${courseId}`)).json();
    const code = (info.course_code || info.name || "Course " + courseId).match(/[A-Z]{2,5}\d{3,5}/)?.[0]
      || info.course_code || "Course " + courseId;

    const mods = await getAll(`${base}/courses/${courseId}/modules?include[]=items&per_page=100`);
    for (const mod of mods) {
      if (!mod.items) mod.items = await getAll(`${base}/courses/${courseId}/modules/${mod.id}/items?per_page=100`);
    }

    // Look up each file (download link, size, lock state), 6 at a time.
    const jobs = [];
    for (const mod of mods) for (const it of mod.items) if (it.type === "File") jobs.push(it);
    const fileInfo = {};
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < jobs.length) {
        const it = jobs[i++];
        try {
          const r = await fetch(`${base}/courses/${courseId}/files/${it.content_id}`);
          fileInfo[it.id] = r.ok ? await r.json() : { locked_for_user: true };
        } catch { fileInfo[it.id] = { locked_for_user: true }; }
      }
    }));

    // Canvas display names can drop the extension ("Tutorial 02 Solution"), so take it from the real filename or type.
    function withExtension(name, f) {
      if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
      const fromFile = decodeURIComponent(f.filename || "").match(/\.[a-z0-9]{2,5}$/i)?.[0];
      const types = { "application/pdf": ".pdf", "application/zip": ".zip", "video/mp4": ".mp4",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx" };
      return name + (fromFile || types[f["content-type"]] || "");
    }

    return {
      id: courseId,
      code,
      modules: mods.map((mod) => ({
        name: mod.name,
        position: mod.position,
        files: mod.items.filter((it) => it.type === "File").map((it) => {
          const f = fileInfo[it.id] || {};
          return {
            id: it.content_id,
            name: withExtension(f.display_name || it.title, f),
            size: f.size || 0,
            url: f.url || "",
            locked: !!f.locked_for_user || !f.url,
          };
        }),
      })).filter((mod) => mod.files.length),
    };
  } catch (e) {
    return { error: e.message };
  }
}

function render() {
  const total = course.modules.reduce((n, m) => n + m.files.length, 0);
  $("title").textContent = course.code;
  setStatus(`${total} files in ${course.modules.length} modules. Saves to Downloads/Canvas/${course.code}/`);
  $("toolbar").hidden = false;
  $("footer").hidden = false;

  const list = $("list");
  list.textContent = "";
  course.modules.forEach((mod, mi) => {
    const box = el("section", "module");
    const head = el("label");
    const modCb = el("input");
    modCb.type = "checkbox";
    head.append(modCb, text(mod.name));
    box.append(head);

    mod.files.forEach((f, fi) => {
      const row = el("label", "file" + (f.locked ? " locked" : ""));
      const cb = el("input");
      cb.type = "checkbox";
      cb.disabled = f.locked;
      cb.dataset.m = mi;
      cb.dataset.f = fi;
      const tick = el("span", "tick");
      tick.textContent = done.has(f.id) ? "✓" : "";
      tick.title = done.has(f.id) ? "Downloaded before" : "";
      const name = el("span", "name");
      name.textContent = f.name;
      name.title = f.name;
      const size = el("span", "size");
      size.textContent = f.locked ? "locked" : fmtSize(f.size);
      size.dataset.size = size.textContent;
      row.append(cb, tick, name, size);
      box.append(row);
    });

    modCb.addEventListener("change", () => {
      box.querySelectorAll(".file input:not(:disabled)").forEach((c) => (c.checked = modCb.checked));
      update();
    });
    list.append(box);
  });

  list.onchange = update;
  $("all").onclick = () => select(() => true);
  $("none").onclick = () => select(() => false);
  $("new").onclick = () => select((f) => !done.has(f.id));
  $("skipBig").onchange = update;
  $("skipVideo").onchange = update;
  $("go").onclick = download;
  select((f) => !done.has(f.id));
}

function select(pick) {
  boxes().forEach(({ cb, f }) => (cb.checked = !cb.disabled && pick(f)));
  update();
}

function boxes() {
  return [...document.querySelectorAll(".file input")].map((cb) => ({
    cb, mod: course.modules[cb.dataset.m], f: course.modules[cb.dataset.m].files[cb.dataset.f],
  }));
}

function skipped(f) {
  return ($("skipVideo").checked && VIDEO.test(f.name)) || ($("skipBig").checked && BIG.test(f.name));
}

function chosen() {
  return boxes().filter(({ cb, f }) => cb.checked && !cb.disabled);
}

function update() {
  // skipped files are unticked, greyed out and labelled, so what you see is what downloads
  boxes().forEach(({ cb, f }) => {
    if (f.locked) return;
    const skip = skipped(f);
    const row = cb.closest(".file");
    if (skip) cb.checked = false;
    cb.disabled = skip;
    row.classList.toggle("locked", skip);
    const size = row.querySelector(".size");
    size.textContent = skip ? "skipped · " + size.dataset.size : size.dataset.size;
  });
  document.querySelectorAll(".module").forEach((box) => {
    const all = [...box.querySelectorAll(".file input:not(:disabled)")];
    const head = box.querySelector(":scope > label input");
    head.checked = all.length > 0 && all.every((c) => c.checked);
    head.indeterminate = !head.checked && all.some((c) => c.checked);
  });
  const sel = chosen();
  const bytes = sel.reduce((n, s) => n + s.f.size, 0);
  $("summary").textContent = `${sel.length} selected · ${fmtSize(bytes)}`;
  $("go").disabled = sel.length === 0;
}

async function download() {
  const sel = chosen();
  $("go").disabled = true;
  setStatus(`Starting ${sel.length} downloads…`);
  const files = sel.map(({ mod, f }) => ({
    id: f.id,
    url: f.url,
    filename: ["Canvas", clean(course.code), pad(mod.position) + " " + clean(mod.name), clean(f.name)].join("/"),
  }));
  let res;
  try {
    res = await api.runtime.sendMessage({ type: "download", courseId: course.id, files });
    if (!res) throw new Error("no reply");
  } catch (e) {
    setStatus("Couldn't start the downloads: " + e.message);
    $("go").disabled = false;
    return;
  }
  res.done.forEach((id) => done.add(id)); // only the ones that actually started
  $("go").disabled = false;
  setStatus(`Started ${res.queued} downloads to Downloads/Canvas/${course.code}/` +
    (res.failed.length ? ` · ${res.failed.length} failed` : ""));
  boxes().forEach(({ cb, f }) => {
    if (done.has(f.id)) cb.closest(".file").querySelector(".tick").textContent = "✓";
  });
}

// Windows-safe file and folder names.
function clean(s) {
  return String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim().slice(0, 120) || "file";
}
function pad(n) { return String(n ?? 0).padStart(2, "0"); }
function fmtSize(b) {
  if (!b) return "0 KB";
  if (b < 1e6) return Math.max(1, Math.round(b / 1e3)) + " KB";
  if (b < 1e9) return (b / 1e6).toFixed(1) + " MB";
  return (b / 1e9).toFixed(2) + " GB";
}
function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function text(s) { return document.createTextNode(s); }
function setStatus(s) { $("status").textContent = s; }
