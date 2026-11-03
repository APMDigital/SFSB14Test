'use strict';

const path = require('node:path');
const { openDatabase } = require('./db');
const { createRepository } = require('./resources');

function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

/** Populate a database with a small, realistic sample dataset. */
function seed(db) {
  const repo = createRepository(db);
  db.exec('BEGIN');
  try {
    const co = {};
    for (const c of [
      { key: 'acme', name: 'Acme Manufacturing', industry: 'Manufacturing', website: 'acme.example.com', phone: '+421 2 1234 5678', address: 'Priemyselná 12, Bratislava' },
      { key: 'nova', name: 'Nova Software', industry: 'Software', website: 'nova.example.com', phone: '+420 222 333 444', address: 'Vinohradská 88, Praha' },
      { key: 'green', name: 'GreenLeaf Retail', industry: 'Retail', website: 'greenleaf.example.com', phone: '+43 1 555 0101', address: 'Mariahilfer Str. 5, Wien' },
      { key: 'blue', name: 'Blue Harbor Logistics', industry: 'Logistics', website: 'blueharbor.example.com', phone: '+49 40 777 888' },
    ]) {
      const { key, ...data } = c;
      co[key] = repo.create('companies', data).id;
    }

    const ct = {};
    for (const c of [
      { key: 'jana', first_name: 'Jana', last_name: 'Kováčová', email: 'jana.kovacova@acme.example.com', phone: '+421 905 111 222', title: 'Head of Purchasing', status: 'customer', company_id: co.acme },
      { key: 'peter', first_name: 'Peter', last_name: 'Novák', email: 'peter.novak@acme.example.com', title: 'CFO', status: 'customer', company_id: co.acme },
      { key: 'tomas', first_name: 'Tomáš', last_name: 'Dvořák', email: 'tomas@nova.example.com', phone: '+420 601 222 333', title: 'CTO', status: 'prospect', company_id: co.nova },
      { key: 'anna', first_name: 'Anna', last_name: 'Huber', email: 'anna.huber@greenleaf.example.com', title: 'Store Operations Manager', status: 'prospect', company_id: co.green },
      { key: 'lukas', first_name: 'Lukas', last_name: 'Schmidt', email: 'l.schmidt@blueharbor.example.com', title: 'IT Director', status: 'lead', company_id: co.blue },
      { key: 'eva', first_name: 'Eva', last_name: 'Horváthová', email: 'eva.horvathova@example.com', phone: '+421 911 444 555', title: 'Freelance consultant', status: 'lead' },
    ]) {
      const { key, ...data } = c;
      ct[key] = repo.create('contacts', data).id;
    }

    const dl = {};
    for (const d of [
      { key: 'acmeErp', title: 'ERP integration – phase 2', value: 48000, stage: 'negotiation', expected_close: day(14), contact_id: ct.jana, company_id: co.acme },
      { key: 'acmeSupport', title: 'Annual support contract', value: 12000, stage: 'won', expected_close: day(-20), contact_id: ct.peter, company_id: co.acme },
      { key: 'novaPilot', title: 'Analytics pilot', value: 15000, stage: 'proposal', expected_close: day(30), contact_id: ct.tomas, company_id: co.nova },
      { key: 'greenPos', title: 'POS rollout (25 stores)', value: 72000, stage: 'qualified', expected_close: day(60), contact_id: ct.anna, company_id: co.green },
      { key: 'blueWms', title: 'Warehouse system audit', value: 8500, stage: 'lead', expected_close: day(45), contact_id: ct.lukas, company_id: co.blue },
      { key: 'evaWorkshop', title: 'Training workshop', value: 3000, stage: 'lost', expected_close: day(-10), contact_id: ct.eva },
    ]) {
      const { key, ...data } = d;
      dl[key] = repo.create('deals', data).id;
    }

    for (const a of [
      { type: 'meeting', subject: 'Kick-off phase 2 scope', body: 'Agreed on scope; waiting for legal review.', contact_id: ct.jana, company_id: co.acme, deal_id: dl.acmeErp, done: 1, due_date: day(-5) },
      { type: 'task', subject: 'Send revised ERP quote', contact_id: ct.jana, company_id: co.acme, deal_id: dl.acmeErp, due_date: day(2) },
      { type: 'call', subject: 'Discovery call with Tomáš', body: 'Interested in real-time dashboards.', contact_id: ct.tomas, company_id: co.nova, deal_id: dl.novaPilot, done: 1, due_date: day(-8) },
      { type: 'task', subject: 'Prepare pilot proposal deck', contact_id: ct.tomas, company_id: co.nova, deal_id: dl.novaPilot, due_date: day(-1) },
      { type: 'email', subject: 'Sent POS case studies', contact_id: ct.anna, company_id: co.green, deal_id: dl.greenPos, done: 1 },
      { type: 'task', subject: 'Schedule store visit in Vienna', contact_id: ct.anna, company_id: co.green, deal_id: dl.greenPos, due_date: day(7) },
      { type: 'note', subject: 'Met at Logistics Expo', body: 'Lukas is evaluating three vendors.', contact_id: ct.lukas, company_id: co.blue },
      { type: 'task', subject: 'Follow up with Lukas', contact_id: ct.lukas, company_id: co.blue, deal_id: dl.blueWms, due_date: day(4) },
    ]) {
      repo.create('activities', a);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

if (require.main === module) {
  const file = process.env.MINICRM_DB || path.join(__dirname, '..', 'data', 'minicrm.db');
  const db = openDatabase(file);
  seed(db);
  db.close();
  console.log(`Sample data inserted into ${file}`);
}

module.exports = { seed };
