// Usage in server.js (after app = express()):
//   require('./amc-server')(app, express, yourAdminAuthMiddleware);
// yourAdminAuthMiddleware = the same check you already use for /admin pages.
const fs = require('fs');
const path = require('path');

module.exports = function (app, express, requireAdmin) {
  const dir = path.join(__dirname, 'data');
  const PRICING = path.join(dir, 'amc-pricing.json');
  const PRICING_FALLBACK = path.join(__dirname, 'public', 'amc-pricing.json');
  const QUOTES = path.join(dir, 'amc-quotes.json');
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const write = (f, v) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
  const clamp = (v, min, max) => { v = parseFloat(v); return isNaN(v) ? min : Math.max(min, Math.min(max, v)); };

  // Recompute the payable amount from the saved prices (same maths as amc.html), so the browser cannot change the price.
  // Returns a whole-rupee total, or null if the request does not match the price list.
  function priceFor(b) {
    const P = read(PRICING, null) || read(PRICING_FALLBACK, null);
    if (!P || !P.config) return null;
    const C = P.config, T = P[b.type];
    if (!T || !T.categories) return null;
    if (b.mode === 'trial') {
      const p = (T.plans || []).find(x => x.name === b.plan);
      return p ? Math.round(p.monthly * (1 + C.gstPct / 100)) : null;
    }
    if (b.mode === 'custom') {
      const s = b.spec || {};
      const pt = T.propertyTypes.find(x => x.id === s.property);
      const sla = T.emergency.find(x => x.id === s.sla);
      const months = Number(s.months);
      if (!pt || !sla || !(C.durations || []).includes(months) || !s.services || typeof s.services !== 'object') return null;
      const area = clamp(s.area, 100, 100000), floors = clamp(s.floors, 1, 30), outlets = clamp(s.outlets, 1, 50);
      const af = Math.max(0.7, Math.min(3, 0.4 + 0.6 * area / T.areaBase)), ff = 1 + 0.05 * (floors - 1), of = T.outlets ? outlets : 1;
      let n = 0, base = 0;
      for (const c of T.categories) {
        const f = s.services[c.id];
        if (!f) continue;
        if (!C.frequencies[f]) return null;
        const v = Math.max(1, Math.round(C.frequencies[f].visits * months / 12));
        n++; base += v * c.perVisit * pt.mult * af * ff * of;
      }
      if (!n) return null;
      const em = sla.price * months / 12, disc = s.upfront ? base * C.advanceDiscountPct / 100 : 0;
      const taxable = base + em - disc;
      return Math.round(taxable + taxable * C.gstPct / 100);
    }
    return null;
  }

  // Public: latest prices (404 means the page falls back to public/amc-pricing.json)
  app.get('/api/amc-pricing', (req, res) => {
    const d = read(PRICING, null);
    d ? res.json(d) : res.status(404).json({});
  });

  // Admin only: save prices
  app.put('/api/amc-pricing', requireAdmin, express.json({ limit: '1mb' }), (req, res) => {
    const b = req.body;
    if (!b || !b.config || !b.residential || !b.cafe || !b.office) return res.status(400).json({ error: 'Invalid pricing data' });
    write(PRICING, b);
    res.json({ ok: true });
  });

  // Public: customer books a plan (trial or annual/custom) and chooses how to pay
  app.post('/api/amc-quotes', express.json({ limit: '100kb' }), (req, res) => {
    const b = req.body || {}, c = b.customer || {};
    const phone = String(c.phone || '').replace(/\D/g, '').slice(-10);
    if (!c.name || phone.length !== 10 || !c.address) return res.status(400).json({ error: 'Please enter name, 10-digit mobile and address.' });
    const date = String(b.preferredDate || '');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return res.status(400).json({ error: 'Please choose a valid preferred start date.' });
    const method = ['upi', 'bank', 'cash'].includes(b.method) ? b.method : null;
    if (!method) return res.status(400).json({ error: 'Please choose a payment method.' });
    const utr = String(b.utr || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
    if (method === 'bank' && utr.length < 6) return res.status(400).json({ error: 'Please enter the transaction / UTR number of your transfer.' });
    const total = priceFor(b);
    if (total === null) return res.status(400).json({ error: 'This plan could not be priced. Please refresh the page and try again.' });
    const lat = Number(b.location && b.location.lat), lng = Number(b.location && b.location.lng);
    const location = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
    const all = read(QUOTES, []);
    const id = 'AMC' + String(all.length + 1).padStart(4, '0');
    all.push({
      id, at: new Date().toISOString(), type: b.type, mode: b.mode, plan: b.plan, spec: b.spec,
      total, preferredDate: date, location,
      payment: { method, status: 'pending', utr: utr || undefined },
      customer: { name: String(c.name).slice(0, 80), phone, email: String(c.email || '').slice(0, 80), address: String(c.address).slice(0, 300) }
    });
    write(QUOTES, all);
    res.json({ id, total, method, message: 'Booking received.' });
  });

  // Admin only: list bookings
  app.get('/api/amc-quotes', requireAdmin, (req, res) => res.json(read(QUOTES, [])));

  // Admin only: mark a booking as paid / pending after you check the payment
  app.patch('/api/amc-quotes/:id', requireAdmin, express.json({ limit: '10kb' }), (req, res) => {
    const status = req.body && req.body.status;
    if (!['paid', 'pending'].includes(status)) return res.status(400).json({ error: 'status must be paid or pending' });
    const all = read(QUOTES, []), q = all.find(x => x.id === req.params.id);
    if (!q) return res.status(404).json({ error: 'Not found' });
    q.payment = Object.assign({}, q.payment, { status, updatedAt: new Date().toISOString() });
    write(QUOTES, all);
    res.json({ ok: true });
  });
};
