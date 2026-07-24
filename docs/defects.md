# Defects - jupyterlab_resource_monitor_extension

`[ ]` open, `[x]` fixed/resolved. Dated notes under each track how it evolved.

## Build and CI

- [x] `DEF-1` **browser_check failure masked by pipeline exit code** - first browser_check run reported success while the check actually exited 1; cause: `python -m jupyterlab.browser_check | tail | tee` reported tee's exit status, not the check's; fix: re-ran with direct redirection capturing the true exit code; `logs/browser-check.log`
  - 2026-07-24 reported: notification said exit 0 while log carried "Exiting with 1 due to errors"
  - 2026-07-24 fixed: re-run with `> log 2>&1; echo EXIT:$?`; real failure surfaced and investigated as DEF-2
- [x] `DEF-2` **browser_check exits 1 in shared conda env** - browser_check fails with console error "Not in a Git Repository"; cause: error emitted by the third-party `jupyterlab_git` extension present in the shared `/opt/conda` env when the server root is not a git repo - not caused by this extension, whose server and lab extensions link, register and load clean in the same run; resolved as environmental, CI runs browser_check in an isolated env where it passes; `logs/browser-check.log`
  - 2026-07-24 reported: browser_check exit 1 after DEF-1 unmasked it
  - 2026-07-24 resolved: root-caused to jupyterlab_git console error; our activation message logs cleanly, extension lists show OK; visual verification via Playwright confirmed working status bar
- [x] `DEF-28` **no committed lockfile; two rival lockfiles untracked at root** - LOW; `yarn.lock` (363 KB) and `package-lock.json` (315 KB) both sit untracked and un-ignored alongside a tracked `package.json` pinned only by semver ranges, so a fresh CI clone resolves transitive deps to whatever is newest that day; every script in package.json runs through `jlpm`, making `yarn.lock` the canonical resolution and `package-lock.json` drift from a stray npm install - but the project rule mandates committing `package.json` and `package-lock.json` together, so which lockfile is canonical is the user's decision; `package.json`
  - 2026-07-24 reported: adversarial rounds 6 and 7, converged by bug-hunter (LOW) and architect (MINOR)
  - 2026-07-24 open: awaiting user decision on the canonical lockfile before any file is deleted or committed; junit.xml also loose at the repo root (test artifact, same commit-time call)
  - 2026-07-24 resolved: not a defect - all 11 sibling jupyterlab extensions in this workspace track BOTH yarn.lock and package-lock.json, and the Makefile itself runs 'git add package.json package-lock.json' (line 108) and formats both lockfiles; the adversaries' delete-one advice was generic best practice contradicting the established convention. Both lockfiles will be committed with package.json; junit.xml, logs/ and uv.lock added to .gitignore matching siblings
- [x] `DEF-29` **check_links had no ignore_links, so registry badges would fail CI** - MEDIUM; the `check_links` job called `check-links@v1` with no `with:` block while README carries npm, pepy and PyPI badges - hosts that 403 automated checkers, and whose package pages 404 until the first release publishes them, so the job would fail on every run before any release existed; the workspace CLAUDE.md and jupyterlab-extension skill both mandate the ignore list and the sibling extensions all carry it; fix: added ignore_links for npmjs/pepy/static.pepy/pypi project URLs; `.github/workflows/build.yml`
  - 2026-07-24 reported: found running the CI gates locally against a CI-equivalent env, not by an adversary
  - 2026-07-24 fixed: ignore_links added matching sibling extensions; remaining 8 README links verified 200, the 2 non-200 are this repo's own Actions URLs which exist only once pushed (repo root currently 404, never pushed)
- [x] `DEF-31` **jupyter-builder uncapped in the dev extra** - LOW; `build-system.requires` and the releaser hook both pin `jupyter-builder>=1.0.0,<2` but the `dev` extra left it uncapped, so a dev env could resolve a 2.x the build backend itself rejects; fix: added the `,<2` cap; `pyproject.toml`
  - 2026-07-24 reported: adversarial round 8 architect (MINOR)
  - 2026-07-24 fixed: dev extra now matches the other two constraints (v0.1.10)

