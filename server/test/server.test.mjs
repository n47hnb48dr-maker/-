import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kwast-'));
const dbFile = path.join(dir, 'test.db');
let app, base;
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

async function start() {
  app = createApp({ dbFile, attemptLimit: 1000 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
}
async function stop() { await new Promise(r => app.server.close(r)); app.db.close(); }
async function call(token, method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
async function register(name, team) {
  const r = await call(null, 'POST', '/api/register', { email: name.toLowerCase().replace(/\s/g, '') + '@example.test', password: 'pilot-pass-1', name, city: 'Utrecht', team, kvk: '12345678' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.state.me };
}
const job = (s, id) => s.jobs.find(j => j.id === id);

test('cross-company booking flow, permissions, capacity, concurrency, cancel, restart', async t => {
  await start();
  const A = await register('Alpha Bouw', 2), B = await register('Beta Schilders', 4), C = await register('Gamma Vastgoed', 1), D = await register('Delta Afbouw', 3);

  await t.test('A publishes a job; B sees it on the shared board', async () => {
    const r = await call(A.token, 'POST', '/api/jobs', { title: 'Покраска офиса', city: 'Amsterdam', start: day(3), end: day(7), area: 200, team: 3, price: 4200, desc: 'Стены в два слоя' });
    assert.equal(r.status, 200); A.job = r.body.id;
    const s = (await call(B.token, 'GET', '/api/state')).body.state;
    assert.equal(job(s, A.job).status, 'open'); assert.equal(job(s, A.job).owner, A.id);
  });

  await t.test('validation and auth', async () => {
    assert.equal((await call(null, 'GET', '/api/state')).status, 401);
    assert.equal((await call('bogus', 'GET', '/api/state')).status, 401);
    assert.equal((await call(A.token, 'POST', '/api/jobs', { title: 'x', city: 'Amsterdam', start: day(5), end: day(2), area: 1, team: 1, price: 1, desc: 'x' })).status, 400);
    assert.equal((await call(A.token, 'POST', '/api/jobs', { title: 'x', city: 'Amsterdam', start: day(-3), end: day(2), area: 1, team: 1, price: 1, desc: 'x' })).status, 400);
    assert.equal((await call(null, 'POST', '/api/login', { email: 'alphabouw@example.test', password: 'wrong-pass' })).status, 401);
    assert.equal((await call(null, 'POST', '/api/register', { email: 'alphabouw@example.test', password: 'pilot-pass-1', name: 'X', city: 'Utrecht', team: 2, kvk: '12345678' })).status, 409);
  });

  await t.test('B offers its crew at its own price; owner cannot offer; crew too small is refused', async () => {
    assert.equal((await call(A.token, 'POST', `/api/jobs/${A.job}/offers`, { price: 1, note: 'x' })).status, 403);
    assert.equal((await call(C.token, 'POST', `/api/jobs/${A.job}/offers`, { price: 1, note: 'x' })).status, 409, 'C has 1 painter, job needs 3');
    const r = await call(B.token, 'POST', `/api/jobs/${A.job}/offers`, { price: 3900, note: 'Начнём в срок' });
    assert.equal(r.status, 200);
    assert.equal((await call(B.token, 'POST', `/api/jobs/${A.job}/offers`, { price: 3800, note: 'дубль' })).status, 409);
    const sa = (await call(A.token, 'GET', '/api/state')).body.state;
    assert.deepEqual(job(sa, A.job).offers.map(o => [o.by, o.price]), [[B.id, 3900]]);
    const sd = (await call(D.token, 'GET', '/api/state')).body.state;
    assert.equal(job(sd, A.job).offers.length, 0, 'third parties do not see other offers');
  });

  await t.test('only the owner may book; both sides then see the same booking', async () => {
    assert.equal((await call(B.token, 'POST', `/api/jobs/${A.job}/book`, { crew: B.id })).status, 403);
    assert.equal((await call(D.token, 'POST', `/api/jobs/${A.job}/book`, { crew: B.id })).status, 403);
    assert.equal((await call(A.token, 'POST', `/api/jobs/${A.job}/book`, { crew: B.id })).status, 200);
    assert.equal((await call(A.token, 'POST', `/api/jobs/${A.job}/book`, { crew: B.id })).status, 409, 'second confirm of same job');
    const sa = (await call(A.token, 'GET', '/api/state')).body.state, sb = (await call(B.token, 'GET', '/api/state')).body.state;
    const pick = s => { const b = s.bookings.find(x => x.job === A.job); return [b.start, b.end, b.price, b.fee, b.status, job(s, A.job).status, job(s, A.job).accepted]; };
    assert.deepEqual(pick(sa), pick(sb));
    assert.deepEqual(pick(sa).slice(2), [3900, 312, 'booked', 'booked', B.id]);
    assert.equal(job((await call(D.token, 'GET', '/api/state')).body.state, A.job).accepted, null);
  });

  await t.test('capacity: B (4 painters, 3 booked) cannot take another overlapping 2-painter job', async () => {
    const j = (await call(D.token, 'POST', '/api/jobs', { title: 'Фасад', city: 'Leiden', start: day(6), end: day(9), area: 90, team: 2, price: 2000, desc: 'Фасад' })).body.id;
    assert.equal((await call(B.token, 'POST', `/api/jobs/${j}/offers`, { price: 2000, note: 'x' })).status, 409);
    const k = (await call(D.token, 'POST', '/api/jobs', { title: 'Окна', city: 'Leiden', start: day(8), end: day(9), area: 20, team: 1, price: 500, desc: 'Окна' })).body.id;
    assert.equal((await call(B.token, 'POST', `/api/jobs/${k}/offers`, { price: 500, note: 'один маляр' })).status, 200, '3+1 fits');
    D.small = k;
  });

  await t.test('two customers confirm the same crew simultaneously: exactly one wins', async () => {
    const E = await register('Echo Schilders', 3);
    const jobs = [];
    for (const owner of [A, D]) {
      const r = await call(owner.token, 'POST', '/api/jobs', { title: 'Параллель ' + owner.id, city: 'Rotterdam', start: day(20), end: day(24), area: 100, team: 2, price: 3000, desc: 'x' });
      jobs.push([owner, r.body.id]);
      assert.equal((await call(E.token, 'POST', `/api/jobs/${r.body.id}/offers`, { price: 2900, note: 'x' })).status, 200);
    }
    const results = await Promise.all(jobs.map(([o, id]) => call(o.token, 'POST', `/api/jobs/${id}/book`, { crew: E.id })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.match(results.find(r => r.status === 409).body.error, /свободно 1 из 3/);
    const se = (await call(E.token, 'GET', '/api/state')).body.state;
    assert.equal(se.bookings.filter(b => b.status === 'booked').length, 1);
    // Repeat many times with a fresh pair to stress the race.
    for (let i = 0; i < 10; i++) {
      const F = await register('Foxtrot ' + i, 2), ids = [];
      for (const owner of [A, D]) { const r = await call(owner.token, 'POST', '/api/jobs', { title: 'R', city: 'Breda', start: day(30), end: day(31), area: 1, team: 2, price: 100, desc: 'x' }); ids.push([owner, r.body.id]); await call(F.token, 'POST', `/api/jobs/${r.body.id}/offers`, { price: 100, note: 'x' }); }
      const rs = await Promise.all(ids.map(([o, id]) => call(o.token, 'POST', `/api/jobs/${id}/book`, { crew: F.id })));
      assert.deepEqual(rs.map(r => r.status).sort(), [200, 409]);
    }
  });

  await t.test('profile cannot shrink the crew below booked load', async () => {
    const r = await call(B.token, 'PUT', '/api/me', { name: 'Beta Schilders', city: 'Utrecht', team: 2, kvk: '12345678' });
    assert.equal(r.status, 409);
  });

  await t.test('cancel: only parties; both see cancelled; painters free again', async () => {
    assert.equal((await call(D.token, 'POST', `/api/jobs/${A.job}/cancel`)).status, 403);
    assert.equal((await call(B.token, 'POST', `/api/jobs/${A.job}/cancel`)).status, 200, 'crew may cancel too');
    for (const who of [A, B]) {
      const s = (await call(who.token, 'GET', '/api/state')).body.state;
      assert.equal(s.bookings.find(b => b.job === A.job).status, 'cancelled');
      assert.equal(s.bookings.find(b => b.job === A.job).closedBy, B.id);
      assert.equal(job(s, A.job).status, 'open');
    }
    const j = (await call(D.token, 'POST', '/api/jobs', { title: 'После отмены', city: 'Leiden', start: day(4), end: day(6), area: 90, team: 3, price: 2000, desc: 'x' })).body.id;
    assert.equal((await call(B.token, 'POST', `/api/jobs/${j}/offers`, { price: 2100, note: 'Теперь свободны' })).status, 200);
    assert.equal((await call(D.token, 'POST', `/api/jobs/${j}/book`, { crew: B.id })).status, 200);
    assert.equal((await call(D.token, 'POST', `/api/jobs/${j}/finish`)).status, 200);
    assert.equal((await call(B.token, 'POST', `/api/jobs/${j}/cancel`)).status, 409, 'finished booking cannot be cancelled');
  });

  await t.test('data and sessions survive a server restart', async () => {
    const before = (await call(A.token, 'GET', '/api/state')).body.state;
    await stop(); await start();
    const after = (await call(A.token, 'GET', '/api/state')).body.state;
    assert.deepEqual(after.bookings, before.bookings);
    assert.deepEqual(after.jobs, before.jobs);
    const login = await call(null, 'POST', '/api/login', { email: 'betaschilders@example.test', password: 'pilot-pass-1' });
    assert.equal(login.status, 200);
  });
  await stop();
});
