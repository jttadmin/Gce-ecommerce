"""Notification service: turns domain events into (simulated) emails and exposes Prometheus metrics."""
import asyncio
import json
import logging
import os

from aiokafka import AIOKafkaConsumer
from prometheus_client import Counter, start_http_server

SERVICE = "notification-service"
KAFKA_BROKERS = os.getenv("KAFKA_BROKERS", "kafka:9092")
PORT = int(os.getenv("PORT", "3005"))
TOPICS = ["user.registered", "order.created", "order.confirmed", "order.cancelled"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(SERVICE)

SENT = Counter("notifications_sent_total", "Notifications sent", ["service", "type"])
FAILED = Counter("notifications_failed_total", "Events that could not be processed", ["service"])


def render(evt: dict) -> tuple[str, str, str] | None:
    """Return (to, subject, body) for an event, or None if it needs no email."""
    kind = evt.get("type")
    to = evt.get("email") or f"user:{evt.get('userId', 'unknown')}"
    if kind == "user.registered":
        return to, "Welcome aboard!", f"Hi {evt.get('name', 'there')}, your account is ready."
    if kind == "order.created":
        return to, f"Order {evt['orderId'][:8]} received", f"We received your order of {evt['total']:.2f}. Reserving stock now."
    if kind == "order.confirmed":
        return to, f"Order {evt['orderId'][:8]} confirmed", f"Good news: your order of {evt['total']:.2f} is confirmed."
    if kind == "order.cancelled":
        return to, f"Order {evt['orderId'][:8]} cancelled", f"Sorry, your order was cancelled: {evt.get('reason') or 'unknown reason'}."
    return None


async def main():
    start_http_server(PORT)
    consumer = AIOKafkaConsumer(
        *TOPICS, bootstrap_servers=KAFKA_BROKERS, group_id="notification-service",
        auto_offset_reset="earliest", enable_auto_commit=True,
    )
    for attempt in range(60):
        try:
            await consumer.start()
            break
        except Exception as exc:  # noqa: BLE001
            log.warning("kafka not ready (%s), retrying", exc)
            await asyncio.sleep(3)
    else:
        raise SystemExit("kafka unavailable")
    log.info("notification-service consuming %s, metrics on :%d", TOPICS, PORT)
    try:
        async for msg in consumer:
            try:
                evt = json.loads(msg.value)
                mail = render(evt)
                if mail:
                    to, subject, body = mail
                    log.info("[EMAIL] to=%s subject=%r body=%r", to, subject, body)
                    SENT.labels(SERVICE, evt["type"]).inc()
            except Exception:  # noqa: BLE001
                FAILED.labels(SERVICE).inc()
                log.exception("bad event on %s", msg.topic)
    finally:
        await consumer.stop()


if __name__ == "__main__":
    asyncio.run(main())