## Metrics collection

- [x] `DEF-3` **cgroup limit invisible outside a private cgroup namespace** - HIGH; sampler read `/sys/fs/cgroup/memory.*` at the mount root and never consulted `/proc/self/cgroup`, so under `--cgroupns=host` or systemd spawners (the JupyterHub deployment this targets) the process sub-cgroup limit was missed and host-wide memory shown, so the 90% warning could never fire before an OOM; cause: hardcoded root path; fix: `_resolve_cgroup_dir` parses `/proc/self/cgroup` `0::` line and joins under the mount root, falling back to root then `/proc`; `metrics.py`
  - 2026-07-24 reported: adversarial bug-hunter finding 1 (HIGH)
  - 2026-07-24 fixed: cgroup self-resolution added, `test_cgroup_self_resolution` covers the sub-cgroup layout
- [x] `DEF-4` **unguarded int() on memory.max/cpu.max freezes the snapshot** - MEDIUM; `int(limit)` and `int(cpu.max quota)` raised ValueError on malformed cgroup content, escaping to the sampler loop which logged once then retried forever with a frozen cache; cause: two casts bypassed the tolerant `_read_int` pattern; fix: `memory.max` routed through `_read_int` (None on non-integer, unifies with the unlimited case), `cpu.max` cast wrapped with fallback to `os.cpu_count()`; `metrics.py`
  - 2026-07-24 reported: adversarial bug-hunter finding 2 (MEDIUM)
  - 2026-07-24 fixed: tolerant parsing; `test_malformed_memory_max_falls_back`, `test_malformed_cpu_max_falls_back`
- [x] `DEF-5` **/proc/stat fallback double-counts guest time** - LOW; `total = sum(fields)` included guest/guest_nice which the kernel already folds into user/nice, inflating the denominator and under-reporting CPU% on KVM-guest hosts; fix: `total = sum(fields[:8])`; `metrics.py`
  - 2026-07-24 reported: adversarial bug-hunter finding 5 (LOW)
  - 2026-07-24 fixed: `test_proc_stat_excludes_guest_time`
- [x] `DEF-6` **stale snapshot presented as live** - MEDIUM; if the sampler thread stalled, the handler served the last snapshot forever and the frontend showed frozen numbers as current, ignoring `ts`; fix: frontend tracks `ts`, hides both items after 3 polls with an unchanged timestamp; `src/index.ts`
  - 2026-07-24 reported: adversarial bug-hunter finding 2 tail + ux finding
  - 2026-07-24 fixed: `STALE_AFTER_POLLS` guard in the poll factory
- [x] `DEF-23` **transient /proc/stat failure spiked CPU for one sample** - LOW; a transient `/proc/stat` read returned the (0,0) sentinel, stored as the baseline, so the next read computed a since-boot delta and reported a one-sample spike; fix: on the sentinel, return 0 without overwriting the baseline; `metrics.py`
  - 2026-07-24 reported: adversarial round 3 bug-hunter (LOW)
  - 2026-07-24 fixed: sentinel keeps baseline, test_proc_stat_transient_failure_does_not_spike (v0.1.4)
- [x] `DEF-26` **IndexError in /proc CPU parsers escaped the degradation path** - LOW; `_read_proc_stat` indexed `fields[3]` outside its try and `_read_stat_key` indexed `split()[1]` with an except tuple missing IndexError, so an empty or truncated /proc/stat (a /dev/null bind-mount opens and reads fine, so the OSError guard never fires) raised instead of taking the (0,0) sentinel - aborting `sample_once` after `_read_memory` had already succeeded, discarding a good memory reading and freezing the snapshot until the frontend stale-hid both items; fix: length guard before the idle column and IndexError added to the except tuple, both routing into the existing sentinel; `metrics.py`
  - 2026-07-24 reported: adversarial round 6 bug-hunter (LOW), runtime-reproduced locally on all three inputs
  - 2026-07-24 fixed: len(fields) < 4 sentinel + IndexError in _read_stat_key; regression tests test_proc_stat_without_idle_column_degrades (parametrized empty/truncated, asserts memory still flows) and test_stat_key_without_value_returns_none; pytest 20 green (v0.1.8)

