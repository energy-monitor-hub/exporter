# Everyday exporter commands. They run directly on this machine (Node 22 + npm >= 11.10,
# Docker for the compose targets). `make` lists them.
# Inside the dashboard repository the same commands are wrapped by its own Makefile.

COMPOSE := docker compose -f deploy/docker-compose.yml
COMPOSE_DEV := $(COMPOSE) -f deploy/docker-compose.dev.yml

.DEFAULT_GOAL := help
.PHONY: help exporter-update login dev logs stop record test typecheck deps-check deps-outdated

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  make %-16s %s\n", $$1, $$2}'

exporter-update: ## Pull the newest image from ghcr.io and (re)start the exporter in the background
	$(COMPOSE) pull exporter
	$(COMPOSE) up -d exporter

login: ## One-off exporter login in a terminal (the status page's "Log in" button does the same)
	$(COMPOSE) run --rm --service-ports login

dev: ## Exporter from source with auto-restart (docker compose watch), status page http://127.0.0.1:9101
	$(COMPOSE_DEV) watch

logs: ## Follow exporter logs
	$(COMPOSE_DEV) logs -f exporter

stop: ## Stop the dev exporter
	$(COMPOSE_DEV) down

record: ## Record MQTT fixtures (needs .env), e.g. make record ARGS="--minutes 20"
	npm run record -- $(ARGS)

test: ## Tests
	npm test

typecheck: ## Type check
	npm run typecheck

deps-check: ## Exact npm versions, lockfile in sync, nothing younger than 7 days
	node scripts/check-deps.mjs

deps-outdated: ## Newer versions that are past the 7-day quarantine
	node scripts/check-deps.mjs --outdated
