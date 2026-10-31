// Ghar to Health - backend (no npm packages needed, Node 18+)
// Run:  node server.js   ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { notifyEmail, notifyEmailMinimal } = require('./notify');
const auth = require('./auth');
const logs = require('./logs');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'GhartoHealth@010106'; // used to view bookings
// WhatsApp alert (CallMeBot). Set these two before starting the server:
//   WHATSAPP_PHONE = your number with country code, no + (e.g. 919876543210)
//   CALLMEBOT_KEY  = API key that CallMeBot sends you on WhatsApp
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE || '';
const CALLMEBOT_KEY = process.env.CALLMEBOT_KEY || '';
// Phone notification via ntfy.sh (free, no signup). Install the "ntfy" app and subscribe to this topic.
// Keep the topic name secret - anyone who knows it can read your booking alerts.
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'ghar-to-health-5704a4d63507';
// Hospital search (Google Places Autocomplete). Set GOOGLE_MAPS_KEY before starting the server.
// The key stays on the server, clients never see it.
let GOOGLE_MAPS_KEY = (process.env.GOOGLE_MAPS_KEY || '').trim();
if (!GOOGLE_MAPS_KEY) { try { GOOGLE_MAPS_KEY = fs.readFileSync(path.join(__dirname, 'google-key.txt'), 'utf8').trim(); } catch {} }
const hospHits = new Map();   // ip -> [timestamps]  (rate limit)
const hospCache = new Map();  // query -> { t, items }
// Website files: use the "public" folder if it has index.html, otherwise the folder next to server.js
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
// Files that must never be served to the browser (bookings, keys, server code)
const BLOCKED = /^\/(data|node_modules|\.git)(\/|$)|^\/(server\.js|google-key\.txt|notify\.js|auth\.js|logs\.js|vendors\.js|tracking\.js|ambulance\.js|air-tracking\.js|invoice-store\.js|package(-lock)?\.json|\.env)$/i;
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Airline MEDIF forms (admin can replace them from Ambulance Charges). Add more airlines here later, e.g. indigo: 'IndiGo'
const MEDIF_DIR = path.join(__dirname, 'data', 'medif');
const MEDIF_AIRLINES = { airindia: 'Air India' };

const DATA_FILE = path.join(__dirname, 'data', 'bookings.json');
const SERVICES = {
  home: ['Plumber', 'Electrician', 'Carpenter', 'Home Appliance', 'Cleaning', 'Pest Control', 'Painting', 'Gardening', 'Packers & Movers'],
  medical: ['Doctor Consultation', 'Medicine Delivery', 'Lab Tests', 'Health Check-up', 'Nurse at Home', 'Physiotherapy', 'Ambulance', 'Scans & Imaging', 'Dental Care', 'Eye Care', 'Mental Health', 'Diet & Nutrition']
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp'
};

