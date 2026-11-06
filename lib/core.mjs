/*
 * LwLAT Trip Planner - API logic.
 * Runtime-agnostic: takes a web Request and a storage adapter, returns a web Response.
 * Used by netlify/functions/api.mjs (production) and dev-server.mjs (local testing).
 *
 * Two ways in:
 *   1. Microsoft (Entra) single sign-on  - organisers and trust admins plan and manage trips;
 *      staff listed on a trip can also open it this way.
 *   2. Trip login (email + personal generated password) - for staff on the day, on any device.
 *      Only works for that one trip, from 06:00 on the first day to midnight on the last day.
 *
 * Storage adapter: get(key)->{data,etag}|null, set(key,data,{onlyIfMatch|onlyIfNew})->{modified}, del(key), list(prefix)->[keys]
 */
import crypto from 'node:crypto';

export const SCHOOLS = [
  { id: 'babington', name: 'Babington Academy', colour: '#009F9A', accent: '#3BBEB4' },
  { id: 'lancaster', name: 'Lancaster Academy', colour: '#182D70', accent: '#CD072E' },
  { id: 'south-wigston', name: 'South Wigston High School', colour: '#1C6A9B', accent: '#EEAC00' },
  { id: 'woodstock', name: 'Woodstock Primary Academy', colour: '#009892', accent: '#A3D30A' },
  { id: 'heatherbrook', name: 'Heatherbrook Primary Academy', colour: '#008985', accent: '#FBB900' },
];
const SCHOOL_IDS = new Set(SCHOOLS.map(s => s.id));
const schoolName = id => (SCHOOLS.find(s => s.id === id) || {}).name || id;
const TZ = 'Europe/London';
const SSO_HOURS = 12;
const MAX_BODY = 3 * 1024 * 1024;

/* ---------------- small helpers ---------------- */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { ...SEC, 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { ...SEC, Location: to, ...headers } });
const rid = n => crypto.randomBytes(n).toString('hex');
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const normEmail = e => str(e, 254).toLowerCase();
const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

/* ---------------- passwords ---------------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(String(pw ?? ''), Buffer.from(s, 'hex'), 64), Buffer.from(h, 'hex'));
}
const WORDS = ('amber anchor apple arrow aspen badger beacon birch bramble breeze brook cactus canal canyon cedar cherry cinder clover comet copper coral cotton crane cricket crystal daisy delta dolphin dune eagle ember falcon fern flint forest fossil galaxy garnet glacier glade granite harbour hazel heron hollow honey island jasper juniper kestrel kite lagoon lantern larch lemon lily linden lotus maple marble meadow meteor mint moss nectar oak ocean olive onyx orbit orchard otter owl panda pebble pepper pine planet plum pollen poppy prairie puffin quartz quill raven reef ridge river robin rocket rowan saffron sage salmon shell sierra silver slate sparrow spruce summit swallow thistle thunder tide tiger topaz tulip valley velvet violet walnut willow wren yarrow zephyr').split(' ');
const genPassword = () => `${WORDS[crypto.randomInt(WORDS.length)]}-${WORDS[crypto.randomInt(WORDS.length)]}-${WORDS[crypto.randomInt(WORDS.length)]}-${crypto.randomInt(100, 1000)}`;

/* ---------------- signed cookies ---------------- */
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}
function unsign(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const cookie = (name, value, maxAge, secure, sameSite = 'Strict') =>
  `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}` + (secure ? '; Secure' : '');
const readCookie = (req, name) => { const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.get('cookie') || ''); return m ? m[1] : null; };

/* ---------------- UK time: trip access window ---------------- */
function tzOffset(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ms;
}
function londonMs(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const t = guess - tzOffset(guess);
  return guess - tzOffset(t);
}
function tripWindow(t) {
  const [y, m, d] = (t.endDate || t.date).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: londonMs(t.date, 6), end: londonMs(next, 0) };
}
const londonToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const ukDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const tripDates = t => (t.endDate && t.endDate !== t.date) ? `${ukDate(t.date)} to ${ukDate(t.endDate)}` : ukDate(t.date);

