# How Resource Collection Avoids Blocking the Server

This extension exists because its predecessor, `jupyter-resource-usage`, measured server memory by walking the process tree synchronously inside the tornado request handler. On a server with roughly 730 leaked orphan processes reparented under it, each poll blocked the single event loop thread for about a second every two to three seconds. Websockets stalled, kernel messages queued, terminals froze and static files hung - all from a status bar widget.

The fix is structural rather than incremental. Collection never runs where a request runs, and its cost never scales with how many processes exist.

## The two rules

Every design decision below follows from two constraints:

- **Nothing measured on the event loop** - request handlers read a cached dictionary and return; they never open a file under `/proc`, never call `psutil`, never await anything that touches the filesystem
- **Cost independent of process count** - no recursive walk of the server's descendants, so a leaked process population cannot degrade the server no matter how large it grows

## Where the work happens

Two daemon threads own all measurement. Each samples on a fixed cadence, writes a small snapshot dictionary into memory, and goes back to sleep. The tornado handlers are pure cache readers.

```
 daemon thread                    tornado event loop
 -------------                    ------------------
 ResourceSampler  --- writes -->  _snapshot  --- reads --->  GET .../metrics
 KernelSampler    --- writes -->  _samples   --- reads --->  GET .../kernels?kernel_id=

 (reads cgroup v2 + /proc)        (plain dicts)              (returns cache, never blocks)
```

The consequence is that a handler's latency is a dictionary lookup and a JSON serialisation - constant, microseconds, and unaffected by whatever the sampler is doing at that moment. A slow or wedged sampler degrades the _freshness_ of the numbers, never the responsiveness of the server.

## Host metrics are O(1)

The status bar's memory and CPU figures come from a fixed set of small file reads - the same handful on every tick regardless of system state:

- **Memory** - cgroup v2 `memory.current` minus reclaimable page cache (`inactive_file`), against the limit in `memory.max`; this is the cadvisor "working set" convention, so the figure matches what a container runtime would report
- **CPU** - the delta of cgroup `cpu.stat` `usage_usec` against elapsed wall time, divided by the effective core count from `cpu.max`
- **Fallback** - without cgroup v2, `/proc/meminfo` and `/proc/stat`, which are likewise two fixed files

The fallback changes what is being measured, not just where it is read from. On the cgroup path the figure is the server's own cgroup - a container, or a systemd session scope. On the fallback path it is `MemTotal - MemAvailable`, which is the whole machine, and CPU likewise comes from host-wide `/proc/stat`. The `limit_source` field and the tooltip qualify the ceiling, not the usage, so on a cgroup v1 host the number shown is the machine's rather than the server's.

Container awareness falls out of reading the cgroup first: inside a container the ceiling shown is the container's limit rather than the host's physical RAM. The cgroup directory is resolved once, lazily, from `/proc/self/cgroup`, not re-derived per sample.

Nothing here enumerates processes. Adding ten thousand processes to the host changes the cost of a host sample by exactly nothing.

## Per-core readings stay within the same bound

The `grid` display mode needs a figure per core, which means reading the `cpuN` lines of `/proc/stat` rather than only the aggregate `cpu` line. That is still one file, opened once per tick, and its length tracks the core count - a fixed property of the machine - not the process count. The bound the design cares about is unchanged.

One detail carries that guarantee. The reader stops at the first line that does not begin with `cpu`, because the `intr` line immediately after them holds one counter per IRQ - hundreds of fields on a large machine - and it is the only part of `/proc/stat` whose size is worth avoiding. Parsing it every five seconds would be the single unbounded read in an otherwise fixed-cost collector, so the loop breaks before reaching it.

Which cores get read is decided by the cgroup's own `cpuset.cpus.effective` - what `--cpuset-cpus` narrows - falling back to every CPU on the machine where no cpuset applies. Those indices are the same indices `/proc/stat` uses, since `/proc` is not namespaced inside a container.

That choice is deliberate and was arrived at the hard way. The cells must describe **exactly the population the percentage is divided by**, or the grid and the number beside it say different things in the same hover. An earlier version took the cell identities from `os.sched_getaffinity(0)` while the denominator came from the cgroup, and under `taskset -c 0-3` on a 64-core host it drew a four-cell grid captioned "of 64 CPUs". One core set, used for both, is what makes that impossible.

The reason affinity is the wrong primitive for either is the same reason in both places. `cpu.stat` counts every process in the cgroup; `sched_getaffinity` describes one task. Dividing a cgroup-wide numerator by a `taskset`-narrowed denominator inflated the reading until it clamped - an idle 64-core host read 100%. Where the numerator comes from `/proc/stat` instead, it has already counted every CPU on the box, so the denominator is `os.cpu_count()` unconditionally.

What the figures mean is worth stating plainly, because it is not what a first reading suggests. They are the **load on the cores assigned to this server**, not this server's own usage broken down per core. No such per-process breakdown exists in `/proc` without walking the process tree, which is the cost this design refuses to pay. On a dedicated machine the difference is academic; on a shared one, a busy cell may be someone else's work on a core you are also entitled to. The tooltip says which of the two things the cells are, so the picture is never read as the server's own load.

Per-core readings are withheld when the cores are not the real ceiling. A quota narrower than the core set - `docker run --cpus=2`, with or without a cpuset - buys a slice of time rather than a set of cores, and no arrangement of cells can represent that: four cells for `--cpus=2 --cpuset-cpus=0-3` would show cores the server can never saturate and would light up under a co-tenant's work. There the sampler reports `per_core: null` and the item renders the ordinary bar against the container's own correctly-scoped percentage. A quota that covers its cpuset (`--cpus=4 --cpuset-cpus=0-3`, or Kubernetes with `cpuManagerPolicy: static`) is the honest case and keeps the grid.

