"""Load-test More Settings for Canvas in headless Firefox (Selenium).

Run:  python test_canvas.py OUT_DIR CERT.pem KEY.pem
It starts tools/fake_canvas.py (https://127.0.0.1:8443), saves 127.0.0.1 as the extra Canvas address,
and checks the popup, migration, reminders on example.com, dark mode and the dashboard features against fake data.
Screenshots go to OUT_DIR.
"""
import json, os, subprocess, sys, time
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
OUT, CERT, KEY = sys.argv[1], sys.argv[2], sys.argv[3]
UUID = "6c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
ID = "more-settings-for-canvas@timwjt"
BASE = f"moz-extension://{UUID}/"
FAKE = "https://127.0.0.1:8443"

server = subprocess.Popen([sys.executable, os.path.join(HERE, "fake_canvas.py"), CERT, KEY])
o = Options()
o.add_argument("-headless")
o.accept_insecure_certs = True
o.set_preference("extensions.webextensions.uuids", json.dumps({ID: UUID}))
d = webdriver.Firefox(options=o, service=Service(service_args=["--allow-system-access"]))
d.set_window_size(1300, 950)
results = []


def check(name, ok, info=""):
    results.append((name, ok))
    print(("PASS " if ok else "FAIL ") + name, info, flush=True)


def chrome(script, *args):
    with d.context(d.CONTEXT_CHROME):
        return d.execute_script(script, *args)


def open_ext_tab(path, background=False):
    before = set(d.window_handles)
    chrome("gBrowser.addTab(arguments[0], {triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: arguments[1]})",
           BASE + path, background)
    time.sleep(1.5)
    return (set(d.window_handles) - before).pop()


def ext_js(script):
    """Run async JS in the extension page tab (has browser.* APIs), then come back to the web tab."""
    d.switch_to.window(ext_handle)
    r = d.execute_async_script("const done = arguments[arguments.length-1];(async()=>{" + script + "})().then(done, e=>done('ERR '+e))")
    d.switch_to.window(web_handle)
    return r


def sync_get(keys="null"):
    return json.loads(ext_js(f"return JSON.stringify(await browser.storage.sync.get({keys}))"))


def sync_set(obj):
    return ext_js(f"await browser.storage.sync.set({json.dumps(obj)}); return 1;")


