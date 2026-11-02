'use strict';

const { CONTACT_STATUSES, DEAL_STAGES, ACTIVITY_TYPES } = require('./db');

/**
 * Declarative description of every CRM entity. The generic repository below
 * uses it for validation, listing, searching, filtering and CSV export.
 */
const RESOURCES = {
  companies: {
    table: 'companies',
    alias: 'co',
    fields: {
      name: { type: 'text', required: true, max: 200 },
      industry: { type: 'text', max: 100 },
      website: { type: 'url', max: 300 },
      phone: { type: 'text', max: 50 },
      address: { type: 'text', max: 500 },
      notes: { type: 'text', max: 10000 },
    },
    select: `
      SELECT co.*,
        (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id) AS contact_count,
        (SELECT COUNT(*) FROM deals d WHERE d.company_id = co.id AND d.stage NOT IN ('won','lost')) AS open_deal_count,
        (SELECT COALESCE(SUM(d.value),0) FROM deals d WHERE d.company_id = co.id AND d.stage NOT IN ('won','lost')) AS open_deal_value
      FROM companies co`,
    search: ['co.name', 'co.industry', 'co.website', 'co.phone'],
    filters: { industry: 'co.industry' },
    sorts: { name: 'co.name COLLATE NOCASE', created_at: 'co.created_at', industry: 'co.industry COLLATE NOCASE' },
    defaultSort: 'name',
  },

  contacts: {
    table: 'contacts',
    alias: 'c',
    fields: {
      first_name: { type: 'text', required: true, max: 100 },
      last_name: { type: 'text', max: 100 },
      email: { type: 'email', max: 200 },
      phone: { type: 'text', max: 50 },
      title: { type: 'text', max: 100 },
      status: { type: 'enum', values: CONTACT_STATUSES, default: 'lead' },
      company_id: { type: 'ref', ref: 'companies' },
      notes: { type: 'text', max: 10000 },
    },
    select: `
      SELECT c.*, TRIM(c.first_name || ' ' || COALESCE(c.last_name,'')) AS full_name,
             co.name AS company_name
      FROM contacts c LEFT JOIN companies co ON co.id = c.company_id`,
    search: ['c.first_name', 'c.last_name', 'c.email', 'c.phone', 'c.title', 'co.name'],
    filters: { status: 'c.status', company_id: 'c.company_id' },
    sorts: {
      name: 'c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE',
      created_at: 'c.created_at',
      status: 'c.status',
      company: 'co.name COLLATE NOCASE',
    },
    defaultSort: 'name',
  },

  deals: {
    table: 'deals',
    alias: 'd',
    fields: {
      title: { type: 'text', required: true, max: 200 },
      value: { type: 'number', min: 0, default: 0 },
      stage: { type: 'enum', values: DEAL_STAGES, default: 'lead' },
      expected_close: { type: 'date' },
      contact_id: { type: 'ref', ref: 'contacts' },
      company_id: { type: 'ref', ref: 'companies' },
      notes: { type: 'text', max: 10000 },
    },
    select: `
      SELECT d.*, co.name AS company_name,
             TRIM(ct.first_name || ' ' || COALESCE(ct.last_name,'')) AS contact_name
      FROM deals d
      LEFT JOIN companies co ON co.id = d.company_id
      LEFT JOIN contacts ct ON ct.id = d.contact_id`,
    search: ['d.title', 'co.name', 'ct.first_name', 'ct.last_name'],
    filters: { stage: 'd.stage', company_id: 'd.company_id', contact_id: 'd.contact_id' },
    sorts: {
      created_at: 'd.created_at',
      value: 'd.value',
      title: 'd.title COLLATE NOCASE',
      expected_close: "COALESCE(d.expected_close,'9999')",
    },
    defaultSort: 'created_at',
    defaultDir: 'desc',
  },

  activities: {
    table: 'activities',
    alias: 'a',
    fields: {
      type: { type: 'enum', values: ACTIVITY_TYPES, default: 'note' },
      subject: { type: 'text', required: true, max: 300 },
      body: { type: 'text', max: 10000 },
      due_date: { type: 'date' },
      done: { type: 'bool', default: 0 },
      contact_id: { type: 'ref', ref: 'contacts' },
      company_id: { type: 'ref', ref: 'companies' },
      deal_id: { type: 'ref', ref: 'deals' },
    },
    select: `
      SELECT a.*, co.name AS company_name, dl.title AS deal_title,
             TRIM(ct.first_name || ' ' || COALESCE(ct.last_name,'')) AS contact_name
      FROM activities a
      LEFT JOIN companies co ON co.id = a.company_id
      LEFT JOIN contacts ct ON ct.id = a.contact_id
      LEFT JOIN deals dl ON dl.id = a.deal_id`,
    search: ['a.subject', 'a.body', 'co.name', 'ct.first_name', 'ct.last_name', 'dl.title'],
    filters: {
      type: 'a.type',
      done: 'a.done',
      contact_id: 'a.contact_id',
      company_id: 'a.company_id',
      deal_id: 'a.deal_id',
    },
    sorts: {
      created_at: 'a.created_at',
      due_date: "COALESCE(a.due_date,'9999')",
      subject: 'a.subject COLLATE NOCASE',
    },
    defaultSort: 'created_at',
    defaultDir: 'desc',
  },
};

