'use strict';
/* LwLAT Trip Planner - front end (no framework, no build step) */

const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
const dlgForm = document.getElementById('dlg-form');
const POLL_MS = 4000;

const S = { me: null, schools: [], sso: false, devSso: false, mail: false, trip: null, ctx: null, cpId: null, expanded: new Set(), q: '', group: '', only: '', poll: null, preview: null };

/* ---------------- helpers ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtDates = t => t.endDate && t.endDate !== t.date ? `${fmtDate(t.date)} – ${fmtDate(t.endDate)}` : fmtDate(t.date);
const fmtTime = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
const fmtDateTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
const schoolOf = id => S.schools.find(s => s.id === id);
const tripPath = (sid, tid) => `/s/${sid}/trips/${tid}`;

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: { 'x-tt': '1', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null; try { data = await res.json(); } catch { }
  if (res.status === 401 && !path.includes('login')) { S.me = null; stopPoll(); location.hash = '#/'; throw new Error((data && data.error) || 'Please sign in.'); }
  if (!res.ok) throw new Error((data && data.error) || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), isErr ? 6000 : 2400);
}

let dlgHandler = null;
function openDialog(html, onSubmit) {
  dlgForm.innerHTML = html + '<div class="error hidden" id="dlg-err"></div>';
  dlgHandler = onSubmit; dlg.showModal();
  const first = dlgForm.querySelector('input:not([type=radio]):not([type=hidden]), select, textarea'); if (first) first.focus();
}
dlgForm.addEventListener('submit', async e => {
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(dlgForm));
  const btn = dlgForm.querySelector('.dlg-actions .primary, .dlg-actions .danger'); if (btn) btn.disabled = true;
  try { const r = dlgHandler ? await dlgHandler(fd) : true; if (r !== false) dlg.close(); }
  catch (err) { const box = $('#dlg-err'); box.textContent = err.message; box.classList.remove('hidden'); }
  finally { if (btn) btn.disabled = false; }
});
dlgForm.addEventListener('click', e => { if (e.target.closest('[data-close]')) dlg.close(); });
const dlgButtons = (label = 'Save', danger, noCancel) => `<div class="dlg-actions">${noCancel ? '' : '<button type="button" class="btn" data-close>Cancel</button>'}<button class="btn ${danger ? 'danger' : 'primary'}">${esc(label)}</button></div>`;
const showError = (el, msg) => { el.textContent = msg; el.classList.remove('hidden'); window.scrollTo(0, 0); };

function topbar(title, sub, right = '', titleHtml) {
  return `<section class="pagehead"><div>${sub ? `<span class="eyebrow">${esc(sub)}</span>` : ''}<h1>${titleHtml || esc(title)}</h1></div>${right ? `<div class="row no-print">${right}</div>` : ''}</section>`;
}
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
const firstName = n => esc(String(n || '').split(' ')[0]);

/* ---------------- theme (per-school colours, Pulse Concept C) ---------------- */
const TRUST_THEME = { brand: '#098F88', mid: '#00706A', deep: '#00524E', ink: '#00706A', accent: '#ACCE33', accentInk: '#1F1F1F' };
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (h, t, f) => { const a = hex2rgb(h), b = hex2rgb(t); return rgb2hex(a.map((v, i) => v + (b[i] - v) * f)); };
const lum = h => { const c = hex2rgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * c[0] + .7152 * c[1] + .0722 * c[2]; };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
function schoolTheme(s) {
  if (!s || !s.colour) return TRUST_THEME;
  let ink = s.colour;
  for (let f = .05; contrast(ink, '#ffffff') < 4.6 && f < 1; f += .05) ink = mix(s.colour, '#000000', f); // darken until small white text passes AA
  const accent = s.accent || '#ACCE33';
  return { brand: s.colour, mid: mix(s.colour, '#000000', .22), deep: mix(s.colour, '#000000', .45), ink, accent, accentInk: contrast(accent, '#ffffff') >= 4.5 ? '#FFFFFF' : '#1F1F1F' };
}
function applyTheme(t) {
  const r = document.documentElement.style;
  r.setProperty('--brand', t.brand); r.setProperty('--brand-mid', t.mid); r.setProperty('--brand-deep', t.deep);
  r.setProperty('--brand-ink', t.ink); r.setProperty('--accent', t.accent); r.setProperty('--accent-ink', t.accentInk);
  document.querySelector('meta[name=theme-color]').content = t.mid;
}
function setHeader(schoolId) {
  const s = schoolOf(schoolId);
  applyTheme(schoolTheme(s));
  const pill = $('#hdr-school');
  pill.textContent = s ? s.name : ''; pill.classList.toggle('hidden', !s);
  $('#hdr-actions').innerHTML = S.me ? '<button class="btn small" data-act="logout">Sign out</button>' : '';
}
function tickClock() {
  const d = new Date();
  $('#clock').innerHTML = `<b>${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</b><span>${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>`;
}
tickClock(); setInterval(tickClock, 15e3);
async function logout() { await api('/logout', { method: 'POST' }).catch(() => { }); S.me = null; S.trip = null; location.hash = '#/'; render(); }
document.querySelector('.hdr').addEventListener('click', e => { if (e.target.closest('[data-act=logout]')) logout(); });
function paintTiles() {
  app.querySelectorAll('.school[data-sid]').forEach(el => {
    const t = schoolTheme(schoolOf(el.dataset.sid));
    el.style.setProperty('--c', t.brand); el.style.setProperty('--c-mid', t.mid); el.style.setProperty('--c-deep', t.deep);
    el.style.setProperty('--c-ink', t.ink); el.style.setProperty('--a', t.accent); el.style.setProperty('--a-ink', t.accentInk);
  });
}
const initials = n => n.split(' ').filter(w => /^[A-Z]/.test(w)).slice(0, 2).map(w => w[0]).join('');

/* ---------------- routing ---------------- */
function stopPoll() { clearInterval(S.poll); S.poll = null; }
window.addEventListener('hashchange', render);
async function render() {
  stopPoll();
  window.scrollTo(0, 0);
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  try {
    if (!S.schools.length) { const c = await api('/schools'); Object.assign(S, { schools: c.schools, sso: c.sso, devSso: c.devSso, mail: c.mail }); }
    S.me = (await api('/me')).user;
    if (!S.me && /[?&]sso=1/.test(location.search) && S.sso && !sessionStorage.getItem('tt_sso_tried')) { // arriving from Pulse
      try { sessionStorage.setItem('tt_sso_tried', '1'); } catch { }
      location.href = '/api/auth/login'; return;
    }
    const [a, b, c, d] = parts;
    // Trip-login users can only ever see their one trip
    if (S.me && S.me.kind === 'trip') {
      const { schoolId, tripId } = S.me.trip;
      if (!(a === 'trip' && b === schoolId && c === tripId)) { location.hash = `#/trip/${schoolId}/${tripId}`; return; }
    }
    setHeader(a === 'school' || a === 'trip' ? b : null);
    $('.pulse-link').classList.toggle('hidden', !!a); // "Back to Pulse" on the home page only
    if (!a) return viewHome();
    if (a === 'day') return viewDayLogin();
    if (a === 'signin-failed') return viewSigninFailed();
    if (!S.me) { location.hash = '#/'; return; }
    if (a === 'trust') return viewTrust();
    if (a === 'activity') return viewActivity();
    if (a === 'school' && c === 'new') return viewNewTrip(b);
    if (a === 'school') return viewTrips(b);
    if (a === 'trip' && d === 'manage') return viewManage(b, c);
    if (a === 'trip' && d === 'report') return viewReport(b, c);
    if (a === 'trip') return viewTrip(b, c);
    location.hash = '#/';
  } catch (e) {
    app.innerHTML = `<section class="pagehead"><div><span class="eyebrow">Problem</span><h1>Something went wrong</h1><p class="sub">${esc(e.message)}</p><p><a class="btn" href="#/">Back to start</a></p></div></section>`;
  }
}

