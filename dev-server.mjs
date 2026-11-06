// Local test server: `npm run dev` then open http://localhost:8888
// Stores data in ./.local-data (never deployed). Not used on Netlify.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { handle } from './lib/core.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, '.local-data');
fs.mkdirSync(DATA, { recursive: true });
const PORT = Number(process.env.PORT) || 8888;
// Local testing only: a fake "Microsoft sign-in" page lets you sign in as any email.
// DEV_FAKE_SSO is never set on Netlify, and the code also refuses it on any host but localhost.
const env = {
  ...process.env,
  SESSION_SECRET: process.env.SESSION_SECRET || 'local-dev-secret-change-me-please',
  TRUST_ADMIN_EMAILS: process.env.TRUST_ADMIN_EMAILS || 'admin@lwlat.org.uk',
  DEV_FAKE_SSO: '1',
};

const file = key => path.join(DATA, encodeURIComponent(key) + '.json');
const etagOf = text => crypto.createHash('md5').update(text).digest('hex');
const store = {
  async get(key) {
    if (!fs.existsSync(file(key))) return null;
    const text = fs.readFileSync(file(key), 'utf8');
    return { data: JSON.parse(text), etag: etagOf(text) };
  },
  async set(key, data, opts = {}) {
    const exists = fs.existsSync(file(key));
    if (opts.onlyIfNew && exists) return { modified: false };
    if (opts.onlyIfMatch && (!exists || etagOf(fs.readFileSync(file(key), 'utf8')) !== opts.onlyIfMatch)) return { modified: false };
    fs.writeFileSync(file(key), JSON.stringify(data));
    return { modified: true };
  },
  async del(key) { fs.rmSync(file(key), { force: true }); },
  async list(prefix) {
    return fs.readdirSync(DATA).map(f => decodeURIComponent(f.replace(/\.json$/, ''))).filter(k => k.startsWith(prefix));
  },
};

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handle(new Request(url, { method: req.method, headers: req.headers, body }), { store, env, ip: req.socket.remoteAddress });
    const headers = Object.fromEntries([...r.headers].filter(([k]) => k !== 'set-cookie'));
    const cookies = r.headers.getSetCookie();
    if (cookies.length) headers['Set-Cookie'] = cookies;
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const f = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log(`Local: http://localhost:${PORT}  (test sign-in on; trust admin: ${env.TRUST_ADMIN_EMAILS})`));
