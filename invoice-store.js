// Ghar to Health - automatic invoice PDFs, saved as:
//   invoices/Invoice-2026/10-Oct/Ambulance/GTH-INV-2026-0001.pdf
//   invoices/Invoice-2026/10-Oct/General/Home Maintenance Services/GTH-INV-2026-0002.pdf
//   invoices/Invoice-2026/10-Oct/General/Medical Services/GTH-INV-2026-0003.pdf
// (year, month and category folders are created automatically)
// No npm packages needed (PDF and ZIP are both written by hand).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

module.exports = function ({ send, readBody, clean, ADMIN_KEY, readBookings, baseDir }) {
  const ROOT = path.join(baseDir, 'invoices');
  const INDEX = path.join(baseDir, 'data', 'invoices.json');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const BUSINESS = { name: 'Ghar to Health', line: 'Home Maintenance & Medical Services, Raipur, Chhattisgarh', email: 'ghartohealth@gmail.com' };

  // ---------- categories ----------
  const CAT_SUB = { ambulance: 'Ambulance', home: 'General/Home Maintenance Services', medical: 'General/Medical Services' };
  const CAT_NAME = { ambulance: 'Ambulance', home: 'Home Maintenance Services', medical: 'Medical Services' };
  const classify = b => {
    b = b || {};
    const s = (String(b.service || '') + ' ' + String(b.item || '')).toLowerCase();
    if (b.air || b.type === 'ambulance' || /ambulance|helicopter|charter/.test(s) || /^AMB/i.test(String(b.id || ''))) return 'ambulance';
    if (b.type === 'medical') return 'medical';
    return 'home';
  };

  const readIdx = () => { try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return []; } };
  const writeIdx = l => { fs.mkdirSync(path.dirname(INDEX), { recursive: true }); fs.writeFileSync(INDEX, JSON.stringify(l, null, 2)); };
  // Invoice numbers only ever go up, so deleting an invoice never lets its number be used again.
  const SEQ = path.join(baseDir, 'data', 'invoice-seq.json');
  const readSeq = () => { try { return JSON.parse(fs.readFileSync(SEQ, 'utf8')); } catch { return {}; } };
  function nextSeq(year, idx) {
    const seqs = readSeq();
    const used = idx.filter(i => i.year === year).map(i => Number(String(i.no).split('-').pop()) || 0);
    const n = Math.max(seqs[year] || 0, ...used, 0) + 1;
    seqs[year] = n;
    fs.mkdirSync(path.dirname(SEQ), { recursive: true }); fs.writeFileSync(SEQ, JSON.stringify(seqs));
    return n;
  }
  const ist = () => new Date(Date.now() + 19800000);          // India time
  const money = n => 'Rs ' + (Math.round(Number(n || 0) * 100) / 100).toFixed(2);

  // ---------- tiny PDF writer (A4, Helvetica) ----------
  function makePdf(ops) {
    const esc = s => String(s == null ? '' : s).replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
    let c = '';
    ops.forEach(o => {
      if (o.t === 'text') c += `BT /${o.b ? 'F2' : 'F1'} ${o.s || 10} Tf ${o.x} ${o.y} Td (${esc(o.v)}) Tj ET\n`;
      else if (o.t === 'line') c += `${o.w || 0.5} w ${o.x1} ${o.y1} m ${o.x2} ${o.y2} l S\n`;
      else if (o.t === 'raw') c += o.v;
      else if (o.t === 'rect') c += `${o.g} g ${o.x} ${o.y} ${o.w} ${o.h} re f 0 g\n`;
    });
    const objs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      `<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}endstream`
    ];
    let out = '%PDF-1.4\n'; const off = [];
    objs.forEach((o, i) => { off.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xr = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') +
      `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }

  function buildPdf(inv) {
    const ops = []; const T = (x, y, v, s, b) => ops.push({ t: 'text', x, y, v, s, b });
    ops.push({ t: 'rect', g: 0.15, x: 0, y: 772, w: 595, h: 70 });
    ops.push({ t: 'raw', v: `BT 1 g /F2 22 Tf 40 806 Td (${BUSINESS.name}) Tj ET BT 1 g /F1 9 Tf 40 788 Td (${BUSINESS.line}) Tj ET 0 g\n` });
    T(40, 740, 'INVOICE', 16, true);
    T(380, 740, 'Invoice No: ' + inv.no, 10, true);
    T(380, 726, 'Date: ' + inv.date, 10);
    T(380, 712, 'Booking ID: ' + inv.bookingId, 10);
    T(40, 712, 'Billed To', 10, true);
    T(40, 698, inv.name || '-', 11);
    T(40, 684, 'Phone: ' + (inv.phone || '-') + (inv.customerId ? '   |   Customer ID: ' + inv.customerId : ''), 10);
    String(inv.address || '').match(/.{1,70}/g)?.slice(0, 3).forEach((l, i) => T(40, 670 - i * 13, l, 10));
    ops.push({ t: 'rect', g: 0.9, x: 40, y: 610, w: 515, h: 20 });
    T(46, 616, 'Description', 10, true); T(330, 616, 'Qty', 10, true); T(380, 616, 'Rate', 10, true); T(470, 616, 'Amount', 10, true);
    let y = 596;
    inv.lines.forEach(l => {
      T(46, y, String(l.name).slice(0, 48), 10); T(330, y, String(l.qty), 10); T(380, y, money(l.price), 10); T(470, y, money(l.price * l.qty), 10);
      y -= 16;
    });
    ops.push({ t: 'line', x1: 40, y1: y + 8, x2: 555, y2: y + 8 }); y -= 10;
    T(380, y, 'Subtotal', 10); T(470, y, money(inv.subtotal), 10); y -= 15;
    (inv.charges || []).forEach(c => { T(380, y, String(c.label).slice(0, 22), 10); T(470, y, money(c.amount), 10); y -= 15; });
    ops.push({ t: 'line', x1: 380, y1: y + 8, x2: 555, y2: y + 8 }); y -= 8;
    T(380, y, 'TOTAL', 12, true); T(470, y, money(inv.total), 12, true); y -= 26;
    T(40, y, 'Payment: ' + (inv.payment || 'As agreed (UPI / Bank transfer / Cash)'), 10); y -= 14;
    T(40, y, 'Status: ' + (inv.status || 'Paid'), 10, true);
    T(40, 60, 'Thank you for choosing Ghar to Health. For help: ' + BUSINESS.email, 9);
    T(40, 48, 'This is a computer generated invoice and does not need a signature.', 8);
    return makePdf(ops);
  }

  // ---------- create / find ----------
  function create(b, extra = {}) {
    if (!b || !b.id) return null;
    const idx = readIdx();
    const old = idx.find(i => i.bookingId === b.id);
    if (old) return old;                                        // one invoice per booking
    const d = extra.at && Number.isFinite(Date.parse(extra.at)) ? new Date(Date.parse(extra.at) + 19800000) : ist(), year = d.getUTCFullYear(), mi = d.getUTCMonth();
    const cat = extra.cat || classify(b);
    const yearDir = 'Invoice-' + year, monthDir = String(mi + 1).padStart(2, '0') + '-' + MON[mi];
    const seq = nextSeq(year, idx);
    const no = `GTH-INV-${year}-${String(seq).padStart(4, '0')}`;
    const lines = (Array.isArray(b.items) && b.items.length ? b.items : [{ name: b.item || b.service || 'Service', price: Number(extra.amount ?? b.total) || 0, qty: 1 }])
      .map(l => ({ name: l.name, price: Number(l.price) || 0, qty: Number(l.qty) || 1 }));
    const subtotal = b.subtotal != null ? b.subtotal : lines.reduce((a, l) => a + l.price * l.qty, 0);
    const total = extra.amount != null ? Number(extra.amount) : (b.total != null ? b.total : subtotal);
    const inv = { customerId: b.customerId || '', no, year, month: mi + 1, folder: yearDir + '/' + monthDir + '/' + CAT_SUB[cat], cat, file: no + '.pdf', bookingId: b.id,
      date: d.toISOString().slice(0, 10), name: b.name || (b.customer && b.customer.name) || '', phone: b.phone || (b.customer && b.customer.phone) || '',
      address: b.address || (b.customer && b.customer.address) || '', lines, subtotal, charges: b.charges || [], total, payment: extra.payment, status: extra.status || 'Paid' };
    const dir = path.join(ROOT, inv.folder);
    fs.mkdirSync(dir, { recursive: true });                      // creates Invoice-2027, month and category folders by itself
    fs.writeFileSync(path.join(dir, inv.file), buildPdf(inv));
    fs.writeFileSync(path.join(dir, no + '.json'), JSON.stringify(Object.assign({}, inv, { service: b.service || '', category: b.category, cat }), null, 2));   // data for the new invoice.html design
    const row = { no, year, month: inv.month, folder: inv.folder, cat, file: inv.file, bookingId: b.id, name: inv.name, phone: inv.phone, total, date: inv.date };
    idx.push(row); writeIdx(idx);
    console.log('Invoice saved:', inv.folder + '/' + inv.file);
    return row;
  }

  // ---------- delete (admin) ----------
  // Removes the PDF, the .json snapshot and the index entry. Returns true if the invoice existed.
  function remove(no) {
    const idx = readIdx();
    const r = idx.find(i => i.no === no);
    if (!r) return false;
    const dir = path.join(ROOT, r.folder);
    if (!path.resolve(dir).startsWith(path.resolve(ROOT) + path.sep)) throw new Error('bad folder in index');
    [r.file, r.no + '.json'].forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; } });
    writeIdx(idx.filter(i => i.no !== no));
    for (let d = dir; path.resolve(d) !== path.resolve(ROOT); d = path.dirname(d)) { try { fs.rmdirSync(d); } catch { break; } }   // drop category / month / year folders only if now empty
    return true;
  }

  // ---------- one-time move of older invoices (Invoice-2026/10-Oct/x.pdf) into the category folders ----------
  function migrate() {
    try {
      const idx = readIdx(); let changed = false;
      let bks = []; try { bks = readBookings() || []; } catch {}
      idx.forEach(r => {
        if (r.cat && CAT_SUB[r.cat]) return;
        const cat = classify(bks.find(x => x.id === r.bookingId) || {});
        const from = path.join(ROOT, r.folder), nf = r.folder.split('/').slice(0, 2).join('/') + '/' + CAT_SUB[cat], to = path.join(ROOT, nf);
        fs.mkdirSync(to, { recursive: true });
        [r.file, r.no + '.json'].forEach(f => { try { fs.renameSync(path.join(from, f), path.join(to, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; } });
        r.folder = nf; r.cat = cat; changed = true;
      });
      if (changed) { writeIdx(idx); console.log('Invoices sorted into Ambulance / General folders.'); }
    } catch (e) { console.log('Invoice folder migration failed:', e.message); }
  }

  // ---------- ZIP export (no npm package) ----------
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = buf => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  function makeZip(files) {                                      // files: [{ name, data: Buffer }]
    const d = ist(), time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const locals = [], centrals = []; let off = 0;
    files.forEach(f => {
      const name = Buffer.from(f.name, 'utf8'), raw = f.data, comp = zlib.deflateRawSync(raw), crc = crc32(raw);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, comp);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += 30 + name.length + comp.length;
    });
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
  }
  const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  // scope: { year: 'Invoice-2026', month: '10-Oct' (optional), cat: 'ambulance' | 'general' | 'home' | 'medical' (optional) }
  function exportZip(scope) {
    const rows = readIdx().filter(r => ('Invoice-' + r.year) === scope.year
      && (!scope.month || r.folder.split('/')[1] === scope.month)
      && (!scope.cat || (scope.cat === 'general' ? r.cat !== 'ambulance' : r.cat === scope.cat)));
    if (!rows.length) return null;
    const files = [];
    rows.forEach(r => { try { files.push({ name: r.folder + '/' + r.file, data: fs.readFileSync(filePath(r)) }); } catch {} });
    const csv = ['Invoice No,Date,Booking ID,Customer,Phone,Category,Total'].concat(rows.slice().sort((a, b) => String(a.no).localeCompare(String(b.no))).map(r =>
      [r.no, r.date, r.bookingId, r.name, r.phone, CAT_NAME[r.cat] || '', Number(r.total || 0).toFixed(2)].map(csvCell).join(','))).join('\r\n');
    files.push({ name: 'invoice-summary.csv', data: Buffer.from('\ufeff' + csv, 'utf8') });
    return files.length > 1 ? makeZip(files) : null;
  }

  // ---------- data for the new invoice.html design ----------
  const r2 = n => Math.round(Number(n || 0) * 100) / 100;
  function viewOf(r) {
    let inv;
    try { inv = JSON.parse(fs.readFileSync(path.join(ROOT, r.folder, r.no + '.json'), 'utf8')); }
    catch {                                                      // older invoices (no snapshot): rebuild from the booking
      const b = readBookings().find(x => x.id === r.bookingId) || {};
      const lines = (Array.isArray(b.items) && b.items.length ? b.items : [{ name: b.service || 'Service', price: Number(r.total) || 0, qty: 1 }])
        .map(l => ({ name: l.name, price: Number(l.price) || 0, qty: Number(l.qty) || 1 }));
      inv = { no: r.no, date: r.date, bookingId: r.bookingId, name: r.name, phone: r.phone, address: b.address || '',
        lines, charges: b.charges || [], total: r.total, status: 'Paid', service: b.service || '', category: b.category };
    }
    const base = r2(inv.lines.reduce((a, l) => a + l.price * l.qty, 0));
    const charges = (inv.charges || []).map(c => ({ label: c.label, amount: r2(c.amount) }));
    const diff = r2(inv.total - base - charges.reduce((a, c) => a + c.amount, 0));   // keeps the total same as the old invoice
    if (Math.abs(diff) >= 0.01) charges.push({ label: diff > 0 ? 'Other charges' : 'Discount / adjustment', amount: diff });
    return { category: inv.category, invoiceNo: inv.no, date: inv.date + 'T12:00:00', bookingId: inv.bookingId,
      paymentMode: inv.payment || 'Pay after service', status: String(inv.status || 'Paid').toUpperCase(),
      client: { name: inv.name, mobile: inv.phone, address: inv.address }, service: inv.service || '',
      items: inv.lines.map(l => ({ label: l.name, qty: l.qty, rate: l.price })), charges, total: r2(inv.total) };
  }

  const filePath = r => path.join(ROOT, r.folder, r.file);
  const sendPdf = (res, r) => { try { const d = fs.readFileSync(filePath(r)); res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${r.file}"` }); res.end(d); } catch { send(res, 404, { error: 'Invoice file missing' }); } };

  // new design: invoice.html with this invoice's data embedded (works from a link, a button or a fetch/blob)
  const sendView = (res, r) => {
    try {
      const f = [path.join(baseDir, 'public', 'invoice.html'), path.join(baseDir, 'invoice.html')].find(x => fs.existsSync(x));
      let h = fs.readFileSync(f, 'utf8');
      const data = JSON.stringify({ invoice: viewOf(r) }).replace(/</g, '\\u003c');
      h = h.replace('<head>', '<head><base href="/"><script>window.GTH_INVOICE=' + data + ';</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h);
    } catch (e) { console.log('Invoice view failed:', e.message); sendPdf(res, r); }   // falls back to the old PDF
  };

  // ---------- API ----------
  async function handle(req, res, url) {
    const p = url.pathname, admin = req.headers['x-admin-key'] === ADMIN_KEY;
    if (p === '/api/invoice' && req.method === 'GET') {          // client download: booking ID + phone
      const id = clean(url.searchParams.get('id'), 30).toUpperCase(), ph = clean(url.searchParams.get('phone'), 15).replace(/[\s-]/g, '').slice(-10);
      const r = readIdx().find(i => i.bookingId === id && String(i.phone).slice(-10) === ph);
      if (!r) { send(res, 404, { error: 'No invoice found. Check the ID and mobile number.' }); return true; }
      const f = url.searchParams.get('format');
      if (f === 'pdf') { sendPdf(res, r); return true; }
      if (f === 'json') { send(res, 200, { invoice: viewOf(r) }); return true; }
      sendView(res, r); return true;
    }
    if (!p.startsWith('/api/admin/invoices')) return false;
    if (!admin) { send(res, 401, { error: 'Wrong admin key' }); return true; }
    if (p === '/api/admin/invoices' && req.method === 'GET') {    // tree: year -> month -> invoices
      const tree = {};
      readIdx().forEach(r => { const y = 'Invoice-' + r.year, m = r.folder.split('/')[1]; ((tree[y] = tree[y] || {})[m] = tree[y][m] || []).push(r); });
      send(res, 200, tree); return true;
    }
    if (p === '/api/admin/invoices/export' && req.method === 'GET') {   // ZIP of a year / month / category folder
      const q = k => clean(url.searchParams.get(k) || '', 40);
      const scope = { year: q('year'), month: q('month'), cat: q('cat') };
      if (!/^Invoice-\d{4}$/.test(scope.year) || (scope.month && !/^\d{2}-[A-Za-z]{3}$/.test(scope.month)) || (scope.cat && !['ambulance', 'general', 'home', 'medical'].includes(scope.cat))) { send(res, 400, { error: 'Invalid export request' }); return true; }
      let zip = null; try { zip = exportZip(scope); } catch (e) { console.log('Invoice export failed:', e.message); }
      if (!zip) { send(res, 404, { error: 'No invoices in this folder to export.' }); return true; }
      const nm = ['GharToHealth', scope.year, scope.month, scope.cat].filter(Boolean).join('-') + '.zip';
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${nm}"`, 'Content-Length': zip.length }); res.end(zip); return true;
    }
    if (p === '/api/admin/invoices/file' && req.method === 'GET') {
      const r = readIdx().find(i => i.no === clean(url.searchParams.get('no'), 40));
      if (!r) { send(res, 404, { error: 'Not found' }); return true; }
      if (url.searchParams.get('format') === 'pdf') sendPdf(res, r); else sendView(res, r);
      return true;
    }
    if (p === '/api/admin/invoices/data' && req.method === 'GET') {   // new design, admin view
      const r = readIdx().find(i => i.no === clean(url.searchParams.get('no'), 40));
      if (!r) { send(res, 404, { error: 'Not found' }); return true; }
      send(res, 200, { invoice: viewOf(r) }); return true;
    }
    if (p === '/api/admin/invoices/generate' && req.method === 'POST') {
      let b; try { b = await readBody(req); } catch { send(res, 400, { error: 'Invalid request.' }); return true; }
      const bk = readBookings().find(x => x.id === clean(b.bookingId, 30));
      if (!bk) { send(res, 404, { error: 'Booking not found' }); return true; }
      const amt = b.amount === '' || b.amount == null ? undefined : Number(b.amount);
      if (amt !== undefined && !(amt >= 0 && amt <= 1000000)) { send(res, 400, { error: 'Invalid amount' }); return true; }
      send(res, 200, { ok: true, invoice: create(bk, { amount: amt, payment: clean(b.payment, 60) || undefined }) }); return true;
    }
    return false;
  }
  migrate();
  return { create, handle, remove };
};
