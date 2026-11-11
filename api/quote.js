// Server-side quote engine. Always prices from the current BASE price list; discounts are applied here, never by the browser.
const r2 = (n) => Math.round(n * 100) / 100;
const TERMS = { monthly: 1, annual: 12, '2yr': 24, '3yr': 36 };
const DEFAULT_PERPETUAL = { multiplier: 24, maintenancePct: 20 };

function bandIndex(list, employees) {
  for (let i = 0; i < list.bands.length; i++) {
    const b = list.bands[i];
    if (employees >= b.min && (b.max === null || employees <= b.max)) return i;
  }
  return list.bands.length - 1;
}

function itemPrice(list, item, bi) {
  const o = (list.overrides || {})[item.id + '|' + bi];
  if (o !== undefined && o !== null) return o;
  const f = list.factors[bi];
  if (item.base == null || f == null) return null;
  return r2(item.base * f);
}

const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const txt = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// Checks and tidies what the wizard sent. Returns { error } or { input }.
function readInput(list, raw) {
  if (!raw || typeof raw !== 'object') return { error: 'Missing quote details' };
  const employees = int(raw.employees, 1, 1000000);
  if (employees === null) return { error: 'Number of employees must be a whole number of at least 1' };
  const adminSeats = int(raw.adminSeats ?? 0, 0, 1000);
  if (adminSeats === null) return { error: 'Administrator seats must be a whole number' };
  const portalUsers = int(raw.portalUsers ?? 0, 0, 1000000);
  if (portalUsers === null) return { error: 'Portal users must be a whole number' };
  const known = new Set(list.items.filter((i) => i.group !== 'core').map((i) => i.id));
  const items = Array.isArray(raw.items) ? [...new Set(raw.items)] : [];
  if (items.some((id) => !known.has(id))) return { error: 'Unknown module or add-on' };
  const extraStorageGB = num(raw.extraStorageGB ?? 0, 0, 100000);
  const n = raw.notifications || {};
  let sms = int(n.sms ?? 0, 0, 100000000), whatsapp = int(n.whatsapp ?? 0, 0, 100000000), email = int(n.email ?? 0, 0, 100000000);
  // Each channel is either activated or not; one that is not activated is not charged
  const en = n.enabled || {};
  const enabled = { sms: en.sms === undefined ? sms > 0 : en.sms === true, whatsapp: en.whatsapp === undefined ? whatsapp > 0 : en.whatsapp === true, email: en.email === undefined ? email > 0 : en.email === true };
  if (sms !== null && !enabled.sms) sms = 0;
  if (whatsapp !== null && !enabled.whatsapp) whatsapp = 0;
  if (email !== null && !enabled.email) email = 0;
  const integrationHours = num(raw.integrationHours ?? 0, 0, 10000);
  const wdmsDevices = int(raw.wdmsDevices ?? 0, 0, 10000);
  if (wdmsDevices === null) return { error: 'WDMS devices must be a whole number' };
  if ([extraStorageGB, sms, whatsapp, email, integrationHours].includes(null)) return { error: 'Storage, notification and hour values must be zero or more' };
  const customisations = [];
  for (const c of Array.isArray(raw.customisations) ? raw.customisations.slice(0, 20) : []) {
    const title = txt(c.title, 120), hours = num(c.hours, 0, 5000);
    if (!title && !c.details && !c.hours) continue;
    if (!title) return { error: 'Each customisation needs a title' };
    if (hours === null) return { error: 'Customisation hours must be zero or more' };
    customisations.push({ title, details: txt(c.details, 2000), hours });
  }
  // Implementation is priced by whoever builds the proposal; the price list only gives a guideline.
  let implementation = { mode: 'guideline', amount: 0, scope: '', milestones: null };
  if (raw.implementation && typeof raw.implementation === 'object') {
    const si = raw.implementation;
    const mode = ['own', 'guideline', 'agreed'].includes(si.mode) ? si.mode : 'guideline';
    const amount = si.amount === '' || si.amount == null ? 0 : num(si.amount, 0, 100000000);
    if (amount === null) return { error: 'The implementation fee must be zero or more' };
    let milestones = null;
    if (Array.isArray(si.milestones) && si.milestones.length) {
      milestones = [];
      for (const m of si.milestones.slice(0, 6)) {
        const pct = num(m.pct, 0, 100); const label = txt(m.label, 40);
        if (pct === null) return { error: 'Each implementation payment needs a percentage' };
        if (pct > 0) milestones.push({ label: label || 'Payment', pct });
      }
      if (!milestones.length) milestones = null;
      else if (Math.abs(milestones.reduce((s, m) => s + m.pct, 0) - 100) > 0.01) return { error: 'The implementation payments must add up to 100%' };
    }
    implementation = { mode, amount, scope: txt(si.scope, 1500), milestones };
  }
  const validityDays = int(raw.validityDays ?? 30, 1, 365) ?? 30;
  const style = ['summary', 'standard', 'comprehensive'].includes(raw.style) ? raw.style : 'standard';
  const excluded = (Array.isArray(raw.excluded) ? raw.excluded : []).filter((k) => typeof k === 'string' && /^[a-z]{2,20}$/.test(k)).slice(0, 40);
  const billing = raw.billing || {};
  const type = billing.type === 'perpetual' ? 'perpetual' : 'subscription';
  const term = Object.prototype.hasOwnProperty.call(TERMS, billing.term) ? billing.term : 'monthly';
  const discounts = [];
  for (const d of Array.isArray(raw.discounts) ? raw.discounts.slice(0, 8) : []) {
    const pct = num(d.pct, 0, 100);
    if (pct === null) return { error: 'Discount must be between 0 and 100' };
    if (pct > 0) discounts.push({ label: txt(d.label, 60) || 'Discount', pct });
  }
  return { input: { employees, adminSeats, portalUsers, items, extraStorageGB, notifications: { sms, whatsapp, email, enabled }, integrationHours, wdmsDevices, customisations, billing: { type, term }, discounts, style, excluded, validityDays, implementation } };
}

