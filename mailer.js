// Minimal Gmail SMTP sender (no npm packages). Needs the GMAIL_APP_PASS environment variable.
// send(to, subject, text) -> Promise<{ sent: boolean, reason?: string }>  (never throws)
const tls = require('tls');
const FROM = process.env.GMAIL_USER || 'ghartohealth@gmail.com';
function send(to, subject, text) {
  return new Promise(resolve => {
    const pass = (process.env.GMAIL_APP_PASS || '').replace(/\s/g, '');
    if (!pass) return resolve({ sent: false, reason: 'GMAIL_APP_PASS is not set on the server' });
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(to))) return resolve({ sent: false, reason: 'invalid recipient address' });
    const host = process.env.SMTP_HOST || 'smtp.gmail.com', port = +(process.env.SMTP_PORT || 465);
    const b64 = x => Buffer.from(String(x)).toString('base64');
    const body = b64(text).replace(/(.{76})/g, '$1\r\n');
    const msg = ['From: Ghar to Health <' + FROM + '>', 'To: ' + to, 'Subject: =?UTF-8?B?' + b64(subject) + '?=', 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n') + '\r\n.\r\n';
    const cmds = [['EHLO ghartohealth', 250], ['AUTH LOGIN', 334], [b64(FROM), 334], [b64(pass), 235], ['MAIL FROM:<' + FROM + '>', 250],
      ['RCPT TO:<' + to + '>', 250], ['DATA', 354], [msg, 250], ['QUIT', 221]];
    let buf = '', step = 0, ended = false;
    const s = tls.connect({ host, port, servername: host, rejectUnauthorized: process.env.SMTP_INSECURE !== '1' });
    const fin = r => { if (ended) return; ended = true; try { s.destroy(); } catch {} resolve(r); };
    s.setTimeout(20000, () => fin({ sent: false, reason: 'timed out' }));
    s.on('error', e => fin({ sent: false, reason: e.message }));
    s.on('data', d => {
      buf += d;
      for (;;) {
        const m = buf.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/);
        if (!m) break;
        buf = buf.slice(m[0].length);
        const code = +m[1];
        if (step === 0) { if (code !== 220) return fin({ sent: false, reason: 'unexpected greeting ' + code }); }
        else {
          if (code !== cmds[step - 1][1]) return fin({ sent: false, reason: code === 535 ? 'Gmail rejected the login (check GMAIL_APP_PASS)' : 'SMTP error ' + code });
          if (step === cmds.length) return fin({ sent: true });
        }
        const c = cmds[step][0]; s.write(c.endsWith('\r\n') ? c : c + '\r\n'); step++;
      }
    });
  });
}
module.exports = { send };
