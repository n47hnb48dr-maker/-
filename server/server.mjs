// Kwast pilot server: shared accounts, jobs, offers and bookings.
// Zero dependencies: Node.js 22.5+ (built-in node:sqlite).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
// Test commission only: nothing is charged, no payment partner is involved.
export const FEE_PERCENT = 8;
const CITIES = ['Amsterdam','Utrecht','Rotterdam','Eindhoven','Groningen','Arnhem','Den Haag','Maastricht','Leiden','Haarlem','Breda','Zwolle','Tilburg','Almere','Nijmegen'];
const SESSION_DAYS = 30;
const MAX_BODY = 6 * 1024 * 1024;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, pass TEXT NOT NULL,
      name TEXT NOT NULL, city TEXT NOT NULL, team INTEGER NOT NULL CHECK (team BETWEEN 1 AND 200),
      kvk TEXT, cv TEXT NOT NULL DEFAULT '', experience TEXT NOT NULL DEFAULT '', proof TEXT,
      portrait TEXT NOT NULL DEFAULT '', gallery TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES companies(id), title TEXT NOT NULL, city TEXT NOT NULL,
      start TEXT NOT NULL, "end" TEXT NOT NULL, area INTEGER NOT NULL, team INTEGER NOT NULL, price_cents INTEGER NOT NULL,
      descr TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('open','booked','done')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), company_id TEXT NOT NULL REFERENCES companies(id),
      price_cents INTEGER NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (job_id, company_id));
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), owner TEXT NOT NULL, crew TEXT NOT NULL,
      start TEXT NOT NULL, "end" TEXT NOT NULL, team INTEGER NOT NULL, price_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('booked','cancelled','done')),
      created_at TEXT NOT NULL, closed_at TEXT, closed_by TEXT);
    CREATE INDEX IF NOT EXISTS bookings_crew ON bookings (crew, status);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking ON bookings (job_id) WHERE status = 'booked';
  `);
  return db;
}

const now = () => new Date().toISOString();
const uid = p => p + crypto.randomBytes(9).toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const dayNum = s => Math.round(Date.parse(s + 'T00:00:00Z') / 86400000);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
const cents = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) fail(400, `Укажите ${what} от 0,01 до 10 000 000 €.`); return Math.round(n * 100); };
const int = (v, lo, hi, what) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) fail(400, `${what}: целое число от ${lo} до ${hi}.`); return n; };
const text = (v, max, what, required = true) => { const s = String(v ?? '').trim(); if (required && !s) fail(400, `Заполните поле «${what}».`); if (s.length > max) fail(400, `Поле «${what}» длиннее ${max} символов.`); return s; };
const image = v => { const s = String(v || ''); if (!s) return ''; if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) || s.length > 1_500_000) fail(400, 'Изображение должно быть JPEG/PNG до 1 МБ.'); return s; };
export const feeCents = c => Math.round(c * FEE_PERCENT / 100);

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(pw, salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Peak number of painters a crew already has booked on any single day within [start, end].
export function peakLoad(db, crew, start, end, excludeJob = null) {
  const rows = db.prepare(`SELECT start, "end", team FROM bookings WHERE crew = ? AND status = 'booked' AND start <= ? AND "end" >= ? AND job_id IS NOT ?`).all(crew, end, start, excludeJob);
  const delta = new Map(); const s0 = dayNum(start), e0 = dayNum(end);
  for (const r of rows) {
    const a = Math.max(s0, dayNum(r.start)), b = Math.min(e0, dayNum(r.end)) + 1;
    delta.set(a, (delta.get(a) || 0) + r.team); delta.set(b, (delta.get(b) || 0) - r.team);
  }
  let used = 0, peak = 0;
  for (const k of [...delta.keys()].sort((x, y) => x - y)) { used += delta.get(k); peak = Math.max(peak, used); }
  return peak;
}

export function createApp({ dbFile = process.env.KWAST_DB || path.join(here, 'data', 'kwast.db'), staticDir = path.join(here, '..', 'dist'), attemptLimit = 10 } = {}) {
  const db = openDb(dbFile);
  const q = sql => db.prepare(sql);
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const attempts = new Map();

  const companyRow = id => q('SELECT * FROM companies WHERE id = ?').get(id);
  const publicCompany = (c, self) => ({
    id: c.id, name: c.name, city: c.city, team: c.team, cv: c.cv, experience: c.experience, proof: c.proof,
    portrait: c.portrait, gallery: JSON.parse(c.gallery), ...(self ? { email: c.email, kvk: c.kvk } : {}),
  });

  function state(me) {
    const companies = q('SELECT * FROM companies ORDER BY created_at').all().map(c => publicCompany(c, c.id === me));
    const offers = q('SELECT * FROM offers ORDER BY created_at').all();
    const active = new Map(q(`SELECT * FROM bookings WHERE status IN ('booked','done')`).all().map(b => [b.job_id, b]));
    const jobs = q('SELECT * FROM jobs ORDER BY created_at DESC').all().map(j => {
      const b = active.get(j.id), party = j.owner === me || b?.crew === me;
      return {
        id: j.id, title: j.title, city: j.city, owner: j.owner, status: j.status, start: j.start, end: j.end,
        area: j.area, team: j.team, price: j.price_cents / 100, desc: j.descr, updatedAt: j.updated_at,
        // Owners see every offer; other companies only their own.
        offers: offers.filter(o => o.job_id === j.id && (j.owner === me || o.company_id === me))
          .map(o => ({ id: o.id, by: o.company_id, price: o.price_cents / 100, note: o.note })),
        accepted: party && b ? b.crew : null,
      };
    });
    const bookings = q(`SELECT b.*, j.title FROM bookings b JOIN jobs j ON j.id = b.job_id WHERE b.owner = ? OR b.crew = ? ORDER BY b.created_at DESC`).all(me, me)
      .map(b => ({ id: b.id, job: b.job_id, title: b.title, owner: b.owner, crew: b.crew, start: b.start, end: b.end, team: b.team,
        price: b.price_cents / 100, fee: b.fee_cents / 100, status: b.status, createdAt: b.created_at, closedAt: b.closed_at, closedBy: b.closed_by }));
    return { me, feePercent: FEE_PERCENT, serverTime: now(), companies, jobs, bookings };
  }

  function newSession(companyId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q('INSERT INTO sessions (token_hash, company_id, expires_at) VALUES (?, ?, ?)').run(sha(token), companyId, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString());
    return token;
  }
  function auth(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) fail(401, 'Войдите в аккаунт компании.');
    const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(m[1]));
    if (!s || s.expires_at < now()) fail(401, 'Сессия истекла. Войдите снова.');
    return s.company_id;
  }
  function throttle(key) {
    const t = Date.now(), list = (attempts.get(key) || []).filter(x => t - x < 15 * 60e3);
    if (list.length >= attemptLimit) fail(429, 'Слишком много попыток входа. Подождите 15 минут.');
    list.push(t); attempts.set(key, list);
  }
  const loadJob = id => q('SELECT * FROM jobs WHERE id = ?').get(id) || fail(404, 'Объект не найден.');

  function profileFields(d, old = {}) {
    const team = int(d.team, 1, 200, 'Размер бригады');
    const city = CITIES.includes(d.city) ? d.city : fail(400, 'Выберите город из списка.');
    const kvk = String(d.kvk ?? old.kvk ?? '').trim();
    if (!/^\d{8}$/.test(kvk)) fail(400, 'Номер KvK — 8 цифр (в пилоте используйте вымышленный).');
    const gallery = Array.isArray(d.gallery) ? d.gallery.map(image) : JSON.parse(old.gallery || '[]');
    if (gallery.length > 4) fail(400, 'Можно добавить не больше четырёх фото портфолио.');
    const experience = text(d.experience, 100, 'Опыт', false);
    if (d.proofRequested && !experience) fail(400, 'Укажите, к какой компании относится фактура.');
    // A test invoice only ever yields "pending"; the server never marks experience as verified here.
    const proof = d.proofRequested ? 'pending' : (old.experience === experience ? old.proof ?? null : null);
    return { name: text(d.name, 65, 'Компания'), city, team, kvk, cv: text(d.cv, 1200, 'О команде', false), experience, proof,
      portrait: d.portrait === undefined ? (old.portrait || '') : image(d.portrait), gallery: JSON.stringify(gallery) };
  }

  const routes = {
    'POST /api/register': (_, d, req) => {
      throttle('reg:' + req.socket.remoteAddress);
      const email = text(d.email, 120, 'E-mail').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'Введите корректный e-mail.');
      if (String(d.password || '').length < 8) fail(400, 'Пароль — не короче 8 символов.');
      const f = profileFields(d), id = uid('c');
      try {
        q(`INSERT INTO companies (id, email, pass, name, city, team, kvk, cv, experience, proof, portrait, gallery, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, email, hashPassword(String(d.password)), f.name, f.city, f.team, f.kvk, f.cv, f.experience, f.proof, f.portrait, f.gallery, now());
      } catch (e) { if (/UNIQUE/.test(e.message)) fail(409, 'Компания с таким e-mail уже зарегистрирована.'); throw e; }
      return { token: newSession(id), state: state(id) };
    },
    'POST /api/login': (_, d, req) => {
      const email = String(d.email || '').trim().toLowerCase();
      throttle('login:' + email); throttle('ip:' + req.socket.remoteAddress);
      const c = q('SELECT * FROM companies WHERE email = ?').get(email);
      if (!c || !checkPassword(String(d.password || ''), c.pass)) fail(401, 'Неверный e-mail или пароль.');
      attempts.delete('login:' + email);
      return { token: newSession(c.id), state: state(c.id) };
    },
    'POST /api/logout': (me, _, req) => { q('DELETE FROM sessions WHERE token_hash = ?').run(sha(/^Bearer (.+)$/.exec(req.headers.authorization)[1])); return { ok: true }; },
    'GET /api/state': me => ({ state: state(me) }),
    'PUT /api/me': (me, d) => tx(() => {
      const old = companyRow(me), f = profileFields(d, old);
      if (f.team < old.team) {
        for (const b of q(`SELECT * FROM bookings WHERE crew = ? AND status = 'booked'`).all(me))
          if (peakLoad(db, me, b.start, b.end) > f.team) fail(409, 'Число маляров меньше уже забронированного на эти даты.');
      }
      q(`UPDATE companies SET name=?, city=?, team=?, kvk=?, cv=?, experience=?, proof=?, portrait=?, gallery=? WHERE id=?`)
        .run(f.name, f.city, f.team, f.kvk, f.cv, f.experience, f.proof, f.portrait, f.gallery, me);
      return { state: state(me) };
    }),
    'POST /api/jobs': (me, d) => {
      const start = d.start, end = d.end;
      if (!isDate(start) || !isDate(end)) fail(400, 'Укажите даты начала и завершения.');
      if (end < start) fail(400, 'Дата завершения должна быть не раньше начала.');
      if (start < today()) fail(400, 'Дата начала не может быть в прошлом.');
      if (dayNum(end) - dayNum(start) > 366) fail(400, 'Срок работ — не больше года.');
      if (!CITIES.includes(d.city)) fail(400, 'Выберите город из списка.');
      const id = uid('j'), t = now();
      q(`INSERT INTO jobs (id, owner, title, city, start, "end", area, team, price_cents, descr, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?)`).run(id, me, text(d.title, 85, 'Название'), d.city, start, end,
        int(d.area, 1, 999999, 'Площадь'), int(d.team, 1, 200, 'Число маляров'), cents(d.price, 'бюджет'), text(d.desc, 1800, 'Описание работ'), t, t);
      return { id, state: state(me) };
    },
    'POST /api/jobs/:id/offers': (me, d, _, id) => tx(() => {
      const j = loadJob(id), crew = companyRow(me);
      if (j.owner === me) fail(403, 'Нельзя откликнуться на собственный объект.');
      if (j.status !== 'open') fail(409, 'Объект уже забронирован или завершён.');
      if (q('SELECT 1 FROM offers WHERE job_id = ? AND company_id = ?').get(id, me)) fail(409, 'Вы уже отправили предложение на этот объект.');
      if (j.team + peakLoad(db, me, j.start, j.end) > crew.team) fail(409, 'Недостаточно свободных маляров на эти даты.');
      q('INSERT INTO offers (id, job_id, company_id, price_cents, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(uid('o'), id, me, cents(d.price, 'стоимость работ'), text(d.note, 1000, 'Условия предложения'), now());
      return { state: state(me) };
    }),
    'POST /api/jobs/:id/book': (me, d, _, id) => tx(() => {
      // BEGIN IMMEDIATE takes the write lock first, so the capacity check and the insert are one atomic step
      // even when two customers confirm the same crew at the same moment.
      const j = loadJob(id);
      if (j.owner !== me) fail(403, 'Подтвердить бронь может только заказчик объекта.');
      if (j.status !== 'open') fail(409, 'Объект уже забронирован или завершён.');
      const o = q('SELECT * FROM offers WHERE job_id = ? AND company_id = ?').get(id, String(d.crew || '')) || fail(404, 'Предложение бригады не найдено.');
      const crew = companyRow(o.company_id);
      const used = peakLoad(db, crew.id, j.start, j.end);
      if (used + j.team > crew.team) fail(409, `На эти даты у бригады свободно ${Math.max(0, crew.team - used)} из ${crew.team} маляров, а нужно ${j.team}. Бронь отклонена.`);
      const t = now();
      q(`INSERT INTO bookings (id, job_id, owner, crew, start, "end", team, price_cents, fee_cents, status, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,'booked',?)`).run(uid('b'), id, me, crew.id, j.start, j.end, j.team, o.price_cents, feeCents(o.price_cents), t);
      q(`UPDATE jobs SET status = 'booked', updated_at = ? WHERE id = ?`).run(t, id);
      return { state: state(me) };
    }),
    'POST /api/jobs/:id/cancel': (me, _, __, id) => tx(() => {
      const j = loadJob(id), b = q(`SELECT * FROM bookings WHERE job_id = ? AND status = 'booked'`).get(id);
      if (!b) fail(409, 'Активной брони по этому объекту нет.');
      if (me !== b.owner && me !== b.crew) fail(403, 'Отменить бронь может только заказчик или бригада.');
      const t = now();
      q(`UPDATE bookings SET status = 'cancelled', closed_at = ?, closed_by = ? WHERE id = ?`).run(t, me, b.id);
      q('DELETE FROM offers WHERE job_id = ? AND company_id = ?').run(id, b.crew);
      q(`UPDATE jobs SET status = 'open', updated_at = ? WHERE id = ?`).run(t, j.id);
      return { state: state(me) };
    }),
    'POST /api/jobs/:id/finish': (me, _, __, id) => tx(() => {
      const j = loadJob(id), b = q(`SELECT * FROM bookings WHERE job_id = ? AND status = 'booked'`).get(id);
      if (j.owner !== me) fail(403, 'Завершение подтверждает только заказчик.');
      if (!b) fail(409, 'Активной брони по этому объекту нет.');
      const t = now();
      q(`UPDATE bookings SET status = 'done', closed_at = ?, closed_by = ? WHERE id = ?`).run(t, me, b.id);
      q(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(t, id);
      return { state: state(me) };
    }),
  };
  const open = new Set(['POST /api/register', 'POST /api/login']);

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new HttpError(413, 'Слишком большой запрос. Уменьшите фото.')); req.destroy(); } else parts.push(c); });
      req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Некорректный JSON.')); } });
      req.on('error', reject);
    });
  }

  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(staticDir, rel);
    if (!file.startsWith(path.resolve(staticDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    // Bearer tokens (no cookies), so any origin may call the API: the WebView apps load from file:// and appassets.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
    if (!url.pathname.startsWith('/api/')) { if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname); else res.writeHead(405).end(); return; }
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === '/api/health') return send(200, { ok: true });
      const m = /^\/api\/jobs\/([A-Za-z0-9_-]+)\/(offers|book|cancel|finish)$/.exec(url.pathname);
      const key = req.method + ' ' + (m ? `/api/jobs/:id/${m[2]}` : url.pathname);
      const handler = routes[key] || fail(404, 'Неизвестный запрос.');
      const body = req.method === 'GET' ? {} : await readBody(req);
      const me = open.has(key) ? null : auth(req);
      send(200, handler(me, body, req, m?.[1]));
    } catch (e) {
      if (e instanceof HttpError) send(e.status, { error: e.message });
      else { console.error(e); send(500, { error: 'Ошибка сервера. Попробуйте ещё раз.' }); }
    }
  });
  return { server, db };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080), host = process.env.HOST || '0.0.0.0';
  const { server } = createApp();
  server.listen(port, host, () => console.log(`Kwast server: http://${host}:${port} (база: ${process.env.KWAST_DB || path.join(here, 'data', 'kwast.db')})`));
}
