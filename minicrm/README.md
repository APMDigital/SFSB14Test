# miniCRM

A standalone mini CRM with a database and web frontend. **Zero npm dependencies.** It needs only Node.js 22.13+, which has SQLite built in (`node:sqlite`).

## Quick start

```bash
cd minicrm
npm start            # → http://127.0.0.1:3000
```

On first start the database `data/minicrm.db` is created and filled with sample data. Set `MINICRM_SEED=0` to start empty.

| Env var        | Default              | Purpose                    |
| -------------- | -------------------- | -------------------------- |
| `PORT`         | `3000`               | HTTP port                  |
| `HOST`         | `127.0.0.1`          | Bind address (`0.0.0.0` for LAN) |
| `MINICRM_DB`   | `data/minicrm.db`    | SQLite database file       |
| `MINICRM_SEED` | `1`                  | Seed sample data into an empty DB |

`npm test` runs the API test suite. `npm run seed` adds sample data again.

## Features

- **Dashboard**: open pipeline, won value and win rate, open/overdue tasks, pipeline by stage, contacts by status, upcoming tasks, recent activity.
- **Contacts**: status (lead/prospect/customer/inactive), company link, search, filter, sort.
- **Companies**: contact count, open deals and pipeline value per company.
- **Deals**: a Kanban board (drag cards between stages) and a stage switcher on the deal page.
- **Activities**: notes, calls, emails, meetings and tasks, with due dates, done/open state and an overdue view. You can log them quickly from any contact, company or deal page.
- CSV export on every list, server-side validation, dark mode, and a mobile-friendly layout.

## Architecture

```
minicrm/
├── src/
│   ├── db.js          # SQLite schema (FKs, CHECK constraints, indexes)
│   ├── resources.js   # entity definitions, validation, generic repository, stats
│   ├── server.js      # node:http REST API + static file server
│   └── seed.js        # sample data
├── public/            # vanilla-JS SPA (index.html, app.js, styles.css)
├── test/api.test.js   # node:test integration tests
└── data/              # database file (git-ignored)
```

### REST API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/{resource}?q=&sort=&dir=&limit=&offset=&<filter>=` | list (`resource` = `companies`, `contacts`, `deals`, `activities`) |
| POST | `/api/{resource}` | create |
| GET | `/api/{resource}/{id}` | record + `related` records |
| PUT/PATCH | `/api/{resource}/{id}` | partial update |
| DELETE | `/api/{resource}/{id}` | delete |
| GET | `/api/{resource}/export.csv` | CSV export (same filters as list) |
| GET | `/api/stats`, `/api/meta`, `/api/health` | dashboard data, enum values, health check |

Filters: contacts `status`, `company_id`; deals `stage`, `company_id`, `contact_id`; activities `type`, `done`, `contact_id`, `company_id`, `deal_id`, `due=overdue|upcoming`.

Validation errors return `400 {"error": "...", "errors": {"field": "message"}}`.

Deleting a company or contact unlinks its related records. Deleting a record also deletes the activities attached to it.

> There is no authentication. The app binds to localhost by default. Put it behind a reverse proxy with auth before you expose it on a network.
