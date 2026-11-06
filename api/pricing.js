const round = (n, dp) => { const f = Math.pow(10, dp); return Math.round(n * f) / f; };

// Structural check only: the page owns the full shape, the API just refuses obviously broken documents.
function validatePriceList(d) {
  if (!d || typeof d !== 'object') return 'Price list must be an object';
  if (d.version !== 4) return 'Unsupported price list version';
  if (!Array.isArray(d.bands) || d.bands.length < 1 || d.bands.length > 12) return 'bands must be a list of 1–12 bands';
  if (!Array.isArray(d.factors) || d.factors.length !== d.bands.length) return 'factors must match bands';
  if (!Array.isArray(d.seats) || d.seats.length !== d.bands.length) return 'seats must match bands';
  if (!Array.isArray(d.portal) || d.portal.length !== d.bands.length) return 'portal must match bands';
  if (!Array.isArray(d.groups) || !Array.isArray(d.items)) return 'groups and items are required';
  const core = d.items.filter((i) => i.group === 'core');
  if (core.length !== 1) return 'Exactly one Core HR item is required';
  const nums = [];
  d.items.forEach((i) => nums.push(i.base));
  d.factors.forEach((f) => nums.push(f));
  d.portal.forEach((p) => nums.push(p));
  nums.push(d.extraSeat, d.integrationHourly, d.developmentHourly);
  if (d.wdmsPerDevice !== undefined) nums.push(d.wdmsPerDevice);
  if (d.storage) nums.push(d.storage.blockPrice, d.storage.freeMBPerEmployee, d.storage.blockGB);
  if (d.notify) Object.values(d.notify).forEach((v) => nums.push(v));
  Object.values(d.overrides || {}).forEach((v) => nums.push(v));
  if (d.perpetual) nums.push(d.perpetual.multiplier, d.perpetual.maintenancePct);
  if (d.implementation) {
    const im = d.implementation;
    if (!Array.isArray(im.base) || im.base.length !== d.bands.length) return 'Implementation base fees must match the bands';
    if (im.perModule && typeof im.perModule !== 'object') return 'Implementation module fees are not valid';
    im.base.forEach((v) => nums.push(v));
    Object.values(im.perModule || {}).forEach((v) => nums.push(v));
    if (im.milestones !== undefined) {
      if (!Array.isArray(im.milestones) || im.milestones.length < 1 || im.milestones.length > 6) return 'Implementation payments need 1 to 6 milestones';
      if (im.milestones.some((m) => !m || typeof m.label !== 'string' || !m.label.trim() || m.label.length > 40 || typeof m.pct !== 'number' || !(m.pct > 0))) return 'Each implementation milestone needs a name and a percentage';
      if (Math.abs(im.milestones.reduce((s, m) => s + m.pct, 0) - 100) > 0.01) return 'Implementation milestones must add up to 100%';
    }
  }
  for (const n of nums) {
    if (n === null || n === undefined) continue;
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return 'Prices must be zero or positive numbers';
  }
  return null;
}

// Applies a partner's category discount to every price except Core HR (the non-discountable minimum fee).
// Done on the server so a partner never receives the undiscounted list.
function applyDiscount(data, pct) {
  const out = JSON.parse(JSON.stringify(data));
  const f = 1 - (Number(pct) || 0) / 100;
  const coreIds = new Set(out.items.filter((i) => i.group === 'core').map((i) => i.id));
  out.items.forEach((i) => { if (!coreIds.has(i.id) && i.base != null) i.base = round(i.base * f, 4); });
  Object.keys(out.overrides || {}).forEach((k) => {
    if (!coreIds.has(k.split('|')[0])) out.overrides[k] = round(out.overrides[k] * f, 4);
  });
  out.extraSeat = round(out.extraSeat * f, 4);
  out.portal = out.portal.map((p) => (p == null ? null : round(p * f, 4)));
  if (out.storage) out.storage.blockPrice = round(out.storage.blockPrice * f, 4);
  if (out.notify) Object.keys(out.notify).forEach((k) => { out.notify[k] = round(out.notify[k] * f, 6); });
  // The implementation guideline is not part of the partner discount: partners see it at full value.
  out.integrationHourly = round(out.integrationHourly * f, 4);
  out.developmentHourly = round(out.developmentHourly * f, 4);
  return out;
}

module.exports = { validatePriceList, applyDiscount };