## Status bar UX

- [x] `DEF-7` **zero-state rendered as live "Mem: 0 / 0 MB"** - MAJOR; on a host without `/proc`+cgroup the handler served 200 with zeros and the frontend rendered the text unconditionally (only the warn flag was gated on `total > 0`); fix: hide both items when `total_bytes <= 0`; `src/index.ts`
  - 2026-07-24 reported: adversarial ux finding (MAJOR)
  - 2026-07-24 fixed: total-guard in the poll factory before render
- [x] `DEF-8` **memory warning wore error clothing and shifted layout** - MAJOR; warn state applied `--jp-error-color1` + `font-weight:600` at 0.9, reading as a crash and reflowing neighbours at the moment of stress, with no hysteresis so it flickered at the boundary; fix: two levels (`--jp-warn-color1` >=0.90, `--jp-error-color1` >=0.95), colour-only (no weight change), `memoryLevel()` hysteresis (warn exit 0.85, danger exit 0.92); `src/format.ts`, `style/base.css`
  - 2026-07-24 reported: adversarial ux finding (MAJOR, three compounding defects)
  - 2026-07-24 fixed: `memoryLevel` pure function + jest hysteresis tests
- [x] `DEF-9` **numeric jitter nudged neighbours every poll** - MINOR; changing digit counts in a left-aligned flex row shifted every right-neighbour every 5s; fix: `font-variant-numeric: tabular-nums` on all items plus a `min-width` reservation on the CPU item; `style/base.css`
  - 2026-07-24 reported: adversarial ux finding (MINOR)
  - 2026-07-24 fixed: CSS tabular-nums + cpu min-width
- [x] `DEF-10` **hide-on-first-failure read as a crash** - MINOR; a single failed poll (laptop wake, proxy blip) hid both items, a layout shift reading as death, kept out up to 60s by backoff; fix: tolerate `HIDE_AFTER_FAILURES` (3) consecutive failures before hiding; `src/index.ts`
  - 2026-07-24 reported: adversarial ux finding (MINOR)
  - 2026-07-24 fixed: failure counter in the poll factory
- [x] `DEF-11` **denominators fetched then dropped; warning invisible to assistive tech** - MINOR; `cpu_count` and the memory percentage were returned by the API but never surfaced, and the warn state signalled by colour alone; fix: `title` tooltips (`CPU: n% of N CPUs`, memory used/total/percent) and the percentage appended to the memory text in warn/danger; `src/index.ts`, `src/format.ts`
  - 2026-07-24 reported: adversarial ux findings (MINOR x2)
  - 2026-07-24 fixed: tooltips + percentage suffix, jest covers the suffix
- [x] `DEF-12` **empty items flashed at startup** - MINOR; both widgets registered visible with empty text until the first poll resolved; fix: construct hidden, reveal on first successful render; `src/index.ts`
  - 2026-07-24 reported: adversarial ux finding (MINOR)
  - 2026-07-24 fixed: `this.hide()` in `ResourceItem` constructor
- [x] `DEF-16` **memory item still reflowed at the warn threshold** - LOW; the round-1 fix appended ` (NN%)` only in warn/danger, so the suffix appeared abruptly at 90% and widened the item, shoving the CPU item right - contradicting DEF-8/DEF-9 "row never reflows", and only the CPU item had a `min-width`; fix: always show the percentage (constant width, also surfaces the glanceable signal below 90%) and reserve a `min-width` on the memory item too; `src/format.ts`, `src/index.ts`, `style/base.css`
  - 2026-07-24 reported: adversarial round 2 bug-hunter finding 1 + ux findings 2-3
  - 2026-07-24 fixed: percentage always rendered, memory min-width 13.5em, jest updated
