"""Order service.

* Creates orders from the user's cart (PostgreSQL).
* Transactional outbox: order + event are written in one transaction, a relay publishes to Kafka.
* Saga: consumes inventory.reserved / inventory.failed and confirms / cancels the order.
"""
import asyncio
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime
from decimal import Decimal

import asyncpg
import httpx
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from pydantic import BaseModel, Field

SERVICE = "order-service"
DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@postgres:5432/orders")
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
CART_URL = os.getenv("CART_SERVICE_URL", "http://cart-service:3003")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger(SERVICE)

HTTP_TOTAL = Counter("http_requests_total", "HTTP requests", ["service", "route", "method", "status"])
HTTP_DURATION = Histogram(
    "http_request_duration_seconds", "HTTP latency", ["service", "route", "method"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
)
ORDERS_CREATED = Counter("orders_created_total", "Orders created", ["service"])
ORDERS_COMPLETED = Counter("orders_completed_total", "Orders finalised by the saga", ["service", "status"])
ORDER_VALUE = Counter("orders_value_total", "Sum of created order value", ["service"])
OUTBOX_PENDING = Gauge("outbox_pending_events", "Unsent outbox rows", ["service"])


class State:
    pool: asyncpg.Pool
    producer: AIOKafkaProducer
    tasks: list


state = State()


async def retry(fn, what, tries=40, delay=2.0):
    for i in range(tries):
        try:
            return await fn()
        except Exception as exc:  # noqa: BLE001
            if i == tries - 1:
                raise
            log.warning("%s not ready (%s), retrying", what, exc)
            await asyncio.sleep(delay)


async def init_conn(conn: asyncpg.Connection):
    await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")


SCHEMA = """
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    user_email TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    total NUMERIC(12,2) NOT NULL,
    items JSONB NOT NULL,
    shipping_address TEXT,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS outbox (
    id BIGSERIAL PRIMARY KEY,
    topic TEXT NOT NULL,
    key TEXT NOT NULL,
    payload JSONB NOT NULL,
    sent BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_unsent_idx ON outbox (id) WHERE NOT sent;
"""


def order_dto(row) -> dict:
    d = dict(row)
    d["id"] = str(d["id"])
    d["total"] = float(d["total"])
    for k in ("created_at", "updated_at"):
        d[k] = d[k].isoformat()
    return {
        "id": d["id"], "status": d["status"], "total": d["total"], "items": d["items"],
        "shippingAddress": d["shipping_address"], "failureReason": d["failure_reason"],
        "createdAt": d["created_at"], "updatedAt": d["updated_at"],
    }


async def outbox_relay():
    """Publish unsent outbox rows to Kafka (at-least-once)."""
    while True:
        try:
            async with state.pool.acquire() as conn:
                async with conn.transaction():
                    rows = await conn.fetch(
                        "SELECT id, topic, key, payload FROM outbox WHERE NOT sent ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED"
                    )
                    for r in rows:
                        await state.producer.send_and_wait(r["topic"], json.dumps(r["payload"]).encode(), key=r["key"].encode())
                    if rows:
                        await conn.execute("UPDATE outbox SET sent = TRUE WHERE id = ANY($1::bigint[])", [r["id"] for r in rows])
                pending = await conn.fetchval("SELECT count(*) FROM outbox WHERE NOT sent")
                OUTBOX_PENDING.labels(SERVICE).set(pending)
            await asyncio.sleep(0.2 if rows else 0.5)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("outbox relay error: %s", exc)
            await asyncio.sleep(2)


async def saga_consumer():
    """Apply inventory results to orders."""
    consumer = AIOKafkaConsumer(
        "inventory.reserved", "inventory.failed",
        bootstrap_servers=KAFKA_BROKERS, group_id="order-service",
        auto_offset_reset="earliest", enable_auto_commit=True,
    )
    await retry(consumer.start, "kafka consumer")
    try:
        async for msg in consumer:
            try:
                evt = json.loads(msg.value)
                await apply_inventory_result(evt)
            except Exception as exc:  # noqa: BLE001
                log.exception("failed to process %s: %s", msg.topic, exc)
    finally:
        await consumer.stop()


async def apply_inventory_result(evt: dict):
    ok = evt.get("type") == "inventory.reserved"
    new_status = "CONFIRMED" if ok else "CANCELLED"
    async with state.pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "UPDATE orders SET status=$2, failure_reason=$3, updated_at=now() "
                "WHERE id=$1::uuid AND status='PENDING' RETURNING *",
                evt["orderId"], new_status, None if ok else evt.get("reason"),
            )
            if not row:  # unknown order or already finalised (duplicate delivery)
                return
            await conn.execute(
                "INSERT INTO outbox (topic, key, payload) VALUES ($1, $2, $3)",
                "order.confirmed" if ok else "order.cancelled", evt["orderId"],
                {"type": "order.confirmed" if ok else "order.cancelled", "orderId": evt["orderId"],
                 "userId": row["user_id"], "email": row["user_email"], "total": float(row["total"]),
                 "reason": row["failure_reason"]},
            )
    ORDERS_COMPLETED.labels(SERVICE, new_status).inc()
    log.info("order %s -> %s", evt["orderId"], new_status)


