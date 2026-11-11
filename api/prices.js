// Proposals saved before module prices existed carry no price list for the client. Work it out again from the price list the proposal
// was made with and add only that part; every saved figure stays exactly as it was.
const db = require('./db');
const { readInput, compute } = require('./quote');

async function withModulePrices(totals, selections, priceListId) {
  if (!totals || totals.modulePrices) return totals;
  try {
    const { rows } = await db.query('SELECT data FROM price_lists WHERE id = $1', [priceListId]);
    if (!rows[0]) return totals;
    const read = readInput(rows[0].data, selections);
    if (read.error) return totals;
    const q = compute(rows[0].data, read.input);
    return { ...totals, modulePrices: q.modulePrices, corePrice: q.corePrice };
  } catch (e) { return totals; }
}

module.exports = { withModulePrices };
