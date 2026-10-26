# Kart — microservices e-commerce platform

React storefront → Go API gateway → polyglot microservices, with Kafka events, Redis, a flexible document DB and a full Prometheus/Grafana monitoring stack. Everything runs with one `docker compose up`.

## Architecture

```
                         ┌──────────────┐
  Browser ──► Nginx/React │  frontend    │ :3000
                         └──────┬───────┘
                                │ /api
                         ┌──────▼───────┐   JWT verify · rate limit · CORS · metrics
                         │ gateway (Go) │ :8080
                         └─┬───┬───┬───┬┘
        ┌──────────────────┘   │   │   └───────────────────┐
┌───────▼────────┐  ┌──────────▼───┐  ┌▼──────────────┐  ┌──▼──────────────┐
│ user-service   │  │ catalog-svc  │  │ cart-service  │  │ order-service   │
│ Node · Postgres│  │ Node · Mongo │  │ Go · Redis    │  │ Python · Postgres│
│ JWT, bcrypt    │  │ + Redis cache│  │ (hash per user)│ │ outbox + saga   │
└───────┬────────┘  └──────┬───▲───┘  └───────────────┘  └──┬───▲──────────┘
        │ user.registered  │   │ order.created              │   │ inventory.*
        │                  │   └────────────────────────────┘   │
        │            ┌─────▼────────────── Kafka ────────────────┴──┐
        └───────────►│ user.registered · order.created/confirmed/   │
                     │ cancelled · inventory.reserved/failed        │
                     └─────────────────────┬────────────────────────┘
                                   ┌───────▼────────────┐
                                   │ notification-svc   │ (Python, simulated emails)
                                   └────────────────────┘
```

| Service | Language | Data store | Responsibility |
|---|---|---|---|
| gateway | Go (stdlib only) | in-memory | Routing, JWT verification, per-IP rate limit, injects `X-User-*` headers |
| user-service | Node.js / Express | PostgreSQL `users` | Register, login, profile, seeded admin |
| catalog-service | Node.js / Express | MongoDB + Redis cache | Product search/CRUD with flexible `attributes`, stock reservation |
| cart-service | Go (stdlib only) | Redis hashes | Cart per user; prices always read from catalog |
| order-service | Python / FastAPI | PostgreSQL `orders` | Orders, transactional outbox, saga result handling |
| notification-service | Python | none | Consumes events, "sends" emails, exposes metrics |

**Why this DB mix:** products differ wildly per category (earbuds have battery life, shoes have sizes), so the catalog lives in MongoDB with a free-form `attributes` object. Users and orders need transactions and constraints, so they use PostgreSQL (one database per service).

**Order flow (saga, no distributed transaction):**
1. `POST /api/orders` reads the cart, then in **one Postgres transaction** inserts the order (`PENDING`) and an `order.created` row in the **outbox**.
2. A relay publishes outbox rows to Kafka (at-least-once).
3. catalog-service consumes `order.created`, atomically decrements stock per item (`stock >= qty` guard), compensates on partial failure, and emits `inventory.reserved` or `inventory.failed`. Reservations are idempotent per order id.
4. order-service consumes the result and moves the order to `CONFIRMED` or `CANCELLED`, emitting `order.confirmed` / `order.cancelled`.
5. notification-service emails the customer. The UI polls while an order is `PENDING`.

## Run it

```bash
cp .env.example .env        # optional, defaults work for local use
docker compose up -d --build
bash scripts/smoke-test.sh  # end-to-end check through the gateway
```

| URL | What |
|---|---|
| http://localhost:3000 | Storefront |
| http://localhost:8080/api/products | API via gateway |
| http://localhost:3030 | Grafana (admin / admin) — dashboard "Kart — E-commerce Overview" is the home page |
| http://localhost:9090 | Prometheus (alert rules under *Alerts*) |

Seeded admin: `admin@example.com` / `admin12345` (shows an **Admin** button to add products with arbitrary JSON attributes). 12 sample products are seeded on first start.

First start takes a few minutes (image builds + Kafka/Mongo/Postgres health checks); `docker compose ps` shows progress.

## API (all under `/api` on the gateway)

| Method & path | Auth | Notes |
|---|---|---|
| `POST /users/register`, `POST /users/login` | public | Returns `{token, user}` |
| `GET /users/me` | user | |
| `GET /products?q=&category=&minPrice=&maxPrice=&sort=&page=&limit=` | public | sort: `price_asc`, `price_desc`, `newest` |
| `GET /products/categories`, `GET /products/:id` | public | Redis-cached |
| `POST/PUT/DELETE /products[/:id]` | admin | |
| `GET /cart`, `POST /cart/items {productId, qty}`, `PUT /cart/items/:id {qty}`, `DELETE /cart/items/:id`, `DELETE /cart` | user | |
| `POST /orders {shippingAddress}`, `GET /orders`, `GET /orders/:id` | user | |

## Monitoring

* **Prometheus** scrapes every service (`/metrics`) plus exporters for Redis, Kafka (consumer lag, topic offsets), PostgreSQL, MongoDB and cAdvisor (container CPU/memory).
* All services emit the same RED metrics — `http_requests_total{service,route,method,status}` and `http_request_duration_seconds` — so one dashboard covers them all. Business metrics: `orders_created_total`, `orders_value_total`, `orders_completed_total{status}`, `inventory_reservations_total`, `catalog_cache_total{result}`, `cart_operations_total`, `outbox_pending_events`.
* **Grafana** is provisioned automatically (datasource + 27-panel dashboard: overview, HTTP, Kafka, Redis, databases, containers).
* **Alert rules** (`monitoring/prometheus/alerts.yml`): service down, 5xx ratio, p95 latency, Kafka lag, outbox backlog, Redis memory. Add an Alertmanager service to route them to Slack/PagerDuty.

## Try the failure paths

* Order more units than are in stock → order ends `CANCELLED` with a reason; stock is restored.
* `docker compose stop kafka` then place an order → order stays `PENDING`, `outbox_pending_events` rises, and drains once Kafka is back (no lost events).
* `docker compose stop redis` → catalog still works (cache is best-effort); cart returns 503.

## Production notes

* Change `JWT_SECRET`, DB passwords and the admin password (`.env`). The gateway and user-service must share the same `JWT_SECRET`.
* Services trust `X-User-*` headers, so they must only be reachable through the gateway (compose publishes only the gateway, frontend and monitoring ports). In Kubernetes enforce this with NetworkPolicies.
* Kafka, Mongo, Redis and Postgres are single nodes here; use managed services (MSK, DocumentDB/Atlas, ElastiCache, RDS) or operators in a real cluster. Scale Kafka topics beyond 3 partitions as consumers grow.
* Gateway rate limiting is in-memory per instance; move it to Redis if you run several replicas.

## Layout

```
gateway/ cart-service/        Go (no external dependencies)
user-service/ catalog-service/ Node.js
order-service/ notification-service/ Python
frontend/                     React + Vite, served by Nginx
monitoring/                   Prometheus rules + Grafana provisioning/dashboard
infra/postgres/init.sql       creates the per-service databases
scripts/smoke-test.sh         end-to-end test
```
