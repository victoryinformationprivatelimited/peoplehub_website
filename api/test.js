// End-to-end API test against the real database. Needs the API running (node server.js) and an admin login in .admin-initial-password.
// Usage: node test.js [baseUrl]    Creates a temporary test partner and removes it again afterwards.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const BASE = process.argv[2] || 'http://localhost:' + (process.env.PORT || 4400);
const adminPw = fs.readFileSync(path.join(__dirname, '.admin-initial-password'), 'utf8').match(/password: (.+)/)[1].trim();

const html = fs.readFileSync(path.join(__dirname, '..', 'tool', 'price-editor.html'), 'utf8');
const defaultsSrc = html.slice(html.indexOf('var DEFAULTS = ') + 'var DEFAULTS = '.length, html.indexOf('var list = JSON.parse'));
const DEFAULTS = new Function('return ' + defaultsSrc.trim().replace(/;$/, ''))();
const IMPL = DEFAULTS.implementation; delete DEFAULTS.implementation;

let passed = 0, failed = 0;
function check(name, ok, extra) { if (ok) { passed++; console.log('  ok   ' + name); } else { failed++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')); } }

function session() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json };
  };
}

(async () => {
  const anon = session(), admin = session(), partner = session();
  const t0 = new Date();
  const origList = (await db.query('SELECT id FROM price_lists WHERE is_current')).rows[0];
  const testUser = 'test.reseller.' + Date.now();
  const testPw = 'T3st-Passw0rd-' + Date.now();
  let partnerId = null;
  const extraPartners = [], extraCustomers = [], extraProposals = [];
  try {
    console.log('Signed-out access');
    check('price list needs login', (await anon('GET', '/api/price-list')).status === 401);
    check('partners need login', (await anon('GET', '/api/partners')).status === 401);
    check('wrong password rejected', (await anon('POST', '/api/auth/login', { username: 'admin', password: 'nope-nope-nope' })).status === 401);
    const form = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    check('non-JSON mutation rejected', form.status === 415);
    check('secrets not served as files', (await fetch(BASE + '/api/.env')).status === 404 && (await fetch(BASE + '/api/schema.sql')).status === 404);

    console.log('Admin');
    const login = await admin('POST', '/api/auth/login', { username: 'admin', password: adminPw });
    check('admin login', login.status === 200 && login.json.role === 'admin');
    check('invalid price list rejected', (await admin('PUT', '/api/price-list', { version: 4 })).status === 400);
    const bad = JSON.parse(JSON.stringify(DEFAULTS)); bad.items[1].base = -5;
    check('negative price rejected', (await admin('PUT', '/api/price-list', bad)).status === 400);
    const save = await admin('PUT', '/api/price-list', DEFAULTS);
    check('price list saved', save.status === 200 && save.json.id);
    const got = await admin('GET', '/api/price-list');
    check('admin reads base list', got.status === 200 && got.json.data.items.find((i) => i.id === 'corehr').base === 120);

    const cats = await admin('GET', '/api/categories');
    const gold = cats.json.find((c) => c.name === 'Gold Reseller');
    check('seeded categories', cats.json.length >= 5 && gold && gold.max_discount_pct === 20);

    const mk = await admin('POST', '/api/partners', { company_name: 'TEST Reseller Co', contact_name: 'Tester', email: 't@example.com', category_id: gold.id });
    check('partner created', mk.status === 201);
    partnerId = mk.json.id;
    check('weak partner password rejected', (await admin('POST', `/api/partners/${partnerId}/login`, { username: testUser, password: 'short' })).status === 400);
    check('partner login created', (await admin('POST', `/api/partners/${partnerId}/login`, { username: testUser, password: testPw })).status === 201);

    console.log('Partner');
    const pl = await partner('POST', '/api/auth/login', { username: testUser, password: testPw });
    check('partner login', pl.status === 200 && pl.json.role === 'partner' && pl.json.partner.maxDiscountPct === 20);
    const pp = await partner('GET', '/api/price-list');
    const base = got.json.data, disc = pp.json.data;
    const item = (d, id) => d.items.find((i) => i.id === id).base;
    check('partner gets discounted list', pp.status === 200 && pp.json.discountPct === 20);
    check('Core HR NOT discounted', item(disc, 'corehr') === item(base, 'corehr'));
    check('module discounted 20%', Math.abs(item(disc, 'payroll') - item(base, 'payroll') * 0.8) < 1e-6, item(disc, 'payroll') + ' vs ' + item(base, 'payroll') * 0.8);
    check('portal rate discounted 20%', Math.abs(disc.portal[0] - base.portal[0] * 0.8) < 1e-6);
    check('development rate discounted 20%', Math.abs(disc.developmentHourly - base.developmentHourly * 0.8) < 1e-6);
    check('partner cannot save price list', (await partner('PUT', '/api/price-list', DEFAULTS)).status === 403);
    check('partner cannot list partners', (await partner('GET', '/api/partners')).status === 403);
    check('partner cannot read categories', (await partner('GET', '/api/categories')).status === 403);
    check('partner cannot create partner', (await partner('POST', '/api/partners', { company_name: 'x', category_id: gold.id })).status === 403);

    console.log('Category change and deactivation');
    const upd = await admin('PUT', `/api/categories/${gold.id}`, { name: 'Gold Reseller', partner_type: 'reseller', max_discount_pct: 12, sort_order: gold.sort_order, active: true });
    check('category updated', upd.status === 200);
    const pp2 = await partner('GET', '/api/price-list');
    check('partner sees new discount at once', pp2.json.discountPct === 12);
    await admin('PUT', `/api/categories/${gold.id}`, { name: 'Gold Reseller', partner_type: 'reseller', max_discount_pct: 20, sort_order: gold.sort_order, active: true });

    const plist = await admin('GET', '/api/partners');
    const mine = plist.json.find((p) => p.id === partnerId);
    check('partner listed with login', mine && mine.logins.length === 1);
    await admin('PUT', `/api/users/${mine.logins[0].id}/active`, { active: false });
    check('deactivated login locked out at once', (await partner('GET', '/api/price-list')).status === 401);
    console.log('Customers');
    const pwA = 'T3st-A-Passw0rd-' + Date.now(), pwB = 'T3st-B-Passw0rd-' + Date.now(), pwS = 'T3st-S-Passw0rd-' + Date.now();
    const mkA = await admin('POST', '/api/partners', { company_name: 'TEST Partner A', category_id: gold.id });
    const mkB = await admin('POST', '/api/partners', { company_name: 'TEST Partner B', category_id: gold.id });
    extraPartners.push(mkA.json.id, mkB.json.id);
    await admin('POST', `/api/partners/${mkA.json.id}/login`, { username: 'test.a.' + Date.now(), password: pwA });
    await admin('POST', `/api/partners/${mkB.json.id}/login`, { username: 'test.b.' + Date.now(), password: pwB });
    const logins = (await admin('GET', '/api/partners')).json;
    const userA = logins.find((p) => p.id === mkA.json.id).logins[0].username, userB = logins.find((p) => p.id === mkB.json.id).logins[0].username;
    const A = session(), B = session(), S = session();
    await A('POST', '/api/auth/login', { username: userA, password: pwA });
    await B('POST', '/api/auth/login', { username: userB, password: pwB });
    // a staff login, created straight in the database (the API has no staff-creation screen yet)
    const staffName = 'test.staff.' + Date.now();
    await db.query("INSERT INTO app_users (username, password_hash, role) VALUES ($1,$2,'staff')", [staffName, require('./auth').hashPassword(pwS)]);
    await S('POST', '/api/auth/login', { username: staffName, password: pwS });

    check('customers need login', (await anon('GET', '/api/customers')).status === 401);
    check('name required', (await A('POST', '/api/customers', { name: '  ' })).status === 400);
    check('bad contact email rejected', (await A('POST', '/api/customers', { name: 'X Corp', contact: { name: 'Bob', email: 'not-an-email' } })).status === 400);
    const cA = await A('POST', '/api/customers', { name: 'Acme Retail Group', industry: 'Retail', contact: { name: 'Priya Fernando', title: 'HR Director', email: 'priya@acme.example' } });
    check('partner A creates customer', cA.status === 201);
    const cA2 = await A('POST', '/api/customers', { name: 'Zeta Logistics' });
    const cB = await B('POST', '/api/customers', { name: 'Beta Foods', contact: { name: 'Nuwan', email: 'nuwan@beta.example' } });
    check('partner B creates customer', cB.status === 201);
    extraCustomers.push(cA.json.id, cA2.json.id, cB.json.id);

    const listA = (await A('GET', '/api/customers')).json;
    check('A sees only own customers', listA.length === 2 && listA.every((c) => c.partner_id === mkA.json.id), JSON.stringify(listA.map((c) => c.name)));
    check('list shows primary contact', listA.find((c) => c.name === 'Acme Retail Group').primary_contact.name === 'Priya Fernando');
    check('B cannot open A customer', (await B('GET', '/api/customers/' + cA.json.id)).status === 404);
    check('B cannot edit A customer', (await B('PUT', '/api/customers/' + cA.json.id, { name: 'Hijacked' })).status === 404);
    check('B cannot add contact to A customer', (await B('POST', '/api/customers/' + cA.json.id + '/contacts', { name: 'Evil' })).status === 404);
    const acmeContact = (await A('GET', '/api/customers/' + cA.json.id)).json.contacts[0];
    check('B cannot edit or delete A contact', (await B('PUT', '/api/contacts/' + acmeContact.id, { name: 'Evil' })).status === 404 && (await B('DELETE', '/api/contacts/' + acmeContact.id)).status === 404);
    check('A customer name unchanged', (await A('GET', '/api/customers/' + cA.json.id)).json.name === 'Acme Retail Group');

    check('B search does not find A customer', (await B('GET', '/api/customers?q=acme')).json.length === 0);
    check('A search by contact email', (await A('GET', '/api/customers?q=priya@acme')).json.length === 1);
    check('duplicate warning for A', (await A('GET', '/api/customers/check?name=acme%20retail%20group')).json.length === 1);
    check('duplicate warning does not leak across partners', (await B('GET', '/api/customers/check?name=acme%20retail%20group&email=priya@acme.example')).json.length === 0);

    const all = (await S('GET', '/api/customers')).json.map((c) => c.name);
    check('staff sees every customer', ['Acme Retail Group', 'Zeta Logistics', 'Beta Foods'].every((n) => all.includes(n)));
    const own = await S('POST', '/api/customers', { name: 'Victory Direct Customer' });
    extraCustomers.push(own.json.id);
    check('staff customer has no partner', (await S('GET', '/api/customers/' + own.json.id)).json.partner_id === null);
    check('A cannot see staff customer', (await A('GET', '/api/customers/' + own.json.id)).status === 404);
    const assigned = await S('POST', '/api/customers', { name: 'Assigned To B', partner_id: mkB.json.id });
    extraCustomers.push(assigned.json.id);
    check('staff can assign a customer to a partner, and B sees it', (await B('GET', '/api/customers/' + assigned.json.id)).status === 200);
    check('partner cannot reassign by sending partner_id', (await A('GET', '/api/customers/' + (await A('POST', '/api/customers', { name: 'Sneaky', partner_id: mkB.json.id }).then((r) => (extraCustomers.push(r.json.id), r))).json.id)).json.partner_id === mkA.json.id);

    const k2 = await A('POST', '/api/customers/' + cA.json.id + '/contacts', { name: 'Kasun Perera', title: 'Finance Manager', email: 'kasun@acme.example', role: 'finance', is_primary: true });
    const detail = (await A('GET', '/api/customers/' + cA.json.id)).json;
    check('new primary replaces old', k2.status === 201 && detail.contacts.filter((c) => c.is_primary).length === 1 && detail.contacts[0].name === 'Kasun Perera');
    await A('DELETE', '/api/contacts/' + k2.json.id);
    const after = (await A('GET', '/api/customers/' + cA.json.id)).json;
    check('deleting primary promotes another contact', after.contacts.length === 1 && after.contacts[0].is_primary === true);
    const edit = await A('PUT', '/api/customers/' + cA.json.id, { name: 'Acme Retail Group', industry: 'Retail & Wholesale', active: false });
    check('edit and deactivate', edit.status === 200 && (await A('GET', '/api/customers/' + cA.json.id)).json.active === false);
    console.log('Quote engine');
    const near = (a, b) => Math.abs(a - b) < 0.011;
    const qIn = { employees: 180, adminSeats: 7, portalUsers: 150, items: ['time', 'payroll'], extraStorageGB: 12, notifications: { sms: 1000, whatsapp: 0, email: 5000 }, integrationHours: 10,
      customisations: [{ title: 'Custom leave report', details: 'Monthly leave liability report', hours: 20 }], billing: { type: 'subscription', term: 'monthly' }, discounts: [{ label: 'Promo', pct: 10 }] };
    check('catalog needs login', (await anon('GET', '/api/quote/catalog')).status === 401);
    const cat1 = await admin('GET', '/api/quote/catalog');
    check('catalog has structure, no prices', cat1.status === 200 && cat1.json.items.length === 13 && !JSON.stringify(cat1.json).includes('"qIn"'));
    const q1 = (await admin('POST', '/api/quote', qIn)).json.quote;
    const L = (q, key) => q.lines.find((l) => l.key === key).amount;
    check('band 101-250', q1.band.label === '101 – 250');
    check('Core HR 336', L(q1, 'core') === 336);
    check('modules priced by band', L(q1, 'time') === 84 && L(q1, 'payroll') === 112);
    check('2 extra seats at 25', L(q1, 'seats') === 50);
    check('portal 150 x 1.00', L(q1, 'portal') === 150);
    check('storage 3 blocks', L(q1, 'storage') === 15 && q1.freeStorageGB === 24.4);
    check('notifications 35', near(L(q1, 'notifications'), 35));
    check('development 20h x 60', L(q1, 'development') === 1200 && L(q1, 'integration') === 500);
    check('10% off everything except Core HR (monthly 737.40)', near(q1.monthlyRecurring, 737.4) && near(q1.discountMonthly, 44.6), JSON.stringify([q1.monthlyRecurring, q1.discountMonthly]));
    check('one-time 1530 after discount', near(q1.oneTime, 1530));
    check('monthly billing: due at signing = one-time, year 1 = 10,378.80', near(q1.dueAtSigning, 1530) && near(q1.year1, 10378.8));
    const q2 = (await admin('POST', '/api/quote', { ...qIn, billing: { type: 'subscription', term: 'annual' } })).json.quote;
    check('annual prepay: 12 months upfront', near(q2.billing.prepayLump, 8848.8) && near(q2.dueAtSigning, 10378.8));
    const q3 = (await admin('POST', '/api/quote', { ...qIn, billing: { type: 'perpetual', term: 'monthly' } })).json.quote;
    check('perpetual licence = platform x 24', near(q3.billing.licence, 16617.6), q3.billing.licence);
    check('perpetual maintenance 20% and usage', near(q3.billing.maintenanceAnnual, 3323.52) && near(q3.billing.usageMonthly, 45));
    check('perpetual due at signing and year 1', near(q3.dueAtSigning, 18147.6) && near(q3.year1, 22011.12), JSON.stringify([q3.dueAtSigning, q3.year1]));
    const q4 = (await admin('POST', '/api/quote', { ...qIn, discounts: [{ label: 'All', pct: 100 }] })).json.quote;
    check('100% discount never goes below Core HR', near(q4.monthlyRecurring, 336));
    const q5 = (await admin('POST', '/api/quote', { ...qIn, discounts: [{ label: 'a', pct: 10 }, { label: 'b', pct: 5 }] })).json.quote;
    check('stacked discounts compound (14.5%)', q5.discountPct === 14.5);
    check('unknown module rejected', (await admin('POST', '/api/quote', { ...qIn, items: ['nope'] })).status === 400);
    check('zero employees rejected', (await admin('POST', '/api/quote', { ...qIn, employees: 0 })).status === 400);
    {
      const w0 = (await admin('POST', '/api/quote', { ...qIn, wdmsDevices: 0 })).json.quote;
      const w1 = (await admin('POST', '/api/quote', { ...qIn, wdmsDevices: 10 })).json.quote;
      const w2 = (await admin('POST', '/api/quote', { ...qIn, wdmsDevices: 10, discounts: [{ label: 'x', pct: 20 }] })).json.quote;
      const w3 = (await admin('POST', '/api/quote', { ...qIn, wdmsDevices: 10, discounts: [{ label: 'x', pct: 20 }], billing: { type: 'perpetual', term: 'monthly' } })).json.quote;
      check('WDMS adds 3 USD per device per month', !w0.lines.some((l) => l.key === 'wdms') && Math.abs(w1.monthlyRecurring - w0.monthlyRecurring - 30) < 0.01);
      const base20 = (await admin('POST', '/api/quote', { ...qIn, discounts: [{ label: 'x', pct: 20 }] })).json.quote;
      check('WDMS is never discounted', Math.abs(w2.monthlyRecurring - base20.monthlyRecurring - 30) < 0.01 && w2.lines.find((l) => l.key === 'wdms').discountable === false && w2.rates.wdmsPerDevice === 3);
      check('WDMS stays a monthly charge on a perpetual licence', w3.billing.usageMonthly >= 30);
      check('a negative device count is rejected', (await admin('POST', '/api/quote', { ...qIn, wdmsDevices: -1 })).status === 400);
      const n1 = (await admin('POST', '/api/quote', { ...qIn, notifications: { sms: 1000, whatsapp: 1000, email: 1000, enabled: { sms: true, whatsapp: false, email: false } } })).json.quote;
      const n0 = (await admin('POST', '/api/quote', { ...qIn, notifications: { sms: 0, whatsapp: 0, email: 0 } })).json.quote;
      check('only activated notification channels are charged', n1.lines.find((l) => l.key === 'notifications').amount === 20 && !JSON.stringify(n1.lines).includes('WhatsApp') && !n0.lines.some((l) => l.key === 'notifications'));
    }
    {
      const cust = (await admin('GET', '/api/customers')).json[0];
      if (cust) {
        const dBefore = (await admin('GET', '/api/proposals/draft-count')).json;
        const dr = await admin('POST', '/api/proposals', { customer_id: cust.id, input: { employees: '', items: ['time'], style: 'standard' }, draft: true });
        check('an incomplete draft can be saved', dr.status === 201 && dr.json.incomplete === true);
        const dAfter = (await admin('GET', '/api/proposals/draft-count')).json;
        check('draft and incomplete counts go up', dAfter.drafts === dBefore.drafts + 1 && dAfter.incomplete === dBefore.incomplete + 1);
        check('without "draft" the same incomplete input is still refused', (await admin('POST', '/api/proposals', { customer_id: cust.id, input: { employees: '', items: ['time'] } })).status === 400);
        check('an incomplete draft cannot be emailed or exported', (await admin('POST', '/api/proposals/' + dr.json.id + '/send', { to: 'a@b.co', subject: 's', message: 'm' })).status === 400 && (await admin('GET', '/api/proposals/' + dr.json.id + '/pdf')).status === 400);
        const fin = await admin('PUT', '/api/proposals/' + dr.json.id, { customer_id: cust.id, input: { ...qIn } });
        check('finishing the draft clears the incomplete flag', fin.status === 200 && fin.json.incomplete === false && (await admin('GET', '/api/proposals/draft-count')).json.incomplete === dBefore.incomplete);
        {
          const pid = dr.json.id, b64 = Buffer.from('hello attachment').toString('base64');
          const up = await admin('POST', '/api/proposals/' + pid + '/attachments', { name: 'terms.txt', data: b64 });
          check('an extra file can be attached to the email', up.status === 201 && up.json.size === 16);
          check('programs and unknown file types are refused', (await admin('POST', '/api/proposals/' + pid + '/attachments', { name: 'run.exe', data: b64 })).status === 400 && (await admin('POST', '/api/proposals/' + pid + '/attachments', { name: 'x.svg', data: b64 })).status === 400);
          check('attachments are listed and can be removed', (await admin('GET', '/api/proposals/' + pid + '/attachments')).json.length === 1 && (await admin('DELETE', '/api/proposals/' + pid + '/attachments/' + up.json.id)).status === 200 && (await admin('GET', '/api/proposals/' + pid + '/attachments')).json.length === 0);
          const pv2 = (await admin('POST', '/api/proposals/' + pid + '/email-preview', { message: 'Hello **bold**\n\n- one\n- two <script>x</script>', options: { includeSummary: false, attachPdf: false } })).json.html || '';
          check('the email preview formats the message and escapes scripts', pv2.includes('<b>bold</b>') && pv2.includes('<li>one</li>') && !pv2.includes('<script>') && !pv2.includes('Monthly subscription') && !pv2.includes('attached as a PDF'));
          const pv3 = (await admin('POST', '/api/proposals/' + pid + '/email-preview', { message: 'Hi' })).json.html || '';
          check('by default the preview has the summary and the link button, and no PDF note', pv3.includes('Monthly subscription') && pv3.includes('View your proposal online') && !pv3.includes('attached as a PDF'));
        }
        {
          const tr = require('./tracking'), pid2 = dr.json.id;
          const l1 = await tr.ensureLink(pid2, 1, 'Ann@Example.com'), l1b = await tr.ensureLink(pid2, 1, 'ann@example.com'), l2 = await tr.ensureLink(pid2, 1, 'bob@example.com'), lg = await tr.ensureLink(pid2, 1);
          check('each recipient gets their own link, the same one each time', l1.token === l1b.token && l1.token !== l2.token && lg.token !== l1.token);
          const lid = (await db.query('SELECT id FROM proposal_links WHERE token = $1', [l1.token])).rows[0].id;
          await db.query("INSERT INTO proposal_views (proposal_id, link_id, sid, type) VALUES ($1,$2,'s1','open'), ($1,$2,'s1','engaged'), ($1,$2,'s1','pdf')", [pid2, lid]);
          await db.query("INSERT INTO email_log (proposal_id, sent_by, to_email, subject, ok) VALUES ($1,1,'bob@example.com','s',true)", [pid2]);
          const an = (await admin('GET', '/api/proposals/' + pid2 + '/analytics')).json;
          const ann = (an.people || []).find((x) => x.who === 'ann@example.com'), bob = (an.people || []).find((x) => x.who === 'bob@example.com');
          check('the breakdown shows who opened and downloaded, and who has not opened', ann && ann.visits === 1 && ann.pdfs === 1 && bob && bob.visits === 0 && bob.delivered === true);
          check('latest events name the person', (an.recent || []).some((e) => e.recipient === 'ann@example.com' && e.type === 'pdf'));
        }
        await db.query('DELETE FROM proposals WHERE id = $1', [dr.json.id]);
      }
    }
    check('negative discount rejected', (await admin('POST', '/api/quote', { ...qIn, discounts: [{ pct: -5 }] })).status === 400);
    check('huge company needs custom quote', (await admin('POST', '/api/quote', { ...qIn, employees: 5000 })).json.quote.custom === true);

    console.log('Discount cap for partners (Gold Reseller = 20%)');
    check('partner catalog shows their cap', (await A('GET', '/api/quote/catalog')).json.maxDiscountPct === 20);
    check('25% refused for partner', (await A('POST', '/api/quote', { ...qIn, discounts: [{ pct: 25 }] })).status === 400);
    check('20% allowed for partner', (await A('POST', '/api/quote', { ...qIn, discounts: [{ pct: 20 }] })).status === 200);
    check('15% then 10% (23.5%) refused', (await A('POST', '/api/quote', { ...qIn, discounts: [{ pct: 15 }, { pct: 10 }] })).status === 400);
    check('10% then 5% (14.5%) allowed', (await A('POST', '/api/quote', { ...qIn, discounts: [{ pct: 10 }, { pct: 5 }] })).status === 200);
    check('staff are not capped', (await S('POST', '/api/quote', { ...qIn, discounts: [{ pct: 40 }] })).status === 200);

    console.log('Proposals');
    const body = (customer, contact, input) => ({ customer_id: customer, contact_id: contact, input });
    check('proposals need login', (await anon('GET', '/api/proposals')).status === 401);
    const zetaContact = (await A('POST', '/api/customers/' + cA2.json.id + '/contacts', { name: 'Zeta Contact', email: 'zeta@example.com' })).json.id;
    const pA = await A('POST', '/api/proposals', body(cA2.json.id, zetaContact, { ...qIn, discounts: [{ label: 'Promo', pct: 10 }] }));
    check('partner creates proposal with a reference', pA.status === 201 && /^VI-PH-\d{4}-\d{4}$/.test(pA.json.ref_no), JSON.stringify(pA.json));
    extraProposals.push(pA.json.id);
    check('partner cannot use another partner customer', (await B('POST', '/api/proposals', body(cA2.json.id, null, qIn))).status === 400);
    check('over-cap discount refused when saving', (await A('POST', '/api/proposals', body(cA2.json.id, null, { ...qIn, discounts: [{ pct: 30 }] }))).status === 400);
    check('contact from another customer refused', (await A('POST', '/api/proposals', body(cA2.json.id, acmeContact.id, qIn))).status === 400);
    check('custom-quote size cannot be saved', (await A('POST', '/api/proposals', body(cA2.json.id, null, { ...qIn, employees: 5000 }))).status === 400);
    const pB = await B('POST', '/api/proposals', body(cB.json.id, null, qIn));
    extraProposals.push(pB.json.id);
    check('proposal numbers increase', Number(pB.json.ref_no.slice(-4)) === Number(pA.json.ref_no.slice(-4)) + 1);
    const stored = (await A('GET', '/api/proposals/' + pA.json.id)).json;
    check('stored proposal keeps client snapshot and totals', stored.client.name === 'Zeta Logistics' && stored.client.contact.name === 'Zeta Contact' && near(stored.totals.monthlyRecurring, 737.4));
    check('partner A lists only own proposals', (await A('GET', '/api/proposals')).json.every((p) => p.ref_no === pA.json.ref_no));
    check('B cannot open A proposal', (await B('GET', '/api/proposals/' + pA.json.id)).status === 404);
    check('B cannot change A proposal status', (await B('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'sent' })).status === 404);
    check('staff list shows both', (await S('GET', '/api/proposals')).json.filter((p) => [pA.json.ref_no, pB.json.ref_no].includes(p.ref_no)).length === 2);
    const propEdit = await A('PUT', '/api/proposals/' + pA.json.id, body(cA2.json.id, zetaContact, { ...qIn, discounts: [{ label: 'Negotiated', pct: 5 }] }));
    check('draft can be edited and re-priced', propEdit.status === 200 && (await A('GET', '/api/proposals/' + pA.json.id)).json.discount_pct === '5.00');
    check('bad status refused', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'bogus' })).status === 400);
    check('mark as sent', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'sent' })).status === 200);
    check('sent proposal is frozen', (await A('PUT', '/api/proposals/' + pA.json.id, body(cA2.json.id, zetaContact, qIn))).status === 400);

    console.log('Proposal pipeline and revisions');
    check('a draft cannot jump to accepted', (await B('PUT', '/api/proposals/' + pB.json.id + '/status', { status: 'accepted' })).status === 400);
    check('sent moves to negotiating', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'negotiating' })).status === 200);
    check('losing needs a reason', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'lost' })).status === 400);
    check('lost with a reason', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'lost', reason: 'Went with a competitor' })).status === 200);
    check('lost reason is stored', (await A('GET', '/api/proposals/' + pA.json.id)).json.lost_reason === 'Went with a competitor');
    check('a lost proposal can be reopened', (await A('PUT', '/api/proposals/' + pA.json.id + '/status', { status: 'negotiating' })).status === 200);
    check('a draft cannot be revised', (await B('POST', '/api/proposals/' + pB.json.id + '/revise')).status === 400);
    check('another partner cannot revise it', (await B('POST', '/api/proposals/' + pA.json.id + '/revise')).status === 404);
    const rev = await A('POST', '/api/proposals/' + pA.json.id + '/revise');
    extraProposals.push(rev.json.id);
    check('revision created as a draft v2', rev.status === 201 && rev.json.version === 2 && rev.json.ref_no === pA.json.ref_no + '-v2');
    check('the old version is marked superseded', (await A('GET', '/api/proposals/' + pA.json.id)).json.status === 'superseded');
    check('the revision starts as an editable draft', (await A('GET', '/api/proposals/' + rev.json.id)).json.status === 'draft');
    check('a superseded version cannot be revised again', (await A('POST', '/api/proposals/' + pA.json.id + '/revise')).status === 400);
    check('a superseded version cannot be emailed', (await A('POST', '/api/proposals/' + pA.json.id + '/send', { to: 'x@example.com', subject: 's', message: 'm' })).status === 400);
    check('versions are listed together', (await A('GET', '/api/proposals/' + rev.json.id + '/versions')).json.length === 2);
    const tline = await A('GET', '/api/proposals/' + pA.json.id + '/timeline');
    check('timeline records the moves', tline.status === 200 && tline.json.filter((e) => e.type === 'status').length >= 4);
    check('partner B cannot read the timeline', (await B('GET', '/api/proposals/' + pA.json.id + '/timeline')).json.length === 0);
    const revB = await B('POST', '/api/proposals/' + pB.json.id + '/status', { status: 'sent' });
    check('status must be a PUT, not a POST', revB.status === 404);

    console.log('Client web view, tracking and interest score');
    const pw = await B('POST', '/api/proposals', body(cB.json.id, null, qIn)); extraProposals.push(pw.json.id);
    check('no link for a draft', (await B('POST', '/api/proposals/' + pw.json.id + '/link')).status === 400);
    await B('PUT', '/api/proposals/' + pw.json.id + '/status', { status: 'sent' });
    const lk = await B('POST', '/api/proposals/' + pw.json.id + '/link');
    check('sent proposal gets a private link', lk.status === 200 && /^[0-9a-f]{64}$/.test(lk.json.token) && lk.json.url.endsWith('/p/' + lk.json.token));
    check('the link is reused, not regenerated', (await B('POST', '/api/proposals/' + pw.json.id + '/link')).json.token === lk.json.token);
    check('another partner cannot get the link', (await A('POST', '/api/proposals/' + pw.json.id + '/link')).status === 404);
    check('another partner cannot read analytics', (await A('GET', '/api/proposals/' + pw.json.id + '/analytics')).status === 404);
    const tk = lk.json.token;
    const pubGet = await anon('GET', '/api/public/proposal/' + tk);
    check('the client can open the proposal without signing in', pubGet.status === 200 && pubGet.json.ref === pw.json.ref_no && pubGet.json.quote.monthlyRecurring > 0);
    const leak = JSON.stringify({ ...pubGet.json, doc: undefined });
    check('the public payload exposes no internal fields', !/max_discount|partner_id|price_list_id|created_by|cost|margin/i.test(leak));
    check('an unknown or malformed link is not found', (await anon('GET', '/api/public/proposal/' + 'a'.repeat(64))).status === 404 && (await anon('GET', '/api/public/proposal/xyz')).status === 404);
    const page = await fetch(BASE + '/p/' + tk);
    check('the client page is served and kept out of search engines', page.status === 200 && /noindex/.test(page.headers.get('x-robots-tag') || '') && (await page.text()).includes('PHDoc'));

    const ev = (type, extra, ua) => fetch(BASE + '/api/public/track/' + tk, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' }, body: JSON.stringify({ sid: 'visitor12345', type, ...(extra || {}) }) }).then((r) => r.status);
    check('a bad event type is refused', (await ev('hack')) === 400);
    check('a bad visitor id is refused', (await fetch(BASE + '/api/public/track/' + tk, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid: '!!', type: 'open' }) })).status === 400);
    check('a scanner open is recorded but ignored', (await ev('open', {}, 'Mozilla/5.0 (compatible; Microsoft SafeLinks Protection)')) === 200 && (await ev('engaged', {}, 'python-requests/2.31')) === 200);
    check('a scanner does not mark the proposal as viewed', (await B('GET', '/api/proposals/' + pw.json.id)).json.status === 'sent');
    check('the client opens and reads', (await ev('open')) === 200 && (await ev('engaged')) === 200 && (await ev('heartbeat', { ms: 999999 })) === 200 && (await ev('section', { section: 'invest' })) === 200 && (await ev('section', { section: 'terms' })) === 200);
    check('the first real read moves the proposal to viewed', (await B('GET', '/api/proposals/' + pw.json.id)).json.status === 'viewed');
    check('a colleague signed in is not counted as the client', (await B('POST', '/api/public/track/' + tk, { sid: 'colleague123', type: 'engaged' })) .status === 200);
    await new Promise((r) => setTimeout(r, 300));
    const an = await B('GET', '/api/proposals/' + pw.json.id + '/analytics');
    check('analytics count one real visitor', an.status === 200 && an.json.stats.visitors === 1 && an.json.stats.visits === 1);
    check('heartbeat time is capped per event', an.json.stats.seconds <= 15);
    check('pricing and terms sections were read', an.json.stats.sections.includes('invest') && an.json.stats.sections.includes('terms'));
    check('scanner opens are reported as ignored', an.json.scannerOpensIgnored >= 1);
    check('interest score explains itself', ['Hot', 'Warm', 'Cold'].includes(an.json.interest.label) && an.json.interest.reasons.length > 0);
    check('client request to talk is recorded and shows on the timeline', (await ev('cta', { note: 'Please call me on Monday' })) === 200 && (await B('GET', '/api/proposals/' + pw.json.id + '/timeline')).json.some((e) => e.type === 'client_request'));
    const pdfRes = await fetch(BASE + '/api/public/proposal/' + tk + '/pdf?sid=visitor12345');
    check('the client can download the PDF', pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf' && (await pdfRes.arrayBuffer()).byteLength > 20000);
    check('PDF downloads are counted', (await B('GET', '/api/proposals/' + pw.json.id + '/analytics')).json.stats.pdfs === 1);
    const ins = await B('GET', '/api/proposals-insights');
    check('insights cover only the own proposals of the partner', ins.status === 200 && ins.json[pw.json.id] && !ins.json[pA.json.id]);
    await db.query(`UPDATE proposal_links SET expires_at = now() - interval '1 day' WHERE token = $1`, [tk]);
    check('an expired link is refused', (await anon('GET', '/api/public/proposal/' + tk)).status === 410);

    const { interest } = require('./scoring');
    const now = new Date('2026-11-10T12:00:00Z'), ago = (h) => new Date(now - h * 3600 * 1000);
    const none = interest({ status: 'sent', sentAt: ago(10), stats: {}, now });
    check('score: just sent and unopened is waiting, not cold', none.label === 'Waiting' && none.score === null);
    const cold = interest({ status: 'sent', sentAt: ago(24 * 6), stats: {}, now });
    check('score: unopened for days is cold', cold.label === 'Cold' && cold.reasons.some((r) => /unopened/i.test(r.text)));
    const hot = interest({ status: 'negotiating', sentAt: ago(100), now, stats: { visits: 4, visitors: 2, days: 3, seconds: 400, pdfs: 1, ctas: 1, sections: ['invest', 'terms'], devices: 2, last_view: ago(5) } });
    check('score: engaged, repeat, asked to talk is hot', hot.label === 'Hot' && hot.score >= 80);
    const stale = interest({ status: 'viewed', sentAt: ago(24 * 20), now, stats: { visits: 1, visitors: 1, days: 1, seconds: 20, pdfs: 0, ctas: 0, sections: [], devices: 1, last_view: ago(24 * 18) } });
    check('score: opened once and gone quiet for weeks is cold', stale.label === 'Cold');
    check('score: accepted and lost are final', interest({ status: 'accepted' }).label === 'Won' && interest({ status: 'lost' }).label === 'Lost' && interest({ status: 'draft' }).score === null);

    console.log('Profile, passwords and price books');
    const crypto = require('crypto');
    check('profile needs login', (await anon('GET', '/api/me/profile')).status === 401);
    const prof = await A('GET', '/api/me/profile');
    check('partner profile shows category and discount', prof.status === 200 && prof.json.partner.category === 'Gold Reseller' && prof.json.partner.maxDiscountPct === 20);
    check('bad email refused', (await A('PUT', '/api/me/profile', { displayName: 'T', email: 'not-an-email', phone: '' })).status === 400);
    check('profile saved', (await A('PUT', '/api/me/profile', { displayName: 'Test Person', email: 'test.person@example.com', phone: '0771234567' })).status === 200);
    check('profile reads back', (await A('GET', '/api/me/profile')).json.email === 'test.person@example.com');
    check('email cannot be shared by two logins', (await admin('PUT', '/api/me/profile', { displayName: 'Admin', email: 'test.person@example.com', phone: '' })).status === 400);

    await admin('POST', `/api/partners/${partnerId}/login`, { username: testUser, password: testPw }); // re-enables the login deactivated earlier
    const P = session(); await P("POST", "/api/auth/login", { username: testUser, password: testPw });
    const newPw = 'N3w-Passw0rd-' + Date.now();
    check('wrong current password refused', (await P('POST', '/api/auth/change-password', { current: 'wrong-wrong-wrong', next: newPw })).status === 400);
    check('short new password refused', (await P('POST', '/api/auth/change-password', { current: testPw, next: 'short' })).status === 400);
    const oldSession = session(); await oldSession('POST', '/api/auth/login', { username: testUser, password: testPw });
    await new Promise((r) => setTimeout(r, 1100));
    const chg = await P('POST', '/api/auth/change-password', { current: testPw, next: newPw }); check('password changed', chg.status === 200, JSON.stringify(chg));
    check('this browser stays signed in', (await P('GET', '/api/auth/me')).status === 200);
    check('older sessions are signed out', (await oldSession('GET', '/api/auth/me')).status === 401);
    check('old password no longer works', (await session()('POST', '/api/auth/login', { username: testUser, password: testPw })).status === 401);
    check('new password works', (await session()('POST', '/api/auth/login', { username: testUser, password: newPw })).status === 200);

    const fg = await anon('POST', '/api/auth/forgot', { identifier: 'no-such-user-xyz' });
    const fg2 = await anon('POST', '/api/auth/forgot', { identifier: testUser });
    check('forgot gives the same answer for unknown and known users', fg.status === 200 && fg2.status === 200 && fg.json.message === fg2.json.message);
    const token = crypto.randomBytes(32).toString('hex');
    const uid = (await P('GET', '/api/auth/me')).json.id;
    await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 minutes')`, [uid, crypto.createHash('sha256').update(token).digest('hex')]);
    const viaReset = 'R3set-Passw0rd-' + Date.now();
    check('reset with a bad token refused', (await anon('POST', '/api/auth/reset', { token: 'f'.repeat(64), password: viaReset })).status === 400);
    check('reset rejects a short password', (await anon('POST', '/api/auth/reset', { token, password: 'short' })).status === 400);
    check('reset with a valid token works', (await anon('POST', '/api/auth/reset', { token, password: viaReset })).status === 200);
    check('reset link is single use', (await anon('POST', '/api/auth/reset', { token, password: viaReset + 'x' })).status === 400);
    const expTok = crypto.randomBytes(32).toString('hex');
    await db.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() - interval '1 minute')`, [uid, crypto.createHash('sha256').update(expTok).digest('hex')]);
    const ex = await anon('POST', '/api/auth/reset', { token: expTok, password: viaReset + 'y' }); check('expired reset link refused', ex.status === 400, JSON.stringify(ex));

    check('only admin can issue a temporary password', (await S('POST', '/api/users/' + uid + '/reset-password')).status === 403);
    const tmp = await admin('POST', '/api/users/' + uid + '/reset-password');
    check('admin issues a temporary password', tmp.status === 200 && tmp.json.temporaryPassword && tmp.json.temporaryPassword.length >= 12);
    const T = session();
    const tl = await T('POST', '/api/auth/login', { username: testUser, password: tmp.json.temporaryPassword });
    check('temporary login flags a forced change', tl.status === 200 && tl.json.mustChangePassword === true);
    const blocked = await T('GET', '/api/quote/catalog');
    check('everything else is blocked until it is changed', blocked.status === 403 && blocked.json.code === 'must_change_password');
    const final = 'F1nal-Passw0rd-' + Date.now();
    check('forced change succeeds', (await T('POST', '/api/auth/change-password', { current: tmp.json.temporaryPassword, next: final })).status === 200);
    check('access restored after the change', (await T('GET', '/api/quote/catalog')).status === 200);
    check('admin cannot reset their own password this way', (await admin('POST', '/api/users/' + (await admin('GET', '/api/auth/me')).json.id + '/reset-password')).status === 400);

    const versions = await admin('GET', '/api/price-lists');
    check('admin lists price list versions', versions.status === 200 && versions.json.length >= 1 && versions.json.filter((v) => v.is_current).length === 1);
    const vOne = await admin('GET', '/api/price-lists/' + versions.json[0].id);
    const goldView = vOne.json.categories.find((c) => c.name === 'Gold Reseller');
    check('category view applies the discount but never to Core HR', goldView && goldView.data.items.find((i) => i.id === 'corehr').base === 120 && goldView.data.items.find((i) => i.id === 'time').base < vOne.json.data.items.find((i) => i.id === 'time').base);
    check('partners cannot browse the version list', (await T('GET', '/api/price-lists')).status === 403);
    const plP = await T('GET', '/api/price-list');
    check('a partner sees list price and their own price (for margin)', plP.status === 200 && plP.json.listData.items.find((i) => i.id === 'time').base > plP.json.data.items.find((i) => i.id === 'time').base && plP.json.listData.items.find((i) => i.id === 'corehr').base === plP.json.data.items.find((i) => i.id === 'corehr').base);

    console.log('Partner team');
    check('team needs a partner owner (admin refused)', (await admin('GET', '/api/team')).status === 403);
    const tm = await T('GET', '/api/team');
    check('owner lists the team', tm.status === 200 && tm.json.users.length >= 1 && tm.json.users[0].partner_role === 'owner');
    check('bad username refused', (await T('POST', '/api/team', { username: 'a b', displayName: 'X' })).status === 400);
    const mUser = 'test.member.' + Date.now();
    const mk2 = await T('POST', '/api/team', { username: mUser, displayName: 'Team Member', email: 'member.' + Date.now() + '@example.com' });
    check('owner adds a member with a temporary password', mk2.status === 201 && mk2.json.temporaryPassword.length >= 12);
    check('duplicate username refused', (await T('POST', '/api/team', { username: mUser, displayName: 'Again' })).status === 400);
    check('other partners do not see this member', !(await A('GET', '/api/team')).json.users.some((u) => u.username === mUser));
    const M = session();
    const ml = await M('POST', '/api/auth/login', { username: mUser, password: mk2.json.temporaryPassword });
    check('member must change the temporary password first', ml.status === 200 && ml.json.mustChangePassword === true && ml.json.partner.isOwner === false);
    const mPw = 'M3mber-Passw0rd-' + Date.now();
    check('member sets a password', (await M('POST', '/api/auth/change-password', { current: mk2.json.temporaryPassword, next: mPw })).status === 200);
    check('member shares the company discount cap', (await M('GET', '/api/quote/catalog')).json.maxDiscountPct === 20);
    check('a member cannot manage the team', (await M('GET', '/api/team')).status === 403 && (await M('POST', '/api/team', { username: 'sneaky.user' })).status === 403);
    check('owner resets a member password', (await T('POST', '/api/team/' + mk2.json.id + '/reset-password')).status === 200);
    check('owner cannot touch another company member', (await A('PUT', '/api/team/' + mk2.json.id + '/active', { active: false })).status === 404);
    check('owner deactivates the member', (await T('PUT', '/api/team/' + mk2.json.id + '/active', { active: false })).status === 200);
    check('a deactivated member is signed out at once', (await M('GET', '/api/quote/catalog')).status === 401);
    await db.query('UPDATE partners SET max_users = (SELECT count(*) FROM app_users WHERE partner_id = $1) WHERE id = $1', [partnerId]);
    check('the company login limit is enforced', (await T('POST', '/api/team', { username: 'over.limit.' + Date.now() })).status === 400);
    await db.query('UPDATE partners SET max_users = 10 WHERE id = $1', [partnerId]);

    console.log('CRM: leads, follow-ups and timeline');
    const co = 'Zephyr' + Date.now().toString(36);
    const crm = require('./crm');
    check('company names match across Pvt/Ltd styles', crm.nameKey('Zephyr Foods (Pvt) Ltd') === crm.nameKey('zephyr foods') && crm.nameKey('A.B.C. Ltd') === 'abc');
    check('leads need login', (await anon('GET', '/api/leads')).status === 401);
    check('a lead needs a company name', (await T('POST', '/api/leads', { contact_name: 'X' })).status === 400);
    check('a bad email is refused', (await T('POST', '/api/leads', { company_name: co, email: 'nope' })).status === 400);
    const ld = await T('POST', '/api/leads', { company_name: co + ' Foods (Pvt) Ltd', contact_name: 'Kamal Silva', contact_title: 'HR Manager', email: 'kamal@' + co + '.example', phone: '+94 77 123 4567', employees: 240, est_value: 650, source: 'Referral' });
    check('partner registers a lead', ld.status === 201 && ld.json.id);
    const LEAD = ld.json.id;
    check('same company again is flagged as a duplicate', (await T('POST', '/api/leads', { company_name: co + ' FOODS' })).json.code === 'duplicate');
    const clash = await A('POST', '/api/leads', { company_name: co.toUpperCase() + ' foods ltd' });
    check('another partner cannot register the same company', clash.status === 409 && clash.json.code === 'registered_elsewhere' && !/test|reseller/i.test(clash.json.error));
    check('nor by the same company email domain', (await A('POST', '/api/leads', { company_name: 'Different Name Co', email: 'someone@' + co + '.example' })).status === 409);
    check('nor by the same phone number', (await A('POST', '/api/leads', { company_name: 'Another Name Co', phone: '0771234567' })).status === 409);
    check('free email providers do not block anyone', (await A('POST', '/api/leads', { company_name: 'Free Mail Co ' + co, email: 'someone.else' + Date.now() + '@gmail.com' })).status === 201);
    const sClash = await S('POST', '/api/leads', { company_name: co + ' foods' });
    check('staff are warned that a partner holds it', sClash.status === 409 && sClash.json.code === 'held_by_partner');
    check('partner leads are private to the company', (await A('GET', '/api/leads/' + LEAD)).status === 404 && !(await A('GET', '/api/leads')).json.some((x) => x.id === LEAD));
    check('staff can see every lead', (await S('GET', '/api/leads/' + LEAD)).status === 200);
    check('the lead starts as new with a 90 day hold', (await T('GET', '/api/leads/' + LEAD)).json.stage === 'new' && new Date((await T('GET', '/api/leads/' + LEAD)).json.lock_until) - Date.now() > 89 * 86400000);

    check('an unknown activity type is refused', (await T('POST', '/api/leads/' + LEAD + '/activities', { type: 'hack', note: 'x' })).status === 400);
    check('a call is logged', (await T('POST', '/api/leads/' + LEAD + '/activities', { type: 'call', note: 'Spoke to Kamal; wants a demo' })).status === 201);
    check('contacting a new lead moves it to contacted', (await T('GET', '/api/leads/' + LEAD)).json.stage === 'contacted');
    check('losing a lead needs a reason', (await T('PUT', '/api/leads/' + LEAD + '/stage', { stage: 'lost' })).status === 400);
    check('another partner cannot move my lead', (await A('PUT', '/api/leads/' + LEAD + '/stage', { stage: 'qualified' })).status === 404);

    const cv = await T('POST', '/api/leads/' + LEAD + '/convert');
    check('lead converts to a customer', cv.status === 201 && cv.json.customer_id);
    check('converting twice returns the same customer', (await T('POST', '/api/leads/' + LEAD + '/convert')).json.customer_id === cv.json.customer_id);
    const custFull = await T('GET', '/api/customers/' + cv.json.customer_id);
    check('the customer keeps the company and its primary contact', custFull.status === 200 && custFull.json.contacts.some((c) => c.name === 'Kamal Silva' && c.is_primary));
    check('the customer belongs to the partner only', (await A('GET', '/api/customers/' + cv.json.customer_id)).status === 404);
    check('converted lead is qualified', (await T('GET', '/api/leads/' + LEAD)).json.stage === 'qualified');

    const pr = await T('POST', '/api/proposals', { customer_id: cv.json.customer_id, contact_id: custFull.json.contacts[0].id, input: qIn }); extraProposals.push(pr.json.id);
    await T('PUT', '/api/proposals/' + pr.json.id + '/status', { status: 'sent' });
    check('sending a proposal moves the lead to proposal', (await T('GET', '/api/leads/' + LEAD)).json.stage === 'proposal');
    check('the lead shows its proposals', (await T('GET', '/api/leads/' + LEAD)).json.proposals.length === 1);
    await T('PUT', '/api/proposals/' + pr.json.id + '/status', { status: 'accepted' });
    check('an accepted proposal wins the lead', (await T('GET', '/api/leads/' + LEAD)).json.stage === 'won');

    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10), yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10), todayStr = new Date().toISOString().slice(0, 10);
    check('a task needs a title and a date', (await T('POST', '/api/tasks', { title: '', due_date: todayStr })).status === 400 && (await T('POST', '/api/tasks', { title: 'TEST x' })).status === 400);
    const t1 = await T('POST', '/api/tasks', { title: 'TEST call Kamal back', type: 'call', due_date: yesterday, lead_id: LEAD });
    const t2 = await T('POST', '/api/tasks', { title: 'TEST send brochure', type: 'email', due_date: todayStr, lead_id: LEAD });
    const t3 = await T('POST', '/api/tasks', { title: 'TEST check in', due_date: tomorrow, customer_id: cv.json.customer_id });
    check('follow-ups created', t1.status === 201 && t2.status === 201 && t3.status === 201);
    const sum = await T('GET', '/api/tasks/summary');
    check('summary counts overdue and due today', sum.json.overdue >= 1 && sum.json.today >= 1);
    check('overdue list holds the late one', (await T('GET', '/api/tasks?scope=overdue')).json.some((t) => t.id === t1.json.id));
    check('upcoming list holds tomorrow', (await T('GET', '/api/tasks?scope=upcoming')).json.some((t) => t.id === t3.json.id));
    check('another partner cannot see or change my tasks', (await A('PUT', '/api/tasks/' + t1.json.id, { done: true })).status === 404 && !(await A('GET', '/api/tasks?who=all')).json.some((t) => t.id === t1.json.id));
    check('a task cannot be given to someone outside the company', (await T('POST', '/api/tasks', { title: 'TEST bad assign', due_date: todayStr, assigned_to: 1 })).status === 400);
    check('completing a task logs it on the lead', (await T('PUT', '/api/tasks/' + t1.json.id, { done: true })).status === 200 && (await T('GET', '/api/leads/' + LEAD)).json.activities.some((a) => /Follow-up done: TEST call Kamal back/.test(a.note)));
    check('done tasks leave the open list', !(await T('GET', '/api/tasks')).json.some((t) => t.id === t1.json.id) && (await T('GET', '/api/tasks?scope=done')).json.some((t) => t.id === t1.json.id));
    check('a task can be rescheduled', (await T('PUT', '/api/tasks/' + t3.json.id, { due_date: todayStr })).status === 200);
    check('a task can be deleted by its creator', (await T('DELETE', '/api/tasks/' + t3.json.id)).status === 200);

    const tlc = await T('GET', '/api/customers/' + cv.json.customer_id + '/timeline');
    check('customer timeline joins CRM activity and proposal history', tlc.status === 200 && tlc.json.some((e) => e.kind === 'activity') && tlc.json.some((e) => e.kind === 'proposal' && /accepted/.test(e.text)) && tlc.json.some((e) => e.kind === 'task'));
    check('another partner cannot read the timeline', (await A('GET', '/api/customers/' + cv.json.customer_id + '/timeline')).status === 404);

    const due = await crm.dueByUser();
    const tid = (await T('GET', '/api/auth/me')).json.id;
    await db.query('UPDATE app_users SET email = $1 WHERE id = $2', ['digest.test.' + Date.now() + '@example.com', tid]);
    const due2 = await crm.dueByUser();
    check('the daily reminder lists due work only for people with an email', !due.has(tid) && due2.has(tid) && due2.get(tid).tasks.some((t) => t.title === 'TEST send brochure'));

    const lost = await T('POST', '/api/leads', { company_name: 'Zephyr Lost ' + co });
    await T('PUT', '/api/leads/' + lost.json.id + '/stage', { stage: 'lost', reason: 'No budget this year' });
    const taken = await A('POST', '/api/leads', { company_name: 'Zephyr Lost ' + co });
    check('a lost lead releases the company', taken.status === 201);
    check('and the original cannot be reopened once someone else holds it', (await T('PUT', '/api/leads/' + lost.json.id + '/stage', { stage: 'new' })).status === 409);

    console.log('Presentations');
    check('presentations need login', (await anon('GET', '/api/presentations')).status === 401);
    const pl1 = await T('GET', '/api/presentations');
    check('partners see only the decks made available to them', pl1.status === 200 && pl1.json.installed === true && pl1.json.decks.map((d) => d.id).join() === 'workshop,tour');
    check('staff see every deck', (await S('GET', '/api/presentations')).json.decks.length >= 5);
    check('an unknown deck cannot be launched', (await T('POST', '/api/presentations/launch', { deck: 'nope' })).status === 400);
    check('a partner cannot launch a staff-only deck', (await T('POST', '/api/presentations/launch', { deck: 'frcs', client: 'Zephyr Demo' })).status === 400);
    const lh = await T('POST', '/api/presentations/launch', { deck: 'workshop', client: 'Zephyr Demo Ltd', country: 'lk', industry: 'apparel', headcount: 250, lead_id: LEAD });
    const lq = new URLSearchParams((lh.json.url || '').split('?')[1] || '');
    check('launch builds a deck address with the client and the presenter', lh.status === 200 && lh.json.url.startsWith('/present/index.html?') && lq.get('deck') === 'workshop' && lq.get('client') === 'Zephyr Demo Ltd' && lq.get('industry') === 'apparel' && lq.get('headcount') === '250' && lq.get('pco') === 'TEST Reseller Co');
    check('unknown country and industry are ignored', !new URLSearchParams(((await T('POST', '/api/presentations/launch', { deck: 'tour', client: 'Zephyr Demo', country: 'zz', industry: 'x' })).json.url || '').split('?')[1]).get('country'));
    check('the launch is remembered and appears in recent', (await T('GET', '/api/presentations')).json.recent.some((x) => x.client === 'Zephyr Demo Ltd'));
    check('presenting to a lead is logged on the lead', (await T('GET', '/api/leads/' + LEAD)).json.activities.some((a) => /Presented: Outcome Workshop/.test(a.note)));
    check('only an admin can change which decks partners may use', (await S('PUT', '/api/presentations/decks/fresh', { partner_visible: true })).status === 403);
    await admin('PUT', '/api/presentations/decks/fresh', { partner_visible: true });
    check('an admin can open a deck to partners', (await T('POST', '/api/presentations/launch', { deck: 'fresh', client: 'Zephyr Demo' })).status === 200);
    await admin('PUT', '/api/presentations/decks/fresh', { partner_visible: false });
    check('and close it again', (await T('POST', '/api/presentations/launch', { deck: 'fresh', client: 'Zephyr Demo' })).status === 400);
    const noAuth = await fetch(BASE + '/present/index.html', { redirect: 'manual' });
    check('the deck cannot be opened without signing in', noAuth.status === 302 && !/PeopleHub/.test(await noAuth.text()));
    const loginRes = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: adminPw }) });
    const ck = loginRes.headers.get('set-cookie').split(';')[0];
    const deckRes = await fetch(BASE + '/present/index.html?deck=workshop', { headers: { Cookie: ck } });
    check('a signed-in user gets the deck', deckRes.status === 200 && (await deckRes.text()).includes('<div id="root">'));

    console.log('Partner rating');
    const { score: rate, DEFAULTS: RD } = require('./rating');
    const zero = rate({ wins: 0, lost: 0, mrrWon: 0, tasksDue: 0, tasksOnTime: 0, leads: 0, proposalsSent: 0, presentations: 0, activities: 0 }, RD);
    check('a brand-new partner starts with a neutral score and is provisional', zero.total === 15 && zero.provisional && zero.label === 'Rising');
    const star = rate({ wins: 6, lost: 2, mrrWon: 9000, tasksDue: 20, tasksOnTime: 20, leads: 20, proposalsSent: 10, presentations: 8, activities: 40 }, RD);
    check('a top partner can reach the full 100', star.total >= 95 && star.label === 'Elite' && star.stars >= 4.5);
    const late = rate({ wins: 0, lost: 0, mrrWon: 0, tasksDue: 10, tasksOnTime: 0, leads: 0, proposalsSent: 0, presentations: 0, activities: 0 }, RD);
    check('missing follow-up deadlines costs points', late.parts.discipline === 0 && late.total < zero.total);
    check('win rate counts once there are enough decisions', rate({ wins: 3, lost: 0, mrrWon: 0, tasksDue: 0, tasksOnTime: 0, leads: 0, proposalsSent: 0, presentations: 0, activities: 0 }, RD).parts.winRate === 15);
    check('the parts add up to the total', Math.abs(Object.values(star.parts).reduce((a, b) => a + b, 0) - star.total) < 0.11);

    check('the leaderboard needs login', (await anon('GET', '/api/ratings/leaderboard')).status === 401);
    const lb = await T('GET', '/api/ratings/leaderboard');
    const meRow = lb.json.rows.find((x) => x.you);
    check('a partner sees the whole leaderboard, ranked', lb.status === 200 && lb.json.rows.length >= 2 && lb.json.rows.every((x, i, a) => i === 0 || a[i - 1].score >= x.score) && lb.json.rows[0].rank === 1);
    check('exactly one row is marked as yours', lb.json.rows.filter((x) => x.you).length === 1 && meRow.company === 'TEST Reseller Co');
    check('your own row has the breakdown and tips', meRow.parts && meRow.metrics && Array.isArray(meRow.hints) && meRow.metrics.presentations >= 2);
    check('other partners show only score, rank and badges', lb.json.rows.filter((x) => !x.you).every((x) => x.parts === undefined && x.metrics === undefined && x.hints === undefined));
    check('staff see the breakdown for everyone', (await S('GET', '/api/ratings/leaderboard')).json.rows.every((x) => x.parts && x.metrics));
    check('partner is told how far the next tier is', lb.json.tier && lb.json.tier.next === 'Platinum Reseller' && lb.json.tier.needed === 75);

    check('partners cannot read rating settings', (await T('GET', '/api/ratings/settings')).status === 403);
    check('invalid settings are refused', (await admin('PUT', '/api/ratings/settings', { ...RD, revenueTarget: -1 })).status === 400);
    check('an admin can tune the targets', (await admin('PUT', '/api/ratings/settings', { ...RD, pipelineTarget: 6 })).status === 200 && (await S('GET', '/api/ratings/settings')).json.pipelineTarget === 6);
    await admin('PUT', '/api/ratings/settings', RD);

    console.log('Tier suggestions');
    const catRows = (await admin('GET', '/api/categories')).json;
    const silver = catRows.find((c) => c.name === 'Silver Reseller'), goldC = catRows.find((c) => c.name === 'Gold Reseller');
    await db.query(`UPDATE partners SET category_id = $1, created_at = now() - interval '200 days' WHERE id = $2`, [silver.id, partnerId]);
    await db.query(`UPDATE partner_categories SET min_score = 1 WHERE id = $1`, [goldC.id]);
    check('suggestions are for Victory only', (await T('GET', '/api/ratings/suggestions')).status === 403);
    const sg = await admin('GET', '/api/ratings/suggestions');
    const sugg = sg.json.find((x) => x.company_name === 'TEST Reseller Co' && x.status === 'pending');
    check('a partner past the threshold is suggested for the next category', sg.status === 200 && sugg && sugg.kind === 'upgrade' && sugg.from_name === 'Silver Reseller' && sugg.to_name === 'Gold Reseller');
    check('only an admin can decide', (await S('PUT', '/api/ratings/suggestions/' + sugg.id, { action: 'approve' })).status === 403);
    check('a bad action is refused', (await admin('PUT', '/api/ratings/suggestions/' + sugg.id, { action: 'x' })).status === 400);
    check('approving moves the partner to the new category', (await admin('PUT', '/api/ratings/suggestions/' + sugg.id, { action: 'approve' })).status === 200 && (await admin('GET', '/api/partners')).json.find((p) => p.id === partnerId).category_name === 'Gold Reseller');
    check('a decided suggestion cannot be decided twice', (await admin('PUT', '/api/ratings/suggestions/' + sugg.id, { action: 'dismiss' })).status === 404);
    await db.query(`UPDATE partner_categories SET min_score = 55 WHERE id = $1`, [goldC.id]);
    await db.query(`UPDATE partner_categories SET min_score = 75 WHERE name = 'Platinum Reseller'`);

    console.log('Discount approvals');
    const pd = await B('POST', '/api/proposals', body(cB.json.id, null, qIn)); extraProposals.push(pd.json.id);
    const over = { ...qIn, discounts: [{ label: 'Special', pct: 25 }] };
    const o1 = await B('PUT', '/api/proposals/' + pd.json.id, body(cB.json.id, null, over));
    check('over the cap is refused and says what to do', o1.status === 400 && /ask Victory to approve/i.test(o1.json.error));
    check('staff do not need approval', (await S('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 50, reason: 'Because I can' })).status === 400);
    check('a request must be above the current limit', (await B('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 10, reason: 'Competitive bid' })).status === 400);
    check('a request needs a real reason', (await B('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 25, reason: 'x' })).status === 400);
    check('another partner cannot ask on this proposal', (await A('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 25, reason: 'Competitive bid against two rivals' })).status === 404);
    check('partner asks for a higher discount', (await B('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 25, reason: 'Competitive bid against two rivals' })).status === 201);
    check('only one request can wait at a time', (await B('POST', '/api/proposals/' + pd.json.id + '/discount-requests', { pct: 30, reason: 'Trying for more than that' })).status === 400);
    const apl = await admin('GET', '/api/approvals');
    const req1 = apl.json.find((x) => x.proposal_id === pd.json.id && x.status === 'pending');
    check('Victory sees the request with the partner, limit and reason', req1 && req1.requested_pct === 25 && req1.cap === 20 && /Competitive bid/.test(req1.reason));
    check('staff can see but not decide', (await S('GET', '/api/approvals')).status === 200 && (await S('PUT', '/api/approvals/' + req1.id, { action: 'approve' })).status === 403);
    check('partners cannot decide their own', (await B('PUT', '/api/approvals/' + req1.id, { action: 'approve' })).status === 403);
    check('pending count is available for the badge', (await admin('GET', '/api/approvals/summary')).json.pending >= 1);
    check('declining needs a reason', (await admin('PUT', '/api/approvals/' + req1.id, { action: 'decline' })).status === 400);
    check('an admin can grant less than was asked', (await admin('PUT', '/api/approvals/' + req1.id, { action: 'approve', approved_pct: 22 })).status === 200);
    check('a decided request cannot be decided twice', (await admin('PUT', '/api/approvals/' + req1.id, { action: 'decline', note: 'changed my mind' })).status === 404);
    check('the quote preview honours the approval for that proposal', (await B('POST', '/api/quote', { ...qIn, discounts: [{ label: 'S', pct: 22 }], proposal_id: pd.json.id })).status === 200 && (await B('POST', '/api/quote', { ...qIn, discounts: [{ label: 'S', pct: 23 }], proposal_id: pd.json.id })).status === 400 && (await B('POST', '/api/quote', { ...qIn, discounts: [{ label: 'S', pct: 22 }] })).status === 400);
    check('the proposal can be saved up to the approved discount', (await B('PUT', '/api/proposals/' + pd.json.id, body(cB.json.id, null, { ...qIn, discounts: [{ label: 'S', pct: 22 }] }))).status === 200);
    check('but not beyond it', (await B('PUT', '/api/proposals/' + pd.json.id, body(cB.json.id, null, over))).status === 400);
    check('the approval is not usable on another proposal', (await B('POST', '/api/quote', { ...qIn, discounts: [{ label: 'S', pct: 22 }], proposal_id: pw.json.id })).status === 400);
    check('the partner can read the decision', (await B('GET', '/api/proposals/' + pd.json.id + '/discount-requests')).json.requests[0].approved_pct === 22);
    check('approvals carry over to a revision', await (async () => {
      await B('PUT', '/api/proposals/' + pd.json.id + '/status', { status: 'sent' });
      const rv = await B('POST', '/api/proposals/' + pd.json.id + '/revise'); extraProposals.push(rv.json.id);
      return (await B('PUT', '/api/proposals/' + rv.json.id, body(cB.json.id, null, { ...qIn, discounts: [{ label: 'S', pct: 22 }] }))).status === 200;
    })());

    console.log('Online acceptance and commissions');
    await admin('PUT', '/api/categories/' + gold.id, { name: gold.name, partner_type: gold.partner_type, max_discount_pct: gold.max_discount_pct, sort_order: gold.sort_order, active: true, commission_pct: 10 });
    check('category commission is stored', (await admin('GET', '/api/categories')).json.find((c) => c.id === gold.id).commission_pct === 10);
    check('commission must be a sensible percentage', (await admin('PUT', '/api/categories/' + gold.id, { name: gold.name, partner_type: gold.partner_type, max_discount_pct: gold.max_discount_pct, sort_order: gold.sort_order, active: true, commission_pct: 150 })).status === 400);
    const pz = await B('POST', '/api/proposals', body(cB.json.id, null, qIn)); extraProposals.push(pz.json.id);
    await B('PUT', '/api/proposals/' + pz.json.id + '/status', { status: 'sent' });
    const tkz = (await B('POST', '/api/proposals/' + pz.json.id + '/link')).json.token;
    const acc = (b) => anon('POST', '/api/public/proposal/' + tkz + '/accept', b);
    check('acceptance needs a name', (await acc({ name: 'A', confirm: true })).status === 400);
    check('acceptance needs the authority confirmation', (await acc({ name: 'Kamal Silva' })).status === 400);
    check('an unknown link cannot accept', (await anon('POST', '/api/public/proposal/' + 'b'.repeat(64) + '/accept', { name: 'Kamal Silva', confirm: true })).status === 404);
    const ok1 = await acc({ name: 'Kamal Silva', title: 'Finance Director', confirm: true });
    check('the client accepts online', ok1.status === 200 && /^[0-9a-f]{12}$/.test(ok1.json.ref));
    check('the proposal is now accepted', (await B('GET', '/api/proposals/' + pz.json.id)).json.status === 'accepted');
    check('a second acceptance is refused', (await acc({ name: 'Someone Else', confirm: true })).status === 409);
    const pubz = await anon('GET', '/api/public/proposal/' + tkz);
    check('the web view shows who accepted and when', pubz.json.status === 'accepted' && pubz.json.acceptance.name === 'Kamal Silva' && pubz.json.acceptance.title === 'Finance Director');
    check('staff see the acceptance on the proposal', (await B('GET', '/api/proposals/' + pz.json.id)).json.acceptance.signer_name === 'Kamal Silva');
    check('the history records the online acceptance', (await B('GET', '/api/proposals/' + pz.json.id + '/timeline')).json.some((e) => /Accepted online by Kamal Silva/.test(e.note || '')));
    const cm = await B('GET', '/api/commissions');
    const mineC = cm.json.rows.find((x) => x.ref_no === pz.json.ref_no);
    check('the partner earns commission on the accepted deal', mineC && mineC.pct === 10 && mineC.status === 'pending' && Math.abs(mineC.amount - mineC.base_amount * 0.1) < 0.02);
    check('other partners cannot see it', !(await A('GET', '/api/commissions')).json.rows.some((x) => x.ref_no === pz.json.ref_no));
    check('staff can see all commissions', (await S('GET', '/api/commissions')).json.rows.some((x) => x.ref_no === pz.json.ref_no));
    check('only an admin can change a commission', (await S('PUT', '/api/commissions/' + mineC.id, { status: 'paid' })).status === 403 && (await B('PUT', '/api/commissions/' + mineC.id, { status: 'paid' })).status === 403);
    check('an admin approves then pays it', (await admin('PUT', '/api/commissions/' + mineC.id, { status: 'approved' })).status === 200 && (await admin('PUT', '/api/commissions/' + mineC.id, { status: 'paid', note: 'Paid by bank transfer' })).status === 200 && (await B('GET', '/api/commissions')).json.totals.paid > 0);
    check('an unknown commission status is refused', (await admin('PUT', '/api/commissions/' + mineC.id, { status: 'maybe' })).status === 400);
    const pz2 = await B('POST', '/api/proposals', body(cB.json.id, null, qIn)); extraProposals.push(pz2.json.id);
    await B('PUT', '/api/proposals/' + pz2.json.id + '/status', { status: 'sent' });
    await B('PUT', '/api/proposals/' + pz2.json.id + '/status', { status: 'accepted' });
    check('accepting by hand also creates the commission', (await B('GET', '/api/commissions')).json.rows.some((x) => x.ref_no === pz2.json.ref_no && x.status === 'pending'));
    await B('PUT', '/api/proposals/' + pz2.json.id + '/status', { status: 'negotiating' });
    check('reopening an accepted deal voids the unpaid commission', (await B('GET', '/api/commissions')).json.rows.find((x) => x.ref_no === pz2.json.ref_no).status === 'void');
    await admin('PUT', '/api/categories/' + gold.id, { name: gold.name, partner_type: gold.partner_type, max_discount_pct: gold.max_discount_pct, sort_order: gold.sort_order, active: true, commission_pct: 0 });
    const pz3 = await B('POST', '/api/proposals', body(cB.json.id, null, qIn)); extraProposals.push(pz3.json.id);
    await B('PUT', '/api/proposals/' + pz3.json.id + '/status', { status: 'sent' }); await B('PUT', '/api/proposals/' + pz3.json.id + '/status', { status: 'accepted' });
    check('no commission when the category pays none', !(await B('GET', '/api/commissions')).json.rows.some((x) => x.ref_no === pz3.json.ref_no));

    console.log('Co-branding, audit log and reminders');
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    check('logo must be a small PNG or JPEG', (await T('PUT', '/api/me/partner-logo', { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' })).status === 400 && (await T('PUT', '/api/me/partner-logo', { dataUrl: 'javascript:alert(1)' })).status === 400);
    check('a partner owner can set the logo', (await T('PUT', '/api/me/partner-logo', { dataUrl: PNG })).status === 200 && (await T('GET', '/api/me/profile')).json.partner.logo === PNG);
    check('staff cannot set a partner logo', (await S('PUT', '/api/me/partner-logo', { dataUrl: PNG })).status === 403);
    const lp = await T('POST', '/api/proposals', body(cv.json.customer_id, null, qIn)); extraProposals.push(lp.json.id);
    check('the logo reaches the proposal', (await T('GET', '/api/proposals/' + lp.json.id)).json.partner_logo === PNG);
    await T('DELETE', '/api/me/partner-logo');
    check('the logo can be removed', (await T('GET', '/api/me/profile')).json.partner.logo === null);

    const au = await admin('GET', '/api/audit');
    check('the audit log records sensitive actions', au.status === 200 && ['discount.approve', 'category.update', 'commission.paid', 'proposal.accepted_online'].every((a) => au.json.some((x) => x.action === a)));
    check('the audit log is for admins only', (await S('GET', '/api/audit')).status === 403 && (await B('GET', '/api/audit')).status === 403);
    check('the audit log can be searched', (await admin('GET', '/api/audit?q=commission')).json.every((x) => /commission/i.test(x.action + (x.detail || '') + (x.username || ''))));

    const short = await B('POST', '/api/proposals', body(cB.json.id, null, { ...qIn, validityDays: 2 })); extraProposals.push(short.json.id);
    await B('PUT', '/api/proposals/' + short.json.id + '/status', { status: 'sent' });
    check('proposals close to expiry are picked up for a reminder', (await crm.sendExpiryNotices(true)).some((x) => x.id === short.json.id) && !(await crm.sendExpiryNotices(true)).some((x) => x.id === pz.json.id));

    console.log('Dashboard, customer view and full presentation settings');
    check('the dashboard needs login', (await anon('GET', '/api/dashboard')).status === 401);
    const dp = await B('GET', '/api/dashboard');
    check('a partner dashboard has the business numbers', dp.status === 200 && dp.json.pipeline && typeof dp.json.pipeline.monthly === 'number' && dp.json.monthly.length === 6 && dp.json.weekly.length === 8 && dp.json.leads.length === 6 && dp.json.tasks && Array.isArray(dp.json.activity));
    check('and the partner extras, but none of the staff ones', dp.json.rating && dp.json.commissions && dp.json.pendingApprovals === undefined && dp.json.topPartners === undefined);
    const ds = await S('GET', '/api/dashboard');
    check('a staff dashboard shows approvals and top partners instead', ds.status === 200 && typeof ds.json.pendingApprovals === 'number' && Array.isArray(ds.json.topPartners) && ds.json.rating === undefined);
    check('a partner only counts their own proposals', dp.json.pipeline.count <= (await B('GET', '/api/proposals')).json.filter((p) => ['sent', 'viewed', 'negotiating'].includes(p.status)).length);
    check('the dashboard lists proposals that need chasing', Array.isArray(dp.json.hot) && dp.json.hot.every((h) => ['Hot', 'Warm', 'Cold'].includes(h.label)));

    const cl = await B('GET', '/api/customers');
    const myCust = cl.json.find((c) => c.id === cB.json.id);
    check('the customer list carries proposal counts and value', cl.status === 200 && myCust && myCust.proposal_count >= 1 && typeof myCust.open_monthly === 'number' && 'last_activity' in myCust);
    const cd = await B('GET', '/api/customers/' + cB.json.id);
    check('the customer view includes its proposals', cd.status === 200 && Array.isArray(cd.json.proposals) && cd.json.proposals.length >= 1 && cd.json.proposals[0].ref_no);
    check('another partner cannot open this customer', (await A('GET', '/api/customers/' + cB.json.id)).status === 404);

    const full = await T('POST', '/api/presentations/launch', { deck: 'workshop', client: 'Zephyr Demo Full', mode: 'settings', hrTeam: 6, agenda: 30, nav: 'wheel', theme: 'light', pains: ['payroll', 'leave', 'not-a-pain'], customPain: 'Month-end close takes a week' });
    const fq = new URLSearchParams((full.json.url || '').split('?')[1] || '');
    check('full settings open the full settings screen with everything prefilled', full.status === 200 && fq.get('launcher') === '1' && fq.get('hrTeam') === '6' && fq.get('agenda') === '30' && fq.get('nav') === 'wheel' && fq.get('theme') === 'light' && fq.get('customPain') === 'Month-end close takes a week');
    check('only real pain points are passed on', fq.get('pains') === 'payroll,leave');
    check('a partner is only offered the decks opened to them', fq.get('decks') === 'workshop,tour');
    const bad2 = new URLSearchParams(((await T('POST', '/api/presentations/launch', { deck: 'tour', client: 'Zephyr Demo', agenda: 7, nav: 'wall', theme: 'neon' })).json.url || '').split('?')[1] || '');
    check('invalid meeting length, navigation screen and theme are dropped', !bad2.get('agenda') && !bad2.get('nav') && !bad2.get('theme'));
    const stf = new URLSearchParams(((await S('POST', '/api/presentations/launch', { deck: 'frcs', client: 'Zephyr Demo' })).json.url || '').split('?')[1] || '');
    check('Victory staff are not limited to a deck list', stf.get('deck') === 'frcs' && !stf.get('decks'));
    const ops = (await T('GET', '/api/presentations')).json;
    check('the launcher can list every deck setting', ops.pains.length === 10 && ops.agendas.length >= 3 && ops.navs.workshop.length === 4);

    console.log('Implementation fee, charges and proposal sections');
    const withImpl = { ...DEFAULTS, implementation: IMPL };
    check('the price list accepts an implementation fee', (await admin('PUT', '/api/price-list', withImpl)).status === 200);
    check('milestones must add up to 100%', (await admin('PUT', '/api/price-list', { ...DEFAULTS, implementation: { ...IMPL, milestones: [{ label: 'A', pct: 50 }, { label: 'B', pct: 40 }] } })).status === 400);
    check('a negative implementation fee is refused', (await admin('PUT', '/api/price-list', { ...DEFAULTS, implementation: { ...IMPL, base: IMPL.base.map((v, i) => (i === 2 ? -5 : v)) } })).status === 400);
    const iIn = { employees: 180, adminSeats: 3, portalUsers: 100, items: ['time', 'payroll'], extraStorageGB: 0, notifications: { sms: 0, whatsapp: 0, email: 0 }, integrationHours: 5, customisations: [], billing: { type: 'subscription', term: 'monthly' }, discounts: [] };
    const q0 = (await admin('POST', '/api/quote', iIn)).json.quote;
    const il = q0.lines.find((l) => l.key === 'implementation');
    check('implementation is the base fee for the band plus each chosen module', il && il.amount === 1450 && il.parts.base === 800 && il.parts.modules.length === 2);
    check('it is paid in milestones and only the first falls due at signing', q0.implementation.schedule.map((m) => m.amount).join() === '725,435,290' && Math.abs(q0.dueAtSigning - (q0.oneTime - 1450 + 725)) < 0.011);
    check('the milestones always add up to the fee', Math.abs(q0.implementation.schedule.reduce((t, m) => t + m.amount, 0) - q0.implementation.net) < 0.006);
    check('the first-year value still counts the whole fee', Math.abs(q0.year1 - (q0.monthlyRecurring * 12 + q0.oneTime)) < 0.011);
    const q1d = (await admin('POST', '/api/quote', { ...iIn, discounts: [{ label: 'x', pct: 10 }] })).json.quote;
    check('discounts do not apply to the implementation fee', q1d.implementation.net === 1450 && q1d.implementation.schedule[0].amount === 725);
    check('rates reflect the discount', q1d.rates.notifications.sms === 0.018 && q0.rates.notifications.sms === 0.02 && q0.rates.storage.blockPrice === 5 && q0.rates.integrationHourly === 50);
    {
      const own = (await admin('POST', '/api/quote', { ...iIn, implementation: { mode: 'own', amount: 2000, scope: 'Three sites and data migration', milestones: [{ label: 'Start', pct: 40 }, { label: 'End', pct: 60 }] }, discounts: [{ label: 'x', pct: 10 }] })).json.quote;
      check('an own implementation fee replaces the guideline and is not discounted', own.implementation.net === 2000 && own.implementation.mode === 'own' && own.implementationGuideline.total === 1450);
      check('own payment parts are used', own.implementation.schedule.map((m) => m.amount).join() === '800,1200');
      check('the commission base leaves out the partner-billed implementation', Math.abs(own.year1Victory - (own.year1 - 2000)) < 0.011);
      const ag = (await admin('POST', '/api/quote', { ...iIn, implementation: { mode: 'agreed' } })).json.quote;
      check('"to be agreed" quotes no implementation line', !ag.lines.some((l) => l.key === 'implementation') && ag.implementationAgreed === true && ag.implementation === null);
      const low = (await admin('POST', '/api/quote', { ...iIn, implementation: { mode: 'own', amount: 500 } })).json.quote;
      check('a fee under half the guideline is flagged', low.implementationLow === true && own.implementationLow === false);
      check('payment parts that do not add up to 100 are refused', (await admin('POST', '/api/quote', { ...iIn, implementation: { mode: 'own', amount: 100, milestones: [{ label: 'a', pct: 50 }] } })).status === 400);
    }
    {
      const sms = require('./sms');
      check('Sri Lankan mobile numbers are normalised for the SMS gateway', ['0771234567', '+94 77 123 4567', '94771234567', '771234567'].every((n) => sms.normalize(n) === '771234567') && sms.normalize('0112345678') === null && sms.normalize('12345') === null);
      const sendNoSetup = await sms.send(['0771234567'], 'x');
      check('SMS reports a clear error when the gateway is not set up', sms.configured() || (sendNoSetup.ok === false && /not set up/.test(sendNoSetup.error)));
      const pf = await admin('PUT', '/api/me/profile', { displayName: 'Admin', email: 'admin@example.test', phone: 'abc', alertEmail: true, alertSms: true });
      check('SMS alerts need a valid mobile number', pf.status === 400);
    }
    {
      const wa = require('./whatsapp');
      check('WhatsApp numbers are normalised to the international format', ['0767444999', '+94 76 744 4999', '767444999'].every((n) => wa.toWa(n) === '94767444999') && wa.toWa('0112345678') === null);
      const waNo = await wa.send('0767444999', 'x');
      check('WhatsApp reports a clear error when it is not set up', wa.configured() || (waNo.ok === false && /not set up/.test(waNo.error)));
      check('WhatsApp alerts need a valid mobile number', (await admin('PUT', '/api/me/profile', { displayName: 'Admin', email: 'admin@example.test', phone: 'abc', alertWhatsapp: true })).status === 400);
      check('a test alert needs a known channel', (await admin('POST', '/api/me/test-alert', { channel: 'fax' })).status === 400);
    }
    {
      const push = require('./push'), tp = push.newTopic();
      check('push topics are private random names', push.validTopic(tp) && tp !== push.newTopic() && !push.validTopic('ph-123') && !push.validTopic('../x'));
      check('push refuses a missing topic', (await push.send('nope', { text: 'x' })).ok === false);
      const me0 = (await admin('GET', '/api/me/profile')).json; // the admin's real details are put back at the end
      const keep = { displayName: me0.displayName, email: me0.email, phone: me0.phone, alertEmail: me0.alertEmail, alertSms: me0.alertSms, alertWhatsapp: me0.alertWhatsapp };
      const pf = await admin('PUT', '/api/me/profile', { ...keep, alertPush: true });
      const me = (await admin('GET', '/api/me/profile')).json;
      check('turning push on creates a private topic that stays the same', pf.status === 200 && push.validTopic(me.ntfyTopic) && me.alertPush === true);
      const pf2 = await admin('PUT', '/api/me/profile', { ...keep, alertPush: me0.alertPush });
      check('turning push off keeps the topic for later', pf2.status === 200 && (await admin('GET', '/api/me/profile')).json.ntfyTopic === me.ntfyTopic);
    }
    {
      // SMS by key: the request, the success code and the error codes (stubbed; nothing is sent)
      const sms = require('./sms'), realFetch = global.fetch, before = { k: process.env.ESMS_KEY, m: process.env.ESMS_MASK, u: process.env.ESMS_USERNAME };
      process.env.ESMS_KEY = 'test-key'; process.env.ESMS_MASK = 'PeopleHub';
      let seen = null, answer = '1';
      global.fetch = async (url) => { seen = new URL(url); return { ok: true, status: 200, text: async () => answer }; };
      const ok = await sms.send(['0767444999', '+94 76 744 4999'], 'Hello there');
      const sentOk = ok.ok === true && seen.searchParams.get('esmsqk') === 'test-key' && seen.searchParams.get('list') === '767444999' && seen.searchParams.get('message') === 'Hello there' && seen.searchParams.get('source_address') === 'PeopleHub';
      answer = '2008'; const poor = await sms.send(['0767444999'], 'x');
      answer = '2007'; const bad = await sms.send(['0767444999'], 'x');
      answer = '2999'; const odd = await sms.send(['0767444999'], 'x');
      global.fetch = realFetch;
      for (const [k, key] of [['k', 'ESMS_KEY'], ['m', 'ESMS_MASK'], ['u', 'ESMS_USERNAME']]) { if (before[k] === undefined) delete process.env[key]; else process.env[key] = before[k]; }
      check('SMS by key: builds the request and reads the success code', sentOk);
      check('SMS by key: explains an empty wallet, a bad key and an unknown code', /wallet/i.test(poor.error) && /key is not valid/i.test(bad.error) && /2999/.test(odd.error));
    }
    {
      // the customer's logo for the proposal cover
      const cust = (await admin('GET', '/api/customers')).json[0];
      if (cust) {
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const put = await admin('PUT', '/api/customers/' + cust.id + '/logo', { dataUrl: png });
        const got = (await admin('GET', '/api/customers/' + cust.id)).json;
        check('a customer logo can be saved and is returned with the customer', put.status === 200 && got.logo === png);
        check('a customer logo must be a small PNG or JPEG', (await admin('PUT', '/api/customers/' + cust.id + '/logo', { dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' })).status === 400 && (await admin('PUT', '/api/customers/' + cust.id + '/logo', { dataUrl: 'data:image/png;base64,' + 'A'.repeat(210000) })).status === 400);
        const del = await admin('DELETE', '/api/customers/' + cust.id + '/logo');
        check('a customer logo can be removed', del.status === 200 && (await admin('GET', '/api/customers/' + cust.id)).json.logo === null);
      }
    }
    {
      // the price of every module for this company size, shown to the client
      const base = (await admin('POST', '/api/quote', { ...qIn, discounts: [] })).json.quote;
      const disc = (await admin('POST', '/api/quote', { ...qIn, discounts: [{ label: 'x', pct: 10 }] })).json.quote;
      const mpBase = base.modulePrices || [], mpDisc = disc.modulePrices || [];
      const t0 = mpBase.find((m) => m.id === 'time'), t1 = mpDisc.find((m) => m.id === 'time');
      check('module prices list every module and add-on, with the core price', mpBase.length >= 10 && base.corePrice > 0 && mpBase.every((m) => ['module', 'addon'].includes(m.group)));
      check('module prices carry the proposal discount and mark what is included', t0 && t1 && Math.abs(t1.price - t0.price * 0.9) < 0.006 && t0.included === qIn.items.includes('time'));
      const proposalId = (await admin('GET', '/api/proposals')).json.find((p) => !p.incomplete);
      if (proposalId) {
        const saved = (await admin('GET', '/api/proposals/' + proposalId.id)).json;
        check('an older proposal gets module prices filled in without changing its saved figures', Array.isArray(saved.totals.modulePrices) && saved.totals.modulePrices.length >= 10);
      }
    }
    {
      // the Users page: create admin, staff and partner logins; edit; switch off; reset passwords
      const A2 = require('./auth');
      const hashOf = async (name) => (await db.query('SELECT password_hash, must_change_password, role, active, partner_role FROM app_users WHERE username = $1', [name])).rows[0];
      let partnerId = null;
      try {
        const st = await admin('POST', '/api/users', { role: 'staff', username: 'zz.staff.test', displayName: 'Z Staff', email: 'zz.staff@example.test' });
        const row = await hashOf('zz.staff.test');
        check('an admin can create a staff login', st.status === 201 && !!st.json.temporaryPassword && row.role === 'staff' && row.must_change_password === true && A2.checkPassword(st.json.temporaryPassword, row.password_hash));
        check('usernames, roles and weak passwords are checked', (await admin('POST', '/api/users', { role: 'staff', username: 'zz.staff.test' })).status === 400 && (await admin('POST', '/api/users', { role: 'boss', username: 'zz.other' })).status === 400 && (await admin('POST', '/api/users', { role: 'staff', username: 'zz.weak', password: 'short' })).status === 400 && (await admin('POST', '/api/users', { role: 'staff', username: 'Bad Name!' })).status === 400);
        const ad = await admin('POST', '/api/users', { role: 'admin', username: 'zz.admin.test', password: 'a-long-password-1' });
        const adRow = await hashOf('zz.admin.test');
        check('an admin can create another admin with a password they type', ad.status === 201 && ad.json.temporaryPassword === null && adRow.role === 'admin' && A2.checkPassword('a-long-password-1', adRow.password_hash));
        const cat = (await admin('GET', '/api/categories')).json[0];
        partnerId = (await admin('POST', '/api/partners', { company_name: 'ZZ Test Co', category_id: cat.id })).json.id;
        check('a partner login needs a company', (await admin('POST', '/api/users', { role: 'partner', username: 'zz.partner.a' })).status === 400);
        const p1 = await admin('POST', '/api/users', { role: 'partner', username: 'zz.partner.a', partnerId, partnerRole: 'member' });
        const p2 = await admin('POST', '/api/users', { role: 'partner', username: 'zz.partner.b', partnerId, partnerRole: 'owner' });
        const p3 = await admin('POST', '/api/users', { role: 'partner', username: 'zz.partner.c', partnerId });
        const pa = await hashOf('zz.partner.a'), pc = await hashOf('zz.partner.c');
        check('the first login of a company becomes its owner, and a company has one owner', p1.status === 201 && pa.partner_role === 'owner' && p2.status === 400 && p3.status === 201 && pc.partner_role === 'member');
        const list = (await admin('GET', '/api/users')).json;
        const stId = list.users.find((u) => u.username === 'zz.staff.test').id;
        check('the user list shows everyone with their company', list.users.length >= 5 && list.users.some((u) => u.username === 'zz.partner.a' && u.company_name === 'ZZ Test Co') && list.partners.some((p) => p.id === partnerId));
        check('a partner cannot see or manage users', (await T('GET', '/api/users')).status === 403 && (await T('POST', '/api/users', { role: 'admin', username: 'zz.sneaky' })).status === 403);
        const ed = await admin('PUT', '/api/users/' + stId, { displayName: 'Z Staffer', email: 'zz.staff2@example.test', phone: '0771234567', role: 'admin' });
        check('an admin can edit a user and change staff to admin', ed.status === 200 && (await hashOf('zz.staff.test')).role === 'admin');
        check('you cannot change your own role or switch yourself off', (await admin('PUT', '/api/users/' + list.me, { role: 'staff' })).status === 400 && (await admin('PUT', '/api/users/' + list.me + '/active', { active: false })).status === 400);
        const t1 = await admin('POST', '/api/users/' + stId + '/temporary-password');
        const afterTemp = await hashOf('zz.staff.test');
        check('a temporary password replaces the old one and must be changed', t1.status === 200 && A2.checkPassword(t1.json.temporaryPassword, afterTemp.password_hash) && afterTemp.must_change_password === true);
        check('an admin can type a new password, which must be long enough', (await admin('POST', '/api/users/' + stId + '/set-password', { password: 'short' })).status === 400 && (await admin('POST', '/api/users/' + stId + '/set-password', { password: 'another-long-password-2' })).status === 200 && A2.checkPassword('another-long-password-2', (await hashOf('zz.staff.test')).password_hash));
        const noMail = await admin('POST', '/api/users', { role: 'staff', username: 'zz.nomail.test' });
        check('a reset link needs an email address on the login', noMail.status === 201 && (await admin('POST', '/api/users/' + noMail.json.id + '/send-reset-link')).status === 400);
        const off = await admin('PUT', '/api/users/' + stId + '/active', { active: false });
        const offRow = await hashOf('zz.staff.test');
        const on = await admin('PUT', '/api/users/' + stId + '/active', { active: true });
        check('a login can be switched off and on again', off.status === 200 && offRow.active === false && on.status === 200 && (await hashOf('zz.staff.test')).active === true);
      } finally {
        await db.query("DELETE FROM app_users WHERE username LIKE 'zz.%'");
        if (partnerId) await db.query('DELETE FROM partners WHERE id = $1', [partnerId]);
      }
    }
    {
      // a sent proposal appears on the lead board
      let custId = null;
      try {
        const cu = await admin('POST', '/api/customers', { name: 'ZZ Board Test Ltd', industry: 'Testing' });
        custId = cu.json.id;
        await admin('POST', '/api/customers/' + custId + '/contacts', { name: 'Zed Tester', title: 'HR', email: 'zed@zzboardtest.example', phone: '0771110000' });
        const pr = await admin('POST', '/api/proposals', { customer_id: custId, input: { ...qIn } });
        const before = (await db.query('SELECT count(*)::int AS n FROM leads WHERE customer_id = $1', [custId])).rows[0].n;
        await admin('PUT', '/api/proposals/' + pr.json.id + '/status', { status: 'sent' });
        const lead = (await db.query('SELECT stage, source, employees, est_value, partner_id FROM leads WHERE customer_id = $1', [custId])).rows;
        check('a sent proposal is added to the lead board in the Proposal stage', before === 0 && lead.length === 1 && lead[0].stage === 'proposal' && lead[0].source === 'proposal' && lead[0].employees === qIn.employees && Number(lead[0].est_value) > 0);
        await admin('PUT', '/api/proposals/' + pr.json.id + '/status', { status: 'negotiating' });
        check('sending or updating again does not add a second lead', (await db.query('SELECT count(*)::int AS n FROM leads WHERE customer_id = $1', [custId])).rows[0].n === 1);
        await db.query('DELETE FROM leads WHERE customer_id = $1', [custId]);
        const back = await require('./crm').ensureLeadForProposal(custId); // the start-up backfill runs exactly this for each customer
        check('a customer with a sent proposal but no lead gets one', back > 0 && (await db.query('SELECT count(*)::int AS n FROM leads WHERE customer_id = $1', [custId])).rows[0].n === 1);
      } finally {
        if (custId) {
          await db.query('DELETE FROM crm_activities WHERE lead_id IN (SELECT id FROM leads WHERE customer_id = $1) OR customer_id = $1', [custId]);
          await db.query('DELETE FROM leads WHERE customer_id = $1', [custId]);
          await db.query('DELETE FROM proposals WHERE customer_id = $1', [custId]);
          await db.query('DELETE FROM customers WHERE id = $1', [custId]);
        }
      }
    }
    const pv = await T('GET', '/api/price-list');
    check('a partner sees the implementation guideline at full value', pv.json.data.implementation.base[2] === 800);

    // proposal sections
    const lib = await T('GET', '/api/proposal-sections');
    check('the section library is available with all 26 sections and 28 modules', lib.status === 200 && lib.json.sections.length === 26 && lib.json.pillars.reduce((n, p) => n + p.modules.length, 0) === 28);
    check('the owner of a partner can edit, staff cannot', lib.json.editable === true && (await S('GET', '/api/proposal-sections')).json.editable === false);
    check('only text sections can be edited', (await T('PUT', '/api/proposal-sections/invest', { body: 'Hello there' })).status === 404 && (await T('PUT', '/api/proposal-sections/nope', { body: 'Hello there' })).status === 404);
    check('staff cannot change the wording', (await S('PUT', '/api/proposal-sections/about', { body: 'Staff text' })).status === 403);
    check('empty or oversized text is refused', (await T('PUT', '/api/proposal-sections/about', { body: ' ' })).status === 400 && (await T('PUT', '/api/proposal-sections/about', { body: 'x'.repeat(12001) })).status === 400);
    check('a partner saves their own wording', (await T('PUT', '/api/proposal-sections/about', { title: 'About TEST Reseller', body: 'We are {{company}} and we serve {{client}}.' })).status === 200);
    const mine1 = (await T('GET', '/api/proposal-sections')).json.sections.find((x) => x.key === 'about');
    check('it shows as theirs, and other partners and Victory do not see it', mine1.custom === 'partner' && mine1.title === 'About TEST Reseller' && (await B('GET', '/api/proposal-sections')).json.sections.find((x) => x.key === 'about').custom === null && (await S('GET', '/api/proposal-sections')).json.sections.find((x) => x.key === 'about').custom === null);
    check('an admin can change the default for everyone', (await admin('PUT', '/api/proposal-sections/challenge', { body: 'Victory wording for everyone about the challenge.' })).status === 200 && (await B('GET', '/api/proposal-sections')).json.sections.find((x) => x.key === 'challenge').custom === 'victory');

    // saved with the wording and style it was written with
    const dIn = { ...iIn, style: 'comprehensive', excluded: ['compare', 'invest'] };
    const pd2 = await T('POST', '/api/proposals', body(cv.json.customer_id, null, dIn)); extraProposals.push(pd2.json.id);
    const sd = (await T('GET', '/api/proposals/' + pd2.json.id)).json;
    check('a proposal keeps its style and the sections switched off', sd.doc.style === 'comprehensive' && sd.doc.excluded.join() === 'compare' && sd.doc.sections.length === 26 && sd.doc.pillars.length === 5);
    check('the proposal carries the partner wording at the time of saving', sd.doc.sections.find((x) => x.key === 'about').body.startsWith('We are {{company}}'));
    await T('PUT', '/api/proposals/' + pd2.json.id + '/status', { status: 'sent' });
    await T('PUT', '/api/proposal-sections/about', { body: 'Changed after sending.' });
    check('a sent proposal keeps the old wording after the library is edited', (await T('GET', '/api/proposals/' + pd2.json.id)).json.doc.sections.find((x) => x.key === 'about').body.startsWith('We are {{company}}'));
    const rv2 = await T('POST', '/api/proposals/' + pd2.json.id + '/revise'); extraProposals.push(rv2.json.id);
    check('a revision keeps the style of the original', (await T('GET', '/api/proposals/' + rv2.json.id)).json.doc.style === 'comprehensive');
    const lk2 = (await T('POST', '/api/proposals/' + pd2.json.id + '/link')).json;
    check('the client page receives the saved wording', (await anon('GET', '/api/public/proposal/' + lk2.token)).json.doc.style === 'comprehensive');
    check('going back to the standard wording works', (await T('DELETE', '/api/proposal-sections/about')).status === 200 && (await T('GET', '/api/proposal-sections')).json.sections.find((x) => x.key === 'about').custom === null);
    await admin('DELETE', '/api/proposal-sections/challenge');

    // the document builder, run the way the browser runs it
    const win = {}; new Function('window', fs.readFileSync(path.join(__dirname, '..', 'tool', 'doc.js'), 'utf8'))(win);
    const ctxFor = (doc, quote) => ({ quote, input: dIn, validity: 30, customer: { name: 'Acme Garments' }, contact: { name: 'Nimal' }, ref: 'VI-PH-TEST', createdAt: Date.now(), catalog: { coreFeatures: ['Employee Management'], items: [{ id: 'time', name: 'Time and Attendance', group: 'module' }, { id: 'payroll', name: 'Payroll', group: 'module' }, { id: 'tickets', name: 'Ticketing', group: 'addon' }, { id: 'grievance', name: 'Grievance', group: 'addon' }, { id: 'recruit', name: 'Recruitment', group: 'module' }] }, presentedBy: 'TEST Reseller', doc });
    const docBase = { ...sd.doc, excluded: [] };
    const hSum = win.PHDoc.html(ctxFor({ ...docBase, style: 'summary' }, q0)), hStd = win.PHDoc.html(ctxFor({ ...docBase, style: 'standard' }, q0)), hCmp = win.PHDoc.html(ctxFor({ ...docBase, style: 'comprehensive' }, q0));
    const secs = (h) => (h.match(/data-sec="/g) || []).length;
    check('summary is short, standard longer, comprehensive longest', secs(hSum) < secs(hStd) && secs(hStd) < secs(hCmp) && !hSum.includes('Contents') && hStd.includes('Contents') && hCmp.includes('Contents'));
    check('comprehensive shows every one of the 28 modules', (hCmp.match(/class="mod /g) || []).length === 28 && (hStd.match(/class="mod /g) || []).length === 28 && !hSum.includes('class="mod '));
    check('modules in the proposal are highlighted and the rest are marked optional', (hCmp.match(/class="mod in"/g) || []).length >= 3 && hCmp.includes('Optional add-on') && hCmp.includes('Included with Core HR'));
    check('the document shows the implementation fee, its schedule and the charges at a glance', hStd.includes('Implementation') && hStd.includes('At go-live') && hStd.includes('Charges at a glance') && hStd.includes('$0.02 each'));
    check('the platform fee wording replaces the old one', hStd.includes('Platform fee') && !hStd.includes('Minimum platform fee'));
    check('switched-off sections disappear but required ones stay', !win.PHDoc.html(ctxFor({ ...docBase, style: 'comprehensive', excluded: ['compare', 'roi'] }, q0)).includes('How PeopleHub compares') && win.PHDoc.html(ctxFor({ ...docBase, style: 'comprehensive', excluded: ['invest', 'accept'] }, q0)).includes('data-sec="invest"'));
    check('placeholders are filled in and text is escaped', win.PHDoc.fmt('Hello {{client}} <b>', { client: 'A & B' }).includes('A &amp; B') && win.PHDoc.fmt('Hello <b>', {}).includes('&lt;b&gt;'));
    check('an old proposal with no saved wording still renders', win.PHDoc.html(ctxFor(null, q0)).includes('data-sec="invest"'));
  } catch (e) {
    failed++; console.log('  ERROR ' + e.message);
  } finally {
    // The tests publish their own price list. Put the real one back FIRST, whatever else goes wrong below.
    let restored = false;
    try {
      if (origList) {
        await db.query('UPDATE price_lists SET is_current = FALSE WHERE is_current');
        await db.query('UPDATE price_lists SET is_current = TRUE WHERE id = $1', [origList.id]);
        restored = true;
      }
    } catch (e) { console.log('  !! COULD NOT RESTORE THE PRICE LIST: ' + e.message); }
    await db.query('DELETE FROM audit_log WHERE created_at >= $1', [t0]).catch(() => {});
    await db.query("DELETE FROM section_overrides WHERE updated_by IN (SELECT id FROM app_users WHERE username LIKE 'test.%') OR partner_id IN (SELECT id FROM partners WHERE company_name LIKE 'TEST%') OR body LIKE 'Victory wording for everyone%'");

    await db.query("DELETE FROM presentation_launches WHERE client LIKE 'Zephyr%'");
    await db.query("DELETE FROM tasks WHERE title LIKE 'TEST %'");
    await db.query("DELETE FROM leads WHERE company_name LIKE 'Zephyr%' OR company_name LIKE 'Free Mail Co%' OR company_name = 'Different Name Co' OR company_name = 'Another Name Co'");
    await db.query("DELETE FROM proposals WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zephyr%')");
    if (extraProposals.length) await db.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [extraProposals]);
    await db.query('DELETE FROM proposal_counters WHERE NOT EXISTS (SELECT 1 FROM proposals)');
    // sending a proposal now puts its customer on the lead board, so those leads go first
    await db.query("DELETE FROM crm_activities WHERE customer_id = ANY($1::int[]) OR lead_id IN (SELECT id FROM leads WHERE customer_id = ANY($1::int[]))", [extraCustomers]).catch(() => {});
    await db.query('DELETE FROM leads WHERE customer_id = ANY($1::int[])', [extraCustomers]).catch(() => {});
    await db.query("DELETE FROM crm_activities WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zephyr%') OR lead_id IN (SELECT id FROM leads WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zephyr%'))").catch(() => {});
    await db.query("DELETE FROM leads WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'Zephyr%')").catch(() => {});
    for (const id of extraCustomers) await db.query('DELETE FROM customers WHERE id = $1', [id]);
    await db.query("DELETE FROM customers WHERE name LIKE 'Zephyr%'");
    await db.query("DELETE FROM app_users WHERE username LIKE 'test.staff.%'");
    for (const id of extraPartners) { await db.query('DELETE FROM app_users WHERE partner_id = $1', [id]); await db.query('DELETE FROM partners WHERE id = $1', [id]); }
    if (partnerId) {
      await db.query('DELETE FROM app_users WHERE partner_id = $1', [partnerId]);
      await db.query('DELETE FROM partners WHERE id = $1', [partnerId]);
    }
    if (origList && restored) await db.query('DELETE FROM price_lists WHERE id > $1 AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.price_list_id = price_lists.id)', [origList.id]).catch(() => {});
    await db.end();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