/* ---------------- CSV ---------------- */
export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); field = ''; rows.push(row); row = []; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
const COLUMNS = {
  firstName: ['first name', 'firstname', 'forename', 'legal forename', 'preferred forename'],
  lastName: ['last name', 'lastname', 'surname', 'legal surname'],
  admissionNo: ['admission no', 'admission number', 'adno', 'upn', 'pupil id', 'student id'],
  yearGroup: ['year group', 'year', 'yeargroup'],
  form: ['form', 'class', 'reg group', 'registration group', 'tutor group'],
  group: ['staff group', 'group', 'trip group'],
  medical: ['medical needs', 'medical', 'medical conditions', 'medical info'],
  allergies: ['allergies', 'allergy'],
  medication: ['medication', 'medicines'],
  ec1Name: ['emergency contact name', 'emergency contact', 'contact 1 name', 'parent name'],
  ec1Relation: ['emergency contact relationship', 'relationship', 'contact 1 relationship'],
  ec1Phone: ['emergency contact phone', 'emergency phone', 'contact 1 phone', 'parent phone'],
  ec2Name: ['emergency contact 2 name', 'contact 2 name'],
  ec2Phone: ['emergency contact 2 phone', 'contact 2 phone'],
  home: ['home arrangement', 'going home', 'home', 'end of day'],
  collector: ['collected by', 'collector', 'collecting adult'],
  notes: ['notes', 'other notes', 'comments'],
};
const PUPIL_FIELDS = ['firstName', 'lastName', 'admissionNo', 'yearGroup', 'form', 'group', 'medical', 'allergies', 'medication', 'ec1Name', 'ec1Relation', 'ec1Phone', 'ec2Name', 'ec2Phone', 'collector', 'notes'];
const FIELD_LABELS = { firstName: 'first name', lastName: 'last name', admissionNo: 'admission no', yearGroup: 'year group', form: 'form', group: 'staff group', medical: 'medical needs', allergies: 'allergies', medication: 'medication', ec1Name: 'emergency contact', ec1Relation: 'relationship', ec1Phone: 'emergency phone', ec2Name: 'second contact', ec2Phone: 'second phone', collector: 'collected by', notes: 'notes', home: 'going home' };
function normaliseHome(v) {
  v = String(v || '').trim().toLowerCase();
  if (!v) return '';
  if (/own|walk|alone|self|independ|bus|cycle/.test(v)) return 'own';
  if (/collect|parent|pick|carer/.test(v)) return 'collected';
  return '';
}
export function csvToPupils(text) {
  const rows = parseCsv(text);
  const errors = [], warnings = [];
  if (rows.length < 2) return { pupils: [], errors: ['The file has no pupil rows. Use the template and add one row per pupil.'], warnings };
  const header = rows[0].map(h => h.trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(COLUMNS)) idx[k] = header.findIndex(h => names.includes(h));
  if (idx.firstName < 0 || idx.lastName < 0) return { pupils: [], errors: ['Could not find "First Name" and "Last Name" columns. Please use the template.'], warnings };
  const pupils = [];
  rows.slice(1).forEach((r, i) => {
    const g = k => (idx[k] >= 0 ? String(r[idx[k]] || '').trim().slice(0, 300) : '');
    const line = i + 2;
    if (!g('firstName') && !g('lastName')) return;
    const p = { id: rid(6) };
    for (const k of PUPIL_FIELDS) p[k] = g(k);
    p.home = normaliseHome(g('home'));
    const who = `Row ${line} (${p.firstName} ${p.lastName})`;
    if (!p.firstName || !p.lastName) warnings.push(`Row ${line}: name is incomplete.`);
    if (g('home') && !p.home) warnings.push(`${who}: home arrangement "${g('home')}" not recognised. Use "Collected" or "Own way home".`);
    if (!p.ec1Phone) warnings.push(`${who}: no emergency contact phone.`);
    pupils.push(p);
  });
  const noHome = pupils.filter(p => !p.home).length;
  if (noHome) warnings.push(`${noHome} pupil(s) have no home arrangement yet. Staff can set it on the day.`);
  if (!pupils.length) errors.push('No pupils found in the file.');
  return { pupils, errors, warnings };
}
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---------------- storage helpers ---------------- */
async function update(store, key, fn, init) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await store.get(key);
    if (!r && init === undefined) fail(404, 'Not found.');
    const data = r ? r.data : structuredClone(init);
    const out = await fn(data);
    const w = await store.set(key, data, r ? { onlyIfMatch: r.etag } : { onlyIfNew: true });
    if (w.modified) return out;
    await sleep(40 + Math.random() * 120); // someone else wrote first - retry on fresh data
  }
  fail(409, 'Busy - please try again.');
}
const tripKey = (sid, tid) => `trips/${sid}/${tid}`;
const idxKey = email => `staffidx/${crypto.createHash('sha256').update(email).digest('hex').slice(0, 32)}`;
async function getConfig(store) {
  const r = await store.get('settings');
  const cfg = r ? r.data : {};
  cfg.trustDomains ||= []; cfg.trustAdmins ||= []; cfg.domains ||= {}; cfg.organisers ||= {}; cfg.viewers ||= {};
  for (const s of SCHOOLS) { cfg.domains[s.id] ||= []; cfg.organisers[s.id] ||= []; cfg.viewers[s.id] ||= []; }
  return cfg;
}
const allDomains = cfg => [...new Set([...cfg.trustDomains, ...Object.values(cfg.domains).flat()])];
const emailAllowed = (cfg, email) => allDomains(cfg).some(d => email.endsWith('@' + d));
async function audit(store, who, schoolId, trip, action) {
  const month = new Date().toISOString().slice(0, 7);
  await update(store, `audit/${month}`, d => { d.entries.push({ at: new Date().toISOString(), by: who.name, email: who.email, school: schoolId, tripId: trip && trip.id, trip: trip && trip.name, action }); }, { entries: [] });
}
function tripLog(t, who, action) { t.log.push({ at: new Date().toISOString(), by: who.name, email: who.email, action }); if (t.log.length > 8000) t.log.shift(); }

/* ---------------- email via Microsoft Graph ---------------- */
let graphToken = null;
async function graphAccessToken(env) {
  if (graphToken && graphToken.exp > Date.now() + 60e3) return graphToken.token;
  const r = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.ENTRA_CLIENT_ID, client_secret: env.ENTRA_CLIENT_SECRET, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error('Could not get mail permission: ' + (d.error_description || d.error || r.status));
  graphToken = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return graphToken.token;
}
const mailConfigured = env => !!(env.MAIL_SENDER && env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && env.ENTRA_CLIENT_SECRET);
async function sendMail(env, to, subject, html) {
  const token = await graphAccessToken(env);
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_SENDER)}/sendMail`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: true }),
  });
  if (!r.ok) { let m = r.status; try { const d = await r.json(); m = d.error && d.error.message || m; } catch { } throw new Error('Email not sent: ' + m); }
}
function tripEmail(t, staff, password, siteUrl, creator) {
  const role = staff.role === 'lead' ? 'the <b>trip lead</b>' : 'a member of staff';
  const w = tripWindow(t);
  const when = d => new Date(d).toLocaleString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const subject = `You're on the trip: ${t.name} (${ukDate(t.date)})`;
  const html = `<div style="font-family:'Open Sans',Arial,sans-serif;font-size:15px;color:#1F1F1F;max-width:560px">
  <div style="background:#00706A;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0"><div style="font-size:13px;opacity:.9">LwLAT Trip Planner · ${escHtml(schoolName(t.schoolId))}</div><div style="font-size:22px;font-weight:800;margin-top:4px">You've been chosen for this trip</div></div>
  <div style="border:1px solid #DCE5E4;border-top:0;padding:20px 22px;border-radius:0 0 12px 12px">
  <p>Hi ${escHtml(staff.name)},</p>
  <p>${escHtml(creator.name)} has added you to <b>${escHtml(t.name)}</b>${t.venue ? ' at ' + escHtml(t.venue) : ''} on <b>${escHtml(tripDates(t))}</b> as ${role}.</p>
  ${(() => { const l = t.staff.find(s => s.role === 'lead'); return l && l.id !== staff.id ? `<p>Trip lead: <b>${escHtml(l.name)}</b>${l.phone ? ', ' + escHtml(l.phone) : ''}</p>` : ''; })()}
  <p>On the day you'll use the Trip Planner on your phone to take registers and see pupil information, including medical needs, emergency contacts and going-home arrangements.</p>
  <p style="margin:22px 0"><a href="${escHtml(siteUrl)}/#/day" style="background:#00706A;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;display:inline-block">Open the trip register</a></p>
  <table style="border-collapse:collapse;font-size:15px"><tr><td style="padding:4px 14px 4px 0;color:#636466">Email</td><td><b>${escHtml(staff.email)}</b></td></tr>
  <tr><td style="padding:4px 14px 4px 0;color:#636466">Password</td><td><b style="font-family:Consolas,monospace;font-size:16px;background:#E6F4F3;padding:3px 8px;border-radius:6px">${escHtml(password)}</b></td></tr></table>
  <p>Your login works from <b>${escHtml(when(w.start))}</b> until <b>${escHtml(when(w.end - 1000))}</b>. If you're signed in to Microsoft (for example through Pulse) you can also open the trip with single sign-on.</p>
  <p style="color:#636466;font-size:13px">This password is personal to you. Every register mark and change you make is recorded against your name, so please don't share it. If you weren't expecting this email, contact ${escHtml(creator.name)} (${escHtml(creator.email)}).</p>
  </div></div>`;
  return { subject, html };
}

