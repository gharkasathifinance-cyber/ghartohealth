// Ghar to Health - email alerts via Gmail SMTP (no npm packages needed, Node 18+)
const tls = require('tls');

const CFG = {
  GMAIL_USER: process.env.GMAIL_USER || 'ghartohealth@gmail.com',
  GMAIL_APP_PASS: (process.env.GMAIL_APP_PASS || '').replace(/\s/g, ''), // 16-letter App Password - set via env, don't hardcode
  NOTIFY_TO: process.env.NOTIFY_TO || 'ghartohealth@gmail.com'
};

function smtpSend({ subject, text }) {
  return new Promise((resolve, reject) => {
    if (!CFG.GMAIL_APP_PASS) return reject(new Error('GMAIL_APP_PASS not set'));
    const sock = tls.connect(465, 'smtp.gmail.com', { servername: 'smtp.gmail.com' });
    sock.setEncoding('utf8'); sock.setTimeout(15000, () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const encSubj = '=?UTF-8?B?' + b64(subject) + '?=';
    const msg = ['From: Ghar to Health <' + CFG.GMAIL_USER + '>', 'To: ' + CFG.NOTIFY_TO, 'Subject: ' + encSubj,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
      b64(text).replace(/(.{76})/g, '$1\r\n')].join('\r\n');
    const steps = [
      [/^220/, 'EHLO gharhealth.local'],
      [/^250/, 'AUTH LOGIN'],
      [/^334/, b64(CFG.GMAIL_USER)],
      [/^334/, b64(CFG.GMAIL_APP_PASS)],
      [/^235/, 'MAIL FROM:<' + CFG.GMAIL_USER + '>'],
      [/^250/, 'RCPT TO:<' + CFG.NOTIFY_TO + '>'],
      [/^250/, 'DATA'],
      [/^354/, msg + '\r\n.'],
      [/^250/, 'QUIT']
    ];
    let i = 0, buf = '';
    sock.on('data', d => {
      buf += d;
      if (!/\r?\n$/.test(buf)) return;
      const lines = buf.trim().split(/\r?\n/); const last = lines[lines.length - 1]; buf = '';
      if (/^\d{3}-/.test(last)) return;            // multi-line reply, wait for final line
      if (i >= steps.length) return resolve();
      if (!steps[i][0].test(last)) { sock.destroy(); return reject(new Error('SMTP: ' + last)); }
      sock.write(steps[i][1] + '\r\n'); i++;
    });
    sock.on('close', () => resolve());
    sock.on('error', reject);
  });
}

// Full details (home services, orders, AMC)
async function notifyEmail(b) {
  const text = `${b.service} (${b.type})\nName: ${b.name}\nPhone: ${b.phone}\nAddress: ${b.address}\nDate: ${b.date || 'not given'}\nID: ${b.id}`;
  try { await smtpSend({ subject: 'New booking: ' + String(b.service).slice(0, 80), text }); console.log('Email alert sent'); }
  catch (e) { console.log('Email alert failed:', e.message); }
}

// Medical: only booking ID, no health details
async function notifyEmailMinimal(id) {
  try { await smtpSend({ subject: 'New medical booking', text: 'Booking ' + id + '. Open the admin panel for details.' }); console.log('Email alert sent'); }
  catch (e) { console.log('Email alert failed:', e.message); }
}

module.exports = { notifyEmail, notifyEmailMinimal };
