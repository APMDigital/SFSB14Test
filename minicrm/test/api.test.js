'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db');
const { createServer } = require('../src/server');
const { seed } = require('../src/seed');

let server;
let base;
let db;

before(async () => {
  db = openDatabase(':memory:');
  server = createServer({ db });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => {
  server.close();
  db.close();
});

async function call(path, method = 'GET', body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

test('health and meta', async () => {
  assert.equal((await call('/health')).data.ok, true);
  const meta = (await call('/meta')).data;
  assert.deepEqual(meta.deal_stages, ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost']);
});

test('company CRUD with validation', async () => {
  let r = await call('/companies', 'POST', { industry: 'X' });
  assert.equal(r.status, 400);
  assert.equal(r.data.errors.name, 'Required');

  r = await call('/companies', 'POST', { name: '  Test Co  ', website: 'test.example' });
  assert.equal(r.status, 201);
  assert.equal(r.data.name, 'Test Co');
  assert.equal(r.data.website, 'https://test.example');
  const id = r.data.id;

  r = await call(`/companies/${id}`, 'PATCH', { industry: 'Testing' });
  assert.equal(r.status, 200);
  assert.equal(r.data.industry, 'Testing');
  assert.equal(r.data.name, 'Test Co');

  r = await call(`/companies/${id}`, 'PUT', { name: '' });
  assert.equal(r.status, 400);

  r = await call(`/companies/${id}`, 'DELETE');
  assert.equal(r.status, 204);
  assert.equal((await call(`/companies/${id}`)).status, 404);
  assert.equal((await call(`/companies/${id}`, 'DELETE')).status, 404);
});

test('contacts: enum, email and reference validation; search & filter', async () => {
  const co = (await call('/companies', 'POST', { name: 'Ref Co' })).data;

  let r = await call('/contacts', 'POST', { first_name: 'A', email: 'nope', status: 'vip', company_id: 99999 });
  assert.equal(r.status, 400);
  assert.ok(r.data.errors.email);
  assert.ok(r.data.errors.status);
  assert.match(r.data.errors.company_id, /company does not exist/);

  r = await call('/contacts', 'POST', { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', company_id: co.id });
  assert.equal(r.status, 201);
  assert.equal(r.data.status, 'lead');
  assert.equal(r.data.full_name, 'Ada Lovelace');
  assert.equal(r.data.company_name, 'Ref Co');

  await call('/contacts', 'POST', { first_name: 'Bob', status: 'customer' });

  const byQ = (await call('/contacts?q=lovel')).data;
  assert.equal(byQ.total, 1);
  const byCompanyName = (await call('/contacts?q=ref%20co')).data;
  assert.equal(byCompanyName.items[0].first_name, 'Ada');
  const customers = (await call('/contacts?status=customer')).data;
  assert.ok(customers.items.every((c) => c.status === 'customer'));
  // LIKE wildcards are escaped
  assert.equal((await call('/contacts?q=%25')).data.total, 0);

  // Deleting the company detaches the contact
  await call(`/companies/${co.id}`, 'DELETE');
  const ada = (await call(`/contacts/${r.data.id}`)).data;
  assert.equal(ada.company_id, null);
});

test('deals, activities, detail relations and stats', async () => {
  const co = (await call('/companies', 'POST', { name: 'Deal Co' })).data;
  const ct = (await call('/contacts', 'POST', { first_name: 'Dee', company_id: co.id })).data;
  const deal = (await call('/deals', 'POST', { title: 'Big one', value: '1234.567', company_id: co.id, contact_id: ct.id })).data;
  assert.equal(deal.value, 1234.57);
  assert.equal(deal.stage, 'lead');

  assert.equal((await call('/deals', 'POST', { title: 'neg', value: -5 })).status, 400);
  assert.equal((await call('/deals', 'POST', { title: 'bad date', expected_close: '2024-13-45' })).status, 400);

  const act = (await call('/activities', 'POST', { type: 'task', subject: 'Call back', due_date: '2000-01-01', deal_id: deal.id, contact_id: ct.id })).data;
  assert.equal(act.done, 0);
  assert.equal(act.deal_title, 'Big one');

  const overdue = (await call('/activities?due=overdue')).data;
  assert.ok(overdue.items.some((a) => a.id === act.id));

  const toggled = (await call(`/activities/${act.id}`, 'PATCH', { done: true })).data;
  assert.equal(toggled.done, 1);

  const detail = (await call(`/companies/${co.id}`)).data;
  assert.equal(detail.related.contacts.length, 1);
  assert.equal(detail.related.deals.length, 1);
  assert.equal(detail.open_deal_value, 1234.57);

  await call(`/deals/${deal.id}`, 'PATCH', { stage: 'won' });
  const stats = (await call('/stats')).data;
  assert.equal(stats.pipeline.length, 6);
  assert.ok(stats.won_value >= 1234.57);

  // Deleting a deal cascades its activities
  await call(`/deals/${deal.id}`, 'DELETE');
  assert.equal((await call(`/activities/${act.id}`)).status, 404);
});

test('CSV export, bad input and unknown routes', async () => {
  await call('/companies', 'POST', { name: '=HYPERLINK("x")', notes: 'a, "quoted"\nline' });
  const r = await call('/companies/export.csv');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.data, /'=HYPERLINK\(""x""\)/);
  assert.match(r.data, /"a, ""quoted""\nline"/);

  const bad = await fetch(`${base}/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/companies/abc')).status, 404);
  assert.equal((await call('/companies', 'DELETE')).status, 405);
});

test('seed data loads and is consistent', async () => {
  const fresh = openDatabase(':memory:');
  seed(fresh);
  const n = (t) => fresh.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  assert.equal(n('companies'), 4);
  assert.equal(n('contacts'), 6);
  assert.equal(n('deals'), 6);
  assert.equal(n('activities'), 8);
  fresh.close();
});

test('static files are served and path traversal is blocked', async () => {
  const root = base.replace(/\/api$/, '');
  const index = await fetch(root + '/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /miniCRM/);
  assert.equal((await fetch(root + '/app.js')).status, 200);
  const trav = await fetch(root + '/%2e%2e/package.json');
  assert.notEqual(trav.status, 200);
});