The ceiling and the core set are resolved together, in one function, once per tick. That is deliberate: they were resolved apart twice, and disagreed twice - once by taking the cells from the task's affinity mask while the denominator came from the cgroup, and once by dividing by a quota wider than the cores it was allowed to use. Returning them as a single value makes `capacity == len(cores)` true by construction wherever there are cells at all, so the grid and the number beside it cannot describe different populations. A quota below the core count is the one case with no core set to return, and it is also the case where the item draws the bar.

**Known limitation.** CPU confinement applied only through `sched_setaffinity` - systemd `CPUAffinity=`, Slurm's `task/affinity` without `task/cgroup`, a bare `taskset` wrapper - is invisible here. Both the denominator and the cells will describe the wider cgroup, so a server pinned to four cores of a sixty-four core host reads as a small fraction of the machine rather than as its own saturation.

This is not an oversight waiting for an affinity tier. Affinity is a per-task property and the numerator is per-cgroup, so the tier would only be sound where the cgroup holds exactly one task - and no cheap test establishes that. Cgroup depth does not: a systemd service unit holding only this server and a login session scope holding the user's whole desktop are both leaves. Reading `cgroup.procs` and requiring a single pid _is_ sound, and it fails for a different reason - a JupyterLab server spawns its kernels into its own cgroup, so the tier would switch off the moment a notebook opens and back on when the last kernel dies, swinging the denominator between four and sixty-four with no change in load. A non-stationary denominator is a worse defect than the one it fixes, and it lands on exactly the deployments the tier was meant to serve.

The asymmetry settles it. Under-reporting stays monotone and is true about something - "this server used 6% of the host" is a correct statement, merely not the one a pinned user wants - while the inflation it would trade for is clamped at 100%, wrong in every state including idle, and hits every ordinary workstation rather than the affinity-confined minority. Constraining CPU through the cgroup (`--cpuset-cpus`, `AllowedCPUs=`, `cpu.max`) is measured exactly.

## Kernel metrics are bounded and leased

Per-kernel memory and CPU genuinely require walking a process tree - a kernel's usage is its own process plus whatever it forked. That cost cannot be made constant, so it is bounded and gated instead.

**Bounded by a read budget.** The walk stops after `_MAX_READS` (2000) file reads. The budget counts reads rather than processes because reads are what cost time: each process contributes one `statm`, one `stat`, and one read per thread, so a 300-thread kernel is far more expensive than a single-threaded one and only a read budget reflects that. Thread directories are enumerated with `os.scandir` and the budget is checked inside the loop, so the enumeration itself stops when the budget is spent. This detail matters: `glob` would materialise and sort the entire thread list before the first budget check, making a 5000-thread process cost 5000 uncharged directory entries. Measured on a 500-thread process with a budget of 50, the scandir form touches 49 directory entries where the glob form touched 501.

On hitting the budget the walk returns a partial sum. A pathological tree therefore under-reports rather than stalling, which is the right failure direction for a glanceable panel.

**Gated by a lease.** A kernel is only walked while someone is looking at it. Each poll from the open panel registers the kernel and renews a 15 second lease. Close the panel and the polling stops, the lease lapses, the watch and its cached sample are dropped, and the sampler walks nothing at all. An idle server with no panel open does zero tree walking.

Watches are held per kernel rather than in a single slot, so two notebooks open in two browser tabs each keep their own reading instead of evicting each other.

**Cadence matched to consumption.** The sampler ticks at 5 seconds, the same interval the frontend polls at, so no walk is performed whose result nobody reads.

## Locking

The lock protects only the small dictionaries - the watch table, the previous-CPU table and the sample cache. It is never held across file I/O.

```python
with self._lock:
    live = [...]          # snapshot the watch list, then release

for kernel_id, name, pid in live:
    mem, ticks = self._read_tree(pid)   # file I/O, no lock held
    with self._lock:
        self._samples[kernel_id] = ...  # brief write
```

So a request arriving mid-walk contends for the lock only for the duration of a dictionary read, never for the duration of a `/proc` traversal. There is no lock a handler can wait on behind file I/O, which is the property that keeps handler latency constant.

Each kernel is timed immediately after its own walk rather than sharing one timestamp across the loop, so a kernel is never charged the walk time of the kernels sampled before it.

## What it costs

- **Host sample** - a fixed handful of small file reads every 5 seconds, independent of process count; the per-core read adds one line per core to a file already being opened, and stops before the per-IRQ counters
- **Kernel sample** - at most 2000 file reads every 5 seconds per watched kernel, and only while a panel is open
- **Request handling** - one dictionary lookup, no I/O, no awaiting
- **Idle server** - one host sample every 5 seconds and nothing else

## Failure behaviour

Failures degrade quietly rather than escalating:

- A sampler exception is caught, logged once, and the loop continues; a persistent failure does not write a traceback every interval forever
- Unreadable or missing `/proc` entries read as zero rather than raising, so a kernel that dies between the handler's PID lookup and the walk produces a zero reading rather than an error
- The frontend tolerates three consecutive failed polls before hiding, so a laptop wake or a proxy blip does not blank the status bar
- A snapshot whose timestamp has not advanced for three polls is treated as stale and stops being presented as live, so a wedged sampler shows nothing rather than a frozen number

## Limitation

The samplers read cgroup v2 and `/proc` exclusively, so this is a Linux-only capability. On macOS and Windows every read fails, memory reads as zero, and the status bar items stay hidden while the kernel panel holds `Measuring...`. No error is surfaced because the requests themselves succeed - there is simply nothing to report.