@asynccontextmanager
async def lifespan(_: FastAPI):
    state.pool = await retry(lambda: asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10, init=init_conn), "postgres")
    async with state.pool.acquire() as conn:
        await conn.execute(SCHEMA)
    state.producer = AIOKafkaProducer(bootstrap_servers=KAFKA_BROKERS, acks="all", enable_idempotence=True)
    await retry(state.producer.start, "kafka producer")
    state.tasks = [asyncio.create_task(outbox_relay()), asyncio.create_task(saga_consumer())]
    log.info("order-service ready")
    yield
    for t in state.tasks:
        t.cancel()
    await asyncio.gather(*state.tasks, return_exceptions=True)
    await state.producer.stop()
    await state.pool.close()


app = FastAPI(title="order-service", lifespan=lifespan)


@app.middleware("http")
async def metrics_mw(request: Request, call_next):
    start = time.perf_counter()
    status = 500
    try:
        response = await call_next(request)
        status = response.status_code
        return response
    finally:
        route = request.scope.get("route")
        path = getattr(route, "path", "unmatched")
        HTTP_TOTAL.labels(SERVICE, path, request.method, str(status)).inc()
        HTTP_DURATION.labels(SERVICE, path, request.method).observe(time.perf_counter() - start)


class UserCtx(BaseModel):
    id: str
    email: str | None = None
    role: str = "customer"


def current_user(
    x_user_id: str | None = Header(default=None),
    x_user_email: str | None = Header(default=None),
    x_user_role: str | None = Header(default=None),
) -> UserCtx:
    if not x_user_id:
        raise HTTPException(401, "authentication required")
    return UserCtx(id=x_user_id, email=x_user_email, role=x_user_role or "customer")


class CreateOrder(BaseModel):
    shippingAddress: str = Field(default="", max_length=500)


@app.post("/orders", status_code=201)
async def create_order(body: CreateOrder, user: UserCtx = Depends(current_user)):
    headers = {"X-User-Id": user.id}
    async with httpx.AsyncClient(timeout=3.0) as http:
        try:
            r = await http.get(f"{CART_URL}/cart", headers=headers)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            log.warning("cart fetch failed: %s", exc)
            raise HTTPException(502, "cart service unavailable")
        cart = r.json()
        items = cart.get("items") or []
        if not items:
            raise HTTPException(400, "cart is empty")
        total = sum(Decimal(str(i["price"])) * i["qty"] for i in items)

        async with state.pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "INSERT INTO orders (user_id, user_email, total, items, shipping_address) "
                    "VALUES ($1,$2,$3,$4,$5) RETURNING *",
                    user.id, user.email, total, items, body.shippingAddress or None,
                )
                oid = str(row["id"])
                await conn.execute(
                    "INSERT INTO outbox (topic, key, payload) VALUES ('order.created', $1, $2)", oid,
                    {"type": "order.created", "orderId": oid, "userId": user.id, "email": user.email,
                     "items": items, "total": float(total), "createdAt": row["created_at"].isoformat()},
                )
        try:  # best effort: a leftover cart is harmless, a failed order is not
            await http.delete(f"{CART_URL}/cart", headers=headers)
        except httpx.HTTPError:
            log.warning("could not clear cart for user %s", user.id)

    ORDERS_CREATED.labels(SERVICE).inc()
    ORDER_VALUE.labels(SERVICE).inc(float(total))
    return order_dto(row)


@app.get("/orders")
async def list_orders(user: UserCtx = Depends(current_user)):
    async with state.pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", user.id)
    return [order_dto(r) for r in rows]


@app.get("/orders/{order_id}")
async def get_order(order_id: str, user: UserCtx = Depends(current_user)):
    try:
        async with state.pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM orders WHERE id=$1::uuid", order_id)
    except asyncpg.DataError:
        raise HTTPException(400, "invalid order id")
    if not row or (row["user_id"] != user.id and user.role != "admin"):
        raise HTTPException(404, "order not found")
    return order_dto(row)


@app.get("/healthz")
async def healthz():
    async with state.pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"status": "ok"}


@app.get("/metrics")
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
