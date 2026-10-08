ENGINES := laya decider kev jev openai
PY_PROJECTS := labkit gateway $(addprefix engines/,$(ENGINES))
LAB := uv run --project gateway

.PHONY: help quickstart doctor setup weights weights-all datasets ui lab dev test test-fast test-engines e2e verify suite clean

help: ## list the commands
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-14s\033[0m %s\n", $$1, $$2}'

quickstart: doctor setup weights ## check the machine, install, fetch the small models, open the playground
	$(LAB) lab --open

doctor: ## check this Mac can run the playground
	@./scripts/doctor.sh

setup: ## install every environment, build the UI, fetch the datasets
	@for p in $(PY_PROJECTS); do echo "== $$p"; (cd $$p && uv sync --quiet) || exit 1; done
	cd ui && npm ci --silent
	$(MAKE) ui
	-$(LAB) python -m gateway.fetch_datasets
	@printf "\nSetup done. Next: make weights (small models, ~6 GB) or make weights-all (~37 GB), then make lab.\n"

weights: ## download the small models: Laya, Decider 0.8B, Kev 0.8B (~6 GB)
	./scripts/download-weights.sh small

weights-all: ## download every local model (~37 GB)
	./scripts/download-weights.sh all

datasets: ## fetch any missing benchmark slices (add FORCE=1 to rebuild all)
	$(LAB) python -m gateway.fetch_datasets $(if $(FORCE),--force)

ui:
	cd ui && npm run build --silent

lab: ## start the playground on http://127.0.0.1:8080
	@test -d ui/dist || $(MAKE) ui
	$(LAB) lab --open

dev: ## gateway plus Vite dev server with hot reload on :5173
	$(LAB) lab & cd ui && npm run dev

test: test-fast e2e ## everything that needs no model weights

test-fast: ## Python and UI unit tests plus typecheck
	cd labkit && uv run pytest -q
	cd gateway && uv run pytest -q
	cd engines/jev && uv run pytest -q
	cd engines/openai && uv run pytest -q
	cd ui && npx tsc --noEmit -p . && npm test --silent

test-engines: ## adapter tests against real weights (Laya on CPU, Decider on MPS)
	cd engines/laya && uv run pytest -q
	cd engines/decider && uv run pytest -q
	cd engines/kev && uv run pytest -q

e2e: ui ## browser tests against a throwaway gateway on :8099
	cd ui && npx playwright test

verify: ## with the lab running: start each engine, run the conformance suite, stop it
	$(LAB) python -m gateway.verify $(ENGINES_TO_VERIFY)

suite: ## with the lab running: benchmark every local engine on every dataset, one engine at a time
	caffeinate -i $(LAB) python -m gateway.suite --limit $(or $(LIMIT),100) $(SUITE_ENGINES)

clean: ## remove build output and logs
	rm -rf ui/dist .run/logs .run/tmp .run/sandbox