// Effective discount of several stacked discounts: 10% then 5% = 14.5%, not 15%.
function effectiveDiscount(discounts) {
  return r2((1 - discounts.reduce((f, d) => f * (1 - d.pct / 100), 1)) * 100);
}

function compute(list, input) {
  const bi = bandIndex(list, input.employees), band = list.bands[bi];
  const lines = [];
  const add = (key, label, detail, amount, extra) => lines.push({ key, label, detail, amount: r2(amount), ...extra });
  let custom = false;

  // Core HR: the minimum fee, never discounted
  const core = list.items.find((i) => i.group === 'core');
  const corePrice = itemPrice(list, core, bi);
  if (corePrice === null) custom = true;
  add('core', 'Core HR', 'Platform fee', corePrice || 0, { section: 'platform', discountable: false, oneTime: false });

  for (const item of list.items.filter((i) => i.group !== 'core' && input.items.includes(i.id))) {
    const p = itemPrice(list, item, bi);
    if (p === null) custom = true;
    add(item.id, item.name, item.group === 'addon' ? 'Add-on' : 'Module', p || 0, { section: 'platform', discountable: true, oneTime: false });
  }

  const included = list.seats[bi], extraSeats = Math.max(0, input.adminSeats - included);
  add('seats', 'Administrator seats', `${included} included; ${extraSeats} additional`, extraSeats * list.extraSeat, { section: 'seats', discountable: true, oneTime: false });

  const pr = list.portal[bi];
  if (input.portalUsers > 0 && pr === null) custom = true;
  add('portal', 'Employee Self-Service portal', `${input.portalUsers} named portal users (web, Android and iOS)`, input.portalUsers * (pr || 0), { section: 'portal', discountable: true, oneTime: false });

  const st = list.storage, freeGB = (b => (b.max === null ? input.employees : b.max) * st.freeMBPerEmployee / 1024)(band);
  const blocks = Math.ceil(input.extraStorageGB / (st.blockGB || 1));
  if (blocks > 0) add('storage', 'Additional storage', `${blocks} × ${st.blockGB} GB`, blocks * st.blockPrice, { section: 'usage', discountable: true, oneTime: false });

  const nt = input.notifications, nr = list.notify;
  const notif = nt.sms * nr.sms + nt.whatsapp * nr.whatsapp + nt.email * nr.email;
  const on = [nt.sms > 0 || (nt.enabled && nt.enabled.sms) ? 'SMS ' + nt.sms : '', nt.whatsapp > 0 || (nt.enabled && nt.enabled.whatsapp) ? 'WhatsApp ' + nt.whatsapp : '', nt.email > 0 || (nt.enabled && nt.enabled.email) ? 'email ' + nt.email : ''].filter(Boolean);
  if (notif > 0) add('notifications', 'Notifications (estimated)', on.join(', ') + ' per month', notif, { section: 'usage', discountable: true, oneTime: false });

  // WDMS (device server for biometric terminals): a fixed price per device each month, never discounted
  const wdmsRate = list.wdmsPerDevice != null ? list.wdmsPerDevice : 3;
  if (input.wdmsDevices > 0) add('wdms', 'WDMS configuration', `${input.wdmsDevices} device${input.wdmsDevices === 1 ? '' : 's'}`, input.wdmsDevices * wdmsRate, { section: 'usage', discountable: false, oneTime: false });

  // Implementation. The price list only gives a GUIDELINE (base fee for the size plus a fee per module).
  // The proposal carries the real fee: typed by the partner or staff member, taken from the guideline, or left to be agreed.
  const im = list.implementation;
  let guide = null;
  if (im) {
    const baseFee = im.base[bi];
    const chosen = list.items.filter((i) => i.group !== 'core' && input.items.includes(i.id)).map((i) => ({ id: i.id, name: i.name, amount: (im.perModule || {})[i.id] || 0 })).filter((m) => m.amount > 0);
    const total = (baseFee || 0) + chosen.reduce((s, m) => s + m.amount, 0);
    if (total > 0 || baseFee != null) guide = { total: r2(total), base: baseFee || 0, modules: chosen };
    if ((baseFee === null || baseFee === undefined) && im.base.some((v) => v) && (input.implementation || {}).mode === 'guideline') custom = true;
  }
  const sel = input.implementation || { mode: 'guideline', amount: 0, scope: '', milestones: null };
  const implFee = sel.mode === 'guideline' ? (guide ? guide.total : 0) : sel.mode === 'own' ? r2(sel.amount || 0) : 0;
  if (implFee > 0) {
    add('implementation', 'Implementation', 'Set-up, configuration, data migration, training and go-live support', implFee, { section: 'once', discountable: false, oneTime: true, parts: sel.mode === 'guideline' && guide ? guide : null });
  }

  if (input.integrationHours > 0) add('integration', 'Integration', `${input.integrationHours} hours`, input.integrationHours * list.integrationHourly, { section: 'once', discountable: true, oneTime: true });
  const devHours = input.customisations.reduce((s, c) => s + c.hours, 0);
  if (devHours > 0) add('development', 'Customisation / development', `${devHours} hours`, devHours * list.developmentHourly, { section: 'once', discountable: true, oneTime: true });

  const pct = effectiveDiscount(input.discounts);
  const sum = (f) => r2(lines.filter(f).reduce((s, l) => s + l.amount, 0));
  const monthlyDiscountable = sum((l) => !l.oneTime && l.discountable);
  const onceDiscountable = sum((l) => l.oneTime && l.discountable);
  const discountMonthly = r2(monthlyDiscountable * pct / 100), discountOnce = r2(onceDiscountable * pct / 100);
  const monthlyBefore = sum((l) => !l.oneTime), onceBefore = sum((l) => l.oneTime);
  const monthlyRecurring = r2(monthlyBefore - discountMonthly), oneTime = r2(onceBefore - discountOnce);

  // The implementation fee is paid in milestones; only the first falls due at signing
  const implLine = lines.find((l) => l.key === 'implementation');
  let implementation = null;
  if (implLine) {
    const net = implLine.amount; // never discounted
    const ms = sel.milestones && sel.milestones.length ? sel.milestones : (im && im.milestones && im.milestones.length ? im.milestones : [{ label: 'On signing', pct: 100 }]);
    let left = net;
    const schedule = ms.map((m, i) => { const amt = i === ms.length - 1 ? r2(left) : r2(net * m.pct / 100); left = r2(left - amt); return { label: m.label, pct: m.pct, amount: amt }; });
    implementation = { gross: implLine.amount, net, schedule, mode: sel.mode, scope: sel.scope || '', base: implLine.parts ? implLine.parts.base : 0, modules: implLine.parts ? implLine.parts.modules : [] };
  }
  const nowOnce = implementation ? r2(oneTime - implementation.net + implementation.schedule[0].amount) : oneTime;

  // Unit rates after this proposal's discount, so the client can see what extra usage costs
  const k = 1 - pct / 100, rr = (v, dp) => { const f = Math.pow(10, dp); return Math.round(v * k * f) / f; };
  const rates = {
    discountPct: pct,
    notifications: { sms: rr(list.notify.sms, 6), whatsapp: rr(list.notify.whatsapp, 6), email: rr(list.notify.email, 6) },
    storage: { includedGB: Math.round(freeGB * 10) / 10, blockGB: st.blockGB, blockPrice: rr(st.blockPrice, 4) },
    extraSeat: rr(list.extraSeat, 4), portalPerUser: pr == null ? null : rr(pr, 4),
    integrationHourly: rr(list.integrationHourly, 4), developmentHourly: rr(list.developmentHourly, 4),
    wdmsPerDevice: wdmsRate, // never discounted
  };

  // What each module and add-on costs for this company size, after this proposal's discount, so the client can see the price of what is not in the proposal too
  const kDisc = 1 - pct / 100;
  const modulePrices = list.items.filter((i) => i.group !== 'core').map((i) => {
    const p = itemPrice(list, i, bi);
    return { id: i.id, name: i.name, group: i.group, included: input.items.includes(i.id), price: p === null ? null : r2(p * kDisc), listPrice: p };
  });

  const out = {
    band: { index: bi, label: band.label }, lines, implementation, rates, modulePrices, corePrice: corePrice === null ? null : corePrice,
    implementationMode: sel.mode, implementationAgreed: !implLine, implementationScope: sel.scope || '',
    implementationGuideline: guide, implementationMilestones: (im && im.milestones && im.milestones.length ? im.milestones : [{ label: 'On signing', pct: 100 }]),
    implementationLow: !!(implLine && sel.mode === 'own' && guide && guide.total > 0 && implLine.amount < guide.total * 0.5), custom, discounts: input.discounts, discountPct: pct,
    freeStorageGB: Math.round(freeGB * 10) / 10, seatsIncluded: included,
    monthlyBeforeDiscount: monthlyBefore, discountMonthly, monthlyRecurring, oneTimeBeforeDiscount: onceBefore, discountOnce, oneTime,
    billing: { ...input.billing },
  };

  if (input.billing.type === 'subscription') {
    const months = TERMS[input.billing.term];
    const lump = months > 1 ? r2(monthlyRecurring * months) : 0;
    out.billing.months = months;
    out.billing.prepayLump = lump;
    out.dueAtSigning = r2(nowOnce + lump);
    out.year1 = r2(monthlyRecurring * 12 + oneTime);
    out.year1Victory = r2(out.year1 - (implementation ? implementation.net : 0));
  } else {
    const p = list.perpetual || DEFAULT_PERPETUAL;
    // The licence fee is based on the platform price (core, modules, add-ons, seats, portal); storage and notifications stay monthly usage.
    const platformMonthly = r2(lines.filter((l) => !l.oneTime && l.section !== 'usage').reduce((s, l) => s + l.amount, 0)
      - lines.filter((l) => !l.oneTime && l.section !== 'usage' && l.discountable).reduce((s, l) => s + l.amount, 0) * pct / 100);
    const usageMonthly = r2(monthlyRecurring - platformMonthly);
    const licence = r2(platformMonthly * p.multiplier), maintenance = r2(licence * p.maintenancePct / 100);
    out.billing = { ...out.billing, licence, maintenanceAnnual: maintenance, maintenancePct: p.maintenancePct, usageMonthly, multiplier: p.multiplier };
    out.dueAtSigning = r2(licence + nowOnce);
    out.year1 = r2(licence + maintenance + usageMonthly * 12 + oneTime);
    out.year1Victory = r2(out.year1 - (implementation ? implementation.net : 0));
  }
  return out;
}

module.exports = { readInput, compute, effectiveDiscount, TERMS, bandIndex };