/* ---------------- home ---------------- */
async function viewHome() {
  if (!S.me) {
    app.innerHTML = `
      <section class="pagehead"><div><h1>Where's the trip <span class="grad">today?</span></h1><p class="sub">Plan trips, take registers on the day and know every child is accounted for.</p></div></section>
      <div class="doors">
        <section class="card" data-label="Organisers">
          <h2>Plan and manage trips</h2>
          <p class="muted">Sign in with your LwLAT Microsoft account, the same one you use for Pulse.</p>
          ${S.sso ? `<a class="btn primary" href="/api/auth/login">Sign in with Microsoft</a>` : `<div class="warnbox">Microsoft sign-in hasn't been set up on this site yet.</div>`}
          ${S.devSso ? '<p class="muted small">Local test mode: you can sign in as any email.</p>' : ''}
        </section>
        <section class="card" data-label="On a trip">
          <h2>On a trip today?</h2>
          <p class="muted">Use your work email and the password from your trip email.</p>
          <a class="btn primary" href="#/day">Log in to my trip</a>
        </section>
      </div>`;
    return;
  }
  const me = S.me;
  const mine = await api('/mytrips');
  const schools = S.schools.filter(s => (me.viewSchools || []).includes(s.id));
  const role = me.trustAdmin ? 'Trust admin' : me.schools.length ? 'Trip organiser' : schools.length ? 'Attendance' : 'Staff';
  app.innerHTML = `${topbar('', role, '', `${greeting()}, <span class="grad">${firstName(me.name)}.</span>`)}
    ${schools.length ? `<h2>Your schools</h2><p class="onbg-note">Open a school to see its trips out today, live.</p><div class="schools">${schools.map(s => `<a class="school" href="#/school/${s.id}" data-sid="${s.id}"><span class="pill">${me.schools.includes(s.id) ? 'Organiser' : 'View'}</span><span class="crest" aria-hidden="true">${esc(initials(s.name))}</span><b>${esc(s.name)}</b></a>`).join('')}</div>` : ''}
    <h2>Trips you're staffing</h2>
    ${mine.length ? `<div class="trips">${mine.map(tripCard).join('')}</div>` : `<div class="empty">You're not on any trips. When an organiser adds you to one, it will appear here and you'll get an email with your trip login.</div>`}
    ${!schools.length && !me.trustAdmin ? `<div class="infobox">If you organise trips, or need to watch trips from school (e.g. attendance), ask a trust admin to give you access.</div>` : ''}
    <p class="footer-links">${me.schools.length ? '<a href="#/activity">Activity log</a>' : ''}${me.trustAdmin ? ' · <a href="#/trust">Trust admin</a>' : ''}</p>`;
  paintTiles();
}
function tripCard(t) {
  const d = new Date(t.date + 'T12:00:00'), t0 = today();
  const chip = t.status === 'closed' ? '<span class="chip closed">Closed</span>' : (t.date <= t0 && (t.endDate || t.date) >= t0) ? '<span class="chip today">On now</span>' : t.date > t0 ? '<span class="chip upcoming">Upcoming</span>' : '<span class="chip">Past</span>';
  const sch = schoolOf(t.schoolId);
  return `<a class="trip" href="#/trip/${t.schoolId}/${t.id}">
    <div class="date"><small>${d.toLocaleDateString('en-GB', { month: 'short' })}</small><b>${d.getDate()}</b></div>
    <div class="info"><b>${esc(t.name)}</b><span class="muted small">${esc([sch && S.me.schools.length !== 1 ? sch.name : '', fmtDates(t), t.venue].filter(Boolean).join(' · '))}</span><br>
    <span class="small">${t.pupilCount} pupils · ${t.staffCount} staff${t.lead ? ' · Lead: ' + esc(t.lead) : ''}${t.createdBy ? ' · Set up by ' + esc(t.createdBy.name) : ''}</span></div>${chip}</a>`;
}

/* ---------------- on-the-day login ---------------- */
function viewDayLogin() {
  app.innerHTML = `
    <section class="pagehead"><div><a href="#/" class="eyebrow">← Trip Planner</a><h1>Log in to your <span class="grad">trip</span></h1><p class="sub">Use your LwLAT work email and the password from your trip email.</p></div></section>
    <form class="card narrow" id="daylogin" data-label="On a trip">
      <div class="error hidden" id="err"></div>
      <label class="field">Work email<input type="text" inputmode="email" name="email" autocomplete="username" required value="${esc(store.get('tt_email') || '')}"></label>
      <label class="field">Trip password<span class="hint">Looks like <b>river-maple-otter-123</b>. It's personal to you.</span><input type="password" name="password" autocomplete="current-password" required autocapitalize="none" spellcheck="false"></label>
      <button class="btn primary">Log in</button>
      <p class="muted small">Your login works from 6am on the first day of the trip until midnight on the last day.${S.sso ? ' Signed in to Microsoft? <a href="/api/auth/login">Use single sign-on instead</a>.' : ''}</p>
    </form>`;
  $('#daylogin').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      const r = await api('/trip-login', { method: 'POST', body: fd });
      store.set('tt_email', fd.email);
      location.hash = `#/trip/${r.schoolId}/${r.tripId}`;
    } catch (err) { showError($('#err'), err.message); }
  });
}
function viewSigninFailed() {
  app.innerHTML = `${topbar('Sign-in didn\'t work', 'Microsoft sign-in')}
    <div class="card narrow" data-label="Sign in"><p>Microsoft sign-in didn't complete. Please try again. If it keeps happening, contact IT.</p><a class="btn primary" href="/api/auth/login">Try again</a> <a class="btn" href="#/">Back</a></div>`;
}

/* ---------------- trust admin ---------------- */
async function viewTrust() {
  if (!S.me.trustAdmin) { location.hash = '#/'; return; }
  const c = await api('/trust/settings');
  const lines = a => esc((a || []).join('\n'));
  app.innerHTML = `${topbar('Trust admin', 'Settings', '<a class="btn" href="#/activity">Activity log</a><a class="btn" href="#/">Home</a>')}
    <form id="trustform">
    <section class="card" data-label="Email">
      <h2>Trip login emails</h2>
      ${c.mail ? `<div class="infobox">Trip logins are emailed from <b>${esc(c.mailSender)}</b>.</div>` : `<div class="warnbox"><b>Email isn't set up yet.</b> Until it is, organisers will be shown each person's password to pass on. See the README (MAIL_SENDER).</div>`}
      <h3>Trust-wide email domains</h3>
      <p class="muted small">Staff with these email domains can be added to any school's trip, e.g. <b>lwlat.org.uk</b>. One per line.</p>
      <textarea name="trustDomains" rows="2">${lines(c.trustDomains)}</textarea>
    </section><br>
    <section class="card" data-label="Schools">
      <h2>Schools</h2>
      <p class="muted small">Only staff with an LwLAT email domain can be added to a trip. Trip organisers sign in with Microsoft to set up and manage that school's trips. Enter one email address per line.</p>
      ${S.schools.map(s => `<h3>${esc(s.name)}</h3><div class="grid2">
        <label class="field">Email domains<textarea name="dom_${s.id}" rows="2" placeholder="e.g. babington.lwlat.org.uk">${lines(c.domains[s.id])}</textarea></label>
        <label class="field">Trip organisers<span class="hint">Set up and manage trips.</span><textarea name="org_${s.id}" rows="3" placeholder="name@school domain">${lines(c.organisers[s.id])}</textarea></label>
        <span></span><label class="field">Attendance viewers<span class="hint">Read-only: watch trips live from school (e.g. attendance team, office).</span><textarea name="view_${s.id}" rows="3" placeholder="name@school domain">${lines(c.viewers[s.id])}</textarea></label></div>`).join('')}
    </section><br>
    <section class="card" data-label="Access">
      <h2>Trust admins</h2>
      <p class="muted small">Trust admins can manage these settings and every school's trips. One email per line.${c.envAdmins.length ? ` Always admins (set in Netlify): <b>${c.envAdmins.map(esc).join(', ')}</b>.` : ''}</p>
      <textarea name="trustAdmins" rows="3">${lines(c.trustAdmins)}</textarea>
      <br><button class="btn primary">Save settings</button>
    </section></form>`;
  $('#trustform').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const body = { trustDomains: fd.trustDomains, trustAdmins: fd.trustAdmins, domains: {}, organisers: {}, viewers: {} };
    for (const s of S.schools) { body.domains[s.id] = fd['dom_' + s.id]; body.organisers[s.id] = fd['org_' + s.id]; body.viewers[s.id] = fd['view_' + s.id]; }
    try { const r = await api('/trust/settings', { method: 'PUT', body }); toast(r.changes ? 'Settings saved' : 'No changes'); S.me = null; viewTrust(); }
    catch (err) { toast(err.message, true); }
  });
}