/* ---------------- Entra (Microsoft) sign-in ---------------- */
const ssoConfigured = env => !!(env.ENTRA_TENANT_ID && env.ENTRA_CLIENT_ID && env.ENTRA_CLIENT_SECRET);
const devSso = (env, url) => env.DEV_FAKE_SSO === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
const siteUrl = (env, url) => (env.SITE_URL || url.origin).replace(/\/+$/, '');

async function ssoLogin(url, env, secret, secure) {
  const back = siteUrl(env, url);
  if (devSso(env, url)) {
    const email = normEmail(url.searchParams.get('dev_email'));
    if (!email) return new Response(`<!doctype html><meta charset=utf-8><title>Test sign-in</title><body style="font-family:sans-serif;max-width:420px;margin:60px auto"><h2>Local test sign-in</h2><p>This page only exists on your computer. On Netlify, this is Microsoft sign-in.</p><form><p><label>Email<br><input name=dev_email type=email required style="width:100%;padding:8px"></label></p><p><label>Name<br><input name=dev_name required style="width:100%;padding:8px"></label></p><button style="padding:8px 16px">Sign in</button></form>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const tok = sign({ k: 'sso', em: email, n: str(url.searchParams.get('dev_name'), 80) || email, exp: Date.now() + SSO_HOURS * 3600e3 }, secret);
    return redirect(back + '/#/', { 'Set-Cookie': cookie('tt_sid', tok, SSO_HOURS * 3600, secure) });
  }
  if (!ssoConfigured(env)) fail(500, 'Microsoft sign-in is not set up yet. See the README (ENTRA_* settings).');
  const state = crypto.randomBytes(16).toString('base64url'), nonce = crypto.randomBytes(16).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const flow = sign({ state, nonce, verifier, exp: Date.now() + 10 * 60e3 }, secret);
  const q = new URLSearchParams({ client_id: env.ENTRA_CLIENT_ID, response_type: 'code', redirect_uri: back + '/api/auth/callback', response_mode: 'query', scope: 'openid profile email', state, nonce, code_challenge: challenge, code_challenge_method: 'S256' });
  // SameSite=Lax: this cookie must survive the redirect back from Microsoft
  return redirect(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/authorize?${q}`, { 'Set-Cookie': cookie('tt_oidc', flow, 600, secure, 'Lax') });
}
async function ssoCallback(request, url, env, secret, secure) {
  const back = siteUrl(env, url);
  const flow = unsign(readCookie(request, 'tt_oidc'), secret);
  const clear = cookie('tt_oidc', '', 0, secure, 'Lax');
  if (url.searchParams.get('error')) return redirect(back + '/#/signin-failed', { 'Set-Cookie': clear });
  if (!flow || flow.state !== url.searchParams.get('state')) return redirect(back + '/#/signin-failed', { 'Set-Cookie': clear });
  const r = await fetch(`https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.ENTRA_CLIENT_ID, client_secret: env.ENTRA_CLIENT_SECRET, grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: back + '/api/auth/callback', code_verifier: flow.verifier, scope: 'openid profile email' }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id_token) return redirect(back + '/#/signin-failed', { 'Set-Cookie': clear });
  // The ID token came straight from Microsoft's token endpoint over TLS (back channel), so its claims can be trusted; still check them.
  let c; try { c = JSON.parse(Buffer.from(d.id_token.split('.')[1], 'base64url').toString()); } catch { c = {}; }
  const ok = c.aud === env.ENTRA_CLIENT_ID && c.tid === env.ENTRA_TENANT_ID && c.iss === `https://login.microsoftonline.com/${env.ENTRA_TENANT_ID}/v2.0` && c.nonce === flow.nonce && c.exp * 1000 > Date.now();
  const email = normEmail(c.email || c.preferred_username);
  if (!ok || !email) return redirect(back + '/#/signin-failed', { 'Set-Cookie': clear });
  const tok = sign({ k: 'sso', em: email, n: str(c.name, 80) || email, exp: Date.now() + SSO_HOURS * 3600e3 }, secret);
  const h = new Headers(SEC);
  h.set('Location', back + '/#/');
  h.append('Set-Cookie', cookie('tt_sid', tok, SSO_HOURS * 3600, secure));
  h.append('Set-Cookie', clear);
  return new Response(null, { status: 302, headers: h });
}

/* ---------------- lockout ---------------- */
const lockKey = (ip, target) => 'lockout/' + crypto.createHash('sha256').update(ip + '|' + target).digest('hex').slice(0, 24);
async function checkLockout(store, key) { const r = await store.get(key); if (r && r.data.count >= 8 && r.data.until > Date.now()) fail(429, 'Too many attempts. Try again in 10 minutes.'); }
async function recordFailure(store, key) { const r = await store.get(key); const d = r && r.data.until > Date.now() ? r.data : { count: 0 }; d.count++; d.until = Date.now() + 600e3; await store.set(key, d); }

/* ---------------- trip views ---------------- */
function orderedCheckpoints(t) { return [...t.checkpoints.filter(c => c.kind === 'morning'), ...t.checkpoints.filter(c => c.kind === 'custom'), ...t.checkpoints.filter(c => c.kind === 'end')]; }
const publicStaff = s => ({ id: s.id, name: s.name, email: s.email, phone: s.phone || '', role: s.role, addedBy: s.addedBy, addedAt: s.addedAt, emailStatus: s.emailStatus, emailedAt: s.emailedAt });
function summary(t) {
  const mo = t.checkpoints.find(c => c.kind === 'morning'), en = t.checkpoints.find(c => c.kind === 'end');
  const count = cp => Object.values((cp && t.marks[cp.id]) || {}).filter(m => m.status === 'present').length;
  const lead = t.staff.find(s => s.role === 'lead');
  return { id: t.id, schoolId: t.schoolId, name: t.name, date: t.date, endDate: t.endDate, venue: t.venue, status: t.status, lead: lead && lead.name, leadPhone: lead && lead.phone, createdBy: t.createdBy, pupilCount: t.pupils.filter(p => !p.removed).length, staffCount: t.staff.length, onTrip: count(mo), dismissed: count(en) };
}
const pname = p => `${p.firstName} ${p.lastName}`;

/* ---------------- main handler ---------------- */
export async function handle(request, { store, env, ip = 'unknown' }) {
  try { return await route(request, store, env, ip); }
  catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
}
async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) fail(413, 'File too large.');
  try { return text ? JSON.parse(text) : {}; } catch { fail(400, 'Bad request.'); }
}