- [x] `DEF-17` **warn text colour failed WCAG AA contrast** - MAJOR; warn used `--jp-warn-color1` as the text colour, ~2.7:1 on the standard light-theme status bar (below the 4.5:1 AA floor), making the number harder to read exactly when it mattered; measured cross-theme via Playwright (custom dark theme baseline text itself only 3.62:1); fix: switched warn/danger to a subtle background tint via `color-mix` with the default text colour retained, so the number stays as readable as every other status bar item and severity is signalled through a channel independent of text contrast; `style/base.css`
  - 2026-07-24 reported: adversarial round 2 ux finding 1 (MAJOR)
  - 2026-07-24 fixed: background-tint scheme, default text colour, no reflow (background does not change box size)
- [x] `DEF-18` **no TB tier - large-RAM nodes read "1024.0 GB"** - MINOR; `formatBytes` capped at GB, so 512GB-2TB JupyterHub nodes (the target deployment) rendered awkward gigabyte counts; fix: added a TB branch; `src/format.ts`
  - 2026-07-24 reported: adversarial round 2 ux finding (MINOR)
  - 2026-07-24 fixed: TB tier, `formatBytes` jest case
- [x] `DEF-19` **tooltip detail invisible to keyboard/touch** - MINOR; DEF-11 put cpu_count and provenance solely in `node.title` (mouse-hover only); fix: also set `aria-label` so it is an accessible name for keyboard and touch/mobile users; `src/index.ts`
  - 2026-07-24 reported: adversarial round 2 ux finding (MINOR)
  - 2026-07-24 fixed: `aria-label` set alongside `title` in the `tooltip` setter
- [x] `DEF-20` **/proc fallback reported 100% when MemAvailable absent** - LOW; `_read_meminfo` left `available=0` when `MemAvailable:` was missing (pre-3.14 kernels), so used = total pinned the bar at 100%; fix: fall back to `MemFree` when `MemAvailable` is absent; `metrics.py`
  - 2026-07-24 reported: adversarial round 2 bug-hunter finding 2 (LOW)
  - 2026-07-24 fixed: MemFree fallback, `test_proc_memory_fallback_without_memavailable`
- [x] `DEF-21` **memory width jitter on large-RAM nodes** - LOW; the round-2 min-width was a floor, so on 512GB-2TB nodes the memory string grew past it and still nudged the CPU item as the numerator gained a digit or the unit collapsed; fix: express used in the total unit and figure-space pad to a constant per-host width, dropping the memory min-width; `src/format.ts`, `style/base.css`
  - 2026-07-24 reported: adversarial round 3 ux (MAJOR) + architect (judgement)
  - 2026-07-24 fixed: figure-space padding to constant per-host width, jest invariant test (v0.1.4)
- [x] `DEF-22` **aria-label unreliable on role-less div; docs overstated keyboard reach** - LOW; the DEF-19 aria-label sat on a bare non-focusable div, so screen readers could ignore it and keyboard tab-focus never landed; fix: added `role="img"` so the aria-label is the accessible name, corrected docs to screen-reader/touch, and enriched the tooltip with limit provenance and a severity word; `src/index.ts`
  - 2026-07-24 reported: adversarial round 3 bug-hunter + ux (converged)
  - 2026-07-24 fixed: role=img + provenance/severity tooltip, docs corrected (v0.1.4)
- [x] `DEF-24` **CPU item jittered despite min-width** - LOW; browser measurement during round-3 verification showed the CPU item grew 57px (CPU: 5%) to 69px (CPU: 100%), and the 5em min-width was below both so it did nothing; fix: figure-space pad the CPU percent to 3 columns like memory, then drop the min-width; U+2007 verified digit-width in the font; `src/format.ts`, `style/base.css`
  - 2026-07-24 reported: found in Playwright width verification (not in the review report)
  - 2026-07-24 fixed: padded CPU percent, cpuConstant true in browser, jest width test (v0.1.5)
