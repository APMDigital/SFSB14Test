/* miniCRM frontend – dependency-free single-page app. */
'use strict';

(() => {
  const CURRENCY = 'EUR';
  const app = document.getElementById('app');
  const modal = document.getElementById('modal');
  const modalForm = document.getElementById('modal-form');
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');

  // ---------- Safe HTML templating ----------
  class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
  const raw = (s) => new Raw(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const piece = (v) => {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(piece).join('');
    if (v === null || v === undefined || v === false) return '';
    return esc(v);
  };
  const html = (strings, ...vals) => raw(strings.reduce((out, s, i) => out + s + (i < vals.length ? piece(vals[i]) : ''), ''));

  // ---------- Formatting ----------
  const money = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 });
  const fmtMoney = (n) => money.format(n || 0);
  const today = () => new Date().toISOString().slice(0, 10);
  const fmtDate = (d) => (d ? new Date(d.length === 10 ? d + 'T00:00:00' : d.replace(' ', 'T') + 'Z').toLocaleDateString() : '');
  const relDate = (d) => {
    if (!d) return '';
    const diff = Math.round((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    return diff > 0 ? `in ${diff} days` : `${-diff} days ago`;
  };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
  const ICONS = { note: '📝', call: '📞', email: '✉️', meeting: '👥', task: '✅' };
  const badge = (v, extra = '') => html`<span class="badge ${v} ${extra}">${v}</span>`;
  const isOverdue = (a) => !a.done && a.due_date && a.due_date < today();

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, body) { super((body && body.error) || `HTTP ${status}`); this.status = status; this.errors = body && body.errors; }
  }
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api/' + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
  const qs = (obj) => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();

  let META = null;
  const meta = async () => (META ||= await api('meta'));

  // ---------- Toasts ----------
  function toast(msg, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toasts').append(el);
    setTimeout(() => el.remove(), 3500);
  }
  const fail = (err) => { console.error(err); toast(err.message || 'Something went wrong', 'error'); };

  // ---------- Forms (modal) ----------
  const FORMS = {
    companies: {
      label: 'company',
      fields: [
        { name: 'name', label: 'Name', required: true, full: true },
        { name: 'industry', label: 'Industry' },
        { name: 'phone', label: 'Phone', type: 'tel' },
        { name: 'website', label: 'Website', full: true, placeholder: 'example.com' },
        { name: 'address', label: 'Address', full: true },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true },
      ],
    },
    contacts: {
      label: 'contact',
      fields: [
        { name: 'first_name', label: 'First name', required: true },
        { name: 'last_name', label: 'Last name' },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'phone', label: 'Phone', type: 'tel' },
        { name: 'title', label: 'Job title' },
        { name: 'status', label: 'Status', type: 'select', options: () => META.contact_statuses },
        { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies', full: true },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true },
      ],
    },
    deals: {
      label: 'deal',
      fields: [
        { name: 'title', label: 'Title', required: true, full: true },
        { name: 'value', label: `Value (${CURRENCY})`, type: 'number' },
        { name: 'stage', label: 'Stage', type: 'select', options: () => META.deal_stages },
        { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies' },
        { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts' },
        { name: 'expected_close', label: 'Expected close', type: 'date' },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true },
      ],
    },
    activities: {
      label: 'activity',
      fields: [
        { name: 'type', label: 'Type', type: 'select', options: () => META.activity_types },
        { name: 'due_date', label: 'Due date', type: 'date' },
        { name: 'subject', label: 'Subject', required: true, full: true },
        { name: 'body', label: 'Details', type: 'textarea', full: true },
        { name: 'contact_id', label: 'Contact', type: 'ref', ref: 'contacts' },
        { name: 'company_id', label: 'Company', type: 'ref', ref: 'companies' },
        { name: 'deal_id', label: 'Deal', type: 'ref', ref: 'deals' },
        { name: 'done', label: 'Completed', type: 'checkbox' },
      ],
    },
  };
  const refLabel = { companies: (r) => r.name, contacts: (r) => r.full_name, deals: (r) => r.title };

  let modalSubmit = null;
  async function openForm(resource, record = null, defaults = {}) {
    await meta();
    const form = FORMS[resource];
    const refs = {};
    await Promise.all(
      [...new Set(form.fields.filter((f) => f.type === 'ref').map((f) => f.ref))].map(async (r) => {
        refs[r] = (await api(`${r}?limit=5000`)).items;
      })
    );
    const values = { ...defaults, ...(record || {}) };
    modalTitle.textContent = `${record ? 'Edit' : 'New'} ${form.label}`;
    modalBody.innerHTML = form.fields.map((f) => fieldHtml(f, values[f.name], refs)).join('');
    modalSubmit = async () => {
      const data = {};
      for (const f of form.fields) {
        const input = modalForm.elements[f.name];
        data[f.name] = f.type === 'checkbox' ? input.checked : input.value;
      }
      const saved = record
        ? await api(`${resource}/${record.id}`, { method: 'PUT', body: data })
        : await api(resource, { method: 'POST', body: data });
      toast(`${cap(form.label)} ${record ? 'updated' : 'created'}`);
      return saved;
    };
    modal.showModal();
    const first = modalBody.querySelector('input, select, textarea');
    if (first) first.focus();
    return new Promise((resolve) => { modal._resolve = resolve; });
  }

  function fieldHtml(f, value, refs) {
    const id = `f-${f.name}`;
    const label = html`<label for="${id}">${f.label}${f.required ? raw(' <span class="req">*</span>') : ''}</label>`;
    const v = value ?? '';
    let control;
    if (f.type === 'textarea') {
      control = html`<textarea id="${id}" name="${f.name}">${v}</textarea>`;
    } else if (f.type === 'select') {
      control = html`<select id="${id}" name="${f.name}">${f.options().map((o) => html`<option value="${o}" ${o === v ? raw('selected') : ''}>${cap(o)}</option>`)}</select>`;
    } else if (f.type === 'ref') {
      const opts = refs[f.ref].map((r) => html`<option value="${r.id}" ${r.id === Number(v) ? raw('selected') : ''}>${refLabel[f.ref](r)}</option>`);
      control = html`<select id="${id}" name="${f.name}"><option value="">— none —</option>${opts}</select>`;
    } else if (f.type === 'checkbox') {
      return html`<div class="field check ${f.full ? 'full' : ''}" data-field="${f.name}"><input type="checkbox" id="${id}" name="${f.name}" ${v ? raw('checked') : ''}>${label}<span class="err"></span></div>`.s;
    } else {
      const type = f.type || 'text';
      control = html`<input id="${id}" name="${f.name}" type="${type}" value="${v}" ${f.placeholder ? raw(`placeholder="${esc(f.placeholder)}"`) : ''} ${type === 'number' ? raw('min="0" step="0.01"') : ''} ${f.required ? raw('required') : ''}>`;
    }
    return html`<div class="field ${f.full ? 'full' : ''}" data-field="${f.name}">${label}${control}<span class="err"></span></div>`.s;
  }

  function closeModal(result = null) {
    modal.close();
    if (modal._resolve) { modal._resolve(result); modal._resolve = null; }
  }

  modalForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    modalBody.querySelectorAll('.field').forEach((el) => { el.classList.remove('invalid'); el.querySelector('.err').textContent = ''; });
    const btn = document.getElementById('modal-submit');
    btn.disabled = true;
    try {
      closeModal(await modalSubmit());
    } catch (err) {
      if (err.errors) {
        for (const [name, msg] of Object.entries(err.errors)) {
          const el = modalBody.querySelector(`[data-field="${name}"]`);
          if (el) { el.classList.add('invalid'); el.querySelector('.err').textContent = msg; }
          else toast(msg, 'error');
        }
      } else fail(err);
    } finally {
      btn.disabled = false;
    }
  });
  modal.addEventListener('cancel', () => closeModal());

  async function confirmDelete(resource, record, name) {
    if (!confirm(`Delete ${FORMS[resource].label} "${name}"? This cannot be undone.`)) return false;
    await api(`${resource}/${record.id}`, { method: 'DELETE' });
    toast(`${cap(FORMS[resource].label)} deleted`);
    return true;
  }

  // ---------- Shared fragments ----------
  const pageHead = (title, sub, actions = '') =>
    html`<div class="page-head"><div><h1>${title}</h1>${sub ? html`<div class="sub">${sub}</div>` : ''}</div><div class="toolbar" style="margin:0">${actions}</div></div>`;

  function activityItem(a, { showLinks = true } = {}) {
    const links = showLinks
      ? [
          a.contact_id && html`<a href="#/contacts/${a.contact_id}">${a.contact_name}</a>`,
          a.company_id && html`<a href="#/companies/${a.company_id}">${a.company_name}</a>`,
          a.deal_id && html`<a href="#/deals/${a.deal_id}">${a.deal_title}</a>`,
        ].filter(Boolean)
      : [];
    const due = a.due_date
      ? html` · due ${fmtDate(a.due_date)} (${relDate(a.due_date)}) ${isOverdue(a) ? badge('overdue') : ''}`
      : '';
    return html`<li data-id="${a.id}">
      <div class="ico" title="${a.type}">${ICONS[a.type] || '•'}</div>
      <div class="body">
        <div class="subj ${a.done ? 'done' : ''}">${a.subject}</div>
        <div class="meta">${cap(a.type)}${due}${links.length ? html` · ${links.map((l, i) => html`${i ? ', ' : ''}${l}`)}` : ''}</div>
        ${a.body ? html`<div class="text">${a.body}</div>` : ''}
      </div>
      <div class="actions">
        <input type="checkbox" title="Mark ${a.done ? 'open' : 'done'}" data-action="toggle-activity" data-id="${a.id}" ${a.done ? raw('checked') : ''}>
        <button class="icon-btn" title="Edit" data-action="edit-activity" data-id="${a.id}">✎</button>
        <button class="icon-btn" title="Delete" data-action="delete-activity" data-id="${a.id}">🗑</button>
      </div>
    </li>`;
  }
  const feed = (items, opts) =>
    items.length ? html`<ul class="feed">${items.map((a) => activityItem(a, opts))}</ul>` : html`<div class="empty">No activities yet.</div>`;

  // Activity actions are shared by every page that renders a feed.
  async function handleActivityAction(action, id) {
    if (action === 'toggle-activity') {
      const a = await api(`activities/${id}`);
      await api(`activities/${id}`, { method: 'PATCH', body: { done: !a.done } });
      toast(a.done ? 'Marked as open' : 'Marked as done');
      return true;
    }
    if (action === 'edit-activity') {
      const a = await api(`activities/${id}`);
      return !!(await openForm('activities', a));
    }
    if (action === 'delete-activity') {
      const a = await api(`activities/${id}`);
      return confirmDelete('activities', a, a.subject);
    }
    return false;
  }

  // ---------- Views ----------
  async function viewDashboard() {
    const s = await api('stats');
    const maxVal = Math.max(1, ...s.pipeline.map((p) => p.value));
    app.innerHTML = html`
      ${pageHead('Dashboard', new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        html`<button class="btn" data-action="new" data-resource="contacts">+ Contact</button><button class="btn primary" data-action="new" data-resource="deals">+ Deal</button>`)}
      <div class="grid stats">
        <div class="card stat"><div class="label">Open pipeline</div><div class="value">${fmtMoney(s.open_pipeline_value)}</div><div class="hint">${s.open_deal_count} open deals</div></div>
        <div class="card stat"><div class="label">Won</div><div class="value">${fmtMoney(s.won_value)}</div><div class="hint">Win rate ${s.win_rate === null ? '—' : s.win_rate + '%'}</div></div>
        <div class="card stat"><div class="label">Contacts</div><div class="value">${s.counts.contacts}</div><div class="hint">${s.counts.companies} companies</div></div>
        <div class="card stat"><div class="label">Open tasks</div><div class="value ${s.counts.overdue_tasks ? 'warn' : ''}">${s.counts.open_tasks}</div><div class="hint">${s.counts.overdue_tasks} overdue</div></div>
      </div>
      <div class="grid two">
        <div class="card">
          <h3>Pipeline by stage</h3>
          <div class="bars">
            ${s.pipeline.map((p) => html`<a class="bar-row" href="#/deals" style="color:inherit;text-decoration:none">
              <span class="name">${p.stage} <span class="muted">(${p.count})</span></span>
              <span class="bar-track"><span class="bar-fill ${p.stage}" style="width:${Math.round((p.value / maxVal) * 100)}%"></span></span>
              <span class="amt">${fmtMoney(p.value)}</span></a>`)}
          </div>
          <h3 style="margin-top:20px">Contacts by status</h3>
          <div class="toolbar">${s.contacts_by_status.map((c) => html`<a href="#/contacts?status=${c.status}">${badge(c.status)} <span class="muted">${c.count}</span></a>`)}</div>
        </div>
        <div class="card">
          <div class="section-head"><h3 style="margin:0">Upcoming & overdue</h3><a href="#/activities" class="muted">All activities →</a></div>
          ${feed(s.upcoming)}
        </div>
        <div class="card" style="grid-column:1/-1">
          <h3>Recent activity</h3>
          ${feed(s.recent)}
        </div>
      </div>`;
  }

  // Generic list page (contacts, companies, activities)
  const LISTS = {
    contacts: {
      title: 'Contacts',
      columns: [
        { label: 'Name', sort: 'name', render: (r) => html`<a href="#/contacts/${r.id}">${r.full_name}</a>` },
        { label: 'Company', sort: 'company', render: (r) => (r.company_id ? html`<a href="#/companies/${r.company_id}">${r.company_name}</a>` : html`<span class="muted">—</span>`) },
        { label: 'Title', render: (r) => r.title || '' },
        { label: 'Email', render: (r) => (r.email ? html`<a href="mailto:${r.email}">${r.email}</a>` : '') },
        { label: 'Phone', render: (r) => (r.phone ? html`<a href="tel:${r.phone}">${r.phone}</a>` : '') },
        { label: 'Status', sort: 'status', render: (r) => badge(r.status) },
      ],
      filters: () => [{ name: 'status', label: 'All statuses', options: META.contact_statuses }],
    },
    companies: {
      title: 'Companies',
      columns: [
        { label: 'Name', sort: 'name', render: (r) => html`<a href="#/companies/${r.id}">${r.name}</a>` },
        { label: 'Industry', sort: 'industry', render: (r) => r.industry || '' },
        { label: 'Contacts', num: true, render: (r) => r.contact_count },
        { label: 'Open deals', num: true, render: (r) => r.open_deal_count },
        { label: 'Pipeline', num: true, render: (r) => fmtMoney(r.open_deal_value) },
        { label: 'Website', render: (r) => (r.website ? html`<a href="${r.website}" target="_blank" rel="noopener noreferrer">${r.website.replace(/^https?:\/\//, '')}</a>` : '') },
      ],
      filters: () => [],
    },
    activities: {
      title: 'Activities',
      columns: [
        { label: '', render: (r) => html`<input type="checkbox" data-action="toggle-activity" data-id="${r.id}" ${r.done ? raw('checked') : ''} title="Done">` },
        { label: 'Type', render: (r) => html`${ICONS[r.type]} ${cap(r.type)}` },
        { label: 'Subject', sort: 'subject', wrap: true, render: (r) => html`<a href="#" data-action="edit-activity" data-id="${r.id}" class="${r.done ? 'muted' : ''}">${r.subject}</a>` },
        { label: 'Related', wrap: true, render: (r) => [
            r.contact_id && html`<a href="#/contacts/${r.contact_id}">${r.contact_name}</a>`,
            r.company_id && html`<a href="#/companies/${r.company_id}">${r.company_name}</a>`,
            r.deal_id && html`<a href="#/deals/${r.deal_id}">${r.deal_title}</a>`,
          ].filter(Boolean).map((l, i) => html`${i ? ' · ' : ''}${l}`) },
        { label: 'Due', sort: 'due_date', render: (r) => (r.due_date ? html`${fmtDate(r.due_date)} ${isOverdue(r) ? badge('overdue') : ''}` : '') },
        { label: 'Created', sort: 'created_at', render: (r) => html`<span class="muted">${fmtDate(r.created_at)}</span>` },
      ],
      filters: () => [
        { name: 'type', label: 'All types', options: META.activity_types },
        { name: 'state', label: 'Any state', options: ['open', 'done', 'overdue'] },
      ],
      params: (st) => {
        const p = { ...st };
        if (p.state === 'open') p.done = '0';
        if (p.state === 'done') p.done = '1';
        if (p.state === 'overdue') p.due = 'overdue';
        delete p.state;
        return p;
      },
    },
  };
  const listState = {};

  async function viewList(resource, query) {
    await meta();
    const cfg = LISTS[resource];
    const st = (listState[resource] ||= { q: '', sort: '', dir: '' });
    for (const [k, v] of Object.entries(query)) st[k] = v;
    const filters = cfg.filters();

    app.innerHTML = html`
      ${pageHead(cfg.title, '', html`
        <a class="btn" href="/api/${resource}/export.csv" download>Export CSV</a>
        <button class="btn primary" data-action="new" data-resource="${resource}">+ New ${FORMS[resource].label}</button>`)}
      <div class="toolbar">
        <input type="search" id="list-q" placeholder="Search ${cfg.title.toLowerCase()}…" value="${st.q || ''}" aria-label="Search">
        ${filters.map((f) => html`<select data-filter="${f.name}" aria-label="${f.label}">
          <option value="">${f.label}</option>
          ${f.options.map((o) => html`<option value="${o}" ${st[f.name] === o ? raw('selected') : ''}>${cap(o)}</option>`)}
        </select>`)}
        <span class="spacer"></span><span class="muted" id="list-count"></span>
      </div>
      <div id="list-body"><div class="loading">Loading…</div></div>`;

    const load = async () => {
      const params = cfg.params ? cfg.params(st) : st;
      const data = await api(`${resource}?${qs(params)}`);
      document.getElementById('list-count').textContent = `${data.total} ${data.total === 1 ? FORMS[resource].label : cfg.title.toLowerCase()}`;
      const body = document.getElementById('list-body');
      if (!data.items.length) {
        body.innerHTML = html`<div class="table-wrap"><div class="empty">${st.q || filters.some((f) => st[f.name]) ? 'No matches.' : `No ${cfg.title.toLowerCase()} yet.`}</div></div>`.s;
        return;
      }
      const arrow = (c) => (c.sort && (st.sort || '') === c.sort ? (st.dir === 'desc' ? ' ↓' : ' ↑') : '');
      body.innerHTML = html`<div class="table-wrap"><table>
        <thead><tr>${cfg.columns.map((c) => html`<th class="${c.num ? 'num' : ''}">${c.sort ? html`<button data-sort="${c.sort}">${c.label}${arrow(c)}</button>` : c.label}</th>`)}</tr></thead>
        <tbody>${data.items.map((r) => html`<tr>${cfg.columns.map((c) => html`<td class="${c.num ? 'num' : ''} ${c.wrap ? 'wrap' : ''}">${c.render(r)}</td>`)}</tr>`)}</tbody>
      </table></div>`.s;
    };
    app._reload = load;

    let t;
    document.getElementById('list-q').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { st.q = e.target.value; load().catch(fail); }, 200);
    });
    app.querySelectorAll('[data-filter]').forEach((sel) => sel.addEventListener('change', () => { st[sel.dataset.filter] = sel.value; load().catch(fail); }));
    document.getElementById('list-body').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      if (st.sort === b.dataset.sort) st.dir = st.dir === 'desc' ? 'asc' : 'desc';
      else { st.sort = b.dataset.sort; st.dir = 'asc'; }
      load().catch(fail);
    });
    await load();
  }

  const dealState = { q: '' };
  async function viewDeals() {
    await meta();
    app.innerHTML = html`
      ${pageHead('Deals', 'Drag cards between columns to change stage', html`
        <a class="btn" href="/api/deals/export.csv" download>Export CSV</a>
        <button class="btn primary" data-action="new" data-resource="deals">+ New deal</button>`)}
      <div class="toolbar"><input type="search" id="deal-q" placeholder="Search deals…" value="${dealState.q}" aria-label="Search deals"></div>
      <div id="board" class="board"></div>`;

    const load = async () => {
      const { items } = await api(`deals?${qs({ q: dealState.q, limit: 5000, sort: 'expected_close', dir: 'asc' })}`);
      document.getElementById('board').innerHTML = META.deal_stages.map((stage) => {
        const deals = items.filter((d) => d.stage === stage);
        const sum = deals.reduce((s, d) => s + d.value, 0);
        return html`<section class="column" data-stage="${stage}">
          <div class="column-head"><span class="t">${stage} <span class="muted">${deals.length}</span></span><span class="s">${fmtMoney(sum)}</span></div>
          ${deals.map((d) => html`<a class="deal-card" draggable="true" data-id="${d.id}" href="#/deals/${d.id}">
            <div class="title">${d.title}</div>
            <div class="value">${fmtMoney(d.value)}</div>
            <div class="meta">${[d.company_name, d.contact_name].filter(Boolean).join(' · ') || '—'}</div>
            ${d.expected_close ? html`<div class="meta">Close ${fmtDate(d.expected_close)}</div>` : ''}
          </a>`)}
        </section>`.s;
      }).join('');
    };
    app._reload = load;

    let t;
    document.getElementById('deal-q').addEventListener('input', (e) => {
      clearTimeout(t);
      t = setTimeout(() => { dealState.q = e.target.value; load().catch(fail); }, 200);
    });

    const board = document.getElementById('board');
    let dragId = null;
    board.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.deal-card');
      if (!card) return;
      dragId = card.dataset.id;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    board.addEventListener('dragend', (e) => { e.target.closest('.deal-card')?.classList.remove('dragging'); board.querySelectorAll('.drop').forEach((c) => c.classList.remove('drop')); });
    board.addEventListener('dragover', (e) => {
      const col = e.target.closest('.column');
      if (!col || !dragId) return;
      e.preventDefault();
      board.querySelectorAll('.drop').forEach((c) => c !== col && c.classList.remove('drop'));
      col.classList.add('drop');
    });
    board.addEventListener('drop', async (e) => {
      const col = e.target.closest('.column');
      if (!col || !dragId) return;
      e.preventDefault();
      const id = dragId;
      dragId = null;
      try {
        const d = await api(`deals/${id}`, { method: 'PATCH', body: { stage: col.dataset.stage } });
        toast(`"${d.title}" moved to ${d.stage}`);
        await load();
      } catch (err) { fail(err); }
    });
    await load();
  }

  // Detail pages
  function fieldList(pairs) {
    return html`<dl class="fields">${pairs.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== false).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>`;
  }
  function quickAdd(defaults) {
    return html`<form class="quick-add" data-quick-add='${JSON.stringify(defaults)}'>
      <select name="type" aria-label="Type">${META.activity_types.map((t) => html`<option value="${t}" ${t === 'note' ? raw('selected') : ''}>${ICONS[t]} ${cap(t)}</option>`)}</select>
      <input name="subject" placeholder="Log a note, call or task…" required aria-label="Subject">
      <input name="due_date" type="date" aria-label="Due date" title="Due date (optional)">
      <button class="btn primary" type="submit">Add</button>
    </form>`;
  }
  const relatedTable = (items, cols, emptyText) =>
    items.length
      ? html`<div class="table-wrap"><table><tbody>${items.map((r) => html`<tr>${cols.map((c) => html`<td class="${c.num ? 'num' : ''}">${c.render(r)}</td>`)}</tr>`)}</tbody></table></div>`
      : html`<div class="card empty">${emptyText}</div>`;
  const dealCols = [
    { render: (d) => html`<a href="#/deals/${d.id}">${d.title}</a>` },
    { render: (d) => badge(d.stage) },
    { num: true, render: (d) => fmtMoney(d.value) },
  ];

  async function viewDetail(resource, id) {
    await meta();
    const r = await api(`${resource}/${id}`);
    const rel = r.related;
    let title, sub, fields, main, activityDefaults;

    if (resource === 'contacts') {
      title = r.full_name;
      sub = html`${r.title || ''}${r.title && r.company_name ? ' at ' : ''}${r.company_id ? html`<a href="#/companies/${r.company_id}">${r.company_name}</a>` : ''}`;
      fields = fieldList([
        ['Status', badge(r.status)],
        ['Email', r.email && html`<a href="mailto:${r.email}">${r.email}</a>`],
        ['Phone', r.phone && html`<a href="tel:${r.phone}">${r.phone}</a>`],
        ['Company', r.company_id && html`<a href="#/companies/${r.company_id}">${r.company_name}</a>`],
        ['Job title', r.title],
        ['Notes', r.notes],
        ['Created', fmtDate(r.created_at)],
      ]);
      main = html`<div class="section"><div class="section-head"><h3 style="margin:0">Deals</h3>
        <button class="btn small" data-action="new" data-resource="deals" data-defaults='${JSON.stringify({ contact_id: r.id, company_id: r.company_id })}'>+ Deal</button></div>
        ${relatedTable(rel.deals, dealCols, 'No deals for this contact.')}</div>`;
      activityDefaults = { contact_id: r.id, company_id: r.company_id };
    } else if (resource === 'companies') {
      title = r.name;
      sub = r.industry;
      fields = fieldList([
        ['Industry', r.industry],
        ['Website', r.website && html`<a href="${r.website}" target="_blank" rel="noopener noreferrer">${r.website.replace(/^https?:\/\//, '')}</a>`],
        ['Phone', r.phone && html`<a href="tel:${r.phone}">${r.phone}</a>`],
        ['Address', r.address],
        ['Open pipeline', fmtMoney(r.open_deal_value)],
        ['Notes', r.notes],
        ['Created', fmtDate(r.created_at)],
      ]);
      main = html`
        <div class="section"><div class="section-head"><h3 style="margin:0">Contacts</h3>
          <button class="btn small" data-action="new" data-resource="contacts" data-defaults='${JSON.stringify({ company_id: r.id })}'>+ Contact</button></div>
          ${relatedTable(rel.contacts, [
            { render: (c) => html`<a href="#/contacts/${c.id}">${c.full_name}</a>` },
            { render: (c) => c.title || '' },
            { render: (c) => (c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : '') },
            { render: (c) => badge(c.status) },
          ], 'No contacts at this company.')}</div>
        <div class="section"><div class="section-head"><h3 style="margin:0">Deals</h3>
          <button class="btn small" data-action="new" data-resource="deals" data-defaults='${JSON.stringify({ company_id: r.id })}'>+ Deal</button></div>
          ${relatedTable(rel.deals, dealCols, 'No deals with this company.')}</div>`;
      activityDefaults = { company_id: r.id };
    } else {
      title = r.title;
      sub = html`${fmtMoney(r.value)}${r.company_id ? html` · <a href="#/companies/${r.company_id}">${r.company_name}</a>` : ''}`;
      fields = fieldList([
        ['Value', fmtMoney(r.value)],
        ['Stage', badge(r.stage)],
        ['Company', r.company_id && html`<a href="#/companies/${r.company_id}">${r.company_name}</a>`],
        ['Contact', r.contact_id && html`<a href="#/contacts/${r.contact_id}">${r.contact_name}</a>`],
        ['Expected close', r.expected_close && `${fmtDate(r.expected_close)} (${relDate(r.expected_close)})`],
        ['Notes', r.notes],
        ['Created', fmtDate(r.created_at)],
      ]);
      main = html`<div class="section card"><h3>Stage</h3><div class="stages">
        ${META.deal_stages.map((s) => html`<button data-action="set-stage" data-stage="${s}" class="${s === r.stage ? 'active' : ''}">${s}</button>`)}
      </div></div>`;
      activityDefaults = { deal_id: r.id, contact_id: r.contact_id, company_id: r.company_id };
    }

    const back = { contacts: 'Contacts', companies: 'Companies', deals: 'Deals' }[resource];
    app.innerHTML = html`
      <a class="back" href="#/${resource}">← ${back}</a>
      ${pageHead(title, sub, html`
        <button class="btn" data-action="edit-record">Edit</button>
        <button class="btn danger" data-action="delete-record">Delete</button>`)}
      <div class="detail">
        <div class="card">${fields}</div>
        <div>
          ${main}
          <div class="section card">
            <h3>Activity</h3>
            ${quickAdd(activityDefaults)}
            ${feed(rel.activities, { showLinks: resource !== 'deals' })}
          </div>
        </div>
      </div>`;

    app._record = { resource, record: r, name: title };
    app._reload = () => viewDetail(resource, id);
  }

  // ---------- Global event delegation ----------
  app.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;
    try {
      if (action === 'toggle-activity') {
        // Let the checkbox flip visually, then sync with server.
        if (await handleActivityAction(action, el.dataset.id)) await reload();
        return;
      }
      e.preventDefault();
      if (action === 'new') {
        const defaults = el.dataset.defaults ? JSON.parse(el.dataset.defaults) : {};
        const saved = await openForm(el.dataset.resource, null, defaults);
        if (saved) {
          if (['contacts', 'companies', 'deals'].includes(el.dataset.resource) && !el.dataset.defaults) location.hash = `#/${el.dataset.resource}/${saved.id}`;
          else await reload();
        }
      } else if (action === 'edit-activity' || action === 'delete-activity') {
        if (await handleActivityAction(action, el.dataset.id)) await reload();
      } else if (action === 'edit-record') {
        const { resource, record } = app._record;
        if (await openForm(resource, record)) await reload();
      } else if (action === 'delete-record') {
        const { resource, record, name } = app._record;
        if (await confirmDelete(resource, record, name)) location.hash = `#/${resource}`;
      } else if (action === 'set-stage') {
        const { record } = app._record;
        await api(`deals/${record.id}`, { method: 'PATCH', body: { stage: el.dataset.stage } });
        toast(`Stage set to ${el.dataset.stage}`);
        await reload();
      }
    } catch (err) {
      fail(err);
    }
  });

  app.addEventListener('submit', async (e) => {
    const form = e.target.closest('[data-quick-add]');
    if (!form) return;
    e.preventDefault();
    const defaults = JSON.parse(form.dataset.quickAdd);
    const f = form.elements;
    const body = { ...defaults, type: f.type.value, subject: f.subject.value, due_date: f.due_date.value };
    try {
      await api('activities', { method: 'POST', body });
      toast('Activity added');
      await reload();
    } catch (err) {
      fail(err.errors ? new Error(Object.values(err.errors).join(', ')) : err);
    }
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-action="close-modal"]')) closeModal();
  });

  // ---------- Router ----------
  async function reload() {
    if (app._reload) await app._reload();
  }

  async function route() {
    const [path, search = ''] = location.hash.replace(/^#\/?/, '').split('?');
    const [first, id] = path.split('/');
    const section = first || 'dashboard';
    const query = Object.fromEntries(new URLSearchParams(search));
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === section));
    app._reload = null;
    app._record = null;
    app.innerHTML = '<div class="loading">Loading…</div>';
    try {
      if (section === 'dashboard') await viewDashboard();
      else if (section === 'deals' && !id) await viewDeals();
      else if (['contacts', 'companies', 'deals'].includes(section) && /^\d+$/.test(id || '')) await viewDetail(section, id);
      else if (LISTS[section] && !id) await viewList(section, query);
      else app.innerHTML = html`<div class="empty"><h1>Page not found</h1><p><a href="#/dashboard">Go to dashboard</a></p></div>`.s;
      document.title = `${cap(section)} · miniCRM`;
    } catch (err) {
      if (err.status === 404) app.innerHTML = html`<div class="empty"><h1>Not found</h1><p>${err.message}</p><p><a href="#/${section}">Back</a></p></div>`.s;
      else {
        app.innerHTML = html`<div class="empty"><h1>Could not load</h1><p>${err.message}</p></div>`.s;
        fail(err);
      }
    }
  }

  window.addEventListener('hashchange', route);
  route();
})();
