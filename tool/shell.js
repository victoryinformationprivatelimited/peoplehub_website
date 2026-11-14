/* PeopleHub sales tool - shared app shell: sidebar navigation, user card, mobile menu.
   Included by every tool page. Pages keep their own sign-in gate and logic. */
(function () {
  var ICONS = {
    proposal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    customers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>',
    price: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>',
    partners: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v6c0 5 3.8 8.4 9 9 5.2-.6 9-4 9-9V7z"/><path d="m9 12 2 2 4-4"/></svg>',
    leads: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/></svg>',
    present: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8M10 9l4 2-4 2z"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
    approve: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/></svg>',
    coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M14.8 9.2c-.4-1-1.4-1.5-2.8-1.5-1.6 0-2.7.8-2.7 2s1 1.7 2.7 2.1 2.9.8 2.9 2.1-1.2 2-2.9 2c-1.5 0-2.6-.6-3-1.7M12 6v1.7M12 16.3V18"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
    calc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15h.01M8 18.5h.01M12 18.5h.01M16 18.5h.01"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>'
  };
  var NAV = [
    { href: 'dashboard.html', label: 'Dashboard', icon: 'dash' },
    { href: 'proposals.html', label: 'Proposals', icon: 'proposal', badge3: true },
    { href: 'leads.html', label: 'Leads', icon: 'leads' },
    { href: 'followups.html', label: 'Follow-ups', icon: 'check', badge: true },
    { href: 'customers.html', label: 'Customers', icon: 'customers' },
    { href: 'presentations.html', label: 'Presentations', icon: 'present' },
    { href: 'rating.html', label: 'Partner rating', icon: 'star' },
    { href: 'proposal-text.html', label: 'Proposal wording', icon: 'text' },
    { href: 'price-book.html', label: 'Price book', icon: 'price' },
    { href: 'price-checker.html', label: 'Price checker', icon: 'calc' },
    { href: 'price-editor.html', label: 'Price editor', icon: 'edit', adminOnly: true },
    { href: 'approvals.html', label: 'Approvals', icon: 'approve', staffOnly: true, badge2: true },
    { href: 'commissions.html', label: 'Commissions', icon: 'coin' },
    { href: 'partners.html', label: 'Partners', icon: 'partners', staffOnly: true },
    { href: 'users.html', label: 'Users', icon: 'user', adminOnly: true },
    { href: 'email-log.html', label: 'Email log', icon: 'log' },
    { href: 'auditlog.html', label: 'Audit log', icon: 'log', adminOnly: true },
    { href: 'team.html', label: 'My team', icon: 'customers', ownerOnly: true },
    { href: 'profile.html', label: 'My profile', icon: 'user' }
  ];
  try { document.documentElement.dataset.theme = localStorage.getItem('ph-theme') || 'dark'; } catch (e) { document.documentElement.dataset.theme = 'dark'; }
  var here = location.pathname.split('/').pop() || 'proposal.html';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // A temporary password must be replaced before anything else works
  function forceChange(user) { if (user && user.mustChangePassword && here !== 'profile.html') { location.replace('profile.html#force'); return true; } return false; }

  // "Forgot password?" under every sign-in form
  function addForgot() {
    var box = document.querySelector('#gate .box');
    if (box && !box.querySelector('.forgot')) {
      var a = document.createElement('a'); a.className = 'forgot'; a.href = 'reset.html'; a.textContent = 'Forgot your password?';
      a.style.cssText = 'display:block;text-align:center;margin-top:14px;font-size:13px;font-weight:600';
      box.appendChild(a);
    }
  }

  function build(user) {
    if (forceChange(user)) return;
    addForgot();
    var old = document.querySelector('.sidebar'); if (old) old.remove();
    var oldBar = document.querySelector('.mobilebar'); if (oldBar) oldBar.remove();
    var staff = user && (user.role === 'admin' || user.role === 'staff');
    var links = NAV.filter(function (n) { return (!n.staffOnly || staff) && (!n.adminOnly || (user && user.role === 'admin')) && (!n.ownerOnly || (user && user.partner && user.partner.isOwner)); }).map(function (n) {
      return '<a href="' + n.href + '"' + (n.href === here || (n.href === 'proposals.html' && here === 'proposal.html') ? ' class="active"' : '') + '>' + ICONS[n.icon] + '<span>' + n.label + '</span>' + (n.badge ? '<em class="badge" id="fuBadge" hidden></em>' : '') + (n.badge2 ? '<em class="badge red" id="apBadge" hidden></em>' : '') + (n.badge3 ? '<em class="badge" id="drBadge" hidden title="Draft proposals"></em>' : '') + '</a>';
    }).join('');
    var name = user ? (user.partner && user.partner.company ? user.partner.company : user.username) : '';
    var side = document.createElement('aside');
    side.className = 'sidebar';
    side.innerHTML =
      '<a class="brand" href="dashboard.html"><span class="logo">P</span><span><b>PeopleHub</b><small>Proposal studio</small></span></a>' +
      '<nav>' + links + '</nav><div class="grow"></div>' +
      (user ? '<div class="me"><span class="av">' + esc(name.charAt(0).toUpperCase()) + '</span><span style="min-width:0"><b>' + esc(name) + '</b><small>' + esc(user.role) + '</small></span></div><button class="signout" id="shellLogout">' + ICONS.out + '<span>Sign out</span></button>' : '');
    var bar = document.createElement('div');
    bar.className = 'mobilebar';
    bar.innerHTML = '<button id="shellMenu" aria-label="Menu">&#9776;</button><b>PeopleHub</b>' + (user ? '<span style="flex:1"></span><button id="mobLogout" style="width:auto;padding:0 12px;font-size:13px;font-weight:650">Sign out</button>' : '');
    var oldUb = document.querySelector('.userbar'); if (oldUb) oldUb.remove();
    if (user) {
      var ub = document.createElement('div'); ub.className = 'userbar';
      ub.innerHTML = '<a href="profile.html" class="who" title="My profile"><span class="av">' + esc(name.charAt(0).toUpperCase()) + '</span><span><b>' + esc(name) + '</b><small>' + esc(user.role) + '</small></span></a><button id="themeBtn" title="Switch between dark and light" aria-label="Switch theme">' + ICONS.theme + '</button><button id="topLogout">' + ICONS.out + '<span>Sign out</span></button>';
      document.body.appendChild(ub);
    }
    document.body.appendChild(side); document.body.appendChild(bar);
    document.body.classList.add('has-shell');
    ['shellLogout', 'topLogout', 'mobLogout'].forEach(function (id) {
      var lo = document.getElementById(id);
      if (lo) lo.addEventListener('click', function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function () { location.href = 'dashboard.html'; });
      });
    });
    var tb = document.getElementById('themeBtn');
    if (tb) tb.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('ph-theme', next); } catch (e) {}
    });
    if (user) refreshBadge();
    document.getElementById('shellMenu').addEventListener('click', function () { document.body.classList.toggle('nav-open'); });
    document.addEventListener('click', function (e) { if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar') && !e.target.closest('#shellMenu')) document.body.classList.remove('nav-open'); });
  }

  // Number of follow-ups overdue or due today, shown on the sidebar link
  function refreshBadge() {
    var ab = document.getElementById('apBadge');
    if (ab) fetch('/api/approvals/summary', { credentials: 'same-origin' }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (s) { if (s) { ab.hidden = !s.pending; ab.textContent = s.pending; } }).catch(function () {});
    var db = document.getElementById('drBadge');
    if (db) fetch('/api/proposals/draft-count', { credentials: 'same-origin' }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (s) { if (s) { db.hidden = !s.drafts; db.textContent = s.drafts; db.title = s.drafts + ' draft proposal' + (s.drafts === 1 ? '' : 's') + (s.incomplete ? ' (' + s.incomplete + ' incomplete)' : ''); } }).catch(function () {});
    var b = document.getElementById('fuBadge'); if (!b) return;
    fetch('/api/tasks/summary', { credentials: 'same-origin' }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (s) {
      if (!s) return; var n = (s.overdue || 0) + (s.today || 0);
      b.hidden = !n; b.textContent = n; b.className = 'badge' + (s.overdue ? ' red' : '');
    }).catch(function () {});
  }

  build(null);
  fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (r) { return r.status === 200 ? r.json() : null; }).then(function (u) { if (u) build(u); else document.body.classList.add('guest'); }).catch(function () { document.body.classList.add('guest'); });

  // Pages call this after a successful in-page sign-in so the sidebar shows the user and role-based links
  window.PHShell = { refresh: function (u) { build(u); }, refreshBadge: refreshBadge };
})();