class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.status = 400;
    this.errors = errors;
  }
}

class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.status = 404;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * Validate and normalise an input object against a resource's field spec.
 * `partial` = true for updates (only provided fields are checked).
 */
function validate(db, spec, input, partial) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError({ _: 'Request body must be a JSON object' });
  }
  const out = {};
  const errors = {};

  for (const [name, f] of Object.entries(spec.fields)) {
    const provided = Object.prototype.hasOwnProperty.call(input, name);
    if (!provided) {
      if (!partial) {
        if (f.required) errors[name] = 'Required';
        else if (f.default !== undefined) out[name] = f.default;
      }
      continue;
    }
    let v = input[name];
    if (isBlank(v)) {
      if (f.required) errors[name] = 'Required';
      else out[name] = f.default !== undefined ? f.default : null;
      continue;
    }
    switch (f.type) {
      case 'text':
      case 'url':
      case 'email': {
        v = String(v).trim();
        if (f.max && v.length > f.max) errors[name] = `Must be at most ${f.max} characters`;
        else if (f.type === 'email' && !EMAIL_RE.test(v)) errors[name] = 'Invalid email address';
        else if (f.type === 'url' && !/^https?:\/\//i.test(v)) v = `https://${v}`;
        out[name] = v;
        break;
      }
      case 'number': {
        const n = Number(v);
        if (!Number.isFinite(n)) errors[name] = 'Must be a number';
        else if (f.min !== undefined && n < f.min) errors[name] = `Must be ≥ ${f.min}`;
        else out[name] = Math.round(n * 100) / 100;
        break;
      }
      case 'enum':
        if (!f.values.includes(v)) errors[name] = `Must be one of: ${f.values.join(', ')}`;
        else out[name] = v;
        break;
      case 'date':
        v = String(v).slice(0, 10);
        if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) errors[name] = 'Must be a date (YYYY-MM-DD)';
        else out[name] = v;
        break;
      case 'bool':
        out[name] = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
        break;
      case 'ref': {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) {
          errors[name] = 'Invalid reference';
        } else {
          const row = db.prepare(`SELECT id FROM ${RESOURCES[f.ref].table} WHERE id = ?`).get(id);
          if (!row) errors[name] = `Referenced ${f.ref.replace(/s$/, '').replace(/ie$/, 'y')} does not exist`;
          else out[name] = id;
        }
        break;
      }
      default:
        out[name] = v;
    }
  }

  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

