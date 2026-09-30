# LVCE quickpick benchmark

Compare desktop LVCE Editor and VS Code file quickpick opening, incremental filtering,
and frontend/backend sampled JavaScript activity. Results from `main` are published at
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

Use `--editor lvce` or `--editor vscode` and `--mode latency` or `--mode profile`
for focused diagnosis. These options overwrite `results/results.json` with that run.
Without them, every repetition measures both editors, both filenames, and both modes.
Raw JSON, Chromium `.cpuprofile` files, screenshots and application logs are retained
in `results/`. `site/raw/` publishes these files alongside the charts.

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
launch cleanup, profile accounting and report output. Every PR must pass `Check` and
`Desktop benchmark (both editors)`; the latter runs real desktop latency and profiling
trials for both queries and both editors. Main runs five repetitions and deploys Pages
only after successful benchmarking. Dependencies are cached by OS, architecture,
Node version file and lockfile. Editor archives are checksum-verified even on cache hits.

No changes to either editor's repository are required. To add another editor, add a
pinned download, selectors/readiness rules, validated process coverage and real smoke
coverage. Do not accept a new adapter based only on mocked DOM tests.
