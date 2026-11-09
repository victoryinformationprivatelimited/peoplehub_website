/* Builds the proposal document HTML. One builder serves the editor (proposal.html), the PDF and the client web view (view.html).
   The proposal's "doc" holds the wording and the module catalogue it was saved with; three styles (summary, standard,
   comprehensive) choose which sections appear. Proposals saved before this existed have no doc and render as "summary". */
window.PHDoc = (function () {
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function money(n){ return '$' + (Number(n)||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
  // unit rates can be a fraction of a cent: show up to four decimals, but never fewer than two
  function rate(n){ n = Number(n) || 0; var s = n.toFixed(4).replace(/0+$/, ''); var d = (s.split('.')[1] || '').length; return '$' + n.toFixed(Math.max(2, d)); }
  var DESC = {
    recruit: 'Vacancies, candidate pipeline, offers, onboarding checklists, resignations and exit clearance.',
    time: 'Biometric, clock and mobile attendance with geofencing, rosters, shifts, and leave management with approvals.',
    payroll: 'Attendance-driven payroll with statutory deductions and tax, payslips, bank files, plus staff loans and benefits administration.',
    performance: 'Goals and OKRs, periodic reviews, 360° feedback, appraisals and development plans.',
    training: 'Training calendar, course catalogue, assignments, assessments and effectiveness reporting.',
    succession: 'Critical roles, 9-box talent grid, successor readiness and development plans.',
    tasks: 'Task assignment with priorities and deadlines, reminders and a Kanban board.',
    tickets: 'Employee help desk with categories, assignment, SLAs and resolution tracking.',
    grievance: 'Open or anonymous grievances with case tracking, escalation and resolution analytics.',
    assets: 'Asset register, allocation to employees, return clearance and maintenance tracking.',
    kb: 'A searchable knowledge base of policies, procedures and how-to articles.',
    chat: 'Secure in-app messaging between employees, managers and HR.',
    leisure: 'Employee community space: events, announcements, polls and recognition.'
  };
  var TERM_LABEL = { monthly: 'Monthly', annual: 'Annual prepay (12 months)', '2yr': '2-year prepay (24 months)', '3yr': '3-year prepay (36 months)' };
  var VI = { name: 'Victory Information (Pvt) Ltd', address: 'No 150, Templers Road, Mount Lavinia, Sri Lanka', email: 'sales@victoryinformation.lk', phone: '+94 76 744 4999' };
  var ALL = ['summary', 'standard', 'comprehensive'];
  // used only for proposals saved before the text library existed
  var FALLBACK = [
    { key: 'exec', part: 'The case', title: 'Executive summary', kind: 'generated', styles: ALL },
    { key: 'scope', part: 'Your solution', title: 'Your solution', kind: 'generated', styles: ALL },
    { key: 'customisation', part: 'Your solution', title: 'Customisation and integration', kind: 'generated', styles: ALL },
    { key: 'invest', part: 'Commercials', title: 'Investment', kind: 'generated', styles: ALL },
    { key: 'terms', part: 'Commercials', title: 'Terms and acceptance', kind: 'text', styles: ALL, body: '- This proposal is valid for {{validity}} days from {{date}}.\n- Notification charges are estimates and are billed at actual usage.\n- Customisation beyond the stated hours requires written agreement.\n- Prices are all-inclusive. There are no other taxes or hidden costs.' },
    { key: 'accept', part: 'Commercials', title: 'Acceptance', kind: 'generated', styles: ALL }
  ];

  // ---- the simple text format: blank line = new paragraph, "- " = bullet, "## " = small heading, **bold**
  function inline(s){ return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]{1,120})\]\((https?:\/\/[^\s)"'<>]{1,300})\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'); }
  function fmt(text, vars){
    var t = String(text || '').replace(/\{\{(\w+)\}\}/g, function(m, k){ return vars && vars[k] != null ? vars[k] : ''; });
    var out = '';
    t.split(/\n\s*\n/).forEach(function(block){
      var lines = block.split('\n'), n = 0;
      while (n < lines.length) {
        var ln = lines[n];
        var im = /^!\[([^\]]{0,120})\]\(img:([0-9a-f]{24})\)\s*$/.exec(ln);
        if (im) { out += '<figure><img src="/img/' + im[2] + '" alt="' + esc(im[1]) + '">' + (im[1] ? '<figcaption>' + esc(im[1]) + '</figcaption>' : '') + '</figure>'; n++; }
        else if (/^## /.test(ln)) { out += '<h4>' + inline(ln.slice(3)) + '</h4>'; n++; }
        else if (/^- /.test(ln)) { var li = []; while (n < lines.length && /^- /.test(lines[n])) { li.push('<li>' + inline(lines[n].slice(2)) + '</li>'); n++; } out += '<ul>' + li.join('') + '</ul>'; }
        else if (!ln.trim()) { n++; }
        else { var p = []; while (n < lines.length && lines[n].trim() && !/^(## |- |!\[)/.test(lines[n])) { p.push(inline(lines[n])); n++; } out += '<p>' + p.join('<br>') + '</p>'; }
      }
    });
    return out;
  }

  function html(ctx){
    var q = ctx.quote, i = ctx.input, c = ctx.contact, customer = ctx.customer, catalog = ctx.catalog;
    var date = new Date(ctx.createdAt || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    var chosen = catalog.items.filter(function(x){ return i.items.indexOf(x.id) > -1; });
    var perp = q.billing.type === 'perpetual';
    var doc = ctx.doc || null;
    var style = doc && doc.style ? doc.style : 'summary';
    var vars = { client: customer.name, company: ctx.presentedBy || 'Victory Information', employees: i.employees.toLocaleString(), date: date, validity: ctx.validity, ref: ctx.ref };
    var hasCustom = (i.customisations && i.customisations.length) || i.integrationHours > 0;

    // ---------------- cover ----------------
    var okLogo = function(x){ return x && /^data:image\/(png|jpeg);base64,[A-Za-z0-9+\/=]+$/.test(x); };
    var badge = function(src, label){ return '<span class="lg"><img alt="' + esc(label || '') + '" src="' + src + '"></span>'; };
    // a ring of people, echoing the PeopleHub mark, drawn faintly behind the title
    var ring = (function(){
      var cols = ['#73ee8c', '#52c492', '#18b491', '#cdff6b'], out = '';
      for (var k = 0; k < 11; k++) { var ang = k / 11 * Math.PI * 2 - Math.PI / 2, cx = 300 + Math.cos(ang) * 215, cy = 300 + Math.sin(ang) * 215; out += '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="34" fill="' + cols[k % 4] + '"/>'; }
      return '<svg class="cv-ring" viewBox="0 0 600 600" aria-hidden="true"><circle cx="300" cy="300" r="150" fill="none" stroke="#52c492" stroke-width="30" stroke-dasharray="70 12"/>' + out + '</svg>';
    })();
    var cover = '<div data-sec="cover" class="pg cover">' + ring +
      '<div class="cv-top"><img class="cv-ph" alt="PeopleHub" src="/assets/peoplehub-logo-white.png"><div class="eyebrow">Business proposal</div></div>' +
      '<div class="cv-mid"><h1>PeopleHub HRIS</h1><div class="cv-rule"></div><p>A connected platform for managing, engaging and empowering your workforce.</p></div>' +
      '<div class="cv-bot"><div class="who">' +
        '<div class="card-for"><small>Prepared for</small>' + (okLogo(customer.logo) ? '<div class="lgs">' + badge(customer.logo, customer.name) + '</div>' : '') + '<b>' + esc(customer.name) + '</b>' + (c ? '<span>' + esc(c.name) + (c.title ? ', ' + esc(c.title) : '') + (c.email ? '<br>' + esc(c.email) : '') + '</span>' : '') + '</div>' +
        '<div class="card-by"><small>Prepared by</small><div class="lgs">' + badge('/assets/victory-logo.png', VI.name) + (okLogo(ctx.logo) ? badge(ctx.logo, ctx.presentedBy || '') : '') + '</div><b>' + esc(VI.name) + '</b>' + (ctx.presentedBy ? '<span>Presented by ' + esc(ctx.presentedBy) + '</span>' : '') + '<span>' + esc(VI.email) + ' · ' + esc(VI.phone) + '</span></div>' +
      '</div>' +
      '<div class="meta"><span>Reference <b>' + esc(ctx.ref) + '</b></span><span>Date <b>' + esc(date) + '</b></span><span>Valid for <b>' + ctx.validity + ' days</b></span>' + (q.band ? '<span>Employee band <b>' + esc(q.band.label) + '</b></span>' : '') + '</div></div></div>';

    // ---------------- generated sections ----------------
    function execSummary(){
      var impl = q.implementation;
      return '<p>' + esc(VI.name) + ' is pleased to propose PeopleHub HRIS for ' + esc(customer.name) + '. This proposal covers ' + i.employees.toLocaleString() + ' employees' + (q.band ? ' (pricing band ' + esc(q.band.label) + ')' : '') +
        (customer.sites ? ' across ' + esc(customer.sites) : '') + (customer.current_system ? ', replacing ' + esc(customer.current_system) : '') + '.</p>' +
        '<p>The solution includes the complete Core HR foundation' + (chosen.length ? ', plus ' + chosen.map(function(x){ return esc(x.name); }).join(', ') : '') + (i.portalUsers > 0 ? ', and the Employee Self-Service portal for ' + i.portalUsers.toLocaleString() + ' users on the web, Android and iOS' : '') + '.</p>' +
        '<div class="big"><div><small>' + (perp ? 'Licence fee' : 'Monthly subscription') + '</small><b>' + money(perp ? q.billing.licence : q.monthlyRecurring) + '</b></div>' +
        (perp ? '<div><small>Annual maintenance</small><b>' + money(q.billing.maintenanceAnnual) + '</b></div>' : '') +
        (impl ? '<div><small>Implementation</small><b>' + money(impl.net) + '</b></div>' : '') +
        '</div>';
    }

    function scope(){
      return '<h4>Core HR — included</h4><ul>' + catalog.coreFeatures.map(function(f){ return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' +
        (chosen.length ? '<h4>Selected modules and add-ons</h4>' + chosen.map(function(x){ return '<p><b>' + esc(x.name) + '.</b> ' + esc(x.includes ? x.includes + '. ' : '') + esc(DESC[x.id] || '') + '</p>'; }).join('') : '') +
        '<h4>Users and capacity</h4><ul><li>Main application: ' + q.seatsIncluded + ' administrator seats included' + (i.adminSeats > q.seatsIncluded ? ', ' + (i.adminSeats - q.seatsIncluded) + ' additional' : '') + '.</li>' +
        '<li>Employee portal: ' + i.portalUsers.toLocaleString() + ' named users, with web and mobile (Android and iOS) access under one licence.</li>' +
        '<li>Document storage: ' + q.freeStorageGB + ' GB included' + (i.extraStorageGB > 0 ? ', plus ' + i.extraStorageGB + ' GB additional' : '') + '.</li>' +
        '<li>In-app and push notifications are included; SMS, WhatsApp and email are charged by usage.</li></ul>';
    }

    function customisation(){
      return (i.customisations.length ? '<table class="doc"><tr><th>Customisation</th><th>Details</th><th class="amt">Hours</th></tr>' + i.customisations.map(function(x){ return '<tr><td><b>' + esc(x.title) + '</b></td><td>' + esc(x.details) + '</td><td class="amt">' + x.hours + '</td></tr>'; }).join('') + '</table>' : '') +
        (i.integrationHours > 0 ? '<p>Integration with the client\'s existing systems is estimated at ' + i.integrationHours + ' hours.</p>' : '') +
        '<p>Customisation and integration are charged once, by the hour, as shown in the investment summary. Any work beyond these estimates will be agreed in writing before it begins.</p>';
    }

    // every module, in its pillar; the ones in this proposal stand out
    function capabilities(){
      var pillars = doc && doc.pillars; if (!pillars) return '';
      var full = style === 'comprehensive', inCount = 0, total = 0;
      function state(m){
        if (m.itemId) {
          var it = catalog.items.filter(function(x){ return x.id === m.itemId; })[0];
          if (i.items.indexOf(m.itemId) > -1) return { st: 'in', label: 'In your proposal' };
          return { st: 'avail', label: it && it.group === 'addon' ? 'Optional add-on' : 'Optional module' };
        }
        if (m.included === 'core') return { st: 'core', label: 'Included with Core HR' };
        if (m.included === 'portal') return i.portalUsers > 0 ? { st: 'in', label: 'In your proposal · ' + i.portalUsers.toLocaleString() + ' users' } : { st: 'avail', label: 'Optional' };
        if (m.included === 'wdms') return i.wdmsDevices > 0 ? { st: 'in', label: 'In your proposal · ' + i.wdmsDevices + ' device' + (i.wdmsDevices === 1 ? '' : 's') } : { st: 'avail', label: 'Optional add-on' };
        if (m.included === 'usage') return { st: 'core', label: 'Included · messages by use' };
        if (m.included === 'hourly') return i.integrationHours > 0 ? { st: 'in', label: 'In your proposal · ' + i.integrationHours + ' hours' } : { st: 'avail', label: 'Available by the hour' };
        return { st: 'avail', label: '' };
      }
      var body = pillars.map(function(p, pi){
        var cards = p.modules.map(function(m){
          var s = state(m); total++; if (s.st !== 'avail') inCount++;
          var caps = s.st === 'avail' ? m.capabilities.slice(0, full ? 2 : 0) : (full ? m.capabilities : m.capabilities.slice(0, s.st === 'in' ? 3 : 0));
          return '<div class="mod ' + s.st + '"><div class="mh"><b>' + esc(m.name) + '</b>' + (s.label ? '<span class="chip ' + s.st + '">' + esc(s.label) + '</span>' : '') + '</div><p class="ms">' + esc(m.summary) + '</p>' +
            (caps.length ? '<ul>' + caps.map(function(x){ return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
            (m.note && (s.st !== 'avail' || full) ? '<div class="mi">Please note: ' + esc(m.note) + '</div>' : '') +
            (full && s.st !== 'avail' && m.impact && m.impact.length ? '<div class="mi">' + esc(m.impact[0]) + '</div>' : '') + '</div>';
        }).join('');
        return '<div class="pillar"><div class="pk">Pillar ' + (pi + 1) + '</div><h3>' + esc(p.name) + '</h3><p class="ptag">' + esc(p.tagline) + '</p><p>' + esc(p.intro) + '</p><div class="mods">' + cards + '</div></div>';
      }).join('');
      return '<p>PeopleHub is organised into five pillars of purpose-built modules that share one employee record. The modules and add-ons in this proposal are highlighted; everything else can be added at any time without changing systems.</p>' + body;
    }

    // what the client pays for, and what extra use costs
    function detail(l){
      if (l.key === 'implementation' && !l.parts && q.implementation && q.implementation.scope) return 'Set-up, configuration, data migration, training and go-live. ' + q.implementation.scope;
      if (l.key === 'implementation' && l.parts) return 'Set-up, configuration, data migration, training and go-live. Base fee ' + money(l.parts.base) + (l.parts.modules.length ? ', plus ' + l.parts.modules.map(function(m){ return m.name + ' ' + money(m.amount); }).join(', ') : '') + '.';
      return l.detail;
    }
    function glance(){
      var r = q.rates; if (!r) return '';
      var en = (i.notifications && i.notifications.enabled) || {};
      function ch(nm, k){ var on = en[k] === undefined ? (+(i.notifications || {})[k] > 0) : en[k]; return '<tr><td>' + nm + '<small>' + (on ? 'activated' : 'not activated') + '</small></td><td class="amt">' + rate(r.notifications[k]) + ' each</td></tr>'; }
      var n = r.notifications, hours = i.integrationHours, dev = (i.customisations || []).reduce(function(s, x){ return s + (+x.hours || 0); }, 0);
      return '<h4>Charges at a glance</h4><p class="hint2">Rates below already include any discount in this proposal.</p><div class="glance">' +
        '<div class="gcol"><h5>Included in the subscription</h5><ul><li>Core HR platform and every Core HR module</li><li>' + q.seatsIncluded + ' administrator seats</li><li>' + q.freeStorageGB + ' GB of storage</li><li>In-app and push notifications</li>' + (i.portalUsers > 0 ? '<li>Web and mobile self-service for ' + i.portalUsers.toLocaleString() + ' employees</li>' : '') + '</ul></div>' +
        '<div class="gcol"><h5>Billed monthly, by use</h5><table class="mini">' + ch('SMS', 'sms') + ch('WhatsApp', 'whatsapp') + ch('Email', 'email') + '<tr><td>WDMS configuration<small>per device</small></td><td class="amt">' + money(r.wdmsPerDevice != null ? r.wdmsPerDevice : 3) + ' / month</td></tr>' +
        '<tr><td>Extra storage</td><td class="amt">' + money(r.storage.blockPrice) + ' per ' + r.storage.blockGB + ' GB</td></tr><tr><td>Extra administrator seat</td><td class="amt">' + money(r.extraSeat) + ' / month</td></tr>' + (r.portalPerUser != null ? '<tr><td>Extra portal user</td><td class="amt">' + rate(r.portalPerUser) + ' / month</td></tr>' : '') + '</table></div>' +
        '<div class="gcol"><h5>Services, by the hour</h5><table class="mini"><tr><td>Integration</td><td class="amt">' + money(r.integrationHourly) + ' / hour</td></tr><tr><td>Customisation and development</td><td class="amt">' + money(r.developmentHourly) + ' / hour</td></tr></table>' +
        '<p class="hint2">' + (hours > 0 || dev > 0 ? 'This proposal estimates ' + (hours > 0 ? hours + ' hours of integration' : '') + (hours > 0 && dev > 0 ? ' and ' : '') + (dev > 0 ? dev + ' hours of customisation' : '') + '. Any further work is agreed in writing first.' : 'Any integration or customisation is agreed in writing before work begins.') + '</p></div></div>';
    }

    function invest(){
      var rows = q.lines.filter(function(l){ return !l.oneTime; }).map(function(l){ return '<tr><td>' + esc(l.label) + '<small>' + esc(l.detail) + '</small></td><td class="amt">' + money(l.amount) + '</td></tr>'; }).join('');
      if (q.discountMonthly > 0) rows += '<tr><td>Discount (' + esc(q.discounts.map(function(d){ return d.label + ' ' + d.pct + '%'; }).join(', ')) + ')</td><td class="amt">−' + money(q.discountMonthly) + '</td></tr>';
      rows += '<tr class="sub"><td>' + (perp ? 'Monthly platform and usage value' : 'Monthly subscription') + '</td><td class="amt">' + money(q.monthlyRecurring) + '</td></tr>';
      var onceRows = q.lines.filter(function(l){ return l.oneTime; }).map(function(l){ return '<tr><td>' + esc(l.label) + '<small>' + esc(detail(l)) + '</small></td><td class="amt">' + money(l.amount) + '</td></tr>'; }).join('');
      if (q.discountOnce > 0) onceRows += '<tr><td>Discount</td><td class="amt">−' + money(q.discountOnce) + '</td></tr>';
      var impl = q.implementation;
      return '<p>All prices are in US dollars and are all-inclusive: there are no other taxes or hidden costs.' + (q.band ? ' Pricing is for the <b>' + esc(q.band.label) + '</b> employee band.' : '') + '</p>' +
        '<table class="doc"><tr><th>Recurring</th><th class="amt">Per month</th></tr>' + rows + '</table>' +
        (onceRows ? '<table class="doc"><tr><th>One-time</th><th class="amt">Amount</th></tr>' + onceRows + '<tr class="sub"><td>One-time total</td><td class="amt">' + money(q.oneTime) + '</td></tr></table>' : '') +
        (q.implementationAgreed && q.implementationMode !== 'guideline' ? '<p><b>Implementation</b> will be quoted separately once the requirements and scope are confirmed.' + (q.implementationScope ? ' ' + esc(q.implementationScope) : '') + '</p>' : '') +
        (impl && impl.schedule.length > 1 && style === 'summary' ? '<p><b>Implementation</b> is paid in ' + impl.schedule.length + ' parts: ' + impl.schedule.map(function(m){ return esc(m.label.toLowerCase()) + ' ' + money(m.amount); }).join(', ') + '.</p>' : '') +
        (perp ? '<table class="doc"><tr><th>Perpetual licence</th><th class="amt">Amount</th></tr><tr><td>Licence fee<small>' + q.billing.multiplier + ' × the monthly platform price</small></td><td class="amt">' + money(q.billing.licence) + '</td></tr>' +
          '<tr><td>Annual maintenance and support<small>' + q.billing.maintenancePct + '% of the licence fee, payable yearly</small></td><td class="amt">' + money(q.billing.maintenanceAnnual) + '</td></tr>' +
          '<tr><td>Usage (storage and notifications)<small>billed monthly</small></td><td class="amt">' + money(q.billing.usageMonthly) + '</td></tr></table>'
          : '<p><b>Billing:</b> ' + esc(TERM_LABEL[q.billing.term]) + '.' + (q.billing.months > 1 ? ' ' + money(q.billing.prepayLump) + ' is invoiced up front for ' + q.billing.months + ' months.' : ' The subscription is invoiced monthly.') + '</p>') +
        glance();
    }

    function payment(){
      var impl = q.implementation, lump = perp ? q.billing.licence : (q.billing.prepayLump || 0);
      var nowOnce = Math.round((q.dueAtSigning - lump) * 100) / 100, rows = [];
      if (lump > 0) rows.push(['On signing', perp ? 'Perpetual licence fee' : 'Subscription paid in advance for ' + q.billing.months + ' months', lump]);
      if (nowOnce > 0) rows.push(['On signing', impl ? 'Implementation, first payment (' + impl.schedule[0].pct + '%)' + (nowOnce > impl.schedule[0].amount + 0.005 ? ' and other one-time charges' : '') : 'One-time charges', nowOnce]);
      if (impl) impl.schedule.slice(1).forEach(function(m){ rows.push([m.label, 'Implementation payment (' + m.pct + '%)', m.amount]); });
      if (perp) rows.push(['Every year', 'Annual maintenance and support', q.billing.maintenanceAnnual]);
      else if (q.billing.months > 1) rows.push(['Every ' + q.billing.months + ' months', 'Subscription renewal', q.billing.prepayLump]);
      else rows.push(['Every month', 'Monthly subscription', q.monthlyRecurring]);
      if (perp && q.billing.usageMonthly > 0) rows.push(['Every month', 'Storage and notification usage', q.billing.usageMonthly]);
      return '<p>This is when each charge falls due. Amounts are in US dollars and are all-inclusive, with no other taxes or hidden costs.</p>' +
        '<table class="doc"><tr><th>When</th><th>What</th><th class="amt">Amount</th></tr>' + rows.map(function(r){ return '<tr><td><b>' + esc(r[0]) + '</b></td><td>' + esc(r[1]) + '</td><td class="amt">' + money(r[2]) + '</td></tr>'; }).join('') + '</table>' +
        '<ul><li>Payments are due within 7 days of the invoice date.</li><li>Payment can be made by bank transfer, card or online payment, as agreed with ' + esc(VI.name) + '.</li><li>Usage charges (notifications and extra storage) are invoiced monthly for what was used.</li><li>Customisation, hardware or modules beyond the agreed scope are invoiced separately once approved.</li></ul>';
    }

    function accept(){
      return '<p>To accept this proposal, ' + (ctx.online ? 'use the <b>Accept proposal</b> button, or ' : '') + 'sign below and return a copy to ' + esc(VI.email) + '.</p>' +
        (ctx.acceptance
          ? '<div class="accepted"><b>Accepted electronically</b><br>' + esc(ctx.acceptance.name) + (ctx.acceptance.title ? ', ' + esc(ctx.acceptance.title) : '') + ' accepted this proposal on behalf of ' + esc(customer.name) + ' on ' + esc(new Date(ctx.acceptance.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })) + '.<br><small>Record reference ' + esc(ctx.acceptance.ref) + '</small></div>'
          : '<div class="sig"><div>For ' + esc(customer.name) + '<br>Name, title, date</div><div>For ' + esc(VI.name) + '<br>Name, title, date</div></div>') +
        '<div class="docfoot">' + esc(VI.name) + ' · ' + esc(VI.address) + ' · ' + esc(VI.email) + ' · ' + esc(VI.phone) + '</div>';
    }

    var GEN = { exec: execSummary, scope: scope, customisation: customisation, capabilities: capabilities, invest: invest, payment: payment, accept: accept };

    // ---------------- choose and number the sections ----------------
    var library = doc && doc.sections && doc.sections.length ? doc.sections : FALLBACK;
    var excluded = (doc && doc.excluded) || [];
    var REQUIRED = { exec: 1, scope: 1, invest: 1, accept: 1 };
    var list = library.filter(function(s){
      if (s.styles.indexOf(style) < 0) return false;
      if (excluded.indexOf(s.key) > -1 && !REQUIRED[s.key]) return false;
      if (s.key === 'customisation' && !hasCustom) return false;
      if (s.key === 'capabilities' && !(doc && doc.pillars)) return false;
      return s.kind === 'text' || !!GEN[s.key];
    });

    var toc = '';
    if (list.length > 7) {
      var lastPart = null, tocRows = '';
      list.forEach(function(s, n){
        if (s.part !== lastPart) { tocRows += '<div class="tocpart">' + esc(s.part) + '</div>'; lastPart = s.part; }
        tocRows += '<div class="tocrow"><span class="tn">' + (n + 1) + '</span><span>' + esc(s.title) + '</span></div>';
      });
      toc = '<div data-sec="contents" class="pg"><h2>Contents</h2>' + tocRows + '</div>';
    }

    var lastPart2 = null;
    var pages = list.map(function(s, n){
      var inner = s.kind === 'text' ? fmt(s.body, vars) : GEN[s.key]();
      var eyebrow = (list.length > 7 && s.part !== lastPart2) ? '<div class="partlabel">' + esc(s.part) + '</div>' : '';
      lastPart2 = s.part;
      return '<div data-sec="' + esc(s.key) + '" class="pg">' + eyebrow + '<h2>' + (n + 1) + '. ' + esc(s.title) + '</h2>' + inner + (s.key === 'terms' && !list.some(function(x){ return x.key === 'accept'; }) ? '' : '') + '</div>';
    }).join('');

    return cover + toc + pages;
  }
  return { html: html, fmt: fmt, DESC: DESC, VI: VI };
})();
