# dsh-renpy-skin — development tasks.
#
# NOTE: `make` is NOT installed on the current development machine (verified).
# These targets are the canonical task names; run the underlying `node` command
# directly until GNU Make is available. Nothing here wraps a hidden toolchain —
# each target is one command you can type yourself.
#
# There is no build step: the host half is plain ESM and the client half is a
# hand-written lazy-CJS factory. Every target below either tests or probes.
#
# `test/*.test.mjs` is passed as a QUOTED GLOB on purpose. A bare directory
# argument (`node --test test/`) fails on both Node 22 and Node 24, and letting
# the shell expand the glob would pass a different argv on Windows than on POSIX.

NODE ?= node

# Override on the command line: make probe GAME="D:\Games\Arches-1.0-win"
GAME ?= D:\Games\Arches-1.0-win

.PHONY: help test check probe syntax doctor clean distclean

help: ## Show this help
	@echo "dsh-renpy-skin"
	@echo ""
	@echo "  make test              Run the headless test suite"
	@echo "  make check             Syntax-check lib/ then run the suite"
	@echo "  make probe             Run the manifest/stage probe against GAME"
	@echo "  make doctor            Check Python, unrpyc, archives and data home"
	@echo "  make syntax            node --check every lib/ entry point"
	@echo "  make clean             Remove temporary probe output"
	@echo ""
	@echo "  NODE=<path>            Use a specific node binary"
	@echo "  GAME=<path>            Ren'Py game dir for 'make probe' / 'make doctor'"

test: ## Run the headless test suite
	$(NODE) --test "test/*.test.mjs"

syntax: ## Syntax-check the lib entry points
	$(NODE) --check lib/index.js
	$(NODE) --check lib/client.js
	$(NODE) --check lib/audio.js
	$(NODE) --check lib/manifest.js
	$(NODE) --check lib/renpy.js
	$(NODE) --check lib/rpa3.js
	$(NODE) --check lib/rpyc.js
	$(NODE) --check lib/stage.js

check: syntax test ## Syntax check plus the test suite

probe: ## Run the manifest/stage probe against a real game (GAME=...)
	$(NODE) test/manifest-probe.mjs "$(GAME)"

doctor: ## Check the toolchain, the archives and the data home (GAME=...)
	$(NODE) tools/check-doctor.mjs $(if $(GAME),--game "$(GAME)")

clean: ## Remove temporary probe output
	@echo "nothing generated to clean"

distclean: clean ## Also drop local settings written by a probe run
	@echo "settings live in %USERPROFILE%\\.dsh-renpy-skin — remove manually if needed"
