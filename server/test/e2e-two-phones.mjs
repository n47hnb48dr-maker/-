// Сквозная проверка: две компании на двух «телефонах» (отдельные браузерные контексты) проводят сделку через сервер.
// Запуск: node --no-warnings server/test/e2e-two-phones.mjs [папка-для-скриншотов]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createApp } from '../server.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');
const shots = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'kwast-shots-'));
fs.mkdirSync(shots, { recursive: true });
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kwast-e2e-')), 'e2e.db');
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

let app = createApp({ dbFile });
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const port = app.server.address().port, base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const log = m => console.log('✓ ' + m);

async function phone(device) {
  const ctx = await browser.newContext({ ...devices[device], locale: 'ru-RU' });
  const page = await ctx.newPage();
  page.on('pageerror', e => { throw e; });
  await page.goto(base);
  return page;
}
const shot = (p, name) => p.screenshot({ path: path.join(shots, name + '.png') });
const toast = async (p, re) => { await p.locator('#toast').filter({ hasText: re }).waitFor({ timeout: 8000 }); };
async function register(p, { name, team, email }) {
  await p.click('[data-action=gateTab][data-id=register]');
  await p.fill('#entry [name=name]', name);
  await p.selectOption('#entry [name=city]', 'Utrecht');
  await p.fill('#entry [name=team]', String(team));
  await p.fill('#entry [name=kvk]', '12345678');
  await p.fill('#entry [name=email]', email);
  await p.fill('#entry [name=password]', 'pilot-pass-1');
  await p.click('#entry [type=submit]');
  await toast(p, 'Компания зарегистрирована');
}
async function publish(p, { title, cityName, start, end, team, price }) {
  await p.click('.publish');
  await p.fill('#entry [name=title]', title);
  await p.selectOption('#entry [name=city]', cityName);
  await p.fill('#entry [name=start]', start);
  await p.fill('#entry [name=end]', end);
  await p.fill('#entry [name=area]', '180');
  await p.fill('#entry [name=team]', String(team));
  await p.fill('#entry [name=price]', String(price));
  await p.fill('#entry [name=desc]', 'Подготовка стен и покраска в два слоя.');
  await p.click('#entry [type=submit]');
  await toast(p, 'Объект опубликован');
  await p.click('#close');
}
async function openFromDeals(p, title) {
  await p.click('.mobileNav [data-page=deals]');
  await p.locator('#view .job', { hasText: title }).first().click();
  await p.locator('#modal h2', { hasText: title }).waitFor();
}
async function offer(p, title, amount, blocked = false) {
  await p.click('.mobileNav [data-page=jobs]');
  await p.click('[data-action=mode][data-id=list]');
  await p.locator('.cards .job', { hasText: title }).click();
  await p.click('#modal [data-action=offer]');
  if (blocked) return;
  await p.fill('#entry [name=amount]', String(amount));
  await p.fill('#entry [name=note]', 'Бригада свободна, начнём в срок.');
  await p.click('#entry [type=submit]');
}
const bookingFacts = async p => {
  const info = await p.locator('#modal .info').nth(1).innerText();
  const pill = await p.locator('#modal .pill').first().innerText();
  return { info, pill };
};