/* ---------------- activity log ---------------- */
async function viewActivity() {
  const month = S.auditMonth || new Date().toISOString().slice(0, 7);
  const school = S.auditSchool || '';
  const r = await api(`/audit?month=${month}&school=${encodeURIComponent(school)}`);
  const allowed = S.schools.filter(s => S.me.trustAdmin || S.me.schools.includes(s.id));
  app.innerHTML = `${topbar('Activity log', 'Who did what', '<a class="btn" href="#/">Home</a>')}
    <div class="controls"><input type="month" id="am" value="${month}" aria-label="Month">
      <select id="as" aria-label="School"><option value="">All my schools</option>${allowed.map(s => `<option value="${s.id}" ${s.id === school ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><span></span></div>
    ${r.entries.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>School</th><th>Trip</th><th>What</th></tr></thead><tbody>
      ${r.entries.map(e => `<tr><td>${fmtDateTime(e.at)}</td><td><b>${esc(e.by)}</b><br><span class="muted small">${esc(e.email)}</span></td><td>${esc(e.school ? (schoolOf(e.school) || {}).name : 'Trust')}</td><td>${e.tripId && e.school ? `<a href="#/trip/${e.school}/${e.tripId}">${esc(e.trip)}</a>` : esc(e.trip || '')}</td><td>${esc(e.action)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">Nothing logged for this month.</div>'}
    <p class="muted small">Every register mark and change is also recorded in each trip's own log (Manage trip → Trip log).</p>`;
  $('#am').addEventListener('change', e => { S.auditMonth = e.target.value; viewActivity(); });
  $('#as').addEventListener('change', e => { S.auditSchool = e.target.value; viewActivity(); });
}

/* ---------------- school trips list ---------------- */
async function viewTrips(sid) {
  const sch = schoolOf(sid); if (!sch) { location.hash = '#/'; return; }
  const canPlan = S.me.trustAdmin || S.me.schools.includes(sid);
  const [trips, live] = await Promise.all([api(`/s/${sid}/trips`), api(`/s/${sid}/trips/live`)]);
  const t0 = today();
  const active = trips.filter(t => t.status !== 'closed' && (t.endDate || t.date) >= t0).sort((a, b) => a.date.localeCompare(b.date));
  const other = trips.filter(t => !active.includes(t));
  app.innerHTML = `${topbar(sch.name, canPlan ? 'Trip organiser' : 'Attendance view', canPlan ? `<a class="btn" href="trip-template.csv" download>CSV template</a><a class="btn" href="#/activity">Activity log</a><a class="btn primary" href="#/school/${sid}/new">+ New trip</a>` : '')}
    <div class="row"><h2>Trips out today</h2><span class="spacer"></span><span class="sync" id="sync">Live</span></div>
    <div id="board" class="board">${drawBoard(live)}</div>
    <h2>On now and upcoming</h2>
    ${active.length ? `<div class="trips">${active.map(tripCard).join('')}</div>` : `<div class="empty">No trips coming up.${canPlan ? ' Create one with <b>+ New trip</b>.' : ''}</div>`}
    ${other.length ? `<h2>Past and closed</h2><div class="trips">${other.map(tripCard).join('')}</div>` : ''}`;
  S.poll = setInterval(async () => {
    if (document.hidden) return;
    try {
      const l = await api(`/s/${sid}/trips/live`);
      if ($('#board')) $('#board').innerHTML = drawBoard(l);
      $('#sync') && ($('#sync').textContent = 'Live · updated ' + fmtTime(new Date().toISOString()), $('#sync').classList.remove('off'));
    } catch { $('#sync') && ($('#sync').textContent = 'Offline - retrying…', $('#sync').classList.add('off')); }
  }, 10000);
}

/* ---------------- Trips out today (office board) ---------------- */
const tel = n => n ? `<a href="tel:${esc(String(n).replace(/[^\d+]/g, ''))}">${esc(n)}</a>` : '';
function drawBoard(live) {
  if (!live.trips.length) return '<div class="empty">No trips out today.</div>';
  return [...live.trips].sort((a, b) => (a.status === 'closed') - (b.status === 'closed')).map(boardCard).join(''); // live trips first
}
function boardCard(t) {
  const cps = t.checkpoints, pupils = livePupils(t);
  const who = p => `<li><b>${esc(p.firstName)} ${esc(p.lastName)}</b> <span class="muted">${esc([p.form || p.yearGroup, p.group].filter(Boolean).join(' · '))}</span>${p.allergies || p.medical ? ' <span class="flag allergy">Medical</span>' : ''}</li>`;
  let li = -1; cps.forEach((cp, i) => { if (Object.keys(t.marks[cp.id] || {}).length) li = i; });
  const allMarks = cps.flatMap(cp => Object.values(t.marks[cp.id] || {}));
  const lastAt = allMarks.map(m => m.at).sort().pop();
  const mo = cpStats(t, 0);
  const absent = pupils.filter(p => (markOf(t, cps[0].id, p.id) || {}).status === 'absent');
  const left = []; pupils.forEach(p => cps.forEach((cp, i) => { const m = markOf(t, cp.id, p.id); if (i > 0 && m && m.status === 'left') left.push({ p, cp, m }); }));
  const added = pupils.filter(p => p.added), removed = t.pupils.filter(p => p.removed);
  const lead = t.staff.find(s => s.role === 'lead');
  let status;
  if (t.status === 'closed') status = '<div class="bstatus ok">Trip closed</div>';
  else if (li < 0) status = `<div class="bstatus wait">Morning register not started yet · ${pupils.length} pupils expected</div>`;
  else {
    const cp = cps[li], st = cpStats(t, li);
    const missing = pupils.filter(p => { const s = pupilState(t, p, li); return !s.excluded && !s.mark; });
    if (!missing.length) status = `<div class="bstatus ok">✓ All ${st.expected} accounted for at <b>${esc(cp.name)}</b></div>`;
    else if (cp.kind === 'morning') status = `<div class="bstatus wait"><b>Morning register in progress:</b> ${st.present + st.other} of ${st.expected} marked</div>`;
    else status = `<div class="bstatus bad" role="alert"><b>⚠ ${missing.length} not yet ${cp.kind === 'end' ? 'handed over / dismissed' : 'seen'} at ${esc(cp.name)}</b><ul class="names">${missing.map(who).join('')}</ul></div>`;
  }
  const section = (title, items, cls = '') => items.length ? `<details class="bsec ${cls}"><summary>${title} (${items.length})</summary><ul class="names">${items.join('')}</ul></details>` : '';
  return `<article class="bcard">
    <div class="bhead"><div><h3>${esc(t.name)}</h3><div class="muted small">${esc([t.venue, fmtDates(t)].filter(Boolean).join(' · '))}</div></div>
      <a class="btn small primary" href="#/trip/${t.schoolId}/${t.id}">Open register</a></div>
    ${lead ? `<div class="blead">Trip lead: <b>${esc(lead.name)}</b> ${tel(lead.phone)}</div>` : ''}
    <div class="bstats">
      <span><b>${mo.present}</b> on trip</span><span><b>${absent.length}</b> absent</span><span><b>${left.length}</b> left early</span>
      <span class="muted">Last register activity: ${lastAt ? fmtTime(lastAt) : 'none yet'}</span>
    </div>
    ${status}
    ${section('Absent at morning register', absent.map(who), 'att')}
    ${section('Left the trip early', left.map(({ p, cp, m }) => `<li><b>${esc(p.firstName)} ${esc(p.lastName)}</b> <span class="muted">at ${esc(cp.name)}, ${fmtTime(m.at)}, marked by ${esc(m.by)}</span></li>`))}
    ${section('Added on the day', added.map(p => `<li><b>${esc(p.firstName)} ${esc(p.lastName)}</b> <span class="muted">by ${esc(p.added.by)}, ${fmtTime(p.added.at)}${p.added.reason ? ' - ' + esc(p.added.reason) : ''}</span></li>`))}
    ${section('Removed from trip', removed.map(p => `<li><b>${esc(p.firstName)} ${esc(p.lastName)}</b> <span class="muted">by ${esc(p.removed.by)}, ${fmtTime(p.removed.at)}${p.removed.reason ? ' - ' + esc(p.removed.reason) : ''}</span></li>`))}
    <div class="bchecks">${cps.map((cp, i) => { const s = cpStats(t, i), n = s.present + s.other; return `<span class="${n === s.expected && s.expected ? 'done' : n ? 'part' : ''}">${esc(cp.name)}: ${n}/${s.expected}</span>`; }).join('')}</div>
  </article>`;
}

/* ---------------- new trip ---------------- */
const staffRow = (i, s = {}) => `<div class="staffrow staffrow4" data-i="${i}"><input type="text" name="sname" placeholder="Name" value="${esc(s.name)}" aria-label="Staff name"><input type="text" inputmode="email" name="semail" placeholder="Work email" value="${esc(s.email)}" aria-label="Staff email"><input type="tel" name="sphone" placeholder="Mobile (optional)" value="${esc(s.phone)}" aria-label="Staff mobile"><button type="button" class="btn small" data-act="rmrow" aria-label="Remove row">✕</button></div>`;
function viewNewTrip(sid) {
  const sch = schoolOf(sid);
  S.preview = null;
  app.innerHTML = `${topbar('New trip', sch.name, `<a class="btn" href="#/school/${sid}">Cancel</a>`)}
    <form class="card" id="newtrip" data-label="New trip">
      <div class="error hidden" id="err"></div>
      <h2>1. Trip details</h2>
      <div class="grid2">
        <label class="field">Trip name<input type="text" name="name" required maxlength="120" placeholder="e.g. Year 7 Twycross Zoo"></label>
        <label class="field">Venue<input type="text" name="venue" maxlength="120"></label>
        <label class="field">Start date<input type="date" name="date" required value="${today()}"></label>
        <label class="field">End date<span class="hint">Same as the start date for a day trip.</span><input type="date" name="endDate" value="${today()}"></label>
      </div>
      <label class="check"><input type="checkbox" name="lunch" checked> Add a lunchtime check-in</label>
      <label class="field">Other check-ins (optional)<span class="hint">Every trip has a morning register and an end-of-day check. One extra per line, e.g. "Back on coach".</span><textarea name="extra" rows="2"></textarea></label>

      <h2>2. Pupils</h2>
      <p class="muted small">Upload the completed CSV. <a href="trip-template.csv" download>Download the template</a> if you don't have it. Save from Excel as <b>CSV UTF-8</b>.</p>
      <label class="field">CSV file<input type="file" id="csvfile" accept=".csv,text/csv"></label>
      <div id="preview"></div>

      <h2>3. Staff going on the trip</h2>
      <p class="muted small">Use LwLAT work email addresses. ${S.mail ? 'Each person is emailed their own trip password when you create the trip.' : 'Email isn\'t set up yet, so you\'ll be shown each person\'s password to pass on.'}</p>
      <h3>Trip lead</h3>
      <p class="muted small">The trip lead's mobile (work or personal) is required, so school can reach them in an emergency. It's shown to staff on the trip, organisers and attendance viewers.</p>
      <div class="staffrow staffrow4"><input type="text" name="leadName" placeholder="Name" required aria-label="Trip lead name"><input type="text" inputmode="email" name="leadEmail" placeholder="Work email" required aria-label="Trip lead email"><input type="tel" name="leadPhone" placeholder="Mobile (required)" required aria-label="Trip lead mobile"><span></span></div>
      <h3>Other staff</h3>
      <div id="staffrows">${staffRow(0)}${staffRow(1)}</div>
      <button type="button" class="btn small" data-act="addrow">+ Add another</button>
      <br><br>
      <div class="row"><button class="btn primary" id="create" disabled>Create trip${S.mail ? ' and email staff' : ''}</button><a class="btn" href="#/school/${sid}">Cancel</a></div>
    </form>`;
  $('#csvfile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    if (f.size > 2.5e6) return toast('That file is too large.', true);
    const text = await f.text();
    try {
      const r = await api(`/s/${sid}/trips/preview`, { method: 'POST', body: { csv: text } });
      S.preview = { csv: text, ...r };
      $('#create').disabled = !!r.errors.length || !r.pupils.length;
      const home = p => p.home === 'own' ? 'Own way home' : p.home === 'collected' ? 'Collected' + (p.collector ? ' (' + esc(p.collector) + ')' : '') : '<span class="muted">Not set</span>';
      $('#preview').innerHTML = `
        ${r.errors.length ? `<div class="error">${r.errors.map(esc).join('<br>')}</div>` : `<div class="infobox"><b>${r.pupils.length} pupils</b> found. Check the list below.</div>`}
        ${r.warnings.length ? `<div class="warnbox"><b>Check these:</b><ul>${r.warnings.slice(0, 30).map(w => `<li>${esc(w)}</li>`).join('')}${r.warnings.length > 30 ? `<li>…and ${r.warnings.length - 30} more</li>` : ''}</ul></div>` : ''}
        ${r.pupils.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Form</th><th>Group</th><th>Medical / allergies</th><th>Emergency contact</th><th>Home</th></tr></thead><tbody>
        ${r.pupils.map(p => `<tr><td>${esc(p.firstName)} ${esc(p.lastName)}</td><td>${esc(p.form)}</td><td>${esc(p.group)}</td><td>${esc([p.medical, p.allergies && 'Allergy: ' + p.allergies].filter(Boolean).join('; '))}</td><td>${esc(p.ec1Name)} ${esc(p.ec1Phone)}</td><td>${home(p)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}`;
    } catch (err) { toast(err.message, true); }
  });
  $('#newtrip').addEventListener('submit', async e => {
    e.preventDefault();
    if (!S.preview) return toast('Upload the pupil CSV first.', true);
    const form = e.target, fd = Object.fromEntries(new FormData(form));
    const staff = [...form.querySelectorAll('#staffrows .staffrow')].map(r => ({ name: r.querySelector('[name=sname]').value, email: r.querySelector('[name=semail]').value, phone: r.querySelector('[name=sphone]').value })).filter(s => s.name.trim() || s.email.trim());
    const btn = $('#create'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const r = await api(`/s/${sid}/trips`, { method: 'POST', body: { name: fd.name, date: fd.date, endDate: fd.endDate || fd.date, venue: fd.venue, lunch: !!fd.lunch, extra: String(fd.extra || '').split('\n').map(s => s.trim()).filter(Boolean), csv: S.preview.csv, lead: { name: fd.leadName, email: fd.leadEmail, phone: fd.leadPhone }, staff } });
      showIssued(r, `/trip/${sid}/${r.id}`, 'Trip created');
    } catch (err) { btn.disabled = false; btn.textContent = 'Create trip'; showError($('#err'), err.message); }
  });
}
// After creating a trip or resetting a password: say who was emailed, and show any passwords that must be handed out.
function showIssued(r, goTo, title) {
  const handout = r.toHandOut || [];
  openDialog(`<h2>${esc(title)}</h2>
    ${r.emailed && r.emailed.length ? `<div class="infobox">Trip login emailed to: <b>${r.emailed.map(esc).join(', ')}</b></div>` : ''}
    ${handout.length ? `<div class="warnbox"><b>Pass these passwords on.</b> They were not emailed${handout[0].problem.includes('not set up') ? ' (email isn\'t set up yet)' : ''}. This is the only time they're shown. Hand them over in person or by Teams message, not by email to personal addresses.</div>
      <div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Password</th></tr></thead><tbody>${handout.map(h => `<tr><td>${esc(h.name)}</td><td>${esc(h.email)}</td><td><b class="pw">${esc(h.password)}</b>${h.problem.startsWith('failed') ? `<br><span class="small muted">${esc(h.problem)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
    ${dlgButtons(goTo ? 'Open the trip' : 'Done', false, true)}`, () => { if (goTo) location.hash = '#' + goTo; else render(); });
}

/* ---------------- register ---------------- */
const markOf = (t, cpId, pid) => (t.marks[cpId] || {})[pid];
const livePupils = t => t.pupils.filter(p => !p.removed);
function pupilState(t, p, cpIdx) {
  const cps = t.checkpoints, cp = cps[cpIdx];
  if (cp.kind !== 'morning') {
    const mm = markOf(t, cps[0].id, p.id);
    if (mm && mm.status === 'absent') return { excluded: 'Not on trip (absent at morning register)' };
    for (let j = 1; j < cpIdx; j++) { const mk = markOf(t, cps[j].id, p.id); if (mk && mk.status === 'left') return { excluded: `Left trip early (${cps[j].name}, ${fmtTime(mk.at)})` }; }
  }
  return { mark: markOf(t, cp.id, p.id) };
}
function cpStats(t, idx) {
  let expected = 0, present = 0, other = 0, excluded = 0;
  for (const p of livePupils(t)) {
    const s = pupilState(t, p, idx);
    if (s.excluded) { excluded++; continue; }
    expected++;
    if (s.mark && s.mark.status === 'present') present++; else if (s.mark) other++;
  }
  return { expected, present, other, excluded, outstanding: expected - present - other };
}

async function loadTrip(sid, tid) {
  const fresh = !S.trip || S.trip.id !== tid;
  S.ctx = { sid, tid };
  S.trip = await api(tripPath(sid, tid));
  if (fresh) { S.expanded.clear(); S.q = ''; S.group = ''; S.only = ''; S.cpId = null; }
  return S.trip;
}
async function viewTrip(sid, tid) {
  const t = await loadTrip(sid, tid);
  if (!S.cpId || !t.checkpoints.some(c => c.id === S.cpId)) {
    const idx = t.checkpoints.findIndex((c, i) => cpStats(t, i).outstanding > 0);
    S.cpId = t.checkpoints[idx >= 0 ? idx : 0].id;
  }
  const groups = [...new Set(livePupils(t).map(p => p.group).filter(Boolean))].sort();
  const isTripLogin = S.me.kind === 'trip', ro = !t.perm.act;
  const lead = t.staff.find(s => s.role === 'lead');
  app.innerHTML = `${topbar(t.name, `${fmtDates(t)}${t.venue ? ' · ' + t.venue : ''}`, isTripLogin ? '' : `<a class="btn small" href="#/${t.perm.manage || ro ? 'school/' + sid : ''}">${t.perm.manage || ro ? 'All trips' : 'Home'}</a>`)}
    ${t.status === 'closed' ? '<div class="warnbox"><b>This trip is closed.</b> Registers are read-only.' + (t.perm.manage ? ' Reopen it from Manage trip.' : '') + '</div>' : ''}
    ${ro ? '<div class="infobox"><b>View only.</b> You\'re watching this trip live. Registers update every few seconds.</div>' : ''}
    <div class="whoami no-print">You: <b>${esc(S.me.name)}</b> (${esc(S.me.email)})${isTripLogin ? ` · trip login until ${new Date(t.window.end - 1000).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}${lead ? ` · Trip lead: <b>${esc(lead.name)}</b> ${tel(lead.phone)}` : ''}</div>
    <div class="toolbar no-print">
      <a class="btn small" href="/api${tripPath(sid, tid)}/export.csv">Download CSV</a>
      <a class="btn small" href="#/trip/${sid}/${tid}/report">PDF report</a>
      ${t.status !== 'closed' && !ro ? '<button class="btn small" data-act="addpupil">+ Add pupil</button>' : ''}
      <a class="btn small" href="#/trip/${sid}/${tid}/manage">${t.perm.manage ? 'Manage trip' : 'Trip info'}</a>
      <span class="spacer"></span><span class="sync" id="sync">Live</span>
    </div>
    <div class="tabs" id="tabs" role="tablist"></div>
    <div id="alert"></div>
    <div class="stats" id="stats"></div>
    <div class="controls">
      <input type="search" id="q" placeholder="Search name or form" value="${esc(S.q)}" aria-label="Search pupils">
      <select id="grp" aria-label="Filter by group"><option value="">All groups</option>${groups.map(g => `<option ${g === S.group ? 'selected' : ''}>${esc(g)}</option>`).join('')}</select>
      <select id="only" aria-label="Show"><option value="">Everyone</option><option value="out" ${S.only === 'out' ? 'selected' : ''}>Not yet marked</option><option value="med" ${S.only === 'med' ? 'selected' : ''}>Medical / allergy</option></select>
    </div>
    <div class="list" id="list"></div>`;
  $('#q').addEventListener('input', e => { S.q = e.target.value; drawRegister(); });
  $('#grp').addEventListener('change', e => { S.group = e.target.value; drawRegister(); });
  $('#only').addEventListener('change', e => { S.only = e.target.value; drawRegister(); });
  drawRegister();
  S.poll = setInterval(async () => {
    if (document.hidden || dlg.open) return;
    try {
      const r = await api(`${tripPath(sid, tid)}?since=${S.trip.version}`);
      $('#sync') && ($('#sync').textContent = 'Live · updated ' + fmtTime(new Date().toISOString()), $('#sync').classList.remove('off'));
      if (r) { S.trip = r; drawRegister(); }
    } catch (e) { $('#sync') && ($('#sync').textContent = 'Offline - retrying…', $('#sync').classList.add('off')); }
  }, POLL_MS);
}
async function refreshTrip() { S.trip = await api(tripPath(S.ctx.sid, S.ctx.tid)); if ($('#list')) drawRegister(); }

function markLabel(cp, p, mk) {
  if (cp.kind === 'morning') {
    if (!mk) return ['', 'Mark present'];
    if (mk.status === 'absent') return ['absent', 'Absent'];
    return ['present', `✓ Present<small>${fmtTime(mk.at)}</small>`];
  }
  if (cp.kind === 'end') {
    if (!mk) return ['', p.home === 'collected' ? 'Hand over' : p.home === 'own' ? 'Dismiss' : 'Set home first'];
    if (mk.status === 'left') return ['left', 'Left early'];
    return ['present', `✓ ${p.home === 'own' ? 'Gone home' : 'Collected'}<small>${fmtTime(mk.at)}</small>`];
  }
  if (!mk) return ['', 'Mark here'];
  if (mk.status === 'left') return ['left', 'Left early'];
  return ['present', `✓ Here<small>${fmtTime(mk.at)}</small>`];
}
function homeLine(p) {
  if (p.home === 'collected') return `<div class="home collected">Collected${p.collector ? ' by ' + esc(p.collector) : ' (collector not named)'}</div>`;
  if (p.home === 'own') return `<div class="home own">Making own way home</div>`;
  return `<div class="home unset">⚠ Home arrangement not set</div>`;
}
function flags(p) {
  return `<span class="flags">${p.medical ? '<span class="flag med">Medical</span>' : ''}${p.allergies ? '<span class="flag allergy">Allergy</span>' : ''}${p.medication ? '<span class="flag meds">Meds</span>' : ''}${p.added ? '<span class="flag added">Added on the day</span>' : ''}</span>`;
}

function drawRegister() {
  const t = S.trip; if (!t || !$('#list')) return;
  const idx = t.checkpoints.findIndex(c => c.id === S.cpId);
  const cp = t.checkpoints[idx];
  const closed = t.status === 'closed' || !t.perm.act;
  $('#tabs').innerHTML = t.checkpoints.map((c, i) => {
    const st = cpStats(t, i);
    return `<button class="tab ${c.id === S.cpId ? 'active' : ''}" role="tab" data-act="cp" data-id="${c.id}"><b>${esc(c.name)}</b><span>${st.present + st.other}/${st.expected} marked</span></button>`;
  }).join('') + (closed ? '' : `<button class="tab add" data-act="addcp" title="Add a check-in">+ Check-in</button>`);

  const st = cpStats(t, idx);
  const isLater = cp.kind !== 'morning';
  const lbl = cp.kind === 'morning' ? ['Pupils', 'Present', 'Absent'] : cp.kind === 'end' ? ['On trip', 'Gone home', 'Left early'] : ['On trip', 'Here', 'Left early'];
  $('#stats').innerHTML = `
    <div class="stat"><b>${st.expected}</b><span>${lbl[0]}</span></div>
    <div class="stat good"><b>${st.present}</b><span>${lbl[1]}</span></div>
    <div class="stat ${st.outstanding && isLater ? 'bad' : ''}"><b>${st.outstanding}</b><span>${isLater ? 'Not yet seen' : 'To register'}</span></div>
    <div class="stat"><b>${st.other + (isLater ? st.excluded : 0)}</b><span>${isLater ? 'Not on trip / left' : lbl[2]}</span></div>`;
  $('#alert').innerHTML = isLater && st.outstanding && Object.keys(t.marks[cp.id] || {}).length
    ? `<div class="alert" role="alert">⚠ ${st.outstanding} ${st.outstanding === 1 ? 'pupil' : 'pupils'} not yet seen at ${esc(cp.name)}<span class="spacer"></span><button class="btn small" data-act="showout">Show them</button></div>`
    : st.expected && !st.outstanding ? `<div class="alert ok">✓ All ${st.expected} pupils accounted for at ${esc(cp.name)}</div>` : '';

  const q = S.q.trim().toLowerCase();
  const rows = livePupils(t)
    .filter(p => !q || `${p.firstName} ${p.lastName} ${p.form} ${p.yearGroup}`.toLowerCase().includes(q))
    .filter(p => !S.group || p.group === S.group)
    .filter(p => S.only !== 'med' || p.medical || p.allergies || p.medication)
    .map(p => ({ p, s: pupilState(t, p, idx) }))
    .filter(r => S.only !== 'out' || (!r.s.excluded && !r.s.mark))
    .sort((a, b) => a.p.lastName.localeCompare(b.p.lastName) || a.p.firstName.localeCompare(b.p.firstName));
  const active = rows.filter(r => !r.s.excluded), excl = rows.filter(r => r.s.excluded);
  const row = ({ p, s }) => {
    const mk = s.mark;
    const cls = s.excluded ? 'excluded' : mk ? mk.status : isLater ? 'outstanding' : '';
    const [mcls, mtxt] = s.excluded ? ['absent', 'Not on trip'] : markLabel(cp, p, mk);
    const open = S.expanded.has(p.id);
    return `<article class="pupil ${cls}" data-pid="${p.id}">
      <div class="main">
        <button class="who" data-act="expand" data-pid="${p.id}" aria-expanded="${open}">
          <b>${esc(p.firstName)} ${esc(p.lastName)}</b>${flags(p)}
          <div class="meta">${esc([p.form || p.yearGroup, p.group].filter(Boolean).join(' · '))}${s.excluded ? ' · ' + esc(s.excluded) : ''}</div>
          ${cp.kind === 'end' && !s.excluded ? homeLine(p) : ''}
        </button>
        <button class="mark ${mcls}" data-act="mark" data-pid="${p.id}" ${closed || s.excluded ? 'disabled' : ''}>${mtxt}</button>
      </div>
      ${open ? details(p, cp, s, closed) : ''}
    </article>`;
  };
  $('#list').innerHTML = (active.length ? active.map(row).join('') : `<div class="empty">No pupils match.</div>`)
    + (excl.length ? `<div class="section-label">Not on trip at this point (${excl.length})</div>` + excl.map(row).join('') : '');
}

function details(p, cp, s, closed) {
  const t = S.trip;
  const dl = [
    ['Medical', p.medical], ['Allergies', p.allergies], ['Medication', p.medication],
    ['Emergency contact', p.ec1Name || p.ec1Phone ? `${esc(p.ec1Name)}${p.ec1Relation ? ' (' + esc(p.ec1Relation) + ')' : ''} ${tel(p.ec1Phone)}` : '', true],
    ['Second contact', p.ec2Name || p.ec2Phone ? `${esc(p.ec2Name)} ${tel(p.ec2Phone)}` : '', true],
    ['Going home', p.home === 'collected' ? 'Collected' + (p.collector ? ' by ' + p.collector : '') : p.home === 'own' ? 'Own way home' : 'Not set'],
    ['Admission no', p.admissionNo], ['Notes', p.notes],
    ['Added on the day', p.added ? `${p.added.by} (${p.added.email}), ${fmtDateTime(p.added.at)}${p.added.reason ? ' - ' + p.added.reason : ''}` : ''],
  ].filter(r => r[1]);
  const hist = t.checkpoints.map(c => { const mk = markOf(t, c.id, p.id); return mk ? `<li>${esc(c.name)}: ${mk.status === 'left' ? 'left early' : mk.status} at ${fmtTime(mk.at)} by ${esc(mk.by)}</li>` : ''; }).join('');
  const b = (act, label, extra = '') => `<button class="btn small ${extra}" data-act="${act}" data-pid="${p.id}" ${closed ? 'disabled' : ''}>${label}</button>`;
  const actions = s.excluded ? '' : cp.kind === 'morning'
    ? b('set-present', 'Present') + b('set-absent', 'Absent') + b('set-clear', 'Clear mark')
    : b('set-present', cp.kind === 'end' ? 'Mark gone home' : 'Mark here') + b('set-left', 'Left trip early') + b('set-clear', 'Clear mark');
  return `<div class="details">
    <dl>${dl.map(([k, v, raw]) => `<dt>${k}</dt><dd>${raw ? v : esc(v)}</dd>`).join('')}</dl>
    ${hist ? `<ul class="history">${hist}</ul>` : ''}
    ${t.perm.act ? `<div class="actions">${actions}${b('home', 'Change home arrangement')}${b('editpupil', 'Edit details')}${b('rmpupil', 'Remove from trip', 'danger')}</div>` : ''}</div>`;
}

async function setMark(pid, status) {
  const t = S.trip, cp = t.checkpoints.find(c => c.id === S.cpId);
  const prev = markOf(t, cp.id, pid);
  t.marks[cp.id] ||= {};
  if (status === 'clear') delete t.marks[cp.id][pid];
  else t.marks[cp.id][pid] = { status, by: S.me.name, at: new Date().toISOString() };
  drawRegister(); // optimistic
  try { await api(`${tripPath(S.ctx.sid, S.ctx.tid)}/mark`, { method: 'POST', body: { checkpointId: cp.id, pupilId: pid, status } }); }
  catch (e) { if (prev) t.marks[cp.id][pid] = prev; else delete t.marks[cp.id][pid]; drawRegister(); toast(e.message, true); }
}
function homeDialog(pid, thenMark) {
  const p = S.trip.pupils.find(x => x.id === pid);
  openDialog(`<h2>Going home: ${esc(p.firstName)} ${esc(p.lastName)}</h2>
    <div class="seg" role="radiogroup">
      <label><input type="radio" name="home" value="collected" ${p.home !== 'own' ? 'checked' : ''}> Collected</label>
      <label><input type="radio" name="home" value="own" ${p.home === 'own' ? 'checked' : ''}> Own way home</label>
    </div><br><br>
    <label class="field">Collected by<span class="hint">Name and relationship of the adult collecting.</span><input type="text" name="collector" maxlength="100" value="${esc(p.collector)}"></label>
    <label class="field">Reason for change (optional)<span class="hint">e.g. "Mum phoned at 2pm". Recorded in the trip log.</span><input type="text" name="reason" maxlength="150"></label>
    ${dlgButtons(thenMark ? 'Save and dismiss' : 'Save')}`, async fd => {
      await api(`${tripPath(S.ctx.sid, S.ctx.tid)}/home`, { method: 'POST', body: { pupilId: pid, home: fd.home, collector: fd.collector, reason: fd.reason } });
      p.home = fd.home; p.collector = fd.home === 'collected' ? fd.collector : '';
      if (thenMark) await setMark(pid, 'present'); else drawRegister();
      toast('Home arrangement saved');
    });
}
const PUPIL_FORM = [
  ['firstName', 'First name', 1], ['lastName', 'Last name', 1], ['admissionNo', 'Admission no'], ['yearGroup', 'Year group'], ['form', 'Form'], ['group', 'Staff group'],
  ['medical', 'Medical needs'], ['allergies', 'Allergies'], ['medication', 'Medication'], ['ec1Name', 'Emergency contact name'], ['ec1Relation', 'Relationship'], ['ec1Phone', 'Emergency contact phone'],
  ['ec2Name', 'Second contact name'], ['ec2Phone', 'Second contact phone'], ['collector', 'Collected by'], ['notes', 'Notes'],
];
function pupilDialog(pid, after) {
  const t = S.trip, p = pid ? t.pupils.find(x => x.id === pid) : {};
  openDialog(`<h2>${pid ? 'Edit ' + esc(p.firstName) + ' ' + esc(p.lastName) : 'Add a pupil to this trip'}</h2>
    ${pid ? '' : `<div class="infobox">Your name and email are recorded against this pupil as the person who added them.</div>
      <label class="field">Why are they being added?<span class="hint">e.g. "Brought signed permission slip on the day"</span><input type="text" name="reason" required maxlength="200"></label>`}
    <div class="grid2">${PUPIL_FORM.map(([k, l, req]) => `<label class="field">${l}<input type="text" name="${k}" value="${esc(p[k])}" ${req ? 'required' : ''} maxlength="300"></label>`).join('')}</div>
    <label class="field">Going home<select name="home"><option value="">Not set</option><option value="collected" ${p.home === 'collected' ? 'selected' : ''}>Collected</option><option value="own" ${p.home === 'own' ? 'selected' : ''}>Own way home</option></select></label>
    ${dlgButtons(pid ? 'Save changes' : 'Add pupil')}`, async fd => {
      await api(`${tripPath(S.ctx.sid, S.ctx.tid)}/pupils${pid ? '/' + pid : ''}`, { method: pid ? 'PUT' : 'POST', body: fd });
      toast(pid ? 'Saved' : 'Pupil added'); await (after || refreshTrip)();
    });
}
function removePupilDialog(pid, after) {
  const p = S.trip.pupils.find(x => x.id === pid);
  openDialog(`<h2>Remove ${esc(p.firstName)} ${esc(p.lastName)} from the trip?</h2>
    <p>They'll disappear from the registers. The removal is recorded with your name, and they stay listed under "Removed from trip" in the report.</p>
    <label class="field">Reason<input type="text" name="reason" required maxlength="200" placeholder="e.g. Didn't bring permission slip"></label>
    ${dlgButtons('Remove from trip', true)}`, async fd => {
      await api(`${tripPath(S.ctx.sid, S.ctx.tid)}/pupils/${pid}?reason=${encodeURIComponent(fd.reason)}`, { method: 'DELETE' });
      S.expanded.delete(pid); toast('Pupil removed'); await (after || refreshTrip)();
    });
}

/* ---------------- manage / trip info ---------------- */
async function viewManage(sid, tid) {
  const t = await loadTrip(sid, tid);
  const m = t.perm.manage;
  const again = () => viewManage(sid, tid);
  const lead = t.staff.find(s => s.role === 'lead');
  const removed = t.pupils.filter(p => p.removed), added = t.pupils.filter(p => p.added && !p.removed);
  app.innerHTML = `${topbar(t.name, m ? 'Manage trip' : 'Trip info', `<a class="btn" href="#/trip/${sid}/${tid}">Back to register</a>`)}
    <section class="card" data-label="Trip details">
      <p class="muted small">Set up by <b>${esc(t.createdBy.name)}</b> (${esc(t.createdBy.email)}) on ${fmtDateTime(t.createdAt)}.</p>
      ${m ? `<form id="tripform"><div class="grid2">
        <label class="field">Trip name<input type="text" name="name" value="${esc(t.name)}" required></label>
        <label class="field">Venue<input type="text" name="venue" value="${esc(t.venue)}"></label>
        <label class="field">Start date<input type="date" name="date" value="${esc(t.date)}" required></label>
        <label class="field">End date<input type="date" name="endDate" value="${esc(t.endDate || t.date)}" required></label>
      </div><div class="row"><button class="btn primary">Save details</button><span class="spacer"></span>
        <button type="button" class="btn" data-act="togglestatus">${t.status === 'closed' ? 'Reopen trip' : 'Close trip'}</button></div></form>`
      : `<p><b>${esc(fmtDates(t))}</b>${t.venue ? ' · ' + esc(t.venue) : ''}</p>`}
      <p class="muted small">Trip logins work from ${new Date(t.window.start).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} to ${new Date(t.window.end - 1000).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${t.status === 'closed' ? ' (trip closed, so they no longer work)' : ''}.</p>
    </section>

    <h2>Staff on this trip</h2>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Mobile</th><th>Role</th><th>Trip login email</th>${m ? '<th></th>' : ''}</tr></thead><tbody>
      ${t.staff.map(s => `<tr><td><b>${esc(s.name)}</b><br><span class="muted small">${esc(s.email)}</span></td><td>${s.phone ? tel(s.phone) : '<span class="muted">-</span>'}</td><td>${s.role === 'lead' ? '<span class="chip today">Trip lead</span>' : 'Staff'}</td>
        <td class="small">${s.emailStatus === 'sent' ? 'Sent ' + fmtDateTime(s.emailedAt) : esc(s.emailStatus || '')}</td>
        ${m ? `<td class="row"><button class="btn small" data-act="editstaff" data-sid="${s.id}">Edit</button>${s.role !== 'lead' ? `<button class="btn small" data-act="makelead" data-sid="${s.id}">Make lead</button>` : ''}<button class="btn small" data-act="resend" data-sid="${s.id}">New password${S.mail ? ' & email' : ''}</button><button class="btn small danger" data-act="rmstaff" data-sid="${s.id}">Remove</button></td>` : ''}</tr>`).join('')}
    </tbody></table></div>
    ${m ? `<form class="staffrow staffrow4 addstaff" id="addstaff"><input type="text" name="name" placeholder="Name" required aria-label="Name"><input type="text" inputmode="email" name="email" placeholder="Work email" required aria-label="Email"><input type="tel" name="phone" placeholder="Mobile (optional)" aria-label="Mobile"><button class="btn primary">+ Add staff</button></form>` : ''}
    ${!lead ? '<div class="warnbox">This trip has no trip lead.</div>' : ''}

    <h2>Check-ins</h2>
    <div class="table-wrap"><table><tbody>${t.checkpoints.map(c => `<tr><td><b>${esc(c.name)}</b></td><td class="muted">${c.kind === 'custom' ? 'Optional' + (c.by ? ', added by ' + esc(c.by) : '') : 'Always included'}</td>
      <td>${m && c.kind === 'custom' ? `<button class="btn small danger" data-act="delcp" data-id="${c.id}">Remove</button>` : ''}</td></tr>`).join('')}</tbody></table></div>

    <div class="row"><h2>Pupils (${t.pupils.length - removed.length})</h2><span class="spacer"></span>${t.status !== 'closed' && t.perm.act ? '<button class="btn small" data-act="addpupil">+ Add pupil</button>' : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Form</th><th>Group</th><th>Home</th><th>Medical</th><th></th></tr></thead><tbody>
      ${livePupils(t).sort((a, b) => a.lastName.localeCompare(b.lastName)).map(p => `<tr><td>${esc(p.firstName)} ${esc(p.lastName)}${p.added ? `<br><span class="small muted">Added by ${esc(p.added.by)}, ${fmtDateTime(p.added.at)}</span>` : ''}</td><td>${esc(p.form)}</td><td>${esc(p.group)}</td>
      <td>${p.home === 'own' ? 'Own way' : p.home === 'collected' ? 'Collected' : '<span class="muted">-</span>'}</td><td>${flags(p)}</td>
      <td class="row">${t.perm.act ? `<button class="btn small" data-act="editpupil" data-pid="${p.id}">Edit</button><button class="btn small danger" data-act="rmpupil" data-pid="${p.id}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${removed.length ? `<h3 class="onbg">Removed from trip</h3><div class="table-wrap"><table><tbody>${removed.map(p => `<tr><td>${esc(p.firstName)} ${esc(p.lastName)}</td><td>Removed by <b>${esc(p.removed.by)}</b> (${esc(p.removed.email)}), ${fmtDateTime(p.removed.at)}${p.removed.reason ? ' - ' + esc(p.removed.reason) : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}

    <h2>Trip log</h2>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>
      ${t.log.slice(-400).reverse().map(l => `<tr><td>${fmtDateTime(l.at)}</td><td>${esc(l.by)}<br><span class="muted small">${esc(l.email || '')}</span></td><td>${esc(l.action)}</td></tr>`).join('')}
    </tbody></table></div>
    ${m ? `<h2>Delete trip</h2><p class="muted small">Download the CSV or PDF report first. Deleting removes all pupil data for this trip permanently. The deletion is recorded in the activity log.</p>
    <button class="btn danger" data-act="deltrip">Delete this trip</button>` : ''}`;
  S.after = again;
  if (m) {
    $('#tripform').addEventListener('submit', async e => {
      e.preventDefault();
      try { await api(tripPath(sid, tid), { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) }); toast('Saved'); again(); } catch (err) { toast(err.message, true); }
    });
    $('#addstaff').addEventListener('submit', async e => {
      e.preventDefault();
      try { const r = await api(`${tripPath(sid, tid)}/staff`, { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); showIssued(r, null, 'Staff member added'); }
      catch (err) { toast(err.message, true); }
    });
  }
}

/* ---------------- report (print / save as PDF) ---------------- */
async function viewReport(sid, tid) {
  const t = await loadTrip(sid, tid);
  const label = { present: 'Present', absent: 'Absent', left: 'Left early' };
  const cell = (c, p) => {
    const s = pupilState(t, p, t.checkpoints.indexOf(c));
    if (s.excluded) return '<td class="st-absent">-</td>';
    const mk = s.mark;
    return mk ? `<td class="st-${mk.status}">${label[mk.status]} ${fmtTime(mk.at)}<br><span class="muted">${esc(mk.by)}</span></td>` : '<td class="st-none">Not marked</td>';
  };
  const pupils = livePupils(t).sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const removed = t.pupils.filter(p => p.removed), added = pupils.filter(p => p.added);
  const lead = t.staff.find(s => s.role === 'lead');
  app.innerHTML = `${topbar('Report: ' + t.name, schoolOf(sid).name, `<a class="btn small" href="#/trip/${sid}/${tid}">Back</a>`)}
    <div class="row no-print"><button class="btn primary" data-act="print">Print / Save as PDF</button><a class="btn" href="/api${tripPath(sid, tid)}/export.csv">Download CSV</a>
      <span class="muted small">In the print window, choose <b>Save as PDF</b> as the printer.</span></div>
    <section class="report card" data-label="Attendance report">
      <h1>${esc(schoolOf(sid).name)}: ${esc(t.name)}</h1>
      <p class="meta-line">${esc(fmtDates(t))}${t.venue ? ' · ' + esc(t.venue) : ''} · ${pupils.length} pupils · Set up by ${esc(t.createdBy.name)} (${esc(t.createdBy.email)})<br>
      Trip lead: ${lead ? esc(lead.name) + (lead.phone ? ' (' + esc(lead.phone) + ')' : '') : '-'} · Staff: ${t.staff.filter(s => s.role !== 'lead').map(s => esc(s.name)).join(', ') || '-'}<br>Generated ${fmtDateTime(new Date().toISOString())} by ${esc(S.me.name)}</p>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Pupil</th><th>Adm no</th><th>Form</th>${t.checkpoints.map(c => `<th>${esc(c.name)}</th>`).join('')}<th>Going home</th></tr></thead><tbody>
      ${pupils.map((p, i) => `<tr><td>${i + 1}</td><td><b>${esc(p.lastName)}, ${esc(p.firstName)}</b>${p.added ? '<br><span class="muted">Added on the day</span>' : ''}</td><td>${esc(p.admissionNo)}</td><td>${esc(p.form || p.yearGroup)}</td>${t.checkpoints.map(c => cell(c, p)).join('')}
        <td>${p.home === 'collected' ? 'Collected' + (p.collector ? ' by ' + esc(p.collector) : '') : p.home === 'own' ? 'Own way' : '-'}</td></tr>`).join('')}
      </tbody></table></div>
      <h2>Summary</h2>
      <div class="table-wrap"><table><thead><tr><th>Check-in</th><th>Expected</th><th>Present</th><th>Absent / left</th><th>Not marked</th></tr></thead><tbody>
      ${t.checkpoints.map((c, i) => { const s = cpStats(t, i); return `<tr><td>${esc(c.name)}</td><td>${s.expected}</td><td>${s.present}</td><td>${s.other}</td><td>${s.outstanding}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${added.length ? `<h2>Added on the day</h2><div class="table-wrap"><table><tbody>${added.map(p => `<tr><td><b>${esc(p.firstName)} ${esc(p.lastName)}</b></td><td>Added by ${esc(p.added.by)} (${esc(p.added.email)}), ${fmtDateTime(p.added.at)}</td><td>${esc(p.added.reason || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
      ${removed.length ? `<h2>Removed from trip</h2><div class="table-wrap"><table><tbody>${removed.map(p => `<tr><td><b>${esc(p.firstName)} ${esc(p.lastName)}</b></td><td>Removed by ${esc(p.removed.by)} (${esc(p.removed.email)}), ${fmtDateTime(p.removed.at)}</td><td>${esc(p.removed.reason || '')}</td></tr>`).join('')}</tbody></table></div>` : ''}
    </section>`;
}

/* ---------------- global click handling ---------------- */
app.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, pid = el.dataset.pid, t = S.trip;
  const base = t && S.ctx ? tripPath(S.ctx.sid, S.ctx.tid) : '';
  const onManage = /\/manage$/.test(location.hash);
  const after = onManage ? () => viewManage(S.ctx.sid, S.ctx.tid) : null;
  try {
    switch (act) {
      case 'logout': await logout(); break;
      case 'addrow': { const box = $('#staffrows'); box.insertAdjacentHTML('beforeend', staffRow(box.children.length)); box.lastElementChild.querySelector('input').focus(); break; }
      case 'rmrow': el.closest('.staffrow').remove(); break;
      case 'cp': S.cpId = el.dataset.id; S.only = ''; $('#only').value = ''; drawRegister(); break;
      case 'showout': S.only = 'out'; $('#only').value = 'out'; drawRegister(); break;
      case 'expand': S.expanded.has(pid) ? S.expanded.delete(pid) : S.expanded.add(pid); drawRegister(); break;
      case 'mark': {
        const cp = t.checkpoints.find(c => c.id === S.cpId), p = t.pupils.find(x => x.id === pid);
        if (markOf(t, cp.id, pid)) { S.expanded.add(pid); drawRegister(); break; } // already marked: open details to change it
        if (cp.kind === 'end' && !p.home) { homeDialog(pid, true); break; }
        await setMark(pid, 'present'); break;
      }
      case 'set-present': case 'set-absent': case 'set-left': case 'set-clear':
        if (act === 'set-present' && t.checkpoints.find(c => c.id === S.cpId).kind === 'end' && !t.pupils.find(x => x.id === pid).home) { homeDialog(pid, true); break; }
        await setMark(pid, act.slice(4)); break;
      case 'home': homeDialog(pid, false); break;
      case 'addpupil': pupilDialog(null, after); break;
      case 'editpupil': pupilDialog(pid, after); break;
      case 'rmpupil': removePupilDialog(pid, after); break;
      case 'addcp':
        openDialog(`<h2>Add a check-in</h2><label class="field">Name<span class="hint">e.g. "Back on coach", "After gift shop"</span><input type="text" name="name" required maxlength="60"></label>${dlgButtons('Add')}`, async fd => {
          await api(`${base}/checkpoints`, { method: 'POST', body: fd });
          S.trip = await api(base);
          const addedCp = S.trip.checkpoints.filter(c => c.kind === 'custom').pop();
          if (onManage) after(); else { S.cpId = addedCp.id; drawRegister(); }
          toast('Check-in added');
        }); break;
      case 'delcp':
        if (!confirm('Remove this check-in and any marks taken for it?')) break;
        await api(`${base}/checkpoints/${el.dataset.id}`, { method: 'DELETE' }); after(); break;
      case 'togglestatus':
        await api(base, { method: 'PUT', body: { status: t.status === 'closed' ? 'active' : 'closed' } }); toast(t.status === 'closed' ? 'Trip reopened' : 'Trip closed. Trip logins have stopped working.'); after(); break;
      case 'editstaff': {
        const s = t.staff.find(x => x.id === el.dataset.sid);
        openDialog(`<h2>Contact details: ${esc(s.name)}</h2>
          <label class="field">Name<input type="text" name="name" value="${esc(s.name)}" required maxlength="80"></label>
          <label class="field">Mobile (work or personal)${s.role === 'lead' ? '<span class="hint">Required for the trip lead.</span>' : ''}<input type="tel" name="phone" value="${esc(s.phone)}" ${s.role === 'lead' ? 'required' : ''}></label>
          <p class="muted small">Email can't be changed here because it's their login. To use a different email, remove them and add them again.</p>
          ${dlgButtons('Save')}`, async fd => { await api(`${base}/staff/${s.id}`, { method: 'PUT', body: fd }); toast('Saved'); after(); });
        break;
      }
      case 'makelead': await api(`${base}/staff/${el.dataset.sid}/lead`, { method: 'POST' }); toast('Trip lead changed'); after(); break;
      case 'resend': {
        const s = t.staff.find(x => x.id === el.dataset.sid);
        if (!confirm(`Give ${s.name} a new trip password?${S.mail ? ' It will be emailed to them.' : ''} Their old password stops working straight away.`)) break;
        const r = await api(`${base}/staff/${s.id}/resend`, { method: 'POST' }); showIssued(r, null, 'New password issued'); break;
      }
      case 'rmstaff': {
        const s = t.staff.find(x => x.id === el.dataset.sid);
        if (!confirm(`Remove ${s.name} from this trip? Their trip login stops working straight away.`)) break;
        await api(`${base}/staff/${s.id}`, { method: 'DELETE' }); toast('Removed'); after(); break;
      }
      case 'deltrip':
        openDialog(`<h2>Delete "${esc(t.name)}"?</h2><p>This permanently removes the trip, its registers and all pupil data. It cannot be undone. The deletion is recorded in the activity log.</p>
          <label class="field">Type DELETE to confirm<input type="text" name="confirm" required autocomplete="off"></label>${dlgButtons('Delete trip', true)}`, async fd => {
          if (fd.confirm.trim().toUpperCase() !== 'DELETE') throw new Error('Type DELETE to confirm.');
          await api(base, { method: 'DELETE' }); S.trip = null; toast('Trip deleted'); location.hash = '#/school/' + S.ctx.sid;
        }); break;
      case 'print': window.print(); break;
    }
  } catch (err) { toast(err.message, true); }
});

render();