function createRepository(db) {
  function spec(name) {
    const s = RESOURCES[name];
    if (!s) throw new NotFoundError(`Unknown resource: ${name}`);
    return s;
  }

  function list(name, query = {}) {
    const s = spec(name);
    const where = [];
    const params = [];

    const q = typeof query.q === 'string' ? query.q.trim() : '';
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
      where.push('(' + s.search.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      for (let i = 0; i < s.search.length; i++) params.push(like);
    }
    for (const [key, col] of Object.entries(s.filters)) {
      const v = query[key];
      if (v === undefined || v === '') continue;
      if (v === 'none') {
        where.push(`${col} IS NULL`);
      } else {
        where.push(`${col} = ?`);
        params.push(/^\d+$/.test(v) ? Number(v) : v);
      }
    }
    if (name === 'activities' && query.due === 'overdue') {
      where.push("a.done = 0 AND a.due_date IS NOT NULL AND a.due_date < date('now')");
    } else if (name === 'activities' && query.due === 'upcoming') {
      where.push("a.done = 0 AND a.due_date IS NOT NULL AND a.due_date >= date('now')");
    }

    const sortKey = s.sorts[query.sort] ? query.sort : s.defaultSort;
    const dir = (query.dir || s.defaultDir || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 5000);
    const offset = Math.max(parseInt(query.offset, 10) || 0, 0);

    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM (${s.select}${whereSql})`).get(...params).n;
    const rows = db
      .prepare(`${s.select}${whereSql} ORDER BY ${s.sorts[sortKey]} ${dir}, ${s.alias}.id ${dir} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { items: rows.map(plain), total, limit, offset };
  }

  function get(name, id) {
    const s = spec(name);
    const row = db.prepare(`${s.select} WHERE ${s.alias}.id = ?`).get(Number(id));
    if (!row) throw new NotFoundError(`${name} #${id} not found`);
    return plain(row);
  }

  function create(name, input) {
    const s = spec(name);
    const data = validate(db, s, input, false);
    const cols = Object.keys(data);
    const sql = cols.length
      ? `INSERT INTO ${s.table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      : `INSERT INTO ${s.table} DEFAULT VALUES`;
    const info = db.prepare(sql).run(...cols.map((c) => data[c]));
    return get(name, info.lastInsertRowid);
  }

  function update(name, id, input) {
    const s = spec(name);
    get(name, id); // 404 if missing
    const data = validate(db, s, input, true);
    const cols = Object.keys(data);
    if (cols.length) {
      db.prepare(
        `UPDATE ${s.table} SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`
      ).run(...cols.map((c) => data[c]), Number(id));
    }
    return get(name, id);
  }

  function remove(name, id) {
    const s = spec(name);
    const info = db.prepare(`DELETE FROM ${s.table} WHERE id = ?`).run(Number(id));
    if (!info.changes) throw new NotFoundError(`${name} #${id} not found`);
  }

  /** A record together with its related records, for detail pages. */
  function detail(name, id) {
    const record = get(name, id);
    const related = {};
    if (name === 'companies') {
      related.contacts = list('contacts', { company_id: String(id) }).items;
      related.deals = list('deals', { company_id: String(id) }).items;
      related.activities = list('activities', { company_id: String(id) }).items;
    } else if (name === 'contacts') {
      related.deals = list('deals', { contact_id: String(id) }).items;
      related.activities = list('activities', { contact_id: String(id) }).items;
    } else if (name === 'deals') {
      related.activities = list('activities', { deal_id: String(id) }).items;
    }
    return { ...record, related };
  }

  function stats() {
    const one = (sql) => db.prepare(sql).get();
    const counts = {
      companies: one('SELECT COUNT(*) AS n FROM companies').n,
      contacts: one('SELECT COUNT(*) AS n FROM contacts').n,
      deals: one('SELECT COUNT(*) AS n FROM deals').n,
      open_tasks: one("SELECT COUNT(*) AS n FROM activities WHERE type = 'task' AND done = 0").n,
      overdue_tasks: one(
        "SELECT COUNT(*) AS n FROM activities WHERE done = 0 AND due_date IS NOT NULL AND due_date < date('now')"
      ).n,
    };
    const byStage = db
      .prepare('SELECT stage, COUNT(*) AS count, COALESCE(SUM(value),0) AS value FROM deals GROUP BY stage')
      .all();
    const pipeline = DEAL_STAGES.map((stage) => {
      const r = byStage.find((x) => x.stage === stage);
      return { stage, count: r ? r.count : 0, value: r ? r.value : 0 };
    });
    const open = pipeline.filter((p) => !['won', 'lost'].includes(p.stage));
    const won = pipeline.find((p) => p.stage === 'won');
    const lost = pipeline.find((p) => p.stage === 'lost');
    const closed = won.count + lost.count;
    const contactsByStatus = CONTACT_STATUSES.map((status) => ({
      status,
      count: db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE status = ?').get(status).n,
    }));

    return {
      counts,
      pipeline,
      contacts_by_status: contactsByStatus,
      open_pipeline_value: open.reduce((sum, p) => sum + p.value, 0),
      open_deal_count: open.reduce((sum, p) => sum + p.count, 0),
      won_value: won.value,
      win_rate: closed ? Math.round((won.count / closed) * 100) : null,
      upcoming: list('activities', { done: '0', sort: 'due_date', dir: 'asc', limit: '8' }).items.filter(
        (a) => a.due_date
      ),
      recent: list('activities', { sort: 'created_at', dir: 'desc', limit: '8' }).items,
    };
  }

  return { list, get, create, update, remove, detail, stats };
}

// node:sqlite returns null-prototype objects; normalise for JSON & tests.
function plain(row) {
  return { ...row };
}

module.exports = { RESOURCES, createRepository, ValidationError, NotFoundError };
