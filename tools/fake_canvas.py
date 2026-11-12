"""A tiny fake Canvas for testing (no login needed): a dashboard page and the few API calls the add-on makes.

Run: python fake_canvas.py CERT.pem KEY.pem   (serves https://127.0.0.1:8443)
Make a throwaway certificate with:
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=127.0.0.1"
The data is made up and dated relative to now, so "due in 3 hours" etc. always holds.
"""
import json, ssl, sys, time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

H = 3600
D = 86400


def iso(offset):
    return datetime.fromtimestamp(time.time() + offset, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def item(kind, pid, course, title, offset, submitted=False, complete=False, ctx=None):
    path = {'assignment': 'assignments', 'quiz': 'quizzes', 'discussion_topic': 'discussion_topics',
            'announcement': 'discussion_topics'}[kind]
    return {
        'plannable_id': pid, 'plannable_type': kind, 'plannable': {'id': pid, 'title': title},
        'plannable_date': iso(offset), 'course_id': course, 'context_name': ctx or f'Course {course}',
        'html_url': f'/courses/{course}/{path}/{pid}',
        'submissions': {'submitted': submitted} if kind != 'announcement' else False,
        'planner_override': {'marked_complete': True} if complete else None,
    }


def planner():
    return [
        item('assignment', 11, 101, 'Essay draft', 2 * D, ctx='Intro to Computing'),
        item('quiz', 12, 101, 'Week 5 quiz', 3 * H, ctx='Intro to Computing'),
        item('discussion_topic', 13, 101, 'Intro post', -1 * D, ctx='Intro to Computing'),
        item('assignment', 14, 101, 'Lab 1', 5 * D, submitted=True, ctx='Intro to Computing'),
        item('assignment', 15, 101, 'Marked done', 1 * D, complete=True, ctx='Intro to Computing'),
        item('announcement', 21, 202, 'Welcome back', -1 * D, ctx='Linear Algebra'),
        item('assignment', 22, 202, 'Problem set 1', 20 * D, ctx='Linear Algebra'),
    ]


CARD = '''<div class="ic-DashboardCard"><div class="ic-DashboardCard__header">
<div class="ic-DashboardCard__header_image" style="background-image:url(data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=)">
<div class="ic-DashboardCard__header_hero" style="background-color:{colour};height:146px;opacity:.6"></div></div>
<a class="ic-DashboardCard__link" href="/courses/{id}"><h3>{code}</h3>
<div class="ic-DashboardCard__header-subtitle">Subtitle {code}</div><div class="ic-DashboardCard__header-term">Semester 2</div></a>
</div></div>'''

DASHBOARD = '''<!doctype html><html><head><meta charset="utf-8"><title>Dashboard</title>
<style>body{font-family:sans-serif;margin:0;display:flex;gap:24px;padding:20px;background:#fff;color:#2d3b45}
#dashboard{flex:1} #DashboardCard_Container{display:flex;gap:16px;flex-wrap:wrap}
.ic-DashboardCard{width:262px;border:1px solid #ddd;border-radius:6px;overflow:hidden;background:#fff}
#right-side{width:300px}</style></head><body>
<div id="dashboard"><h1>Dashboard</h1><div id="DashboardCard_Container"></div></div>
<aside id="right-side"><div class="Sidebar__TodoListContainer" id="canvas-own-todo"><h2>To Do</h2>Canvas own list</div>
<div class="events_list recent_feedback" id="feedback"><h2>Recent Feedback</h2>Nice work</div></aside>
<script>setTimeout(function () {
  document.getElementById("DashboardCard_Container").innerHTML = CARDS;
}, 600);</script></body></html>'''


# Dark mode test page: parts Canvas really has, with made-up markup (hashed InstUI-like class, course card with a
# course colour, red primary button, inline white course content, FullCalendar, TinyMCE chrome, same-origin iframe).
DARK_PAGE = '''<!doctype html><html><head><meta charset="utf-8"><title>Dark test</title>
<style>body{font-family:sans-serif;margin:0;background:#fff;color:#2d3b45}
#content{padding:20px}
.css-1x9k2q-view{background:#fff;color:#2d3b45;padding:12px;border:1px solid #c7cdd1;margin:8px 0}
.ic-DashboardCard{width:262px;background:#fff;border:1px solid #ddd;margin:8px 0}
.Button{padding:8px 14px;border:1px solid #c7cdd1;background:#f5f5f5;color:#2d3b45}
.Button.Button--danger{background:#e0061f;border-color:#e0061f;color:#fff}
.fc-unthemed td{border:1px solid #ddd;padding:6px}
.fc-view-container{background:#fff}
.tox .tox-toolbar__primary{background:#fff;padding:4px}
.tox .tox-tbtn{color:#222f3e;background:transparent;border:0}
.tox .tox-tbtn svg{fill:#222f3e}
.pale{background:#fff8e1;color:#333;padding:6px}
</style></head><body>
<div id="application"><div id="wrapper"><div id="main"><div id="content">
<h1 id="t-h1">Course page</h1>
<div class="css-1x9k2q-view" id="t-instui"><span id="t-instui-text">Hashed InstUI box with dark text</span></div>
<div class="ic-DashboardCard" id="t-card">
 <div class="ic-DashboardCard__header_hero" id="t-hero" style="background-color:#e66135;height:60px"></div>
 <a class="ic-DashboardCard__link" href="/courses/1" id="t-card-link"><span id="t-card-title" style="color:#e66135">COMP1001</span></a>
</div>
<button class="Button Button--danger" id="t-red">Delete</button> <button class="Button" id="t-grey">Cancel</button>
<span id="t-label" style="background:#0b874b;color:#fff;padding:2px 6px">Published</span>
<div class="user_content" id="t-inline" style="background:#fff;color:#333"><p id="t-inline-p">Inline white course content</p></div>
<div class="pale" id="t-pale">Pale tint note</div>
<img id="t-img" alt="" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=">
<div class="fc fc-unthemed" id="t-fc"><div class="fc-view-container" id="t-fc-view"><table><tr>
 <td id="t-fc-td">12</td><td><a class="fc-event" id="t-fc-event" style="background-color:#2b7abc;color:#fff">Lab</a></td></tr></table></div></div>
<div class="tox tox-tinymce" id="t-tox"><div class="tox-editor-header"><div class="tox-toolbar__primary" id="t-tox-bar">
 <button class="tox-tbtn" id="t-tox-btn"><svg id="t-tox-svg" width="12" height="12" viewBox="0 0 12 12"><rect width="12" height="12"/></svg> B</button></div></div></div>
<iframe id="t-frame" src="/frame" width="300" height="80"></iframe>
</div></div></div></div>
<script>setTimeout(function () {
  var d = document.createElement("div");
  d.className = "css-1x9k2q-view"; d.id = "t-later"; d.textContent = "Added later by React";
  document.getElementById("content").append(d);
}, 300);</script></body></html>'''

FRAME_PAGE = ('<!doctype html><html><head><style>body{background:#fff;color:#222;font-family:sans-serif}</style></head>'
              '<body><p id="f-p">Same-origin iframe content</p></body></html>')


def big_page():
    # About 6,000 elements of InstUI-like boxes, for timing the first recolour pass.
    rows = ''.join(f'<div class="css-a{i}-row" style="padding:2px"><span class="css-b{i}">Row {i}</span>'
                   f'<div style="background:#fff;color:#333"><b>Item</b> <i>{i}</i> <a href="#{i}">link</a></div></div>'
                   for i in range(1000))
    return ('<!doctype html><html><head><meta charset="utf-8"><title>Big</title><style>'
            '[class$="-row"]{background:#fff;color:#2d3b45}</style></head><body><div id="content">'
            + rows + '</div></body></html>')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body, ctype='application/json', extra=None):
        data = body.encode()
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def api(self, obj, extra=None):
        # Real Canvas may prefix JSON with while(1); - the add-on must cope with it.
        self.send('while(1);' + json.dumps(obj), extra=extra)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == '/':
            cards = ''.join(CARD.format(id=i, code=c, colour=col) for i, c, col in
                            [(101, 'COMP1001', '#e4202e'), (202, 'MATH2002', '#2b7abc')])
            return self.send(DASHBOARD.replace('CARDS', json.dumps(cards)), 'text/html')
        if u.path == '/other':
            return self.send('<!doctype html><title>Other</title><p>Another Canvas page '
                             '<div class="recent_feedback">feedback here</div>', 'text/html')
        if u.path == '/darktest':
            return self.send(DARK_PAGE, 'text/html')
        if u.path == '/frame':
            return self.send(FRAME_PAGE, 'text/html')
        if u.path == '/big':
            return self.send(big_page(), 'text/html')
        if u.path == '/api/v1/planner/items':
            items = planner()
            if q.get('page') == ['2']:
                return self.api(items[4:])
            nxt = f'<https://127.0.0.1:8443/api/v1/planner/items?page=2&per_page=75>; rel="next"'
            return self.api(items[:4], {'Link': nxt})
        if u.path == '/api/v1/courses':
            return self.api([{'id': 101, 'course_code': 'COMP1001', 'enrollment_term_id': 5},
                             {'id': 202, 'course_code': 'MATH2002', 'enrollment_term_id': 5}])
        if u.path == '/api/v1/users/self/colors':
            return self.api({'custom_colors': {'course_101': '#e4202e', 'course_202': '#2b7abc'}})
        if u.path == '/api/v1/courses/101/assignments/11':
            return self.api({'description': '<p>Write <b>500</b> words.</p><script>alert(1)</script>'})
        self.send_response(404)
        self.end_headers()


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', 8443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(sys.argv[1], sys.argv[2])
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print('fake Canvas on https://127.0.0.1:8443', flush=True)
    srv.serve_forever()
