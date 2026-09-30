# LVCE quickpick benchmark

Compare desktop LVCE Editor and VS Code file quickpick opening, incremental filtering,
renderer-only and frontend/backend sampled JavaScript activity, renderer traffic, CSS style recalculation
and paint work. Results from `main` are published at
https://levivilet.github.io/lvce-quickpick-benchmark/.

## Run

Linux x64, Node 24.15+, Git, `tar`, `dpkg-deb`, `ripgrep` (`rg`), and Electron system libraries are required.
The editor binaries are pinned with SHA256 checksums in `config/editors.lock.json`.
The benchmark workspace is the **VS Code source tree at tag 1.39.0**, commit
`9df03c6d6ce97c6645c5846f6dfa2a6a7d276515`; this is distinct from the VS Code executable version.
Setup downloads approximately 500 MB. No fixture dependencies are installed or executed.

```sh
npm ci
npm run setup
xvfb-run -a npm run benchmark -- --repeats 5
npm run report
# Serve site/ with any static HTTP server.
```

Use `--editor lvce` or `--editor vscode` and `--mode latency`, `--mode profile`,
`--mode traffic` or `--mode render`
for focused diagnosis. These options overwrite `results/results.json` with that run.
Without them, every repetition measures both editors, both filenames, and all four modes.
Raw JSON, Chromium `.cpuprofile` and rendering trace files, screenshots and application
logs are retained in `results/`. `site/raw/` publishes these files alongside the charts.

## Protocol

Each trial launches the same source fixture in a fresh profile, with separate
Chromium user data and XDG config/data/cache/state directories. The actual home
directory is preserved. A dedicated process group is killed and its profile removed
on completion, launch failure, timeout or editor crash. Runs use Xvfb; they do not
control an existing desktop editor. Third-party extensions, updates and telemetry are
disabled where the editor supports those launch/settings options.

The fixed queries are `quickOpenModel.ts` and `editorOptions.ts`. Each trial performs
one warmup of the same complete query, closes quickpick, waits for initialized worker
targets, then measures reopening and typing one character at a time. VS Code's late
TextMate worker must be ready before measurement. Editor order alternates across
repetitions. These are **warm quickpick searches**, not cold disk-cache measurements.
The operating-system cache is not flushed.

Latency uses a trusted renderer keydown timestamp. Completion requires the expected
input value, focused input, a visible result whose concatenated filename highlights
match the current query, no visible busy indicator, and two consecutive animation
frames satisfying these conditions. The next character is dispatched only after
completion. Matching the query in highlights rejects stale results even when the
same filenames remain visible. The final expected filename must be present.
Opening ends when the empty quickpick input is visible and focused. This measures
query-qualified visible updates, **not exhaustive filesystem-search completion or
physical display latency**. Animation frame scheduling adds latency and a floor.
The full-search chart sums these individual intervals, excluding controller gaps.

Profiling runs separately, using the same search, with V8 sampling at 1 ms:

- Frontend: all discovered Chromium page/worker/iframe isolates, deduplicated by V8
  isolate ID. LVCE's worker architecture is included, not just its thin renderer.
- Renderer JavaScript: sampled JavaScript milliseconds from the identified top-level
  application page isolate per search. Iframe and worker isolates are excluded from
  this measure and remain included in the broader frontend total and raw profiles.
- Backend: Electron main plus every live utility created by `utilityProcess.fork`.
  The harness pauses the original main entrypoint using the Node inspector, wraps
  `fork` to add `--inspect=0`, resumes execution, and discovers each inspector from
  stderr. It retains module path, PID, argv, raw profile, interval and sample count.
- Node worker threads, standalone child processes, native ripgrep, Chromium browser,
  GPU, and other native CPU time are **not measured**. Built-in native work attributed
  by V8 to a JavaScript frame may be included. The results are sampled JS activity,
  not total process CPU time or exact instruction-level execution time.

Each sample's microsecond delta is attributed to its sampled frame. `(idle)` is
separate from `(program)`, garbage collection and other VM pseudo frames. Remaining
samples are reported as estimated JavaScript milliseconds. Missing profiles or
changed target/process membership invalidate the trial, never produce a synthetic
zero. A valid profile with only idle samples can legitimately report zero JS time.
The raw profiles retain each profiler's exact window; sequential starts/stops and
controller gaps add overhead. Instrumentation is not overhead-corrected. Profiling
numbers must not be substituted for the separate latency pass.

The chart pools both filenames and reports median, p95, range and sample counts.
Raw JSON keeps per-query/per-character measurements. Hosted-runner load, different
filtering algorithms, default exclusions and result order limit direct comparisons.
Small differences and one-repeat PR smoke results are not reliable rankings.

