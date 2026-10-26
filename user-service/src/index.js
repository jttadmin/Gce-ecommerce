'use strict';
// User service: registration, login (JWT), profile. Storage: PostgreSQL. Emits user.registered to Kafka.

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const client = require('prom-client');
const { Kafka, logLevel } = require('kafkajs');

const SERVICE = 'user-service';
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters');
}
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres:5432/users';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');

// ---------- metrics ----------
client.register.setDefaultLabels({ service: SERVICE });
client.collectDefaultMetrics();
const httpTotal = new client.Counter({
  name: 'http_requests_total', help: 'HTTP requests', labelNames: ['route', 'method', 'status'],
});
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['route', 'method'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
const registrations = new client.Counter({ name: 'user_registrations_total', help: 'Users registered' });
const logins = new client.Counter({ name: 'user_logins_total', help: 'Login attempts', labelNames: ['result'] });

const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- kafka (best effort) ----------
const kafka = new Kafka({ clientId: SERVICE, brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
const producer = kafka.producer({ allowAutoTopicCreation: true });
let producerReady = false;
(async function connectProducer() {
  for (;;) {
    try { await producer.connect(); producerReady = true; console.log('kafka producer connected'); return; }
    catch (e) { console.warn('kafka not ready, retrying:', e.message); await sleep(3000); }
  }
})();
async function publish(topic, key, value) {
  if (!producerReady) return;
  try { await producer.send({ topic, messages: [{ key, value: JSON.stringify(value) }] }); }
  catch (e) { console.warn('publish failed:', e.message); }
}

// ---------- db ----------
async function initDb() {
  for (let i = 0; i < 30; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'customer',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      return;
    } catch (e) { console.warn('postgres not ready, retrying:', e.message); await sleep(2000); }
  }
  throw new Error('postgres unavailable');
}

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  const hash = await bcrypt.hash(password, 10);
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1, 'Administrator', $2, 'admin')
     ON CONFLICT (email) DO NOTHING`, [email, hash]);
}

const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const sign = (u) => jwt.sign({ sub: u.id, role: u.role, email: u.email }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '12h' });

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? (req.baseUrl || '') + req.route.path : 'unmatched';
    httpTotal.inc({ route, method: req.method, status: res.statusCode });
    httpDuration.observe({ route, method: req.method }, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
});

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: 'internal error' });
});

app.post('/users/register', wrap(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
  const hash = await bcrypt.hash(password, 10);
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, role`,
      [email.toLowerCase(), name.trim(), hash]);
    registrations.inc();
    publish('user.registered', rows[0].id, { type: 'user.registered', userId: rows[0].id, email: rows[0].email, name: rows[0].name });
    res.status(201).json({ token: sign(rows[0]), user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'email already registered' });
    throw e;
  }
}));

app.post('/users/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'email and password required' });
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    logins.inc({ result: 'failure' });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  logins.inc({ result: 'success' });
  res.json({ token: sign(u), user: publicUser(u) });
}));

app.get('/users/me', wrap(async (req, res) => {
  const id = req.get('X-User-Id');
  if (!id) return res.status(401).json({ error: 'authentication required' });
  const { rows } = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  res.json(rows[0]);
}));

app.get('/healthz', wrap(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

(async () => {
  await initDb();
  await seedAdmin();
  const server = app.listen(PORT, () => console.log(`${SERVICE} listening on ${PORT}`));
  const shutdown = async () => {
    server.close();
    try { await producer.disconnect(); } catch (_) { /* ignore */ }
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((e) => { console.error(e); process.exit(1); });