try {
  // 1. Компания А (iPhone) регистрируется и публикует объект.
  const A = await phone('iPhone 13');
  await A.locator('.gatePanel').waitFor();
  await shot(A, '01-login');
  await register(A, { name: 'Alpha Bouw', team: 2, email: 'alpha@example.test' });
  await publish(A, { title: 'Покраска офиса у канала', cityName: 'Amsterdam', start: day(3), end: day(7), team: 3, price: 4500 });
  log('А зарегистрировалась и опубликовала объект (Амстердам, 3 маляра, 4 500 €)');

  // 2. Компания Б (Android) видит объект на карте и предлагает бригаду по своей цене.
  const B = await phone('Pixel 7');
  await register(B, { name: 'Beta Schilders', team: 4, email: 'beta@example.test' });
  const pin = B.locator('.kw-pin');
  await pin.first().waitFor();
  assert.equal(await pin.count(), 1);
  await shot(B, '02-crew-map');
  await pin.first().click();
  await B.locator('#modal h2', { hasText: 'Покраска офиса у канала' }).waitFor();
  await B.click('#modal [data-action=offer]');
  await B.fill('#entry [name=amount]', '4100');
  await B.fill('#entry [name=note]', 'Бригада из трёх маляров, начнём в срок.');
  await shot(B, '03-crew-offer');
  // А держит карточку объекта открытой — отклик должен появиться сам (опрос сервера каждые 10 с).
  await openFromDeals(A, 'Покраска офиса у канала');
  await B.click('#entry [type=submit]');
  await toast(B, 'Предложение отправлено');
  log('Б нашла объект на карте и предложила бригаду за 4 100 €');

  await A.locator('#modal .offer', { hasText: 'Beta Schilders' }).waitFor({ timeout: 15000 });
  log('Отклик Б появился у А без перезагрузки (автообновление)');
  await shot(A, '04-owner-sees-offer');

  // 3. А открывает профиль Б и подтверждает бронь.
  await A.locator('#modal .offer [data-action=profile]').click();
  await A.locator('#modal h2', { hasText: 'Beta Schilders' }).waitFor();
  assert.match(await A.locator('#modal').innerText(), /4 чел\./);
  await shot(A, '05-crew-profile');
  await A.click('#close');
  await openFromDeals(A, 'Покраска офиса у канала');
  await A.click('#modal [data-action=book]');
  await A.click('#modal [data-action=doBook]');
  await toast(A, 'Бригада забронирована');
  log('А открыла профиль Б и подтвердила бронь');

  // Перезапуск: обе стороны перезагружают приложение, а сервер перезапускается с той же базой.
  await new Promise(r => app.server.close(r)); app.db.close();
  app = createApp({ dbFile }); await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  await A.reload(); await B.reload();
  await openFromDeals(A, 'Покраска офиса у канала');
  await openFromDeals(B, 'Покраска офиса у канала');
  const fa = await bookingFacts(A), fb = await bookingFacts(B);
  assert.equal(fa.pill, 'Забронирован'); assert.equal(fb.pill, 'Забронирован');
  assert.equal(fa.info, fb.info, 'одинаковые даты, состав и цена у обеих сторон');
  assert.match(fa.info, /4\s100/);
  await shot(A, '06-owner-booked-after-restart');
  await shot(B, '07-crew-booked-after-restart');
  log(`После перезапуска обе стороны видят: «${fa.info.replace(/\s+/g, ' ')}», статус «${fa.pill}»`);
  await A.click('#close'); await B.click('#close');

  // 4. Недостаточно маляров + одновременное подтверждение двумя заказчиками.
  const C = await phone('iPhone 13');
  await register(C, { name: 'Gamma Vastgoed', team: 1, email: 'gamma@example.test' });
  await publish(C, { title: 'Фасад в Лейдене', cityName: 'Leiden', start: day(5), end: day(6), team: 2, price: 2000 });
  await offer(B, 'Фасад в Лейдене', 2000, true);
  await toast(B, 'Недостаточно свободных маляров');
  // Сервер отказывает и в обход проверки на устройстве (например, устаревшие данные на телефоне).
  const direct = await B.evaluate(async () => {
    const c = JSON.parse(localStorage.getItem('kwast-connection')), s = JSON.parse(localStorage.getItem('kwast-server-cache')).state;
    const j = s.jobs.find(x => x.title === 'Фасад в Лейдене');
    const r = await fetch(c.server + '/api/jobs/' + j.id + '/offers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token }, body: JSON.stringify({ price: 2000, note: 'x' }) });
    return [r.status, (await r.json()).error];
  });
  assert.deepEqual(direct, [409, 'Недостаточно свободных маляров на эти даты.']);
  log('Б не может взять второй объект на те же даты: занято 3 из 4 маляров (отказ и на телефоне, и на сервере)');
  await B.click('#close').catch(() => {});

  await publish(A, { title: 'Склад в Роттердаме', cityName: 'Rotterdam', start: day(20), end: day(22), team: 3, price: 3000 });
  await publish(C, { title: 'Шоурум в Бреде', cityName: 'Breda', start: day(21), end: day(23), team: 3, price: 3200 });
  for (const t of ['Склад в Роттердаме', 'Шоурум в Бреде']) { await offer(B, t, 2900); await toast(B, 'Предложение отправлено'); await B.click('#close'); }
  for (const [p, t] of [[A, 'Склад в Роттердаме'], [C, 'Шоурум в Бреде']]) {
    await p.reload(); await openFromDeals(p, t); await p.click('#modal [data-action=book]'); await p.locator('#modal [data-action=doBook]').waitFor();
  }
  await Promise.all([A.click('#modal [data-action=doBook]'), C.click('#modal [data-action=doBook]')]);
  const outcome = await Promise.all([A, C].map(async p => {
    await p.locator('#toast').filter({ hasText: /забронирована|свободно/ }).waitFor();
    return p.locator('#toast').innerText();
  }));
  assert.equal(outcome.filter(t => /Бригада забронирована/.test(t)).length, 1, outcome.join(' | '));
  assert.equal(outcome.filter(t => /свободно 1 из 4 маляров, а нужно 3/.test(t)).length, 1, outcome.join(' | '));
  const loser = /свободно/.test(outcome[0]) ? A : C;
  await shot(loser, '08-concurrent-rejected');
  log('Одновременное подтверждение: одна бронь принята, вторую сервер отклонил — ' + outcome.find(t => /свободно/.test(t)));

  // 5. Б отменяет основную бронь, обе стороны видят новый статус, маляры снова свободны.
  await B.reload();
  await openFromDeals(B, 'Покраска офиса у канала');
  await B.click('#modal [data-action=cancelBooking]');
  await B.click('#modal [data-action=doCancel]');
  await toast(B, 'Бронь отменена');
  await A.reload(); await A.click('.mobileNav [data-page=deals]');
  await A.locator('#view .job', { hasText: 'Покраска офиса у канала' }).filter({ hasText: 'Бронь отменена' }).waitFor();
  await B.click('#close'); await B.click('.mobileNav [data-page=deals]');
  await B.locator('#view .job', { hasText: 'Покраска офиса у канала' }).filter({ hasText: 'Бронь отменена' }).waitFor();
  await shot(A, '09-owner-sees-cancel');
  await openFromDeals(A, 'Покраска офиса у канала');
  assert.match(await A.locator('#modal').innerText(), /отменил\(а\) Beta Schilders/);
  assert.equal(await A.locator('#modal .pill').first().innerText(), 'Открыт');
  log('Б отменила бронь: у А и у Б статус «Бронь отменена», объект снова открыт');
  await offer(B, 'Фасад в Лейдене', 2000);
  await toast(B, 'Предложение отправлено');
  log('Маляры Б снова свободны: отклик на «Фасад в Лейдене» на те же даты принят');

  // Деморежим отдельно: без регистрации, сервер не нужен.
  const D = await phone('Pixel 7');
  await D.click('.gateDemo [data-action=demo]');
  await D.locator('.accountName', { hasText: 'демо' }).waitFor();
  assert.ok(await D.locator('.kw-pin').count() >= 5);
  await shot(D, '10-demo');
  log('Деморежим открывается без регистрации и показывает демо-компании');
  console.log('\nВсе проверки пройдены. Скриншоты: ' + shots);
} finally {
  await browser.close();
  await new Promise(r => app.server.close(r));
}
