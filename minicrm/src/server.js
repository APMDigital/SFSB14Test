'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, CONTACT_STATUSES, DEAL_STAGES, ACTIVITY_TYPES } = require('./db');
const { RESOURCES, createRepository } = require('./resources');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024; // 1 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = payload === undefined ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback: unknown non-asset paths serve the app shell.
      if (!path.extname(rel)) return serveStatic(req, res, '/index.html');
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer({ db }) {
  const repo = createRepository(db);

  async function handleApi(req, res, url) {
    const parts = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const query = Object.fromEntries(url.searchParams);
    const method = req.method;

    if (parts.length === 1 && parts[0] === 'health' && method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }
    if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
      return sendJson(res, 200, {
        contact_statuses: CONTACT_STATUSES,
        deal_stages: DEAL_STAGES,
        activity_types: ACTIVITY_TYPES,
      });
    }
    if (parts.length === 1 && parts[0] === 'stats' && method === 'GET') {
      return sendJson(res, 200, repo.stats());
    }

    const [resource, idOrAction, ...rest] = parts;
    if (!resource || !RESOURCES[resource] || rest.length) {
      return sendJson(res, 404, { error: 'Not found' });
    }

    if (idOrAction === undefined) {
      if (method === 'GET') return sendJson(res, 200, repo.list(resource, query));
      if (method === 'POST') return sendJson(res, 201, repo.create(resource, await readBody(req)));
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    if (idOrAction === 'export.csv' && method === 'GET') {
      const { items } = repo.list(resource, { ...query, limit: '5000' });
      const columns = ['id', ...Object.keys(RESOURCES[resource].fields)];
      if (items[0]) for (const k of Object.keys(items[0])) if (!columns.includes(k)) columns.push(k);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${resource}.csv"`,
      });
      return res.end('﻿' + toCsv(items, columns));
    }

    if (!/^\d+$/.test(idOrAction)) return sendJson(res, 404, { error: 'Not found' });
    const id = Number(idOrAction);
    if (method === 'GET') return sendJson(res, 200, repo.detail(resource, id));
    if (method === 'PUT' || method === 'PATCH') {
      return sendJson(res, 200, repo.update(resource, id, await readBody(req)));
    }
    if (method === 'DELETE') {
      repo.remove(resource, id);
      res.writeHead(204).end();
      return;
    }
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
      } else {
        res.writeHead(405).end();
      }
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) {
        sendJson(res, status, {
          error: status === 500 ? 'Internal server error' : err.message,
          ...(err.errors ? { errors: err.errors } : {}),
        });
      } else {
        res.end();
      }
    }
  });
}

if (require.main === module) {
  const dbFile = process.env.MINICRM_DB || path.join(__dirname, '..', 'data', 'minicrm.db');
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const db = openDatabase(dbFile);

  if (process.env.MINICRM_SEED !== '0') {
    const empty = db.prepare('SELECT (SELECT COUNT(*) FROM companies) + (SELECT COUNT(*) FROM contacts) AS n').get().n === 0;
    if (empty) {
      require('./seed').seed(db);
      console.log('Empty database – loaded sample data (set MINICRM_SEED=0 to disable).');
    }
  }

  const server = createServer({ db });
  server.listen(port, host, () => {
    console.log(`miniCRM running at http://${host}:${port}  (database: ${dbFile})`);
  });
  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer };
