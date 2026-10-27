'use strict';
// Catalog service: product CRUD/search on MongoDB (flexible attributes), Redis read-through cache,
// and Kafka-driven stock reservation (order.created -> inventory.reserved | inventory.failed).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const Redis = require('ioredis');
const client = require('prom-client');
const { Kafka, logLevel } = require('kafkajs');
const seed = require('./seed');

const SERVICE = 'catalog-service';
const PORT = Number(process.env.PORT || 3002);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    }
    cb(null, true);
  },
});
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongo:27017';
const MONGO_DB = process.env.MONGO_DB || 'catalog';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const KAFKA_BROKERS = (process.env.KAFKA_BROKERS || 'kafka:9092').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- metrics ----------
client.register.setDefaultLabels({ service: SERVICE });
client.collectDefaultMetrics();
const httpTotal = new client.Counter({ name: 'http_requests_total', help: 'HTTP requests', labelNames: ['route', 'method', 'status'] });
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP latency', labelNames: ['route', 'method'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
const cacheOps = new client.Counter({ name: 'catalog_cache_total', help: 'Cache lookups', labelNames: ['result'] });
const reservations = new client.Counter({ name: 'inventory_reservations_total', help: 'Stock reservations', labelNames: ['result'] });

// ---------- infra handles ----------
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
redis.on('error', (e) => console.warn('redis error:', e.message));
let products; let reservationsCol;

const kafka = new Kafka({ clientId: SERVICE, brokers: KAFKA_BROKERS, logLevel: logLevel.NOTHING });
const producer = kafka.producer({ allowAutoTopicCreation: true });
const consumer = kafka.consumer({ groupId: 'catalog-service' });

// ---------- cache helpers (cache failures never break requests) ----------
async function cached(key, ttlSec, loader) {
  try {
    const hit = await redis.get(key);
    if (hit) { cacheOps.inc({ result: 'hit' }); return JSON.parse(hit); }
  } catch (_) { /* fall through */ }
  cacheOps.inc({ result: 'miss' });
  const value = await loader();
  if (value !== null && value !== undefined) {
    redis.set(key, JSON.stringify(value), 'EX', ttlSec).catch(() => {});
  }
  return value;
}
const bumpVersion = () => redis.incr('products:ver').catch(() => {});
async function version() { try { return (await redis.get('products:ver')) || '0'; } catch (_) { return '0'; } }
const dto = (d) => { const { _id, ...rest } = d; return { id: _id.toString(), ...rest }; };

// ---------- validation ----------
function cleanProduct(body, partial) {
  const out = {};
  const errors = [];
  const str = (k, req) => {
    if (body[k] === undefined) { if (req && !partial) errors.push(`${k} required`); return; }
    if (typeof body[k] !== 'string' || !body[k].trim()) errors.push(`${k} must be a non-empty string`); else out[k] = body[k].trim();
  };
  str('name', true); str('category', true); str('description', false); str('image', false);
  for (const k of ['price', 'stock']) {
    if (body[k] === undefined) { if (!partial) errors.push(`${k} required`); continue; }
    const n = Number(body[k]);
    if (!Number.isFinite(n) || n < 0) errors.push(`${k} must be a non-negative number`);
    else out[k] = k === 'stock' ? Math.floor(n) : Math.round(n * 100) / 100;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== 'string')) errors.push('tags must be an array of strings'); else out.tags = body.tags;
  }
  if (body.attributes !== undefined) {
    if (typeof body.attributes !== 'object' || body.attributes === null || Array.isArray(body.attributes)) errors.push('attributes must be an object'); else out.attributes = body.attributes;
  }
  return { out, errors };
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route ? (req.baseUrl || '') + req.route.path : 'unmatched';
    httpTotal.inc({ route, method: req.method, status: res.statusCode });
    httpDuration.observe({ route, method: req.method }, Number(process.hrtime.bigint() - start) / 1e9);
  });
  next();
});
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: 'internal error' }); });
const requireAdmin = (req, res, next) => (req.get('X-User-Role') === 'admin' ? next() : res.status(403).json({ error: 'admin only' }));

app.get('/products', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const { q, category, minPrice, maxPrice, sort } = req.query;
  const filter = {};
  if (q) filter.$text = { $search: String(q) };
  if (category) filter.category = String(category);
  if (minPrice || maxPrice) {
    filter.price = {};
    if (minPrice) filter.price.$gte = Number(minPrice);
    if (maxPrice) filter.price.$lte = Number(maxPrice);
  }
  const sorts = { price_asc: { price: 1 }, price_desc: { price: -1 }, newest: { createdAt: -1 } };
  const key = `products:list:${await version()}:${crypto.createHash('sha1').update(JSON.stringify([filter, page, limit, sort])).digest('hex')}`;
  const body = await cached(key, 30, async () => {
    const [items, total] = await Promise.all([
      products.find(filter).sort(sorts[sort] || { name: 1 }).skip((page - 1) * limit).limit(limit).toArray(),
      products.countDocuments(filter),
    ]);
    return { items: items.map(dto), total, page, limit, pages: Math.ceil(total / limit) };
  });
  res.json(body);
}));

app.get('/products/categories', wrap(async (req, res) => {
  const key = `products:categories:${await version()}`;
  res.json(await cached(key, 60, async () => {
    const rows = await products.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray();
    return rows.map((r) => ({ name: r._id, count: r.count }));
  }));
}));

app.get('/products/:id', wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const p = await cached(`product:${req.params.id}`, 60, async () => {
    const d = await products.findOne({ _id: new ObjectId(req.params.id) });
    return d ? dto(d) : null;
  });
  if (!p) return res.status(404).json({ error: 'product not found' });
  res.json(p);
}));

// Admin image upload: validate actual image content, resize, and save as WebP.
app.post('/products/upload', requireAdmin, (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      const tooLarge = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'Image must be 5 MB or smaller' : err.message,
      });
    }
    next();
  });
}, wrap(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Choose an image file using the image field' });
  }

  let metadata;
  try {
    metadata = await sharp(req.file.buffer, { limitInputPixels: 40000000 }).metadata();
  } catch (_) {
    return res.status(400).json({ error: 'Uploaded file is not a valid image' });
  }

  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    return res.status(400).json({ error: 'Only JPEG, PNG, and WebP images are supported' });
  }

  const filename = `${crypto.randomUUID()}.webp`;
  const destination = path.join(UPLOAD_DIR, filename);

  try {
    await sharp(req.file.buffer, { limitInputPixels: 40000000 })
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(destination);
  } catch (err) {
    console.error('Image processing failed:', err.message);
    return res.status(400).json({ error: 'Could not process this image' });
  }

  res.status(201).json({ image: `/api/products/uploads/${filename}` });
}));

// Serve only processed WebP files, not the original uploads.
app.get('/products/uploads/:filename', (req, res, next) => {
  const filename = req.params.filename;
  if (!/^[a-f0-9-]{36}\.webp$/.test(filename)) {
    return res.status(404).end();
  }
  res.type('image/webp');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(UPLOAD_DIR, filename), (err) => {
    if (err && !res.headersSent) next(err);
  });
});

app.post('/products', requireAdmin, wrap(async (req, res) => {
  const { out, errors } = cleanProduct(req.body || {}, false);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const doc = { description: '', image: '📦', tags: [], attributes: {}, ...out, createdAt: new Date() };
  const r = await products.insertOne(doc);
  await bumpVersion();
  res.status(201).json(dto({ _id: r.insertedId, ...doc }));
}));

app.put('/products/:id', requireAdmin, wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const { out, errors } = cleanProduct(req.body || {}, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const d = await products.findOneAndUpdate({ _id: new ObjectId(req.params.id) }, { $set: out }, { returnDocument: 'after' });
  if (!d) return res.status(404).json({ error: 'product not found' });
  await Promise.all([redis.del(`product:${req.params.id}`).catch(() => {}), bumpVersion()]);
  res.json(dto(d));
}));

app.delete('/products/:id', requireAdmin, wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'invalid id' });
  const r = await products.deleteOne({ _id: new ObjectId(req.params.id) });
  await Promise.all([redis.del(`product:${req.params.id}`).catch(() => {}), bumpVersion()]);
  res.status(r.deletedCount ? 204 : 404).end();
}));