function readBookings() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function saveBookings(list) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? 'application/json' : 'text/plain', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, max = 10000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > max) {
        reject(new Error('too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

const clean = (v, max = 200) => String(v || '').replace(/[<>]/g, '').trim().slice(0, max);
const invoices = require('./invoice-store')({ send, readBody, clean, ADMIN_KEY, readBookings, baseDir: __dirname });
const vendors = require('./vendors')({ readBookings, saveBookings, readBody, send, clean, ADMIN_KEY, NTFY_TOPIC, readCatalog });
const tracking = require('./tracking')({ readBookings, saveBookings, readBody, send, clean, ADMIN_KEY, auth: vendors.auth });   // live partner tracking
const ambulance = require('./ambulance')({ readBookings, saveBookings, readBody, send, clean, ADMIN_KEY, notifyMinimal, vendors, invoices });
const airTracking = require('./air-tracking')({ readBookings, saveBookings, readBody, send, clean, ADMIN_KEY, ambulance, notifyApplication: notifyOperatorApplication });
ambulance.setAirQuote(airTracking.quote);   // live air price (hours x hourly rate) for the ambulance booking page

async function notifyPhone(b) {
  notifyEmail(b); // email copy to ghartohealth@gmail.com
  const text = `${b.service} (${b.type})\nName: ${b.name}\nPhone: ${b.phone}\nAddress: ${b.address}\nDate: ${b.date || 'not given'}${b.total ? '\nTotal: Rs ' + b.total : ''}${b.payment ? '\nPayment: ' + b.payment : ''}\nID: ${b.id}`;
  try {
    const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, {
      method: 'POST',
      headers: { Title: 'New booking: ' + String(b.service).replace(/[^\x20-\x7E]/g, '').slice(0, 80), Priority: 'high', Tags: 'house' },
      body: text
    });
    console.log('Phone alert status:', r.status);
  } catch (e) { console.log('Phone alert failed:', e.message); }
}

async function notifyWhatsApp(b) {
  if (!WHATSAPP_PHONE || !CALLMEBOT_KEY) return console.log('WhatsApp alert skipped: WHATSAPP_PHONE / CALLMEBOT_KEY not set');
  const text = `New booking ${b.id}\nService: ${b.service} (${b.type})\nName: ${b.name}\nPhone: ${b.phone}\nAddress: ${b.address}\nDate: ${b.date || 'not given'}`;
  const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(WHATSAPP_PHONE)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(CALLMEBOT_KEY)}`;
  try {
    const r = await fetch(url);
    console.log('WhatsApp alert status:', r.status);
  } catch (e) { console.log('WhatsApp alert failed:', e.message); }
}

const SERVICES_FILE = path.join(__dirname, 'data', 'services.json');
// If data/services.json is missing (e.g. Render wiped the disk), copy the services.json that was uploaded next to server.js
(function seedServicesFile() {
  try {
    if (fs.existsSync(SERVICES_FILE)) return;
    const candidates = [path.join(__dirname, 'services.json'), path.join(process.cwd(), 'services.json'), path.join(__dirname, '..', 'services.json'), path.join(__dirname, 'public', 'services.json')];
    for (const c of candidates) {
      if (fs.existsSync(c) && JSON.parse(fs.readFileSync(c, 'utf8')).length) {
        fs.mkdirSync(path.dirname(SERVICES_FILE), { recursive: true });
        fs.copyFileSync(c, SERVICES_FILE);
        console.log('Services loaded from ' + c);
        return;
      }
    }
  } catch (e) { console.log('services.json seed failed:', e.message); }
})();
const SEED = [
 ['Electrician','Switch Board Repair & Installation','Fix faulty switches, sockets and switchboards.',199,'30-45 mins'],
 ['Electrician','Ceiling Fan Installation','Fan installation, blade balancing and regulator connection.',229,'45-60 mins'],
 ['Electrician','LED Light & Spotlight Fitting','Ceiling battens, profile lights and pendant lights.',149,'30 mins'],
 ['Electrician','MCB & Wiring Repair','MCB change, short circuit and wiring fault repair.',349,'45-60 mins'],
 ['Plumber','Tap & Mixer Repair','Leaking tap, mixer or shower repair and replacement.',149,'30 mins'],
 ['Plumber','Wash Basin Installation','Fitting of wash basin with pipes and taps.',399,'45-60 mins'],
 ['Plumber','Drain Blockage Clearing','Kitchen or bathroom drain unblocking.',299,'30-45 mins'],
 ['Plumber','Water Tank Cleaning','Overhead tank cleaning and disinfection.',699,'1-2 hrs'],
 ['Carpenter','Door & Lock Repair','Door alignment, hinge and lock fitting.',249,'30-45 mins'],
 ['Carpenter','Furniture Assembly','Bed, wardrobe or table assembly.',499,'1-2 hrs'],
 ['Carpenter','Curtain Rod & Shelf Fitting','Wall drilling and fitting of rods and shelves.',199,'30 mins'],
 ['Cleaning','Fabric Sofa Cleaning (3 Seater)','Deep shampoo and vacuum cleaning.',549,'1 hr'],
 ['Cleaning','Bathroom Deep Cleaning','Tiles, fittings and floor deep clean.',449,'1 hr'],
 ['Cleaning','Kitchen Deep Cleaning','Chimney, slab, cabinets and tiles cleaning.',999,'2-3 hrs'],
 ['Cleaning','Full Home Deep Cleaning (1 BHK)','Complete floor-to-ceiling cleaning.',2499,'4-5 hrs'],
 ['Home Appliance','AC Service (Split)','Jet-pump cleaning, gas pressure and cooling check.',499,'45-60 mins'],
 ['Home Appliance','Washing Machine Repair','Inspection and repair of front or top load machines.',349,'45-60 mins'],
 ['Home Appliance','Refrigerator Repair','Cooling issue and compressor inspection.',399,'45-60 mins'],
 ['Home Appliance','Water Purifier Service','Filter check, cleaning and sanitisation.',399,'30-45 mins'],
 ['Pest Control','Cockroach & Ant Control','Gel and spray treatment for the whole home.',599,'1 hr'],
 ['Pest Control','Termite Control (1 BHK)','Drill-and-fill anti-termite treatment.',1999,'2-3 hrs'],
 ['Cleaning','Mattress Deep Cleaning (Double Bed)','Vacuum, stain removal and sanitisation.',699,'1 hr'],
 ['Cleaning','Glass & Window Cleaning (Home)','Windows, glass doors and balcony glass cleaning.',599,'1-2 hrs'],
 ['Cleaning','Car Interior Cleaning','Seats, mats, dashboard and boot deep clean.',799,'1-2 hrs'],
 ['Painting','Single Wall Painting','Putty, primer and two coats on one wall.',999,'3-4 hrs'],
 ['Gardening','Garden Maintenance (Monthly)','Pruning, weeding, watering and plant care.',799,'2 hrs'],
 ['Packers & Movers','Local Shifting (1 BHK)','Packing, loading, transport and unloading within the city.',4999,'4-6 hrs'],
];

/* ===== Sub-categories (chips on the category page) ===== */
const CAT_RENAME = { 'ac & appliances': 'Home Appliance', 'ac service': 'Home Appliance', 'appliance repair': 'Home Appliance',
  'sofa cleaning': 'Cleaning', 'mattress cleaning': 'Cleaning', 'matress cleaning': 'Cleaning', 'car cleaning': 'Cleaning' };
const SUB_RULES = {
  'electrician': [[/switch|socket/, 'Switch & Socket'], [/fan|light|led/, 'Fan & Lights'], [/mcb|wiring/, 'Wiring & MCB']],
  'plumber': [[/tap|mixer/, 'Tap & Mixer'], [/basin|fitting/, 'Basin & Fittings'], [/drain|block/, 'Drain & Blockage'], [/tank/, 'Water Tank']],
  'carpenter': [[/door|lock/, 'Door & Lock'], [/furniture|assembl/, 'Furniture'], [/curtain|shelf/, 'Curtain & Shelf']],
  'home appliance': [[/\bac\b|split|window/, 'AC'], [/washing/, 'Washing Machine'], [/fridge|refriger/, 'Refrigerator'], [/purifier|\bro\b/, 'Water Purifier']],
  'cleaning': [[/sofa|carpet/, 'Sofa & Carpet'], [/mattress|matress/, 'Mattress Cleaning'], [/\bcar\b|vehicle/, 'Car Cleaning'],
    [/full home/, 'Full Home Deep Clean'], [/bathroom|kitchen/, 'Bathroom & Kitchen'], [/tank/, 'Water Tank Cleaning'], [/glass|window/, 'Glass Cleaning']],
  'pest control': [[/termite/, 'Termite Control']],
};
function deriveSub(item) {
  const rules = SUB_RULES[String(item.category).trim().toLowerCase()] || [];
  const n = String(item.name || '').toLowerCase();
  for (const [re, sub] of rules) if (re.test(n)) return sub;
  return 'General';
}
// Converts old data to the new structure (category rename + sub-category). Returns true if the file changed.
function normalizeCatalog(list) {
  let changed = false;
  list.forEach(s => {
    const to = CAT_RENAME[String(s.category || '').trim().toLowerCase()];
    if (to && s.category !== to) { s.category = to; changed = true; }
    if (!s.sub) { s.sub = deriveSub(s); changed = true; }
  });
  return changed;
}
function removeServiceImage(p) {
  try {
    const f = path.join(UPLOAD_DIR, path.basename(String(p)));
    if (f.startsWith(UPLOAD_DIR) && path.basename(f).startsWith('svc-')) fs.unlinkSync(f);
  } catch {}
}
function writeCatalog(l) { fs.mkdirSync(path.dirname(SERVICES_FILE), { recursive: true }); fs.writeFileSync(SERVICES_FILE, JSON.stringify(l, null, 2)); }
function readCatalog() {
  let list;
  try { list = JSON.parse(fs.readFileSync(SERVICES_FILE, 'utf8')); } catch {
    list = SEED.map((r, i) => ({ id: 's' + (i + 1), category: r[0], name: r[1], description: r[2], price: r[3], duration: r[4] }));
    normalizeCatalog(list); writeCatalog(list); return list;
  }
  if (normalizeCatalog(list)) writeCatalog(list);
  return list;
}

// ---- Charges per service: basic price + GST % + platform fee + extra charges (all set from admin Edit) ----
// A service with no charges set keeps the old 3% "Convenience & safety" fee until you save charges for it.
const r2 = n => Math.round(n * 100) / 100;
function cleanCharges(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v, max) => Math.min(Math.max(r2(Number(v) || 0), 0), max);
  const extras = (Array.isArray(c.extras) ? c.extras : []).slice(0, 8)
    .map(e => ({ label: clean(e && e.label, 40), amount: n(e && e.amount, 100000) }))
    .filter(e => e.label && e.amount > 0);
  return { gstPercent: n(c.gstPercent, 28), platformFee: n(c.platformFee, 10000), extras };
}
// items: [{ s: catalogService, qty }]  ->  { subtotal, charges:[{label,amount}], fee, total }
function calcCart(items) {
  let subtotal = 0, gst = 0, platform = 0, legacy = 0; const extras = {};
  items.forEach(({ s, qty }) => {
    const base = s.price * qty; subtotal += base;
    const c = s.charges;
    if (!c) { legacy += base * 0.03; return; }
    gst += base * (Number(c.gstPercent) || 0) / 100;
    platform += (Number(c.platformFee) || 0) * qty;
    (c.extras || []).forEach(e => { extras[e.label] = (extras[e.label] || 0) + e.amount * qty; });
  });
  const charges = [];
  if (gst) charges.push({ label: 'GST', amount: r2(gst) });
  if (platform) charges.push({ label: 'Platform fee', amount: r2(platform) });
  Object.keys(extras).forEach(l => { if (extras[l]) charges.push({ label: l, amount: r2(extras[l]) }); });
  if (legacy) charges.push({ label: 'Convenience & safety', amount: r2(legacy) });
  const fee = r2(charges.reduce((a, c) => a + c.amount, 0));
  return { subtotal: r2(subtotal), charges, fee, total: r2(subtotal + fee) };
}

// Picks an emoji automatically from the category name
function autoIcon(category) {
  const c = String(category || '').toLowerCase();
  const rules = [
    [/laundry|dry ?clean|\biron/, '👕'],
    [/waterproof|leakage|seepage/, '💧'],
    [/mattress|matress|\bbed\b/, '🛏️'],
    [/sofa|couch|upholster/, '🛋️'],
    [/\bcars?\b|vehicle|\bbike|automobile|car wash/, '🚗'],
    [/carpent|wood|furniture|door/, '🔨'],
    [/plumb|\btap|pipe|drain|\btank|\bwater/, '🚰'],
    [/electric|wiring|\bfan\b|switch|light/, '⚡'],
    [/\bac\b|air ?cond|\bcooler|hvac|cooling/, '❄️'],
    [/appliance|washing|fridge|refrigerator|microwave|\btv\b|geyser/, '🧺'],
    [/pest|termite|cockroach|insect|\bants?\b|rodent/, '🐜'],
    [/paint|polish|putty|\bwall/, '🎨'],
    [/garden|lawn|plant|\btree/, '🌿'],
    [/tile|floor|marble|granite/, '🧱'],
    [/glass|window/, '🪟'],
    [/cctv|camera|security|\block/, '📷'],
    [/move|shift|packer|relocat/, '🚚'],
    [/cook|chef|kitchen|tiffin|food/, '🍳'],
    [/salon|beauty|hair|makeup|\bspa\b|massage/, '💇'],
    [/laptop|computer|mobile|phone|\bwifi/, '💻'],
    [/pet\b|\bdog|puppy/, '🐶'],
    [/tutor|teach|coaching|\bclass/, '📚'],
    [/clean|maid|housekeep|dust|sweep|mop|sanit/, '🧹'],
  ];
  for (const [re, icon] of rules) if (re.test(c)) return icon;
  return '🛠️';
}

// Home services = built-in list + any new category added from admin
function homeServices() {
  const extra = [...new Set(readCatalog().map(s => s.category))]
    .filter(c => !SERVICES.home.some(h => h.toLowerCase() === c.toLowerCase()));
  return [...SERVICES.home, ...extra];
}
function allowedServices(type) { return type === 'home' ? homeServices() : SERVICES.medical; }

function validateBooking(b) {
  if (b.type === 'medical') return { error: 'Please book medical services from the Medical Services page.' };
  const type = 'home';
  const booking = {
    type,
    service: clean(b.service, 60),
    name: clean(b.name, 80),
    phone: clean(b.phone, 15).replace(/[\s-]/g, ''),
    address: clean(b.address, 250),
    date: clean(b.date, 20),
    notes: clean(b.notes, 300)
  };
  if (!allowedServices(type).includes(booking.service)) return { error: 'Please choose a valid service.' };
  if (booking.name.length < 2) return { error: 'Please enter your name.' };
  if (!/^(\+91)?[6-9]\d{9}$/.test(booking.phone)) return { error: 'Enter a valid 10-digit mobile number.' };
  if (booking.address.length < 5) return { error: 'Please enter your address.' };
  return { booking };
}

// Payment alert on both ntfy and Gmail (when the client taps "I have paid")
async function notifyPayment(b) {
  const total = b.total ? 'Rs ' + b.total : '';
  try { notifyEmail({ ...b, type: 'payment', service: 'PAYMENT RECEIVED ' + total + ' (' + (b.payment || 'online') + ') - ' + b.service }); } catch (e) { console.log('Payment email failed:', e.message); }
  const text = `Booking ${b.id}\nAmount: ${total}\nMethod: ${b.payment || '-'}${b.txn ? '\nUTR: ' + b.txn : ''}\nName: ${b.name}\nPhone: ${b.phone}\nService: ${b.service}`;
  try {
    const r = await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers: { Title: 'Payment received ' + total.replace(/[^\x20-\x7E]/g, ''), Priority: 'high', Tags: 'moneybag' }, body: text });
    console.log('Payment alert status:', r.status);
  } catch (e) { console.log('Payment alert failed:', e.message); }
}

const AMC_PRICING_FILE = path.join(__dirname, 'data', 'amc-pricing.json');
const AMC_QUOTES_FILE = path.join(__dirname, 'data', 'amc-quotes.json');

// Alerts for medical bookings carry NO health details, only the booking ID.
async function notifyMinimal(id) {
  notifyEmailMinimal(id); // email copy, booking ID only
  try { await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers: { Title: 'New medical booking', Priority: 'high', Tags: 'hospital' }, body: 'Booking ' + id + '. Open the admin panel for details.' }); } catch (e) { console.log('Alert failed:', e.message); }
}
// Phone alert when an air operator agency fills the online operator form (company name only, no ID or document details)
async function notifyOperatorApplication(id, name, type) {
  try { await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers: { Title: 'New air operator application', Priority: 'high', Tags: 'airplane' },
    body: 'Operator: ' + name + ' (' + type + ')\nID ' + id + '\nOpen Air Operators & Charges, check the documents, then switch Available on.' }); }
  catch (e) { console.log('Operator application alert failed:', e.message); }
}
const MED_FILE = path.join(__dirname, 'data', 'medical-services.json');
function readMedical() { try { return JSON.parse(fs.readFileSync(MED_FILE, 'utf8')); } catch { return []; } }
function writeMedical(l) { fs.mkdirSync(path.dirname(MED_FILE), { recursive: true }); fs.writeFileSync(MED_FILE, JSON.stringify(l, null, 2)); }
function medicalCategories() { const c = [...new Set(readMedical().filter(s => s.active !== false).map(s => s.category))]; return c.length ? c : SERVICES.medical; }
const SLOTS = ['Morning (9-12)', 'Afternoon (12-4)', 'Evening (4-8)'];

// ---- Medical payment: bookings wait here until the client pays, then move to bookings.json ----
// Medicine Delivery = 50% advance (rest on delivery). Every other medical service = full payment first.
const PENDING_FILE = path.join(__dirname, 'data', 'pending-medical.json');
function readPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return []; } }
function writePending(l) { fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true }); fs.writeFileSync(PENDING_FILE, JSON.stringify(l.slice(-300), null, 2)); }
function medPay(service, total) {
  total = Math.round(Number(total) || 0);
  if (!(total > 0) || total > 100000) return null;
  if (service === 'Medicine Delivery') { const due = Math.ceil(total / 2); return { mode: 'advance50', total, due, balance: total - due }; }
  return { mode: 'full', total, due: total, balance: 0 };
}
// Payment alert for medical bookings: NO name / phone / service, only ID + amount + UTR.
async function notifyMedPayment(id, amount, utr) {
  try { await fetch('https://ntfy.sh/' + NTFY_TOPIC, { method: 'POST', headers: { Title: 'Medical payment Rs ' + amount, Priority: 'high', Tags: 'moneybag' },
    body: 'Booking ' + id + '\nAmount: Rs ' + amount + '\nUTR: ' + utr + '\nCheck your bank / UPI app, then confirm in the admin panel.' }); }
  catch (e) { console.log('Medical payment alert failed:', e.message); }
}
async function handleApi(req, res, url) {
  // ---- Airline MEDIF PDF (client downloads it, admin can replace it anytime) ----
  // Files live in data/medif/ (NOT in public/), so a code update never overwrites the PDF the admin uploaded.
  const medifM = /^\/api\/(admin\/)?medif\/([a-z]+)(\/info)?$/.exec(url.pathname);
  if (medifM && MEDIF_AIRLINES[medifM[2]]) {
    const al = medifM[2], pdfPath = path.join(MEDIF_DIR, al + '.pdf'), metaPath = path.join(MEDIF_DIR, al + '.json');
    const readMeta = () => { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; } };
    if (!medifM[1] && req.method === 'GET') {            // public: info or the PDF itself
      if (!fs.existsSync(pdfPath)) return medifM[3] ? send(res, 200, { available: false }) : send(res, 404, { error: 'MEDIF not available yet.' });
      const meta = readMeta() || {};
      if (medifM[3]) return send(res, 200, { available: true, updatedAt: meta.updatedAt || null, originalName: meta.originalName || '', airline: MEDIF_AIRLINES[al] });
      const buf = fs.readFileSync(pdfPath);
      return send(res, 200, buf, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length, 'Cache-Control': 'no-cache',
        'Content-Disposition': 'attachment; filename="' + MEDIF_AIRLINES[al].replace(/\s+/g, '') + '_MEDIF.pdf"' });
    }
    if (medifM[1] && req.method === 'POST') {            // admin: replace the PDF. Body: { data: "data:application/pdf;base64,...", note, name }
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
      let b; try { b = await readBody(req, 12000000); } catch { return send(res, 400, { error: 'PDF is too large (max 8 MB).' }); }
      const m = /^data:application\/pdf;base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data || ''));
      if (!m) return send(res, 400, { error: 'Please upload a PDF file only.' });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 8 * 1024 * 1024) return send(res, 400, { error: 'PDF must be smaller than 8 MB.' });
      if (buf.slice(0, 4).toString() !== '%PDF') return send(res, 400, { error: 'This does not look like a valid PDF file.' });
      fs.mkdirSync(MEDIF_DIR, { recursive: true });
      if (fs.existsSync(pdfPath)) {                      // keep the old one as a backup (last 10 kept)
        fs.copyFileSync(pdfPath, path.join(MEDIF_DIR, al + '_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.pdf'));
        fs.readdirSync(MEDIF_DIR).filter(n => n.startsWith(al + '_backup_')).sort().slice(0, -10).forEach(n => { try { fs.unlinkSync(path.join(MEDIF_DIR, n)); } catch {} });
      }
      fs.writeFileSync(pdfPath, buf);
      const meta = { updatedAt: new Date().toISOString(), originalName: clean(b.name, 120) || (al + '.pdf'), note: clean(b.note, 200) };
      fs.writeFileSync(metaPath, JSON.stringify(meta));
      return send(res, 200, { ok: true, ...meta });
    }
  }
  if (url.pathname.startsWith('/api/auth/') && await auth.handle(req, res, url, { send, readBody, clean })) return;
  if (url.pathname.startsWith('/api/admin/users') && await auth.handle(req, res, url, { send, readBody, clean, ADMIN_KEY })) return;
  if (url.pathname.startsWith('/api/admin/logs') && await logs.handle(req, res, url, { send, ADMIN_KEY })) return;
  if (tracking.handle(req, res, url)) return;   // /api/vendor/track, /api/live, /api/admin/live (must stay above vendors.handle)
  if (await vendors.handle(req, res, url)) return;
  // Ambulance booking needs the same customer login (phone + OTP, GTHU id) as home services
  if (req.method === 'POST' && (url.pathname === '/api/ambulance/start' || url.pathname === '/api/ambulance/confirm')) {
    const sess = auth.getSession(req);
    if (!sess) return send(res, 401, { error: 'Please log in with your mobile number to place a booking.' });
    req.gthSession = sess;   // ambulance.js can read req.gthSession.userId to save customerId on the booking
  }
  if (await ambulance.handle(req, res, url)) return;
  if (await airTracking.handle(req, res, url)) return;
  // Delete one invoice (admin only): DELETE /api/admin/invoices?no=GTH-INV-2026-0007  with header x-admin-key
  if (req.method === 'DELETE' && url.pathname === '/api/admin/invoices') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    const no = clean(url.searchParams.get('no') || '', 40);
    if (!/^[A-Za-z0-9-]+$/.test(no)) return send(res, 400, { error: 'Invalid invoice number' });
    if (typeof invoices.remove !== 'function') return send(res, 501, { error: 'Delete is not installed in invoice-store.js yet' });
    let removed = false;
    try { removed = invoices.remove(no); } catch (e) { console.log('Invoice delete failed:', e.message); return send(res, 500, { error: 'Could not delete the invoice' }); }
    if (!removed) return send(res, 404, { error: 'Invoice not found' });
    console.log('Invoice deleted by admin:', no);
    return send(res, 200, { ok: true });
  }
  if (await invoices.handle(req, res, url)) return;
  if (req.method === 'GET' && url.pathname === '/api/hospital-search') {
    const q = clean(url.searchParams.get('q') || '', 80);
    const token = clean(url.searchParams.get('t') || '', 64);
    if (q.length < 3) return send(res, 200, { items: [] });
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const now = Date.now();
    const hits = (hospHits.get(ip) || []).filter(t => now - t < 60000);
    if (hits.length >= 40) return send(res, 429, { error: 'Too many searches, please wait a minute.' });
    hits.push(now); hospHits.set(ip, hits);
    const key = q.toLowerCase();
    const c = hospCache.get(key);
    if (c && now - c.t < 600000) return send(res, 200, { items: c.items });
    if (!GOOGLE_MAPS_KEY) { // free fallback: Photon (OpenStreetMap), no key needed
      try {
        const pu = 'https://photon.komoot.io/api/?lang=en&limit=10&osm_tag=amenity:hospital&bbox=68.1,6.5,97.4,35.7&q=' + encodeURIComponent(q);
        const r = await fetch(pu, { headers: { 'User-Agent': 'GharToHealth/1.0' }, signal: AbortSignal.timeout(4000) });
        const j = await r.json().catch(() => ({}));
        const seen = new Set();
        const items = (j.features || []).map(f => f.properties || {}).filter(p => p.name && (!p.countrycode || p.countrycode === 'IN')).map(p => {
          const place = [p.city || p.district || p.county, p.state].filter(Boolean);
          const detail = [p.street, ...place].filter(Boolean).join(', ');
          return { name: p.name, detail, full: [p.name, ...place].join(', ') };
        }).filter(i => { const k = i.full.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 6);
        if (hospCache.size > 500) hospCache.clear();
        hospCache.set(key, { t: now, items });
        return send(res, 200, { items });
      } catch (e) { console.log('Free hospital search failed:', e.message); return send(res, 200, { items: [], reason: 'Free search failed: ' + e.message }); }
    }
    try {
      const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
        signal: AbortSignal.timeout(4000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
        body: JSON.stringify({
          input: q,
          includedRegionCodes: ['in'],
          includedPrimaryTypes: ['hospital'],
          languageCode: 'en',
          ...(token ? { sessionToken: token } : {})
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { console.log('Places error:', JSON.stringify(j.error || j).slice(0, 300)); return send(res, 200, { items: [], reason: 'Google said: ' + String((j.error && j.error.message) || r.status).slice(0, 300) }); }
      const items = (j.suggestions || []).map(x => x.placePrediction).filter(Boolean).slice(0, 6).map(p => ({
        name: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || '',
        detail: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || '',
        full: (p.text && p.text.text) || ''
      })).filter(i => i.full);
      if (hospCache.size > 500) hospCache.clear();
      hospCache.set(key, { t: now, items });
      return send(res, 200, { items });
    } catch (e) { console.log('Places failed:', e.message); return send(res, 200, { items: [] }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/medical-bookings') {
    const sess = auth.getSession(req);   // same customer login as home services
    if (!sess) return send(res, 401, { error: 'Please log in with your mobile number to place a booking.' });
    let b; try { b = await readBody(req, 20000); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const m = { service: clean(b.service, 60), item: clean(b.item, 80), name: clean(b.name, 80), phone: clean(b.phone, 15).replace(/[\s-]/g, ''),
      age: clean(b.age, 3), address: clean(b.address, 250), date: clean(b.date, 10), slot: clean(b.slot, 30), details: clean(b.details, 400), customerId: sess.userId };
    const today = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    if (m.service.toLowerCase() === 'ambulance') return send(res, 400, { error: 'Ambulance bookings need online payment. Please book from the Ambulance page.' });
    if (!medicalCategories().includes(m.service)) return send(res, 400, { error: 'Please choose a valid service.' });
    if (m.name.length < 2) return send(res, 400, { error: 'Please enter the patient name.' });
    if (!/^(\+91)?[6-9]\d{9}$/.test(m.phone)) return send(res, 400, { error: 'Enter a valid 10-digit mobile number.' });
    if (m.address.length < 5) return send(res, 400, { error: 'Please enter your address.' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date) || m.date < today) return send(res, 400, { error: 'Please choose a valid date.' });
    if (!SLOTS.includes(m.slot)) return send(res, 400, { error: 'Please choose a time.' });
    if (b.consent !== true) return send(res, 400, { error: 'Please tick the consent box to continue.' });
    const pay = medPay(m.service, b.total);
    const isMedicine = m.service === 'Medicine Delivery';
    if (!pay && !isMedicine) return send(res, 400, { error: 'Online payment is needed for this service, but its price is not set yet. Please contact us.' });
    if (pay) {   // payment first: keep it pending, no alert to staff yet
      const t0 = new Date().toISOString(), pid = 'MED' + Date.now().toString(36).toUpperCase();
      const pend = readPending().filter(x => Date.now() - Date.parse(x.createdAt) < 172800000);
      pend.push({ id: pid, status: 'new', createdAt: t0, type: 'medical', ...m, consent: { agreed: true, at: t0 },
        payment: { method: 'UPI', mode: pay.mode, total: pay.total, due: pay.due, balance: pay.balance, verified: false },
        history: [{ at: t0, event: 'Booking created, waiting for payment' }] });
      writePending(pend);
      return send(res, 201, { pending: true, id: pid, mode: pay.mode, total: pay.total, due: pay.due, balance: pay.balance });
    }
    const now = new Date().toISOString();
    const saved = { id: 'MED' + Date.now().toString(36).toUpperCase(), status: 'new', createdAt: now, type: 'medical', ...m,
      consent: { agreed: true, at: now }, history: [{ at: now, event: 'Booking created' }],
      payment: { mode: 'advance50', note: 'Amount not fixed yet. Collect 50% advance after confirming the bill on call.' } };
    const list = readBookings(); list.push(saved); vendors.assign(saved, list); saveBookings(list);
    notifyMinimal(saved.id);
    return send(res, 201, { message: 'Request received! We will call you to confirm the date and time.', id: saved.id });
  }
  if (req.method === 'POST' && url.pathname === '/api/medical-bookings/paid') {   // client tapped "I have paid"
    const sess = auth.getSession(req);
    if (!sess) return send(res, 401, { error: 'Please log in with your mobile number.' });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const id = clean(b.id, 30).toUpperCase(), ph = clean(b.phone, 15).replace(/[\s-]/g, '').slice(-10), utr = clean(b.utr, 20).replace(/\D/g, '');
    const list = readBookings();
    if (list.find(x => x.id === id && x.type === 'medical')) return send(res, 200, { ok: true, id });   // already confirmed
    if (!/^\d{12}$/.test(utr)) return send(res, 400, { error: 'Enter the 12-digit UPI reference (UTR) number from your payment app.' });
    const pend = readPending(), i = pend.findIndex(x => x.id === id && String(x.phone).slice(-10) === ph && x.customerId === sess.userId);
    if (i < 0) return send(res, 404, { error: 'Booking not found or expired. Please book again.' });
    const used = list.some(x => x.payment && x.payment.utr === utr) || pend.some(x => x.payment && x.payment.utr === utr);
    if (used) return send(res, 400, { error: 'This UTR number was already used for another booking.' });
    const now = new Date().toISOString(), saved = pend.splice(i, 1)[0];
    Object.assign(saved.payment, { utr, claimedAt: now });
    saved.paid = true;
    saved.history.push({ at: now, event: 'Payment claimed: Rs ' + saved.payment.due + ' UTR ' + utr + ' (not yet verified)' });
    list.push(saved); vendors.assign(saved, list); saveBookings(list); writePending(pend);
    notifyMinimal(saved.id); notifyMedPayment(saved.id, saved.payment.due, utr);
    let inv = null;   // invoice PDF, same as home maintenance (invoices/Invoice-YYYY/MM-Mon/General/Medical Services/)
    try {
      const adv = saved.payment.mode === 'advance50';
      inv = invoices.create(saved, { amount: saved.payment.total, status: adv ? 'Advance paid' : 'Paid',
        payment: 'UPI' + (adv ? ' (50% advance Rs ' + saved.payment.due + ' paid, balance Rs ' + saved.payment.balance + ' on delivery)' : '') });
    } catch (e) { console.log('Invoice failed:', e.message); }
    return send(res, 200, { ok: true, id: saved.id, invoiceNo: inv ? inv.no : undefined, message: 'Payment noted. Your booking is received and our team will call you to confirm.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/track') {
    const id = clean(url.searchParams.get('id'), 30).toUpperCase(), ph = clean(url.searchParams.get('phone'), 15).replace(/[\s-]/g, '').slice(-10);
    const b = readBookings().find(x => x.id === id && String(x.phone).slice(-10) === ph);
    if (!b) return send(res, 404, { error: 'No booking found. Check the ID and mobile number.' });
    return send(res, 200, { id: b.id, service: b.item || b.service, status: b.status, date: b.date, slot: b.slot || '', confirmedDate: b.confirmedDate || '',
      confirmedTime: b.confirmedTime || '', partnerName: b.partnerName || '', meetLink: b.meetLink || '', note: b.clientNote || '', stage: b.air ? b.air.stage : '' });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/booking-update') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const list = readBookings(), i = list.findIndex(x => x.id === b.id);
    if (i < 0) return send(res, 404, { error: 'Booking not found' });
    const link = clean(b.meetLink, 200);
    if (link && !/^https:\/\//.test(link)) return send(res, 400, { error: 'Link must start with https://' });
    const st = ['new', 'confirmed', 'completed', 'cancelled'].includes(b.status) ? b.status : list[i].status;
    Object.assign(list[i], { status: st, confirmedDate: clean(b.confirmedDate, 10), confirmedTime: clean(b.confirmedTime, 12), partnerName: clean(b.partnerName, 80), meetLink: link, clientNote: clean(b.clientNote, 200) });
    (list[i].history = list[i].history || []).push({ at: new Date().toISOString(), event: 'Updated: ' + st + ' ' + list[i].confirmedDate + ' ' + list[i].confirmedTime + (list[i].partnerName ? ' | ' + list[i].partnerName : '') });
    saveBookings(list);
    if (st === 'completed' && list[i].total) { try { invoices.create(list[i]); } catch (e) { console.log('Invoice failed:', e.message); } }
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/medical-catalog') return send(res, 200, readMedical().filter(s => s.active !== false));
  if (url.pathname === '/api/admin/medical-services') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    const cat = readMedical();
    if (req.method === 'GET') return send(res, 200, cat);
    if (req.method === 'DELETE') { writeMedical(cat.filter(s => s.id !== url.searchParams.get('id'))); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' || req.method === 'PUT') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      if (req.method === 'POST' && b.bulk) {
        const mode = b.bulk.mode, val = Number(b.bulk.value), c = clean(b.bulk.category, 40);
        if (!['percent', 'amount'].includes(mode) || !isFinite(val) || Math.abs(val) > (mode === 'percent' ? 200 : 100000)) return send(res, 400, { error: 'Invalid change value.' });
        let n = 0;
        cat.forEach(s => { if ((!c || s.category === c) && s.price > 0) { s.price = Math.min(100000, Math.max(1, Math.round(mode === 'percent' ? s.price * (1 + val / 100) : s.price + val))); n++; } });
        writeMedical(cat); return send(res, 200, { ok: true, changed: n });
      }
      const item = { category: clean(b.category, 40), name: clean(b.name, 80), description: clean(b.description, 200), price: Number(b.price), duration: clean(b.duration, 40), active: b.active !== false };
      if (!item.category || item.name.length < 2 || !(item.price >= 0 && item.price <= 100000)) return send(res, 400, { error: 'Category, name and a valid price (0 = on request) are required.' });
      if (req.method === 'POST') { item.id = 'm' + Date.now().toString(36); cat.push(item); }
      else { const i = cat.findIndex(s => s.id === b.id); if (i < 0) return send(res, 404, { error: 'Not found' }); cat[i] = { ...cat[i], ...item }; }
      writeMedical(cat); return send(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/services') return send(res, 200, { home: homeServices(), medical: medicalCategories() });

  if (req.method === 'POST' && url.pathname === '/api/bookings') {
    const sess = auth.getSession(req);
    if (!sess) return send(res, 401, { error: 'Please log in with your mobile number to place a booking.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Invalid request.' }); }
    const { booking, error } = validateBooking(body);
    if (error) return send(res, 400, { error });
    const list = readBookings();
    const saved = { id: 'GTH' + Date.now().toString(36).toUpperCase(), status: 'new', createdAt: new Date().toISOString(), customerId: sess.userId, ...booking };
    list.push(saved);
    vendors.assign(saved, list);
    saveBookings(list);
    notifyPhone(saved);
    notifyWhatsApp(saved); // runs in background, does not slow the customer
    return send(res, 201, { message: 'Booking received! We will call you shortly.', id: saved.id });
  }

  if (req.method === 'GET' && url.pathname === '/api/bookings') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
    return send(res, 200, readBookings());
  }

  if (req.method === 'GET' && url.pathname === '/api/catalog') {
    return send(res, 200, readCatalog().map(s => ({ ...s, icon: s.icon || autoIcon(s.category) })));
  }

  if (req.method === 'POST' && url.pathname === '/api/orders') {
    const sess = auth.getSession(req);
    if (!sess) return send(res, 401, { error: 'Please log in with your mobile number to place a booking.' });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const catalog = readCatalog();
    const lines = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(i => {
      const s = catalog.find(x => x.id === i.id); const q = Math.min(Math.max(parseInt(i.qty) || 0, 0), 10);
      return s && q ? { id: s.id, name: s.name, price: s.price, qty: q } : null;
    }).filter(Boolean);
    const name = clean(b.name, 80), phone = clean(b.phone, 15).replace(/[\s-]/g, ''), address = clean(b.address, 250);
    if (!lines.length) return send(res, 400, { error: 'Your cart is empty.' });
    if (name.length < 2) return send(res, 400, { error: 'Please enter your name.' });
    if (!/^(\+91)?[6-9]\d{9}$/.test(phone)) return send(res, 400, { error: 'Enter a valid 10-digit mobile number.' });
    if (address.length < 5) return send(res, 400, { error: 'Please enter your address.' });
    const calc = calcCart(lines.map(l => ({ s: catalog.find(x => x.id === l.id), qty: l.qty })));
    const { subtotal, fee } = calc;
    const saved = { id: 'GTH' + Date.now().toString(36).toUpperCase(), status: 'new', createdAt: new Date().toISOString(), type: 'order', customerId: sess.userId,
      service: lines.map(l => `${l.name} x${l.qty}`).join(', '), items: lines, subtotal, fee, charges: calc.charges, total: calc.total,
      name, phone, address, date: clean(b.date, 20), notes: '',
      payment: clean(b.payment_method, 20), txn: clean(b.txn_id, 40), paid: false };
    const list = readBookings(); list.push(saved);
    vendors.assign(saved, list, (catalog.find(x => x.id === lines[0].id) || {}).category);
    saveBookings(list);
    notifyPhone(saved); notifyWhatsApp(saved);
    let inv = null; try { inv = invoices.create(saved); } catch (e) { console.log('Invoice failed:', e.message); }   // PDF saved in invoices/Invoice-YYYY/MM-Mon/
    return send(res, 201, { message: 'Booking received! We will call you shortly.', id: saved.id, total: saved.total, invoiceNo: inv ? inv.no : undefined });
  }

  if (req.method === 'POST' && url.pathname === '/api/orders/paid') {   // client tapped "I have paid"
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const list = readBookings(); const o = list.find(x => x.id === clean(b.id, 30) && x.type === 'order');
    if (!o) return send(res, 404, { error: 'Booking not found.' });
    if (!o.paid) {
      o.paid = true; o.paidAt = new Date().toISOString();
      if (b.txn_id) o.txn = clean(b.txn_id, 40);
      saveBookings(list); notifyPayment(o);
    }
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/services/charges') {   // same charges for a category / all services
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
    const ch = cleanCharges(b.charges); if (!ch) return send(res, 400, { error: 'Invalid charges.' });
    const list = readCatalog(); const key = clean(b.category, 40).toLowerCase();
    const targets = b.scope === 'all' ? list : b.scope === 'category' ? list.filter(s => String(s.category).trim().toLowerCase() === key) : [];
    if (!targets.length) return send(res, 404, { error: 'No services found.' });
    try { fs.copyFileSync(SERVICES_FILE, SERVICES_FILE + '.bak'); } catch {}   // safety copy
    targets.forEach(s => { s.charges = ch; });
    writeCatalog(list); return send(res, 200, { ok: true, updated: targets.length });
  }

  // Service photo upload / remove (admin). Body: { id, data: "data:image/jpeg;base64,..." }  (data empty/missing = remove photo)
  if (req.method === 'POST' && url.pathname === '/api/admin/services/image') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    let b; try { b = await readBody(req, 3000000); } catch { return send(res, 400, { error: 'Photo is too large (max ~2 MB).' }); }
    const catalog = readCatalog();
    const i = catalog.findIndex(x => x.id === b.id);
    if (i < 0) return send(res, 404, { error: 'Service not found' });
    if (!b.data) {
      if (catalog[i].image) removeServiceImage(catalog[i].image);
      delete catalog[i].image; writeCatalog(catalog); return send(res, 200, { ok: true });
    }
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(b.data));
    if (!m) return send(res, 400, { error: 'Only JPG, PNG or WEBP photos are allowed.' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 2 * 1024 * 1024) return send(res, 400, { error: 'Photo must be smaller than 2 MB.' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const fname = 'svc-' + String(catalog[i].id).replace(/[^a-z0-9]/gi, '') + '-' + Date.now().toString(36) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
    if (catalog[i].image) removeServiceImage(catalog[i].image);
    catalog[i].image = '/uploads/' + fname;
    writeCatalog(catalog);
    return send(res, 200, { ok: true, image: catalog[i].image });
  }

  if (url.pathname === '/api/admin/services') {
    if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
    const catalog = readCatalog();
    if (req.method === 'DELETE') {
      const gone = catalog.find(s => s.id === url.searchParams.get('id'));
      if (gone && gone.image) removeServiceImage(gone.image);
      writeCatalog(catalog.filter(s => s.id !== url.searchParams.get('id'))); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      const item = { category: clean(b.category, 40), name: clean(b.name, 80), description: clean(b.description, 200), price: Number(b.price), duration: clean(b.duration, 20) };
      if (b.icon !== undefined) item.icon = clean(b.icon, 8);
      if (b.sub !== undefined) item.sub = clean(b.sub, 40) || deriveSub(item);
      if (b.overview !== undefined) item.overview = clean(b.overview, 600);
      if (b.included !== undefined) item.included = (Array.isArray(b.included) ? b.included : String(b.included || '').split('\n')).map(x => clean(x, 120)).filter(Boolean).slice(0, 12);
      if (b.charges !== undefined) { const ch = cleanCharges(b.charges); if (ch) item.charges = ch; }
      if (!item.category || item.name.length < 2 || !(item.price > 0 && item.price <= 100000)) return send(res, 400, { error: 'Category, name and a valid price are required.' });
      if (req.method === 'POST') { item.id = 's' + Date.now().toString(36); catalog.push(item); }
      else { const i = catalog.findIndex(s => s.id === b.id); if (i < 0) return send(res, 404, { error: 'Not found' }); catalog[i] = { ...catalog[i], ...item }; }
      writeCatalog(catalog); return send(res, 200, { ok: true, id: req.method === 'POST' ? item.id : b.id });
    }
  }

  if (url.pathname === '/api/amc-pricing') {
    if (req.method === 'GET') {
      try { return send(res, 200, JSON.parse(fs.readFileSync(AMC_PRICING_FILE, 'utf8'))); }
      catch { return send(res, 404, {}); }
    }
    if (req.method === 'PUT') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Wrong admin key' });
      let b; try { b = await readBody(req, 100000); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      if (!b || !b.config || !b.residential || !b.cafe || !b.office) return send(res, 400, { error: 'Invalid pricing data' });
      fs.mkdirSync(path.dirname(AMC_PRICING_FILE), { recursive: true });
      fs.writeFileSync(AMC_PRICING_FILE, JSON.stringify(b, null, 2));
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === '/api/amc-quotes') {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(AMC_QUOTES_FILE, 'utf8')); } catch {}
    if (req.method === 'GET') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
      return send(res, 200, list);
    }
    // Admin: update tracking status / notes of an AMC request
    if (req.method === 'PUT') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      const q = list.find(x => x.id === b.id);
      if (!q) return send(res, 404, { error: 'Request not found' });
      const STATUSES = ['new', 'called', 'confirmed', 'active', 'closed', 'cancelled'];
      if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return send(res, 400, { error: 'Invalid status' }); q.status = b.status; }
      if (b.notes !== undefined) q.notes = clean(b.notes, 1000);
      q.updatedAt = new Date().toISOString();
      fs.writeFileSync(AMC_QUOTES_FILE, JSON.stringify(list, null, 2));
      return send(res, 200, { ok: true, updatedAt: q.updatedAt });
    }
    // Admin: delete an AMC request (e.g. test entries)
    if (req.method === 'DELETE') {
      if (req.headers['x-admin-key'] !== ADMIN_KEY) return send(res, 401, { error: 'Unauthorized' });
      const id = url.searchParams.get('id');
      const next = list.filter(x => x.id !== id);
      if (next.length === list.length) return send(res, 404, { error: 'Request not found' });
      fs.writeFileSync(AMC_QUOTES_FILE, JSON.stringify(next, null, 2));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      let b; try { b = await readBody(req); } catch { return send(res, 400, { error: 'Invalid request.' }); }
      const sess = auth.getSession(req);
      if (!sess) return send(res, 401, { error: 'Please log in with your mobile number to place a booking.' });
      const c = b.customer || {};
      const name = clean(c.name, 80), phone = clean(c.phone, 15).replace(/[\s-]/g, ''), address = clean(c.address, 250);
      if (name.length < 2) return send(res, 400, { error: 'Please enter your name.' });
      if (!/^(\+91)?[6-9]\d{9}$/.test(phone)) return send(res, 400, { error: 'Enter a valid 10-digit mobile number.' });
      if (address.length < 5) return send(res, 400, { error: 'Please enter your address.' });
      const saved = { id: 'AMC' + Date.now().toString(36).toUpperCase(), at: new Date().toISOString(), status: 'new',
        type: clean(b.type, 20), mode: clean(b.mode, 20), plan: clean(b.plan, 80),
        spec: b.spec && typeof b.spec === 'object' ? b.spec : undefined, total: Number(b.total) || 0,
        customer: { name, phone, email: clean(c.email, 80), address }, customerId: sess.userId };
      list.push(saved);
      fs.mkdirSync(path.dirname(AMC_QUOTES_FILE), { recursive: true });
      fs.writeFileSync(AMC_QUOTES_FILE, JSON.stringify(list, null, 2));
      const alert = { id: saved.id, type: 'amc', service: 'AMC ' + saved.type + ' - ' + (saved.plan || 'Custom plan') + ' (Rs ' + saved.total + ')', name, phone, address, date: '' };
      notifyPhone(alert); notifyWhatsApp(alert);
      let inv = null;   // invoice PDF for every AMC request (View / Print on the AMC page)
      try {
        inv = invoices.create({ id: saved.id, service: alert.service, name, phone, address, customerId: sess.userId,
          items: [{ name: 'AMC ' + saved.type + ' - ' + (saved.plan || 'Custom plan'), price: saved.total, qty: 1 }],
          total: saved.total, subtotal: saved.total },
          { cat: saved.type === 'medical' ? 'medical' : 'home', amount: saved.total,
            status: saved.method === 'cash' ? 'Pay on first visit' : 'Payment pending',
            payment: saved.method === 'cash' ? 'Cash' : (saved.method === 'bank' ? 'Bank transfer' : 'UPI') });
      } catch (e) { console.log('AMC invoice failed:', e.message); }
      return send(res, 201, { message: 'Request received! We will call you shortly.', id: saved.id, total: saved.total, invoiceNo: inv ? inv.no : undefined });
    }
  }

  return send(res, 404, { error: 'Not found' });
}

const zlib = require('zlib');
// ---- WhatsApp / social link preview (picture + title) for the partner invite links ----
// Invite link: /vendor-register.html?for=road   or   /operator-apply.html?for=air   (the pictures are in the public folder)
const OG = {
  road: { title: 'Ghar to Health - Road Ambulance Partner', desc: 'Every life matters. Join our road ambulance network and reach patients who need you first. Register in 5 minutes.', img: '/og-road-ambulance.jpg' },
  air: { title: 'Ghar to Health - Air Ambulance Operator', desc: 'Every flight carries hope. Join our air ambulance network and help save critical patients.', img: '/og-air-ambulance.jpg' }
};
function pageHtml(full, data) {   // every page gets the logo script; admin pages also get the Vendors link
        const s0 = String(data);
        let tag = '<script src="/site-logo.js"></script>';
        const bn = path.basename(full).toLowerCase();   // live tracking scripts
        if (bn === 'vendor.html') tag += '<script src="/vendor-gps.js"></script>';
        else if (!/adminKey/.test(s0) && !/^(admin|vendor|doctor-sign|invoice|legal|amc-quotation|live|operator-apply)/.test(bn)) tag += '<script src="/site-track.js"></script>';
        if (/drop hospital/i.test(s0)) tag += '<script src="/hospital-autocomplete.js"></script>';
        if (/adminKey/.test(s0) && !/admin-(login|vendors)\.html$/.test(full)) tag += '<script src="/admin-nav.js"></script>';
        const bi = s0.lastIndexOf('</body>');   // last </body> = the real end of the page, never one inside a script string
        return Buffer.from(bi >= 0 ? s0.slice(0, bi) + tag + s0.slice(bi) : s0 + tag);
}
function ogTags(req, kind) {
  const o = OG[kind]; if (!o) return '';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(), proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http', base = proto + '://' + host;
  const e = v => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return '<meta property="og:type" content="website"><meta property="og:site_name" content="Ghar to Health"><meta property="og:title" content="' + e(o.title) + '"><meta property="og:description" content="' + e(o.desc) + '">' +
    '<meta property="og:image" content="' + e(base + o.img) + '"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta name="twitter:card" content="summary_large_image">';
}
const staticCache = new Map();   // full path -> { m, buf, gz, etag }  (re-read automatically when the file changes)
function serveStatic(req, res, url) {
  let file = decodeURIComponent(url.pathname);
  if (file === '/') file = '/index.html';
  let full = path.normalize(path.join(PUBLIC_DIR, file));
  // Photo not found at its folder path (e.g. /ambulance_pack/images/van.png)? Use the same file name from the main folder.
  if (/\.(png|jpe?g|svg|webp|ico)$/i.test(file) && !fs.existsSync(full)) {
    const base = path.basename(file);
    const alt = path.join(PUBLIC_DIR, base); if (fs.existsSync(alt)) full = alt;
  }
  if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
  if (BLOCKED.test(file) || (PUBLIC_DIR === __dirname && /^\/data\//i.test(file))) return send(res, 404, 'Not found');
  const ogKind = url.searchParams.get('for');
  if (OG[ogKind] && /^(vendor-register|operator-apply)\.html$/.test(path.basename(full).toLowerCase())) {
    return fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      let h = String(pageHtml(full, data)); const t = ogTags(req, ogKind);
      h = /<head[^>]*>/i.test(h) ? h.replace(/<head[^>]*>/i, m => m + t) : t + h;
      send(res, 200, Buffer.from(h), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    });
  }
  fs.stat(full, (e, st) => {
    if (e || !st.isFile()) {
      // Image not found in its folder (e.g. uploaded without folders)? Try the same file name in the main folder.
      const bn = path.basename(full);
      if (/\.(png|jpe?g|svg|webp|gif|ico)$/i.test(bn) && !BLOCKED.test('/' + bn)) {
        const alt = path.join(PUBLIC_DIR, bn);
        if (alt !== full && fs.existsSync(alt)) return serveStatic(req, res, new URL('/' + encodeURIComponent(bn), 'http://localhost'));
      }
      return send(res, 404, 'Not found');
    }
    const ext = path.extname(full).toLowerCase();
    const respond = (ent) => {
      const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'ETag': ent.etag, 'Cache-Control': 'no-cache' };
      if (req.headers['if-none-match'] === ent.etag) { res.writeHead(304, h); return res.end(); }
      if (ent.gz && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
        h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding';
        return send(res, 200, ent.gz, h);
      }
      send(res, 200, ent.buf, h);
    };
    const c = staticCache.get(full);
    if (c && c.m === st.mtimeMs) return respond(c);
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      if (ext === '.html') data = pageHtml(full, data);
      const compressible = /^\.(html|js|css|json|svg|txt)$/.test(ext) && data.length > 1024;
      const ent = { m: st.mtimeMs, buf: data, gz: compressible ? zlib.gzipSync(data) : null, etag: 'W/"' + data.length + '-' + Math.round(st.mtimeMs) + '"' };
      if (data.length < 3000000) { if (staticCache.size > 300) staticCache.clear(); staticCache.set(full, ent); }
      respond(ent);
    });
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url).catch(() => send(res, 500, { error: 'Server error' }));
  if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
  serveStatic(req, res, url);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Ghar to Health running at http://localhost:${PORT}`);
  console.log('Website folder: ' + PUBLIC_DIR + '  (index.html ' + (fs.existsSync(path.join(PUBLIC_DIR, 'index.html')) ? 'FOUND' : 'NOT FOUND - put index.html in this folder') + ')');
  console.log('Hospital search: ' + (GOOGLE_MAPS_KEY ? 'Google (key found)' : 'FREE mode (no Google key) - works without any setup'));
  console.log(`Phone alert topic (subscribe in the ntfy app): ${NTFY_TOPIC}`);
  // Show the address to type in your mobile browser (phone must be on the same Wi-Fi)
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list) {
      if (n.family === 'IPv4' && !n.internal) console.log(`Open on mobile: http://${n.address}:${PORT}`);
    }
  }
});