async function route(request, store, env, ip) {
  const url = new URL(request.url);
  const p = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const secret = env.SESSION_SECRET;
  const secure = url.protocol === 'https:';
  if (!secret || secret.length < 16) fail(500, 'Server not configured: set SESSION_SECRET (at least 16 characters) in the Netlify environment variables.');

  if (p === '/api/auth/login' && method === 'GET') return ssoLogin(url, env, secret, secure);
  if (p === '/api/auth/callback' && method === 'GET') return ssoCallback(request, url, env, secret, secure);

  // CSRF guard: state-changing calls must come from our own JS (custom header + SameSite=Strict cookie)
  if (method !== 'GET' && request.headers.get('x-tt') !== '1') fail(403, 'Forbidden');

  const cfg = await getConfig(store);
  const sess = unsign(readCookie(request, 'tt_sid'), secret);
  const envAdmins = String(env.TRUST_ADMIN_EMAILS || '').split(',').map(normEmail).filter(Boolean);

  // ---- who is this? ----
  let me = null;
  if (sess && sess.k === 'sso') {
    const trustAdmin = envAdmins.includes(sess.em) || cfg.trustAdmins.includes(sess.em);
    const all = SCHOOLS.map(s => s.id);
    const schools = trustAdmin ? all : all.filter(id => cfg.organisers[id].includes(sess.em));
    me = { kind: 'sso', name: sess.n, email: sess.em, trustAdmin, schools, viewSchools: trustAdmin ? all : all.filter(id => schools.includes(id) || cfg.viewers[id].includes(sess.em)) };
  } else if (sess && sess.k === 'trip') {
    me = { kind: 'trip', name: sess.n, email: sess.em, trustAdmin: false, schools: [], trip: { schoolId: sess.s, tripId: sess.t }, staffId: sess.sid, v: sess.v };
  }
  const who = me ? { name: me.name, email: me.email } : null;

  if (p === '/api/schools' && method === 'GET') return json(200, { schools: SCHOOLS, sso: ssoConfigured(env) || devSso(env, url), devSso: devSso(env, url), mail: mailConfigured(env) });
  if (p === '/api/me' && method === 'GET') return json(200, { user: me && { kind: me.kind, name: me.name, email: me.email, trustAdmin: me.trustAdmin, schools: me.schools, viewSchools: me.viewSchools || [], trip: me.trip } });
  if (p === '/api/logout' && method === 'POST') return json(200, { ok: true }, { 'Set-Cookie': cookie('tt_sid', '', 0, secure) });

  /* ---- on-the-day trip login ---- */
  if (p === '/api/trip-login' && method === 'POST') {
    const b = await readBody(request);
    const email = normEmail(b.email), pw = String(b.password || '').trim().toLowerCase();
    if (!isEmail(email) || !pw) fail(400, 'Enter your work email and the password from your trip email.');
    const lk = lockKey(ip, email);
    await checkLockout(store, lk);
    const idx = await store.get(idxKey(email));
    let match = null, notYet = null;
    for (const ref of (idx ? idx.data.trips : [])) {
      const r = await store.get(tripKey(ref.s, ref.t)); if (!r) continue;
      const t = r.data, st = t.staff.find(s => s.email === email);
      if (!st || !verifyPassword(pw, st.hash)) continue;
      const w = tripWindow(t), now = Date.now();
      if (t.status === 'closed') fail(403, 'This trip has been closed, so trip logins no longer work.');
      if (now < w.start) { notYet = w; continue; }
      if (now >= w.end) fail(403, 'This trip has finished, so your trip login no longer works.');
      match = { t, st, w }; break;
    }
    if (!match) {
      if (notYet) fail(403, `Your login works from 6am on ${new Date(notYet.start).toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' })}.`);
      await recordFailure(store, lk); fail(401, 'That email and password don\'t match a trip. Check the password in your trip email.');
    }
    const tok = sign({ k: 'trip', em: email, n: match.st.name, s: match.t.schoolId, t: match.t.id, sid: match.st.id, v: match.st.v, exp: match.w.end }, secret);
    await update(store, tripKey(match.t.schoolId, match.t.id), t => { tripLog(t, { name: match.st.name, email }, 'Logged in with trip password'); });
    return json(200, { ok: true, schoolId: match.t.schoolId, tripId: match.t.id }, { 'Set-Cookie': cookie('tt_sid', tok, (match.w.end - Date.now()) / 1000, secure) });
  }

  if (!me) fail(401, 'Please sign in.');

  /* ---- trust admin settings ---- */
  if (p === '/api/trust/settings') {
    if (!me.trustAdmin) fail(403, 'Trust admins only.');
    if (method === 'GET') return json(200, { ...cfg, envAdmins, mail: mailConfigured(env), mailSender: env.MAIL_SENDER || '' });
    if (method === 'PUT') {
      const b = await readBody(request);
      const domainList = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(d => normEmail(d).replace(/^@/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)))];
      const emailList = v => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(normEmail).filter(isEmail))];
      const changes = [];
      await update(store, 'settings', d => {
        d.trustDomains ||= []; d.trustAdmins ||= []; d.domains ||= {}; d.organisers ||= {}; d.viewers ||= {};
        const set = (label, oldV, newV, apply) => { if (JSON.stringify(oldV || []) !== JSON.stringify(newV)) { apply(newV); changes.push(`${label}: ${newV.join(', ') || '(none)'}`); } };
        if (b.trustDomains !== undefined) set('Trust-wide email domains', d.trustDomains, domainList(b.trustDomains), v => d.trustDomains = v);
        if (b.trustAdmins !== undefined) set('Trust admins', d.trustAdmins, emailList(b.trustAdmins), v => d.trustAdmins = v);
        for (const s of SCHOOLS) {
          if (b.domains && b.domains[s.id] !== undefined) set(`${s.name} email domains`, d.domains[s.id], domainList(b.domains[s.id]), v => d.domains[s.id] = v);
          if (b.organisers && b.organisers[s.id] !== undefined) set(`${s.name} trip organisers`, d.organisers[s.id], emailList(b.organisers[s.id]), v => d.organisers[s.id] = v);
          if (b.viewers && b.viewers[s.id] !== undefined) set(`${s.name} attendance viewers`, d.viewers[s.id], emailList(b.viewers[s.id]), v => d.viewers[s.id] = v);
        }
      }, {});
      for (const c of changes) await audit(store, who, null, null, 'Settings changed - ' + c);
      return json(200, { ok: true, changes: changes.length });
    }
  }

  /* ---- activity log ---- */
  if (p === '/api/audit' && method === 'GET') {
    if (me.kind !== 'sso' || (!me.trustAdmin && !me.schools.length)) fail(403, 'Only trip organisers and trust admins can see the activity log.');
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : new Date().toISOString().slice(0, 7);
    const school = url.searchParams.get('school') || '';
    const r = await store.get(`audit/${month}`);
    let entries = r ? r.data.entries : [];
    entries = entries.filter(e => me.trustAdmin ? (!school || e.school === school) : (e.school && me.schools.includes(e.school) && (!school || e.school === school)));
    return json(200, { month, entries: entries.reverse() });
  }

  /* ---- my trips (staff on trips, signed in with Microsoft) ---- */
  if (p === '/api/mytrips' && method === 'GET') {
    if (me.kind !== 'sso') return json(200, []);
    const idx = await store.get(idxKey(me.email));
    const out = [];
    for (const ref of (idx ? idx.data.trips : [])) { const r = await store.get(tripKey(ref.s, ref.t)); if (r) out.push(summary(r.data)); }
    return json(200, out.sort((a, b) => b.date.localeCompare(a.date)));
  }

  /* ---- school-level ---- */
  const ms = /^\/api\/s\/([a-z-]+)\/trips(?:\/([a-f0-9]{16}))?(\/.*)?$/.exec(p);
  if (!ms || !SCHOOL_IDS.has(ms[1])) fail(404, 'Not found');
  const sid = ms[1], tid = ms[2], sub = ms[3] || '';
  const canPlan = me.kind === 'sso' && (me.trustAdmin || me.schools.includes(sid));
  const canWatch = me.kind === 'sso' && (me.trustAdmin || me.viewSchools.includes(sid)); // organisers + attendance viewers

  if (!tid) {
    if (!canWatch) fail(403, `You don't have access to ${schoolName(sid)}'s trips. Ask a trust admin.`);
    if (method === 'GET' && sub === '/live') {
      // "Trips out today": every trip running today (UK date), with full register data for the office board
      const day = londonToday();
      const keys = await store.list(`trips/${sid}/`);
      const trips = (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean).map(r => r.data)
        .filter(t => t.date <= day && (t.endDate || t.date) >= day)
        .map(t => ({ ...t, log: undefined, staff: t.staff.map(publicStaff), checkpoints: orderedCheckpoints(t), window: tripWindow(t) }));
      return json(200, { day, trips, perm: { manage: canPlan } });
    }
    if (method === 'GET' && !sub) {
      const keys = await store.list(`trips/${sid}/`);
      const trips = (await Promise.all(keys.map(k => store.get(k)))).filter(Boolean).map(r => summary(r.data));
      return json(200, trips.sort((a, b) => b.date.localeCompare(a.date)));
    }
    if (method !== 'GET' && !canPlan) fail(403, `Only trip organisers can set up trips for ${schoolName(sid)}.`);
    if (method === 'POST' && sub === '/preview') { const b = await readBody(request); return json(200, csvToPupils(b.csv)); }
    if (method === 'POST' && !sub) return createTrip(await readBody(request), { store, env, url, sid, me, who, cfg });
    fail(404, 'Not found');
  }

  /* ---- trip-level: who can open it? ---- */
  const key = tripKey(sid, tid);
  const r0 = await store.get(key);
  if (!r0) fail(404, 'Trip not found.');
  const t0 = r0.data;
  const onTrip = me.kind === 'sso' && t0.staff.some(s => s.email === me.email);
  let canView = canPlan || canWatch || onTrip;
  let canAct = canPlan || onTrip; // attendance viewers are read-only
  if (me.kind === 'trip') {
    const st = t0.staff.find(s => s.id === me.staffId);
    const w = tripWindow(t0);
    canView = me.trip.schoolId === sid && me.trip.tripId === tid && st && st.v === me.v && t0.status !== 'closed' && Date.now() >= w.start && Date.now() < w.end;
    if (!canView) fail(401, 'Your trip login has ended or been changed. Ask the trip organiser if you still need access.');
    canAct = true;
  }
  if (!canView) fail(403, 'You are not on this trip.');

  if (sub === '' && method === 'GET') {
    if (url.searchParams.get('since') === String(t0.version)) return new Response(null, { status: 204, headers: SEC });
    const w = tripWindow(t0);
    return json(200, { ...t0, staff: t0.staff.map(publicStaff), checkpoints: orderedCheckpoints(t0), window: w, perm: { manage: canPlan, act: canAct }, mail: mailConfigured(env) });
  }

  if (sub === '/export.csv' && method === 'GET') {
    const t = t0, cps = orderedCheckpoints(t);
    const head = ['First Name', 'Last Name', 'Admission No', 'Year Group', 'Form', 'Staff Group'];
    for (const c of cps) head.push(c.name, c.name + ' - time', c.name + ' - marked by');
    head.push('Home Arrangement', 'Collected By', 'Medical Needs', 'Allergies', 'Notes', 'Added on the day by', 'Removed from trip by');
    const lines = [head.map(csvCell).join(',')];
    const label = { present: 'Present', absent: 'Absent', left: 'Left trip early' };
    const time = iso => new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    for (const pu of t.pupils) {
      const row = [pu.firstName, pu.lastName, pu.admissionNo, pu.yearGroup, pu.form, pu.group];
      for (const c of cps) { const mk = (t.marks[c.id] || {})[pu.id]; row.push(mk ? label[mk.status] : 'Not marked', mk ? time(mk.at) : '', mk ? `${mk.by}${mk.email ? ' <' + mk.email + '>' : ''}` : ''); }
      row.push(pu.home === 'own' ? 'Own way home' : pu.home === 'collected' ? 'Collected' : 'Not set', pu.collector, pu.medical, pu.allergies, pu.notes,
        pu.added ? `${pu.added.by} <${pu.added.email}> ${time(pu.added.at)}` : '', pu.removed ? `${pu.removed.by} <${pu.removed.email}> ${time(pu.removed.at)}` : '');
      lines.push(row.map(csvCell).join(','));
    }
    const fname = `${t.date}-${t.name}`.replace(/[^a-z0-9-]+/gi, '-').slice(0, 80) + '-attendance.csv';
    return new Response('﻿' + lines.join('\r\n'), { status: 200, headers: { ...SEC, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` } });
  }
  if (method === 'GET') fail(404, 'Not found');
  const b = method === 'DELETE' ? {} : await readBody(request);
  const mutate = fn => update(store, key, t => { const out = fn(t); t.version = (t.version || 0) + 1; return out; });
  const openOnly = t => { if (t.status === 'closed') fail(400, 'This trip is closed.'); };

  /* ---- anyone working on the trip (not read-only viewers) ---- */
  if (!canAct) fail(403, 'You have view-only access to this trip.');
  if (sub === '/mark' && method === 'POST') {
    await mutate(t => {
      openOnly(t);
      const cp = t.checkpoints.find(c => c.id === b.checkpointId), pu = t.pupils.find(x => x.id === b.pupilId && !x.removed);
      if (!cp || !pu) fail(400, 'Unknown check-in or pupil.');
      const allowed = cp.kind === 'morning' ? ['present', 'absent', 'clear'] : ['present', 'left', 'clear'];
      if (!allowed.includes(b.status)) fail(400, 'Invalid status.');
      t.marks[cp.id] ||= {};
      if (b.status === 'clear') delete t.marks[cp.id][pu.id];
      else t.marks[cp.id][pu.id] = { status: b.status, by: who.name, email: who.email, at: new Date().toISOString() };
      tripLog(t, who, `${cp.name}: ${pname(pu)} → ${b.status === 'clear' ? 'unmarked' : b.status === 'left' ? 'left trip early' : b.status}`);
    });
    return json(200, { ok: true });
  }
  if (sub === '/home' && method === 'POST') {
    await mutate(t => {
      const pu = t.pupils.find(x => x.id === b.pupilId && !x.removed); if (!pu) fail(400, 'Unknown pupil.');
      const home = ['own', 'collected'].includes(b.home) ? b.home : '';
      pu.home = home; pu.collector = home === 'collected' ? str(b.collector, 100) : '';
      const desc = home === 'own' ? 'own way home' : home === 'collected' ? 'collected' + (pu.collector ? ' by ' + pu.collector : '') : 'not set';
      tripLog(t, who, `Home arrangement for ${pname(pu)} → ${desc}${b.reason ? ' (' + str(b.reason, 150) + ')' : ''}`);
    });
    return json(200, { ok: true });
  }
  if (sub === '/checkpoints' && method === 'POST') {
    const name = str(b.name, 60); if (!name) fail(400, 'Give the check-in a name.');
    await mutate(t => { openOnly(t); if (t.checkpoints.length >= 20) fail(400, 'Too many check-ins.'); t.checkpoints.push({ id: rid(5), name, kind: 'custom', by: who.name }); tripLog(t, who, `Added check-in "${name}"`); });
    return json(200, { ok: true });
  }
  if (sub === '/pupils' && method === 'POST') {
    const pu = { id: rid(6) };
    for (const f of PUPIL_FIELDS) pu[f] = str(b[f], 300);
    pu.home = ['own', 'collected'].includes(b.home) ? b.home : '';
    if (!pu.firstName || !pu.lastName) fail(400, 'First and last name are required.');
    pu.added = { by: who.name, email: who.email, at: new Date().toISOString(), reason: str(b.reason, 200) };
    await mutate(t => { t.pupils.push(pu); tripLog(t, who, `Added pupil ${pname(pu)} to the trip${pu.added.reason ? ' (' + pu.added.reason + ')' : ''}`); });
    await audit(store, who, sid, t0, `Added pupil ${pname(pu)} after the trip was set up${pu.added.reason ? ' (' + pu.added.reason + ')' : ''}`);
    return json(200, { ok: true });
  }
  const pm = /^\/pupils\/([a-f0-9]+)$/.exec(sub);
  if (pm && method === 'PUT') {
    await mutate(t => {
      const pu = t.pupils.find(x => x.id === pm[1] && !x.removed); if (!pu) fail(404, 'Pupil not found.');
      const changed = [];
      for (const f of PUPIL_FIELDS) if (b[f] !== undefined && str(b[f], 300) !== pu[f]) { changed.push(`${FIELD_LABELS[f]} "${pu[f] || ''}" → "${str(b[f], 300)}"`); pu[f] = str(b[f], 300); }
      if (b.home !== undefined) { const h = ['own', 'collected'].includes(b.home) ? b.home : ''; if (h !== pu.home) { changed.push(`going home "${pu.home || 'not set'}" → "${h || 'not set'}"`); pu.home = h; } }
      if (pu.home !== 'collected') pu.collector = '';
      if (changed.length) tripLog(t, who, `Edited ${pname(pu)}: ${changed.join('; ')}`);
    });
    return json(200, { ok: true });
  }
  if (pm && method === 'DELETE') {
    let name = '';
    const reason = str(url.searchParams.get('reason'), 200);
    await mutate(t => {
      const pu = t.pupils.find(x => x.id === pm[1] && !x.removed); if (!pu) fail(404, 'Pupil not found.');
      pu.removed = { by: who.name, email: who.email, at: new Date().toISOString(), reason }; name = pname(pu);
      tripLog(t, who, `Removed pupil ${name} from the trip${reason ? ' (' + reason + ')' : ''}`);
    });
    await audit(store, who, sid, t0, `Removed pupil ${name} from the trip${reason ? ' (' + reason + ')' : ''}`);
    return json(200, { ok: true });
  }

  /* ---- organisers / trust admins only from here ---- */
  if (!canPlan) fail(403, 'Only trip organisers can do this.');

  if (sub === '' && method === 'PUT') {
    const changes = [];
    await mutate(t => {
      if (b.name !== undefined && str(b.name, 120) && str(b.name, 120) !== t.name) { changes.push(`name → "${str(b.name, 120)}"`); t.name = str(b.name, 120); }
      if (b.date !== undefined && isDate(b.date) && b.date !== t.date) { changes.push(`start date → ${b.date}`); t.date = b.date; }
      if (b.endDate !== undefined && isDate(b.endDate) && b.endDate !== t.endDate) { changes.push(`end date → ${b.endDate}`); t.endDate = b.endDate; }
      if (t.endDate < t.date) t.endDate = t.date;
      if (b.venue !== undefined && str(b.venue, 120) !== t.venue) { changes.push(`venue → "${str(b.venue, 120)}"`); t.venue = str(b.venue, 120); }
      if ((b.status === 'closed' || b.status === 'active') && b.status !== t.status) { t.status = b.status; changes.push(b.status === 'closed' ? 'closed the trip' : 'reopened the trip'); }
      if (changes.length) tripLog(t, who, 'Trip updated: ' + changes.join('; '));
    });
    if (changes.length) await audit(store, who, sid, t0, 'Trip updated: ' + changes.join('; '));
    return json(200, { ok: true });
  }
  if (sub === '' && method === 'DELETE') {
    for (const s of t0.staff) await update(store, idxKey(s.email), d => { d.trips = d.trips.filter(x => x.t !== tid); }, { trips: [] });
    await store.del(key);
    await audit(store, who, sid, t0, `Deleted the trip (${t0.pupils.length} pupils, ${tripDates(t0)})`);
    return json(200, { ok: true });
  }
  const cpd = /^\/checkpoints\/([a-f0-9]+)$/.exec(sub);
  if (cpd && method === 'DELETE') {
    await mutate(t => {
      const cp = t.checkpoints.find(c => c.id === cpd[1]);
      if (!cp || cp.kind !== 'custom') fail(400, 'Only optional check-ins can be removed.');
      t.checkpoints = t.checkpoints.filter(c => c !== cp); delete t.marks[cp.id];
      tripLog(t, who, `Removed check-in "${cp.name}"`);
    });
    return json(200, { ok: true });
  }

  /* ---- trip staff management ---- */
  if (sub === '/staff' && method === 'POST') {
    const st = validStaff(cfg, b, b.role === 'lead' ? 'lead' : 'staff');
    if (t0.staff.some(s => s.email === st.email)) fail(400, `${st.email} is already on this trip.`);
    const res = await addStaffAndNotify({ store, env, url, sid, tid, who, list: [st] });
    await audit(store, who, sid, t0, `Added ${st.name} <${st.email}> as ${st.role === 'lead' ? 'trip lead' : 'trip staff'}`);
    return json(200, res);
  }
  const sm = /^\/staff\/([a-f0-9]+)(\/resend|\/lead)?$/.exec(sub);
  if (sm) {
    const st = t0.staff.find(s => s.id === sm[1]); if (!st) fail(404, 'Staff member not found.');
    if (method === 'PUT' && !sm[2]) {
      const phone = cleanPhone(b.phone), name = str(b.name, 80) || st.name;
      if (phone && !validPhone(phone)) fail(400, `"${b.phone}" doesn't look like a phone number.`);
      if (st.role === 'lead' && !phone) fail(400, "The trip lead must have a mobile number.");
      await mutate(t => { const s = t.staff.find(x => x.id === st.id); s.name = name; s.phone = phone; tripLog(t, who, `Updated contact details for ${name}`); });
      await audit(store, who, sid, t0, `Updated contact details for ${name} <${st.email}>`);
      return json(200, { ok: true });
    }
    if (method === 'DELETE') {
      await mutate(t => { t.staff = t.staff.filter(s => s.id !== st.id); tripLog(t, who, `Removed ${st.name} <${st.email}> from the trip staff (their trip login stops working)`); });
      await update(store, idxKey(st.email), d => { d.trips = d.trips.filter(x => x.t !== tid); }, { trips: [] });
      await audit(store, who, sid, t0, `Removed ${st.name} <${st.email}> from the trip staff`);
      return json(200, { ok: true });
    }
    if (method === 'POST' && sm[2] === '/resend') {
      const res = await issuePasswords({ store, env, url, sid, tid, who, ids: [st.id], reason: 'reset' });
      await audit(store, who, sid, t0, `Reset the trip password for ${st.name} <${st.email}>${res.emailed.length ? ' and emailed it' : ''}`);
      return json(200, res);
    }
    if (method === 'POST' && sm[2] === '/lead') {
      if (!st.phone) fail(400, `Add a mobile number for ${st.name} before making them trip lead.`);
      await mutate(t => { for (const s of t.staff) s.role = s.id === st.id ? 'lead' : 'staff'; tripLog(t, who, `Made ${st.name} the trip lead`); });
      await audit(store, who, sid, t0, `Made ${st.name} <${st.email}> the trip lead`);
      return json(200, { ok: true });
    }
  }
  fail(404, 'Not found');
}

const cleanPhone = v => str(v, 30).replace(/[^\d+ ()-]/g, '');
const validPhone = v => (v.replace(/\D/g, '').length >= 10 && v.replace(/\D/g, '').length <= 15);
function validStaff(cfg, b, role) {
  const email = normEmail(b.email), name = str(b.name, 80), phone = cleanPhone(b.phone);
  if (!name) fail(400, 'Enter a name for each member of staff.');
  if (role === 'lead' && !phone) fail(400, "Enter the trip lead's mobile number (work or personal) so they can be contacted in an emergency.");
  if (phone && !validPhone(phone)) fail(400, `"${b.phone}" doesn't look like a phone number.`);
  if (!isEmail(email)) fail(400, `"${b.email}" isn't a valid email address.`);
  if (!allDomains(cfg).length) fail(400, 'No LwLAT email domains are set up yet. A trust admin needs to add them in Trust admin first.');
  if (!emailAllowed(cfg, email)) fail(400, `${email} isn't an LwLAT work email address. Only staff with an LwLAT email can be added to a trip.`);
  return { id: rid(6), name, email, phone, role };
}

async function createTrip(b, { store, env, url, sid, me, who, cfg }) {
  const name = str(b.name, 120), date = str(b.date, 10), endDate = isDate(b.endDate) ? b.endDate : date;
  if (!name || !isDate(date)) fail(400, 'Trip name and start date are required.');
  if (endDate < date) fail(400, 'The end date is before the start date.');
  const parsed = csvToPupils(b.csv);
  if (parsed.errors.length) fail(400, parsed.errors.join(' '));
  if (!b.lead || !b.lead.email) fail(400, 'Add a trip lead.');
  const list = [validStaff(cfg, b.lead, 'lead'), ...(Array.isArray(b.staff) ? b.staff : []).filter(s => s && (s.email || s.name)).map(s => validStaff(cfg, s, 'staff'))];
  const seen = new Set(); for (const s of list) { if (seen.has(s.email)) fail(400, `${s.email} is listed twice.`); seen.add(s.email); }
  const checkpoints = [{ id: rid(5), name: 'Morning register', kind: 'morning' }];
  if (b.lunch) checkpoints.push({ id: rid(5), name: 'Lunchtime check-in', kind: 'custom' });
  for (const n of Array.isArray(b.extra) ? b.extra.slice(0, 10) : []) if (str(n, 60)) checkpoints.push({ id: rid(5), name: str(n, 60), kind: 'custom' });
  checkpoints.push({ id: rid(5), name: 'End of day', kind: 'end' });
  const t = {
    id: rid(8), schoolId: sid, name, date, endDate, venue: str(b.venue, 120), status: 'active',
    createdAt: new Date().toISOString(), createdBy: { name: me.name, email: me.email },
    checkpoints, pupils: parsed.pupils, staff: [], marks: {}, log: [], version: 1,
  };
  tripLog(t, who, `Created the trip with ${t.pupils.length} pupils`);
  await store.set(tripKey(sid, t.id), t, { onlyIfNew: true });
  await audit(store, who, sid, t, `Created the trip: ${t.pupils.length} pupils, ${tripDates(t)}, lead ${list[0].name} <${list[0].email}>, ${list.length - 1} other staff`);
  const res = await addStaffAndNotify({ store, env, url, sid, tid: t.id, who, list });
  return json(200, { id: t.id, ...res });
}

async function addStaffAndNotify({ store, env, url, sid, tid, who, list }) {
  await update(store, tripKey(sid, tid), t => {
    for (const s of list) {
      if (s.role === 'lead') for (const o of t.staff) o.role = 'staff';
      t.staff.push({ ...s, addedBy: who.name, addedAt: new Date().toISOString(), v: 0, hash: null });
      tripLog(t, who, `Added ${s.name} <${s.email}> as ${s.role === 'lead' ? 'trip lead' : 'trip staff'}`);
    }
    t.version++;
  });
  for (const s of list) await update(store, idxKey(s.email), d => { if (!d.trips.some(x => x.t === tid)) d.trips.push({ s: sid, t: tid }); }, { trips: [] });
  return issuePasswords({ store, env, url, sid, tid, who, ids: list.map(s => s.id), reason: 'new' });
}

// Generate a fresh personal password for each listed staff member, store only its hash, then email it.
// If email isn't set up (or fails) the password is returned so the organiser can pass it on.
async function issuePasswords({ store, env, url, sid, tid, who, ids, reason }) {
  const issued = [];
  await update(store, tripKey(sid, tid), t => {
    for (const s of t.staff.filter(x => ids.includes(x.id))) {
      const pw = genPassword();
      s.hash = hashPassword(pw); s.v = (s.v || 0) + 1; // bumping v logs out any old session for this person
      issued.push({ id: s.id, name: s.name, email: s.email, role: s.role, password: pw });
      if (reason === 'reset') tripLog(t, who, `Reset trip password for ${s.name} <${s.email}>`);
    }
    t.version++;
  });
  const tr = (await store.get(tripKey(sid, tid))).data;
  const emailed = [], toHandOut = [];
  for (const i of issued) {
    let status = 'not sent (email not set up)';
    if (mailConfigured(env)) {
      try { const m = tripEmail(tr, i, i.password, siteUrl(env, url), who); await sendMail(env, i.email, m.subject, m.html); status = 'sent'; emailed.push(i.email); }
      catch (e) { status = 'failed: ' + e.message; }
    } else if (env.DEV_FAKE_SSO === '1') console.log(`[dev email] to ${i.email}: password ${i.password}`);
    if (status !== 'sent') toHandOut.push({ name: i.name, email: i.email, password: i.password, problem: status });
    await update(store, tripKey(sid, tid), t => { const s = t.staff.find(x => x.id === i.id); if (s) { s.emailStatus = status; s.emailedAt = status === 'sent' ? new Date().toISOString() : s.emailedAt; tripLog(t, who, `Login email for ${i.name} <${i.email}>: ${status}`); } t.version++; });
  }
  return { emailed, toHandOut };
}