app.get('/healthz', wrap(async (req, res) => {
  await products.estimatedDocumentCount();
  res.json({ status: 'ok', redis: redis.status });
}));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// ---------- inventory saga participant ----------
async function emit(topic, orderId, payload) {
  await producer.send({ topic, messages: [{ key: orderId, value: JSON.stringify({ type: topic, orderId, ...payload }) }] });
}

async function reserveStock(order) {
  const { orderId, items } = order;
  try {
    await reservationsCol.insertOne({ _id: orderId, status: 'pending', createdAt: new Date() });
  } catch (e) {
    if (e.code !== 11000) throw e;
    const prev = await reservationsCol.findOne({ _id: orderId });
    if (prev && prev.status === 'reserved') return emit('inventory.reserved', orderId, {});
    if (prev && prev.status === 'failed') return emit('inventory.failed', orderId, { reason: prev.reason });
    // 'pending' means a previous attempt crashed midway: undo anything it did and retry cleanly
    for (const it of prev?.applied || []) {
      await products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: it.qty } });
    }
    await reservationsCol.updateOne({ _id: orderId }, { $set: { applied: [] } });
  }

  const applied = [];
  let failure = null;
  for (const it of items) {
    if (!ObjectId.isValid(it.productId)) { failure = `invalid product ${it.productId}`; break; }
    const r = await products.updateOne({ _id: new ObjectId(it.productId), stock: { $gte: it.qty } }, { $inc: { stock: -it.qty } });
    if (r.modifiedCount !== 1) { failure = `insufficient stock for ${it.name || it.productId}`; break; }
    applied.push({ productId: it.productId, qty: it.qty });
    await reservationsCol.updateOne({ _id: orderId }, { $set: { applied } });
  }

  if (failure) {
    for (const it of applied) await products.updateOne({ _id: new ObjectId(it.productId) }, { $inc: { stock: it.qty } });
    await reservationsCol.updateOne({ _id: orderId }, { $set: { status: 'failed', reason: failure, applied: [] } });
    reservations.inc({ result: 'failed' });
    await emit('inventory.failed', orderId, { reason: failure });
  } else {
    await reservationsCol.updateOne({ _id: orderId }, { $set: { status: 'reserved' } });
    reservations.inc({ result: 'reserved' });
    await emit('inventory.reserved', orderId, {});
  }
  await Promise.all([bumpVersion(), ...items.map((it) => redis.del(`product:${it.productId}`).catch(() => {}))]);
}

async function runKafka() {
  for (;;) {
    try {
      await producer.connect();
      await consumer.connect();
      await consumer.subscribe({ topic: 'order.created', fromBeginning: true });
      await consumer.run({
        eachMessage: async ({ message }) => {
          let order;
          try { order = JSON.parse(message.value.toString()); } catch (_) { console.warn('skipping malformed order.created message'); return; }
          if (!order.orderId || !Array.isArray(order.items)) { console.warn('skipping invalid order.created message'); return; }
          console.log(`reserving stock for order ${order.orderId}`);
          await reserveStock(order);
        },
      });
      console.log('kafka consumer running');
      return;
    } catch (e) {
      console.warn('kafka not ready, retrying:', e.message);
      try { await consumer.disconnect(); } catch (_) { /* ignore */ }
      await sleep(3000);
    }
  }
}

// ---------- bootstrap ----------
async function main() {
  let mongo;
  for (let i = 0; ; i++) {
    try { mongo = await MongoClient.connect(MONGO_URL, { serverSelectionTimeoutMS: 3000 }); break; }
    catch (e) { if (i >= 30) throw e; console.warn('mongo not ready, retrying:', e.message); await sleep(2000); }
  }
  const db = mongo.db(MONGO_DB);
  products = db.collection('products');
  reservationsCol = db.collection('inventory_reservations');
  await products.createIndex({ name: 'text', description: 'text', tags: 'text' });
  await products.createIndex({ category: 1, price: 1 });
  if ((await products.estimatedDocumentCount()) === 0) {
    await products.insertMany(seed.map((p) => ({ ...p, createdAt: new Date() })));
    console.log(`seeded ${seed.length} products`);
  }
  const server = app.listen(PORT, () => console.log(`${SERVICE} listening on ${PORT}`));
  runKafka();
  const shutdown = async () => {
    server.close();
    try { await consumer.disconnect(); await producer.disconnect(); } catch (_) { /* ignore */ }
    await mongo.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
