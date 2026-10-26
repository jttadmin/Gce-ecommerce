.PHONY: up down logs ps smoke reset

up:
	docker compose up -d --build

down:
	docker compose down

reset:
	docker compose down -v

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

smoke:
	bash scripts/smoke-test.sh
