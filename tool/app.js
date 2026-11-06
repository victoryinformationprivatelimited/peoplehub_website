/* Small shared helpers for the newer tool pages: API calls, escaping, money, and the sign-in gate.
   A page includes the standard #gate markup, then calls PH.boot(function (user) { ... }). */
window.PH = (function () {
  var PH = {};
  PH.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  PH.money = function (n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  PH.$ = function (id) { return document.getElementById(id); };
  PH.api = function (method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    else if (method !== 'GET' && method !== 'DELETE') { o.headers['Content-Type'] = 'application/json'; o.body = '{}'; }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, json: j }; }); });
  };
  PH.say = function (el, text, ok) { el.textContent = text; el.className = 'msg ' + (ok ? 'ok' : 'err'); };

  PH.boot = function (onUser) {
    function start(user) {
      document.body.classList.add('authed');
      if (window.PHShell) PHShell.refresh(user);
      if (user.mustChangePassword && !/profile\.html$/.test(location.pathname)) return;
      onUser(user);
    }
    var go = PH.$('gGo');
    if (go) {
      go.addEventListener('click', function () {
        PH.$('gErr').textContent = '';
        PH.api('POST', '/api/auth/login', { username: PH.$('gUser').value, password: PH.$('gPass').value }).then(function (r) {
          if (r.status === 200) { PH.$('gPass').value = ''; start(r.json); } else PH.$('gErr').textContent = r.json.error || 'Could not sign in.';
        }).catch(function () { PH.$('gErr').textContent = 'Cannot reach the server.'; });
      });
      ['gUser', 'gPass'].forEach(function (id) { PH.$(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); }); });
    }
    PH.api('GET', '/api/auth/me').then(function (r) { if (r.status === 200) start(r.json); }).catch(function () {});
  };
  return PH;
})();
