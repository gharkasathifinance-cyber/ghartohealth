// Ghar to Health - phase 2 (medical booking flow, privacy, legal links).
// Put this file and the 5 files next to it (medical.html, track.html, legal.html, admin-medical.html, gth-pages.css)
// in your project folder (where server.js is), then run:  node apply-phase2.js
const fs = require('fs'), path = require('path');
const serverPath = path.join(__dirname, 'server.js');
const pub = path.join(__dirname, 'public');
const indexPath = [path.join(pub, 'index.html'), path.join(__dirname, 'index.html')].find(fs.existsSync);
if (!fs.existsSync(serverPath) || !indexPath) { console.error('server.js or index.html not found.'); process.exit(1); }

function patch(file, steps) {
  let t = fs.readFileSync(file, 'utf8');
  for (const [name, find, repl] of steps) {
    const n = t.split(find).length - 1;
    if (n !== 1) { console.error(`STOPPED: "${name}" matched ${n} times in ${path.basename(file)}. Nothing was changed.`); process.exit(1); }
    t = t.replace(find, () => repl);
  }
  return t;
}

const helper = `// Alerts for medical bookings carry NO health details, only the booking ID.
async function notifyMinimal(id) {
  try { await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers: { Title: 'New medical booking', Priority: 'high', Tags: 'hospital' }, body: 'Booking ' + id + '. Open the admin panel for details.' }); } catch (e) { console.log('Alert failed:', e.message); }
}
const SLOTS = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)'];
async function handleApi(req, res, url) {`;

const routes = `if (req.method === 'POST' && url.pathname === '/api/medical-bookings') {
    let b; try { b = await readBody(req, 20000); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const m = { service: clean(b.service, 60), item: clean(b.item, 80), name: clean(b.name, 80), phone: clean(b.phone, 15).replace(/[\\s-]/g, ''),
      age: clean(b.age, 3), address: clean(b.address, 250), date: clean(b.date, 10), slot: clean(b.slot, 30), details: clean(b.details, 400) };
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    if (!SERVICES.medical.includes(m.service)) return send(res, 400, { error: 'Please choose a valid service.' });
    if (m.name.length < 2) return send(res, 400, { error: 'Please enter the patient name.' });
    if (!/^(\\+91)?[6-9]\\d{9}$/.test(m.phone)) return send(res, 400, { error: 'Enter a valid 10-digit mobile number.' });
    if (m.address.length < 5) return send(res, 400, { error: 'Please enter your address.' });
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(m.date) || m.date < today) return send(res, 400, { error: 'Please choose a valid date.' });
    if (!SLOTS.includes(m.slot)) return send(res, 400, { error: 'Please choose a time.' });
    if (b.consent !== true) return send(res, 400, { error: 'Please tick the consent box to continue.' });
    const now = new Date().toISOString();
    const saved = { id: 'MED' + Date.now().toString(36).toUpperCase(), status: 'new', createdAt: now, type: 'medical', ...m,
      consent: { agreed: true, at: now }, history: [{ at: now, event: 'Booking created' }] };
    const list = readBookings(); list.push(saved); saveBookings(list);
    notifyMinimal(saved.id);
    return send(res, 201, { message: 'Request received! We will call you to confirm the date and time.', id: saved.id });
  }
  if (req.method === 'GET' && url.pathname === '/api/track') {
    const id = clean(url.searchParams.get('id'), 30).toUpperCase(), ph = clean(url.searchParams.get('phone'), 15).replace(/[\\s-]/g, '').slice(-10);
    const b = readBookings().find(x => x.id === id && String(x.phone).slice(-10) === ph);
    if (!b) return send(res, 404, { error: 'No booking found. Check the ID and mobile number.' });
    return send(res, 200, { id: b.id, service: b.item || b.service, status: b.status, date: b.date, slot: b.slot || '', confirmedDate: b.confirmedDate || '',
      confirmedTime: b.confirmedTime || '', partnerName: b.partnerName || '', meetLink: b.meetLink || '', note: b.clientNote || '' });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/booking-update') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const list = readBookings(), i = list.findIndex(x => x.id === b.id);
    if (i < 0) return send(res, 404, { error: 'Booking not found' });
    const link = clean(b.meetLink, 200);
    if (link && !/^https:\\/\\//.test(link)) return send(res, 400, { error: 'Link must start with https://' });
    const st = ['new', 'confirmed', 'completed', 'cancelled'].includes(b.status) ? b.status : list[i].status;
    Object.assign(list[i], { status: st, confirmedDate: clean(b.confirmedDate, 10), confirmedTime: clean(b.confirmedTime, 12), partnerName: clean(b.partnerName, 80), meetLink: link, clientNote: clean(b.clientNote, 200) });
    (list[i].history = list[i].history || []).push({ at: new Date().toISOString(), event: 'Updated: ' + st + ' ' + list[i].confirmedDate + ' ' + list[i].confirmedTime + (list[i].partnerName ? ' | ' + list[i].partnerName : '') });
    saveBookings(list); return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/services')`;

const serverOut = patch(serverPath, [
  ['helper', 'async function handleApi(req, res, url) {', helper],
  ['routes', "if (req.method === 'GET' && url.pathname === '/api/services')", routes],
  ['block old medical form', "const type = b.type === 'medical' ? 'medical' : 'home';",
    "if (b.type === 'medical') return { error: 'Please book medical services from the Medical Services page.' };\n  const type = 'home';"]
]);
const go = "window.location.href='medical.html?cat='+encodeURIComponent(";
const indexOut = patch(indexPath, [
  ['tile click', "c.addEventListener('click',function(){open('medical',s)})", "c.addEventListener('click',function(){" + go + "s)})"],
  ['hero/promo buttons', "b.addEventListener('click',function(){open('medical','Doctor Consultation')});", "b.addEventListener('click',function(){window.location.href='medical.html'});"],
  ['footer links', '<p>Terms &amp; Conditions | Privacy Policy | Support</p>',
    '<p><a href="legal.html#terms">Terms &amp; Conditions</a> | <a href="legal.html#privacy">Privacy Policy</a> | <a href="legal.html#refund">Refunds</a> | <a href="track.html">Track Booking</a></p>\n<p>Ghar to Health is a platform. Services are provided by independent partners.</p>']
]);

fs.copyFileSync(serverPath, serverPath + '.bak2'); fs.copyFileSync(indexPath, indexPath + '.bak2');
fs.writeFileSync(serverPath, serverOut); fs.writeFileSync(indexPath, indexOut);
fs.mkdirSync(pub, { recursive: true });
for (const f of ['medical.html', 'track.html', 'legal.html', 'admin-medical.html', 'gth-pages.css'])
  if (fs.existsSync(path.join(__dirname, f))) fs.copyFileSync(path.join(__dirname, f), path.join(pub, f)); else console.log('Missing file next to script: ' + f);
console.log('Done. Restart the server: node server.js');
console.log('Backups: server.js.bak2, index.html.bak2. Admin page: http://localhost:3000/admin-medical.html');