- [x] `DEF-25` **constant width depended on the U+2007 glyph metric** - LOW; DEF-21/DEF-24 held the item width steady by padding with U+2007 FIGURE SPACE, which assumes every client font metrics that glyph at exactly one digit width - true on this host but not guaranteed across the Segoe UI / SF / DejaVu mix a JupyterHub deployment sees, so a mis-metriced font would reintroduce the neighbour-nudge; fix: dropped the padding and gave each changing numeric run an inline-block box sized in `ch` and right-aligned, so the reservation comes from the CSS box; `src/format.ts`, `src/index.ts`, `style/base.css`
  - 2026-07-24 reported: adversarial round 4 ux finding 1 (MINOR)
  - 2026-07-24 fixed: ISegment columns + .jp-ResourceMonitor-column ch box; browser-measured constant 167.31px memory / 69.47px CPU across value extremes, 1ch == 6.119px == tabular digit advance; jest 16, pytest 17, galata 2 green (v0.1.7)
- [x] `DEF-27` **unit tier picked from the raw value while display rounds** - LOW; `formatBytes` chose the tier from raw bytes but rounded for display, so a total in [1023.95, 1024) GiB rendered `1024.0 GB` and one just under 1 GiB rendered `1024 MB` - the exact strings DEF-18's TB tier was raised to kill; reachable when a cgroup limit sits a few tens of MB under a power boundary; fix: promote the tier at the rounded boundary, not the raw one; `src/format.ts`
  - 2026-07-24 reported: adversarial round 7 ux (MINOR), reproduced in node before fixing
  - 2026-07-24 fixed: tier promotes when the rounded value reaches the next tier's floor, jest covers both boundaries and the non-promoting neighbour; jest 17 green (v0.1.9)
- [x] `DEF-30` **raw cpu_count float reached the tooltip** - LOW; `cpu_count` is a cgroup quota/period ratio, so an odd cfs period yields a long float and the tooltip interpolated it verbatim (`of 0.3333333333333333 CPUs`) - the one display path where a server float bypassed rounding; fix: `parseFloat(cpus.toFixed(2))` at the display site only, leaving the server value exact for its percent maths; `src/index.ts`
  - 2026-07-24 reported: adversarial round 8 ux (MINOR)
  - 2026-07-24 fixed: display-site rounding, pluralisation still correct for 1.0 (v0.1.10)
  - 2026-07-24 relocated: display rounding moved out of `src/index.ts` into `cpuTooltip` in `src/format.ts`, where jest can reach it - round-9 architect noted the fix had shipped untested; five jest cases now pin it and format.ts is at 100% statements (v0.1.11)

## Lifecycle and packaging

- [x] `DEF-13` **console.log spam on every failed poll** - MAJOR (violated a closed criterion); template `request.ts` logged "Not a JSON response body." on every poll when the endpoint returned the HTML 404 page, spamming the console forever when the server extension was absent; fix: dropped the per-call log, the thrown `ResponseError` already reaches the single warn-once site; `src/request.ts`
  - 2026-07-24 reported: adversarial architect finding (MAJOR)
  - 2026-07-24 fixed: removed `console.log` at the JSON-parse catch
- [x] `DEF-14` **sampler shutdown advertised but not wired** - MINOR; `stop()` had zero callers yet acc-crit claimed "stops cleanly on server shutdown"; fix: `atexit.register(sampler.stop)` in `_load_jupyter_server_extension`, criterion reworded to match; `__init__.py`
  - 2026-07-24 reported: all three adversaries
  - 2026-07-24 fixed: atexit hook gives `stop()` a real caller, `test_stop_is_idempotent`
- [x] `DEF-15` **package.json ships placeholder metadata** - LOW; `homepage:""`, `bugs.url:"/issues"`, `repository.url:".git"` copier stubs would publish broken links to npm and (via hatch-nodejs urls) PyPI; fix: filled all three with the real GitHub URLs; `package.json`
  - 2026-07-24 reported: adversarial architect + bug-hunter findings
  - 2026-07-24 fixed: real repository/homepage/bugs URLs