try:
    time.sleep(1)
    # Collect script errors from extension pages and content scripts.
    chrome("""window.__errs = [];
      Services.console.registerListener({ observe(m) { try {
        if (m instanceof Ci.nsIScriptError && !(m.flags & 1) && /moz-extension|canvas|reminder/.test(m.sourceName + m.errorMessage))
          window.__errs.push(m.errorMessage + ' @ ' + m.sourceName + ':' + m.lineNumber);
      } catch (e) {} } });""")
    d.install_addon(EXT, temporary=True)
    time.sleep(2)
    print("Firefox", d.capabilities.get("browserVersion"))
    web_handle = d.current_window_handle

    # ---------- popup ----------
    ext_handle = open_ext_tab("popup.html")
    d.switch_to.window(ext_handle)
    tabs = [t.text for t in d.find_elements(By.CSS_SELECTOR, ".tab")]
    check("popup renders 3 tabs", tabs == ["Dashboard", "To-do", "More"], str(tabs))
    title = d.find_element(By.CSS_SELECTOR, "h1").text
    check("popup title", title == "Canvas Settings", title)
    d.save_screenshot(os.path.join(OUT, "v2-popup-dashboard.png"))
    d.find_element(By.XPATH, "//span[@class='name' and text()='Compact cards']").click()
    time.sleep(0.4)
    d.switch_to.window(web_handle)
    check("switch saves (compactCards)", sync_get('"compactCards"').get("compactCards") is True)
    d.switch_to.window(ext_handle)
    d.execute_script("const r=document.getElementById('range-cardCount'); r.value=2; r.dispatchEvent(new Event('change'))")
    time.sleep(0.3)
    d.switch_to.window(web_handle)
    check("slider saves (cardCount=2)", sync_get('"cardCount"').get("cardCount") == 2)
    d.switch_to.window(ext_handle)
    d.find_element(By.ID, "tab-todo").click()
    d.save_screenshot(os.path.join(OUT, "v2-popup-todo.png"))
    d.find_element(By.ID, "tab-more").click()
    d.save_screenshot(os.path.join(OUT, "v2-popup-more.png"))
    d.find_element(By.ID, "power").click()
    time.sleep(0.3)
    off = d.execute_script("return [document.getElementById('power').getAttribute('aria-checked'), document.getElementById('off-msg').textContent, document.getElementById('rest').inert]")
    check("power button off", off[0] == "false" and off[1].startswith("Off.") and off[2] is True, str(off))
    d.save_screenshot(os.path.join(OUT, "v2-popup-off.png"))
    d.find_element(By.ID, "power").click()
    time.sleep(0.3)
    d.switch_to.window(web_handle)
    check("power saved back on", sync_get('"on"').get("on") is True)
    sync_set({"cardCount": 4, "compactCards": False})

    # ---------- migration (re-install = "update") ----------
    sync_set({"enabled": False, "canvas_host": "https://Canvas.Old.edu/", "dark_mode": False, "num_assignments": "7",
              "assignment_date_format": "mm/dd", "todo_colors": True, "dashboard_notes_text": "old note",
              "dark_preset": {"x": 1}, "custom_cards": {}, "custom_assignments_overflow": [1], "assignment_states": {},
              "reminders": [{"old": 1}]})
    d.install_addon(EXT, temporary=True)
    time.sleep(2.5)
    d.switch_to.window(web_handle)
    ext_handle = open_ext_tab("popup.html", background=True)   # the reinstall closed the old extension tab
    got = sync_get()
    want = {"on": False, "host": "canvas.old.edu", "dark": False, "cardCount": 7, "cardDayFirst": False,
            "todoColours": True, "notesText": "old note"}
    gone = [k for k in ["enabled", "canvas_host", "dark_mode", "num_assignments", "dark_preset", "custom_cards",
                        "custom_assignments_overflow", "assignment_states", "reminders"] if k in got]
    check("migration copies values", all(got.get(k) == v for k, v in want.items()), json.dumps({k: got.get(k) for k in want}))
    check("migration removes old keys", not gone, str(gone))
    ext_js("await browser.storage.sync.clear(); return 1;")

    # ---------- extra Canvas address -> registered scripts ----------
    has = ext_js("return await browser.permissions.contains({origins:['https://127.0.0.1/*']})")
    print("permission for 127.0.0.1 already granted:", has)
    if not has:
        chrome("""const {ExtensionPermissions} = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
                  const {ExtensionParent} = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
                  const ext = ExtensionParent.GlobalManager.getExtension(arguments[0]);
                  ExtensionPermissions.add(arguments[0], {permissions: [], origins: ['https://127.0.0.1/*']}, ext);""", ID)
        time.sleep(1)
    sync_set({"host": "127.0.0.1"})
    time.sleep(1.5)
    reg = ext_js("return JSON.stringify(await browser.scripting.getRegisteredContentScripts())")
    check("extra host scripts registered", "https://127.0.0.1/*" in reg, reg[:160])

    # ---------- dashboard on fake Canvas ----------
    d.get(FAKE + "/")
    time.sleep(4)
    dark = d.execute_script("return [document.documentElement.hasAttribute('data-mscv-dark'), getComputedStyle(document.documentElement).filter, localStorage.getItem('mscv-dark')]")
    check("dark mode on by default", dark[0] and "invert" in dark[1] and dark[2] in (None, "1"), str(dark))
    img = d.execute_script("return getComputedStyle(document.querySelector('.ic-DashboardCard__header_image')).filter")
    check("background-image elements un-inverted", "invert(1)" in img, img)
    st = d.execute_script("""return {
      notes: !!document.querySelector('.mscv-notes textarea[aria-label="Dashboard notes"]'),
      notesBeforeCards: document.querySelector('.mscv-notes')?.nextElementSibling?.id,
      due: [...document.querySelectorAll('.ic-DashboardCard')].map(c => [...c.querySelectorAll('.mscv-due li')].map(li => li.querySelector('.mscv-due-title').textContent + '|' + li.querySelector('.mscv-due-when').textContent)),
      none: [...document.querySelectorAll('.mscv-due-none')].map(e => e.textContent),
      todo: [...document.querySelectorAll('#mscv-todo .mscv-list')[0].querySelectorAll('.mscv-title')].map(e => e.textContent),
      ann: [...document.querySelectorAll('#mscv-todo .mscv-list')[1].querySelectorAll('.mscv-title')].map(e => e.textContent),
      soon: [...document.querySelectorAll('#mscv-todo .mscv-soon .mscv-title')].map(e => e.textContent),
      dates: [...document.querySelectorAll('#mscv-todo .mscv-date')].map(e => e.textContent),
      canvasTodoHidden: getComputedStyle(document.getElementById('canvas-own-todo')).display,
      feedbackShown: getComputedStyle(document.getElementById('feedback')).display,
      status: document.querySelector('#mscv-todo .mscv-status').textContent,
    }""")
    print(json.dumps(st, indent=1))
    check("notes box above cards", st["notes"] and st["notesBeforeCards"] == "DashboardCard_Container")
    c1 = st["due"][0] if st["due"] else []
    check("card due list (skips complete, past due shown, submitted future kept)",
          [x.split("|")[0] for x in c1] == ["Intro post", "Week 5 quiz", "Essay draft", "Lab 1"], str(c1))
    check("relative due text", c1 and c1[1].endswith("|in 3h"), str(c1[:2]))
    check("to-do list items", st["todo"][:2] == ["Week 5 quiz", "Essay draft"] and "Intro post" not in st["todo"] and "Marked done" not in st["todo"], str(st["todo"]))
    check("announcements section", st["ann"] == ["Welcome back"], str(st["ann"]))
    check("due within 6h is red", st["soon"] == ["Week 5 quiz"], str(st["soon"]))
    check("date format 'Mon D at h:mmam (in ...)'", any(" at " in x and "(in " in x for x in st["dates"]), str(st["dates"][:2]))
    check("Canvas sidebar hidden, feedback kept", st["canvasTodoHidden"] == "none" and st["feedbackShown"] != "none")
    check("planner loaded (no error text)", st["status"] == "", st["status"])
    d.save_screenshot(os.path.join(OUT, "v2-dashboard-dark.png"))

    # reminders were saved from the planner
    rem = sync_get('"reminders"').get("reminders") or {}
    titles = [r["title"] for r in rem.get("items", [])]
    hidden = {r["title"]: r["hidden"] for r in rem.get("items", [])}
    check("reminders saved (next 10 days, submitted = -1, not complete/past/far)",
          sorted(titles) == sorted(["Week 5 quiz", "Essay draft", "Lab 1"]) and hidden.get("Lab 1") == -1, json.dumps(hidden))
    check("reminder urls are absolute", all(r["url"].startswith(FAKE + "/courses/") for r in rem.get("items", [])))

    # Cross off from a card, live options
    d.execute_script("document.querySelector('.ic-DashboardCard .mscv-due-when').click()")
    time.sleep(0.6)
    crossed = d.execute_script("return document.querySelector('.ic-DashboardCard .mscv-due li').classList.contains('mscv-crossed')")
    state = sync_get('"itemState"').get("itemState", {})
    check("cross off saves to itemState", crossed and state.get("d13", {}).get("x") is True, json.dumps(state))
    sync_set({"cardRelative": False, "cardDayFirst": True, "cardPastDue": False, "todo24h": True, "compactCards": True, "hideFeedback": True})
    time.sleep(0.8)
    live = d.execute_script("""return {
      first: document.querySelector('.ic-DashboardCard .mscv-due li .mscv-due-title').textContent,
      when: document.querySelector('.ic-DashboardCard .mscv-due li .mscv-due-when').textContent,
      date24: document.querySelector('#mscv-todo .mscv-date').textContent,
      hero: getComputedStyle(document.querySelector('.ic-DashboardCard__header_hero')).height,
      sub: getComputedStyle(document.querySelector('.ic-DashboardCard__header-subtitle')).display,
      fb: getComputedStyle(document.getElementById('feedback')).display }""")
    check("options apply live (d/m dates, no past due, 24h, compact, hide feedback)",
          live["first"] != "Intro post" and "/" in live["when"] and ("am" not in live["date24"] and "pm" not in live["date24"])
          and live["hero"] == "56px" and live["sub"] == "none" and live["fb"] == "none", json.dumps(live))
    sync_set({"cardRelative": True, "cardPastDue": True, "todo24h": False, "compactCards": False, "hideFeedback": False})
    time.sleep(0.5)

    # Item menu: Remove -> shows under Done; Label
    d.execute_script("document.querySelector('#mscv-todo .mscv-menu-btn').click()")
    time.sleep(0.3)
    menu = d.execute_script("return [...document.querySelectorAll('#mscv-todo .mscv-menu [role=menuitem]')].map(b => b.textContent)")
    focus_in_menu = d.execute_script("return document.activeElement.getAttribute('role')")
    check("item menu opens with focus", menu[:3] == ["Remove", "Cross off", "Label"] and focus_in_menu == "menuitem", str(menu))
    d.execute_script("document.querySelector('#mscv-todo .mscv-menu [role=menuitem]').click()")
    time.sleep(0.5)
    todo_now = d.execute_script("return [...document.querySelectorAll('#mscv-todo .mscv-list')[0].querySelectorAll('.mscv-title')].map(e => e.textContent)")
    d.execute_script("document.querySelectorAll('#mscv-todo .mscv-seg-btn')[1].click()")
    time.sleep(0.3)
    done_now = d.execute_script("return [...document.querySelectorAll('#mscv-todo .mscv-list')[0].querySelectorAll('.mscv-title')].map(e => e.textContent)")
    check("Remove moves item to Done", "Week 5 quiz" not in todo_now and "Week 5 quiz" in done_now and "Marked done" in done_now, f"{todo_now} / {done_now}")
    d.execute_script("document.querySelectorAll('#mscv-todo .mscv-seg-btn')[0].click()")
    time.sleep(0.2)
    d.execute_script("document.querySelector('#mscv-todo .mscv-menu-btn').click()")
    time.sleep(0.2)
    d.execute_script("[...document.querySelectorAll('#mscv-todo .mscv-menu [role=menuitem]')].find(b => b.textContent === 'Label').click()")
    time.sleep(0.3)
    inp = d.switch_to.active_element
    inp.send_keys("Group")
    inp.send_keys(Keys.ENTER)
    time.sleep(0.5)
    lab = d.execute_script("return document.querySelector('#mscv-todo .mscv-label')?.textContent")
    check("label saved and shown", lab == "Group", str(lab))

    # + Add a personal to-do
    d.execute_script("document.querySelector('#mscv-todo .mscv-add-btn').click()")
    time.sleep(0.2)
    opts = d.execute_script("return [...document.querySelectorAll('#mscv-add-form select option')].map(o => o.textContent)")
    check("add form lists courses", opts == ["No course", "COMP1001", "MATH2002"], str(opts))
    d.execute_script("""const f = document.getElementById('mscv-add-form');
      f.querySelector('input[name=name]').value = 'Buy lab coat';
      f.querySelector('select').value = '202';
      const t = new Date(Date.now() + 86400e3); const p = n => String(n).padStart(2, '0');
      f.querySelector('input[name=date]').value = t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
      f.querySelector('input[name=time]').value = '09:00';
      f.requestSubmit();""")
    time.sleep(0.8)
    mine = sync_get('"myTodos"').get("myTodos", [])
    shown = d.execute_script("return [...document.querySelectorAll('#mscv-todo .mscv-title')].map(e => e.textContent)")
    check("personal to-do saved and shown", len(mine) == 1 and mine[0]["t"] == "Buy lab coat" and "Buy lab coat" in shown, json.dumps(mine))

    # Hover preview: plain text, script tag stripped
    d.execute_script("""const li = [...document.querySelectorAll('#mscv-todo .mscv-item')].find(l => l.textContent.includes('Essay draft'));
      li.dispatchEvent(new MouseEvent('mouseenter'));""")
    time.sleep(1.2)
    pv = d.execute_script("const p = document.getElementById('mscv-preview'); return [p.hidden, p.textContent]")
    check("hover preview shows details as plain text", pv[0] is False and "Write 500 words." in pv[1] and "alert" not in pv[1], str(pv))

    # Notes save after 1 s
    ta = d.find_element(By.CSS_SELECTOR, ".mscv-notes textarea")
    ta.send_keys("Exam in week 9")
    time.sleep(1.6)
    check("notes save after typing stops", sync_get('"notesText"').get("notesText") == "Exam in week 9")
    d.save_screenshot(os.path.join(OUT, "v2-dashboard-after.png"))

    # Dark mode off live, then power off removes everything
    sync_set({"dark": False})
    time.sleep(0.5)
    dk = d.execute_script("return [document.documentElement.hasAttribute('data-mscv-dark'), localStorage.getItem('mscv-dark')]")
    check("dark mode turns off live", dk == [False, "0"], str(dk))
    d.save_screenshot(os.path.join(OUT, "v2-dashboard-light.png"))
    sync_set({"dark": True, "on": False})
    time.sleep(0.6)
    gone = d.execute_script("return [document.documentElement.hasAttribute('data-mscv-dark'), !!document.querySelector('.mscv-due, #mscv-todo, .mscv-notes'), getComputedStyle(document.getElementById('canvas-own-todo')).display]")
    check("power off removes everything live", gone[0] is False and gone[1] is False and gone[2] != "none", str(gone))
    sync_set({"on": True})
    time.sleep(0.8)
    back = d.execute_script("return [document.documentElement.hasAttribute('data-mscv-dark'), !!document.querySelector('#mscv-todo'), document.querySelectorAll('.mscv-due').length]")
    check("power on brings it back live", back == [True, True, 2], str(back))

    # Example reminder when reminders are switched on
    sync_set({"remind": False})
    time.sleep(0.3)
    # Change it from the extension tab after a delay, so the Canvas tab is the visible one when it happens.
    ext_js("setTimeout(() => browser.storage.sync.set({remind: true}), 1500); return 1;")
    time.sleep(2.5)
    ex = d.execute_script("return !!document.querySelector('msc-reminders')")
    check("example reminder on the Canvas tab", ex)
    d.save_screenshot(os.path.join(OUT, "v2-example-reminder.png"))

    # ---------- reminders on another site ----------
    now = int(time.time() * 1000)
    sync_set({"reminders": {"v": 2, "items": [
        {"due": now + 2 * 86400000, "title": "SECRET essay title", "url": FAKE + "/courses/101/assignments/11", "hidden": 0},
        {"due": now + 3 * 86400000, "title": "Dismissed once", "url": FAKE + "/courses/101/assignments/99", "hidden": 1},
        {"due": now + 4 * 86400000, "title": "Submitted thing", "url": FAKE + "/courses/101/assignments/98", "hidden": -1}]}})
    d.get("https://example.com/")
    time.sleep(3.5)
    page_view = d.execute_script("""const h = document.querySelector('msc-reminders');
      return { host: !!h, shadow: h ? h.shadowRoot : 'nohost', body: document.body.innerText, html: document.documentElement.innerText,
               outer: h ? h.outerHTML : '' }""")
    check("reminder host on example.com", page_view["host"] is True)
    check("page can't open the shadow root", page_view["shadow"] is None)
    check("page text doesn't contain the title", "SECRET" not in page_view["body"] and "SECRET" not in page_view["html"] and "SECRET" not in page_view["outer"])
    d.save_screenshot(os.path.join(OUT, "v2-reminder-example-com.png"))
    btn_ok = d.execute_script("""const h = document.querySelector('msc-reminders'); return h ? h.getBoundingClientRect().width > 0 : false""")
    check("reminder card visible (has size)", btn_ok)
    # Click the dismiss button (top-right of the only card) with a real mouse click.
    from selenium.webdriver.common.action_chains import ActionChains
    w, hgt = d.execute_script("const r = document.querySelector('msc-reminders').getBoundingClientRect(); return [r.width, r.height]")
    ActionChains(d).move_to_element_with_offset(d.find_element(By.TAG_NAME, "msc-reminders"), int(w / 2) - 24, -int(hgt / 2) + 26).click().perform()
    time.sleep(1)
    rem = sync_get('"reminders"')["reminders"]["items"]
    check("dismiss counts up hidden", rem[0]["hidden"] == 1, json.dumps([r["hidden"] for r in rem]))
    check("dismissed card removed", d.execute_script("return !document.querySelector('msc-reminders')"))

    # Reminders off -> nothing on other sites
    sync_set({"reminders": {"v": 2, "items": [{"due": now + 86400000, "title": "X", "url": FAKE + "/a", "hidden": 0}]}})
    time.sleep(0.5)
    check("new reminder appears on storage change", d.execute_script("return !!document.querySelector('msc-reminders')"))
    sync_set({"remind": False})
    time.sleep(0.5)
    check("reminders off removes card", d.execute_script("return !document.querySelector('msc-reminders')"))

    # ---------- download message checks ----------
    r = ext_js("try { const x = await browser.runtime.sendMessage({type:'download', courseId:'1', files:[]}); return 'reply:' + JSON.stringify(x); } catch (e) { return 'rejected:' + e.message; }")
    check("download refused from the popup page", not r.startswith("reply:{"), r)
    dl = open_ext_tab("html/downloader.html?sidebar=1", background=True)
    d.switch_to.window(dl)
    r = d.execute_async_script("""const done = arguments[arguments.length-1];
      browser.runtime.sendMessage({type:'download', courseId:'12', files:[
        {id: 1, url: 'http://x.instructure.com/files/1', filename: 'Canvas/A/f.pdf'},
        {id: 2, url: 'https://evil.example/files/2', filename: 'Canvas/A/g.pdf'},
        {id: 3, url: 'https://x.instructure.com/files/3', filename: 'Canvas/../h.pdf'}]}).then(x => done(JSON.stringify(x)), e => done('ERR ' + e));""")
    check("downloader: bad urls/filenames refused", json.loads(r) == {"queued": 0, "failed": ["Canvas/A/f.pdf", "Canvas/A/g.pdf", "Canvas/../h.pdf"], "done": []}, r)
    r = d.execute_async_script("""const done = arguments[arguments.length-1];
      browser.runtime.sendMessage({type:'download', courseId:'12a', files:[]}).then(x => done(JSON.stringify(x)), e => done('ERR ' + e));""")
    check("downloader: bad course id refused", '"queued":0' in r, r)
    d.switch_to.window(web_handle)

    errs = chrome("return window.__errs")
    check("no script errors from the add-on", not errs, "\n".join(errs[:10]))
finally:
    passed = sum(1 for _, ok in results if ok)
    print(f"\n{passed}/{len(results)} passed")
    d.quit()
    server.terminate()
