# Kaplan — one-command local setup and day-to-day tasks.
#
# Quick start (clone → running in ~5 minutes):
#     make setup      # .env + install + start MySQL + migrate
#     make dev        # run backend (:4517) + frontend (:3000)
#     open http://localhost:3000
#
# Requires: Docker (Compose v2), Node >= 20, and your AI CLIs on PATH
# (claude / codex / agy — whichever providers you use).
#
# Windows: run these from Git Bash or WSL (`make` + a POSIX shell).

# Use bash for recipes (needed for the healthcheck wait loop).
SHELL := bash
.ONESHELL:
.DEFAULT_GOAL := help

COMPOSE   ?= docker compose
BE_ENV    := apps/backend/.env
DB_PASS   ?= kaplan

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: env install db-up migrate ## First-time setup: env + install + MySQL + migrate
	@echo ""
	@echo "✅ Setup complete. Run 'make dev' and open http://localhost:3000"

.PHONY: env
env: ## Create apps/backend/.env from the example (dev MySQL password) if missing
	@if [ -f "$(BE_ENV)" ]; then \
		echo "• $(BE_ENV) already exists — leaving it untouched."; \
	else \
		cp apps/backend/.env.example "$(BE_ENV)"; \
		# Set the dev DB password to match docker-compose (MYSQL_ROOT_PASSWORD).
		sed -i.bak "s/^KAPLAN_DB_PASSWORD=.*/KAPLAN_DB_PASSWORD=$(DB_PASS)/" "$(BE_ENV)" && rm -f "$(BE_ENV).bak"; \
		echo "• Wrote $(BE_ENV) (KAPLAN_DB_PASSWORD=$(DB_PASS))."; \
	fi

.PHONY: install
install: ## Install all workspace dependencies
	npm install

.PHONY: db-up
db-up: ## Start MySQL (+ Adminer) and wait until it is healthy
	$(COMPOSE) up -d
	@echo -n "• Waiting for MySQL to be healthy"
	@for i in $$(seq 1 40); do \
		status=$$($(COMPOSE) ps --format '{{.Health}}' mysql 2>/dev/null || echo ""); \
		if [ "$$status" = "healthy" ]; then echo " ✓"; exit 0; fi; \
		echo -n "."; sleep 2; \
	done; \
	echo ""; echo "✗ MySQL did not become healthy in time — check '$(COMPOSE) logs mysql'."; exit 1

.PHONY: db-down
db-down: ## Stop MySQL + Adminer (keeps data)
	$(COMPOSE) down

.PHONY: db-reset
db-reset: ## Stop and DELETE the MySQL data volume (destructive)
	$(COMPOSE) down -v

.PHONY: migrate
migrate: ## Apply database migrations
	npm run migrate -w @kaplan/backend

.PHONY: migrate-down
migrate-down: ## Roll back the last migration
	npm run migrate:down -w @kaplan/backend

.PHONY: dev
dev: ## Run backend (:4517) + frontend (:3000) together
	npm run dev

.PHONY: test
test: ## Run backend + frontend test suites
	npm test -w @kaplan/backend
	npm test -w @kaplan/frontend

.PHONY: typecheck
typecheck: ## Type-check both apps
	npm run typecheck

.PHONY: lint
lint: ## Lint the repo
	npm run lint

.PHONY: format
format: ## Format the repo with Prettier
	npm run format

.PHONY: check
check: typecheck lint test ## Run all pre-commit gates (typecheck + lint + tests)

.PHONY: build
build: ## Production build of the frontend SPA
	npm run build:frontend

.PHONY: clean
clean: ## Remove node_modules and build artifacts
	rm -rf node_modules apps/*/node_modules apps/frontend/.nuxt apps/frontend/.output
