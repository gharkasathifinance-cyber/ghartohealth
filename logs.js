// logs.js - Customer login log in one Excel file: data/login-log.xlsx
// Pehle ek baar project folder mein:  npm install exceljs
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'login-log.xlsx');
const BACKUP_FILE = path.join(DATA_DIR, 'login-backup.jsonl');
const ROWS_PER_SHEET = 1048575;   // Excel limit 1,048,576 minus header row
const HEADERS = ['Login Date', 'Login Time', 'User Name', 'User No', 'User ID'];

let ExcelJS = null;
try { ExcelJS = require('exceljs'); }
catch { console.log('Login Excel is disabled: run "npm install exceljs" in the project folder'); }

// Excel read/write ek-ek karke chalein, taaki file corrupt na ho
let queue = Promise.resolve();
function locked(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

// Current IST date aur time, text mein (timezone ki confusion nahi hogi)
function istParts() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date()).map(x => [x.type, x.value])
  );
  return { date: `${p.day}/${p.month}/${p.year}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

function newSheet(wb) {
  const s = wb.addWorksheet('Logins ' + (wb.worksheets.length + 1));
  s.columns = [
    { header: HEADERS[0], key: 'date', width: 14 },
    { header: HEADERS[1], key: 'time', width: 12 },
    { header: HEADERS[2], key: 'name', width: 26 },
    { header: HEADERS[3], key: 'phone', width: 16 },
    { header: HEADERS[4], key: 'userId', width: 14 }
  ];
  s.getRow(1).font = { bold: true };
  s.views = [{ state: 'frozen', ySplit: 1 }];
  s.autoFilter = { from: 'A1', to: 'E1' };
  return s;
}

async function writeLogin(e) {
  if (!ExcelJS) return;
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(LOG_FILE)) await wb.xlsx.readFile(LOG_FILE);

  let sheet = wb.worksheets[wb.worksheets.length - 1];
  if (!sheet) sheet = newSheet(wb);
  else if (sheet.rowCount - 1 >= ROWS_PER_SHEET) sheet = newSheet(wb);   // sheet bhar gayi, nayi sheet

  const t = istParts();
  sheet.addRow([t.date, t.time, e.name, e.phone, e.userId]);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  await wb.xlsx.writeFile(LOG_FILE);
}

// auth.js ye call karta hai. Login ko rokta nahi.
function appendLogin(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(BACKUP_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  locked(() => writeLogin(entry)).catch(err => console.log('Login Excel write failed:', err.message));
}

async function readRows() {
  if (!ExcelJS || !fs.existsSync(LOG_FILE)) return [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(LOG_FILE);
  const rows = [];
  wb.eachSheet(sheet => sheet.eachRow((row, n) => {
    if (n === 1) return;
    const v = row.values;   // v[1] = column A
    rows.push({
      date: String(v[1] ?? ''), time: String(v[2] ?? ''), name: String(v[3] ?? ''),
      phone: String(v[4] ?? ''), userId: String(v[5] ?? '')
    });
  }));
  return rows.reverse();    // latest pehle
}

async function handle(req, res, url, { send, ADMIN_KEY }) {
  if (!url.pathname.startsWith('/api/admin/logs')) return false;
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    send(res, 401, { error: 'Wrong admin key' });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/logs') {
    try {
      const rows = await locked(readRows);
      send(res, 200, { ok: true, total: rows.length, rows });
    } catch (e) {
      console.log('Log read failed:', e.message);
      send(res, 500, { error: 'Could not load the login log' });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/logs/download') {
    if (!fs.existsSync(LOG_FILE)) { send(res, 404, { error: 'No logins yet' }); return true; }
    const buf = await locked(async () => fs.readFileSync(LOG_FILE));
    send(res, 200, buf, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="Login Log.xlsx"',
      'Content-Length': buf.length
    });
    return true;
  }

  return false;
}

module.exports = { appendLogin, handle };
