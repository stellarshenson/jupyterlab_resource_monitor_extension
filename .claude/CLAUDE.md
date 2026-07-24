<!-- @import /home/lab/.claude/CLAUDE.md -->
<!-- @import /home/lab/workspace/.claude/CLAUDE.md -->

# Project-Specific Configuration

This file is a thin overlay. It imports both configuration layers without duplicating them:

- **User-level** (global, applies to every project on this machine): `/home/lab/.claude/CLAUDE.md`
- **Workspace-level** (applies under `/home/lab/workspace`): `/home/lab/workspace/.claude/CLAUDE.md`

All rules from both layers apply. Project-specific rules below strengthen or extend them.

## Project Context

`jupyterlab_resource_monitor_extension` - a JupyterLab 4 extension replacing `jupyter-resource-usage` with a less intrusive, better implementation of resource usage monitoring. Composed of a Python server extension (`jupyterlab_resource_monitor_extension/`, jupyter_server + tornado) and a TypeScript frontend extension (`src/`, `@jupyterlab/*` 4.x). Generated from the copier extension template; built with the canonical JupyterLab extension Makefile (currently v1.35).

**Design mandate** (from the incident that motivated this project): `jupyter-resource-usage` computes server memory as self + all children via a synchronous `psutil.Process().children(recursive=True)` walk inline in the tornado coroutine. With ~730 leaked orphan processes reparented under the server, each poll blocked the single event-loop thread ~1s every 2-3s, stalling websockets, kernel messages, and static files. This extension MUST therefore:

- Provide the same status bar features: memory usage with max available memory, and CPU usage
- Never perform metrics collection synchronously on the tornado event loop - collect off-loop (executor/subprocess/cached background sampler)
- Keep collection cost bounded and independent of the server's child process count - no unbounded recursive `/proc` tree walks per request

## Mandatory Bans (Reinforced)

The following workspace rules are STRICTLY ENFORCED for this project:

- **No automatic git tags** - only create tags when user explicitly requests
- **No automatic version changes** - only modify version in package.json/pyproject.toml/etc. when user explicitly requests
- **No automatic publishing** - never run `make publish`, `npm publish`, `twine upload`, or similar without explicit user request
- **No manual package installs if Makefile exists** - use `make install` or equivalent Makefile targets, not direct `pip install`/`uv install`/`npm install`
- **No automatic git commits or pushes** - only when user explicitly requests

## Mandatory Build Lifecycle (Makefile Only)

Always use the project Makefile for the entire build lifecycle - never run `pip`/`jlpm`/`yarn`/`npm`, build, publish, or clean commands directly:

- `make install` - build and install the extension
- `make publish` - release the extension
- `make clean` - clean build artefacts
- `make mrproper` - remove all build and venv artefacts

## Mandatory Repository Rules

- Always commit both `package.json` and `package-lock.json` together
- Always check the local `Makefile` version against `/home/lab/workspace/private/jupyterlab/@utils/jupyterlab-extensions/Makefile` and update the local Makefile as soon as a newer version is found

## Mandatory Quality Tracking

- Create and maintain acceptance criteria for every feature using the `/acceptance-criteria` skill (`docs/acc-crit-*.md`)
- Track defects using the `/defects-tracking` skill (`docs/defects.md`)

## Required Workspace Skills

Skills at `/home/lab/workspace/.claude/skills/` that MUST be used in this project:

- **jupyterlab-extension** - extension development guidelines, CI/CD, caveats
- **playwright** - browser automation for screenshots and UI verification

## Journal Rules (Project-Specific)

- **APPEND ONLY**: New journal entries MUST be appended at the end of the file, never inserted between existing entries
- Entries maintain strict chronological order by position - the last entry in the file is always the most recent work
- Never reorder, move, or insert entries out of sequence
- The Stellars **journal plugin** is the canonical tool for this file: create via `/journal:create`, append via `/journal:update`, archive via `/journal:archive`. The `journal:journal` skill auto-triggers on any mention of "journal" and runs `journal-tools check` after every write
- Direct edits to `JOURNAL.md` are a last resort - prefer the plugin so modus secundis format, continuous numbering and append-only order are enforced automatically