## Validation and CI

```sh
npm run type-check
npm run lint
npx playwright install --with-deps chromium
npm test
```

For a locally unsupported Playwright host OS, set `CHROME_BIN` to a compatible Chrome
executable for the browser regression tests. Desktop benchmark binaries remain pinned.
Tests cover stale highlights with unchanged filenames, timeout/page-close behavior,
launch cleanup, profile and trace accounting, report output, and renderer-traffic
coverage. Every PR must pass `Check` and
`Desktop benchmark (both editors)`; the latter runs real desktop latency, profiling,
traffic and rendering trials for both queries and both editors. Main runs five repetitions and deploys Pages
only after successful benchmarking. Dependencies are cached by OS, architecture,
Node version file and lockfile. Editor archives are checksum-verified even on cache hits.

No changes to either editor's repository are required. To add another editor, add a
pinned download, selectors/readiness rules, validated process coverage and real smoke
coverage. Do not accept a new adapter based only on mocked DOM tests.

## Renderer traffic

The separate `--mode traffic` pass measures **incoming workbench messages** during
opening and each character, using the same trusted-keydown to query-qualified
visible-update boundary. The standard run includes all four measurement passes. No instrumentation
is added to the latency or profile passes. Raw `traffic.samples` retain the query,
window timestamps, counts and logical bytes by transport; `traffic.worlds` records
context identities, discovered port/worker counts and each world's original windows.
The charts pool both filenames and keep opening separate from filtering.

The collector uses the debugger to recover already-created main-world MessagePorts
and Workers, then observes their incoming `message` events. Hooks discover subsequent
listener registrations and transferred ports without starting paused ports. Each
object/event is observed once, regardless of the application's number of listeners.
An additional isolated preload runs before the application's preload, intercepting
Electron `ipcRenderer` event delivery and asynchronous `invoke` replies. A real
four-byte binary IPC probe must pass before a trial can report results. Missing
preload/context/port coverage, context changes, mismatched windows or unsupported
payloads fail the trial rather than producing a zero measurement.

**Logical bytes are not exact IPC wire bytes.** Strings and object keys use UTF-8
length, numbers and Dates use eight bytes, booleans one byte, bigint values use their
decimal UTF-8 length, and null/undefined use zero. Arrays, plain objects, Maps and
Sets sum their contents. ArrayBuffers and typed-array/DataView slices use byteLength.
Repeated references to the same object (including cycles) count once per message;
distinct views count their respective visible bytes. Container framing, channel
names, transferred port handles, serialization metadata and protocol overhead are
excluded. Unsupported object types invalidate byte measurements. Rejected invoke
replies count the UTF-8 error string exposed to JavaScript.

Counts include background activity delivered during the windows, with no causal
attribution or background subtraction. Controller gaps between characters are
excluded. Workbench main-world delivery may cross a thread or process boundary;
these are not OS-level process network counters. Window-message forwarding is
excluded to avoid recounting IPC notifications within the renderer. Isolated-world
ports, worker-to-worker traffic, other frames/windows, sockets/network traffic,
native internal Electron IPC and synchronous IPC replies are excluded. A MessageEvent data getter hook accounts before application code can mutate or
detach a received payload; passive listeners provide a fallback for unread messages. Hooks, heap-object discovery (before measurement), IPC interception and
payload traversal add overhead. Do not use traffic-pass durations as latency results.

Implementation references: [CDP object discovery](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-queryObjects),
[Electron session preloads](https://www.electronjs.org/docs/latest/api/session#sesregisterpreloadscriptscript),
and [Electron MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports).

## Rendering work

The separate `--mode render` pass starts after the same full query has been warmed and
quickpick closed. Tracing starts immediately before reopening and incrementally
filtering the query, so setup and warmup events are excluded. Style recalculation sums
main-frame Chromium `UpdateLayoutTree` event durations; paint work sums main-frame
`Paint` event durations. Event counts are reported alongside durations. Frame identity
comes from the quickpick main frame in the trace; missing style or paint evidence fails
the measurement instead of reporting zero. Trace durations are converted from
microseconds to milliseconds. Raw traces are linked per editor and query.

Tracing and event filtering add overhead. The launcher uses `--disable-gpu`, so these
results describe main-frame browser work in that environment and exclude GPU
rasterization, compositing and physical display latency. They are event-duration totals,
not end-to-end search latency or unique painted pixels.

## Performance investigation

See the [quickpick latency investigation](docs/investigations/quickpick-latency/README.md)
for repeated measurements, native search timings, and a cache experiment rejected
because it loses file freshness.
