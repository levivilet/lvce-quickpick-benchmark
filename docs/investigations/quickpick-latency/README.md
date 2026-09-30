# Why less JavaScript can still mean slower quickpick updates

Investigation date: 2026-09-30. This is a measured diagnosis and an optimization
experiment, **not a shipped editor performance fix**.

LVCE v0.116.0 re-enumerates the workspace for each character of a file query,
including after a warmup. On the measured local fixture, the native file listing
accounts for most of the search wait. That work is outside the benchmark's V8
JavaScript accounting. A diagnostic snapshot removes most of the latency gap, but
fails file freshness and must not be used as a production fix.

## Reproduction and scope

The baseline is benchmark commit `06e410b9b9758e29eda325c211d2dcd5f743da84`, with
unchanged `config/editors.lock.json`: LVCE v0.116.0 and VS Code 1.136.2. Both archive
SHA256 checks passed. The fixture is the clean VS Code 1.39.0 source tree at
`9df03c6d6ce97c6645c5846f6dfa2a6a7d276515`, with no fixture dependencies installed.
Node was v24.15.0, Linux x64. Editors ran sequentially under Xvfb with fresh Chromium
and XDG profiles, using the existing launcher and alternating editor order.

```sh
npm ci
npm run setup
xvfb-run -a npm run benchmark -- --repeats 5 --mode latency
# Preserve the complete results directory before running another mode/experiment.
```

The published baseline was downloaded from
[raw/results.json](https://levivilet.github.io/lvce-quickpick-benchmark/raw/results.json),
created `2026-09-30T08:43:44.020Z`. That URL changes when Pages deploys;
[measurements.json](measurements.json) preserves the measured intervals and the
SHA256 of each original results JSON. Its arrays are opening followed by the 16
successive query prefixes. Both queries have 16 characters. All 20 local baseline
trials and all 10 snapshot trials passed the unchanged completion conditions.

| Environment / editor | Opening median (ms) | Character median (ms) | Full query median (ms) |
| --- | ---: | ---: | ---: |
| Published LVCE | 69.39 | 63.88 | 1168.66 |
| Published VS Code | 30.60 | 46.90 | 901.35 |
| Local LVCE | 125.19 | 110.47 | 1984.23 |
| Local VS Code | 25.85 | 46.30 | 1049.25 |
| Local LVCE, diagnostic snapshot | 52.39 | 43.85 | 793.45 |

Each row pools five repetitions of each query. Full-query numbers are medians of
per-trial sums, not sums of pooled medians. Local baseline LVCE full-query sums
range from 1794.18–2097.00 ms; snapshot sums range from 740.25–813.03 ms. The ranges
do not overlap. VS Code differs substantially by query: local character medians
are 44.10 ms for `quickOpenModel.ts` and 64.90 ms for `editorOptions.ts`; a pooled
ranking hides this difference. These observations do not establish rankings for
other workspaces, hardware, editor versions or cold searches.

## Critical-path evidence

A separate diagnostic pass wrapped `MessagePort.postMessage` and the
`MessageEvent.data` getter in the page and its live workers after warmup. It recorded
`performance.timeOrigin + performance.now()`, direction, per-context port identity,
RPC ID and method. Matching outgoing requests and incoming replies by port and ID
gives elapsed RPC time. Only metadata was retained; the probe did not stringify
full file lists on the timed path. These instrumented timings are diagnostic,
not substitutes for the uninstrumented latency pass. The diagnostic script used
for the capture is included in [capture-rpc-stages.txt](capture-rpc-stages.txt).

For one `quickOpenModel.ts` trial:

| Observed call | Count | Median elapsed (ms) |
| --- | ---: | ---: |
| Quickpick → `Workspace.getPath` | 18 | 0.35 |
| Quickpick → `FileSearch.searchFile` | 18 | 66.69 |
| File-search worker → `SearchProcess.invoke` | 18 | 65.08 |
| Renderer worker → `SearchFile.searchFile` | 18 | 64.21 |
| Quickpick → `IconTheme.getFileIcon` | 30 | 8.20 |
| Quickpick → `Viewlet.requestRender` | 18 | 3.10 |
| Renderer worker → `QuickPick.render2` | 18 | 0.98 |

These are nested or potentially concurrent intervals; **do not add them**. The
opening path can make more than one file request, so RPC counts need not equal
sample counts. Every captured file-search reply contains 4,417 paths, even for
long prefixes that display one match. Icons contribute some delay, but their
presence alone does not explain the dominant wait. This is not evidence that
worker message passing itself costs 66 ms: almost that whole interval is inside
the forwarded search request.

The pinned bundles show the path:

1. Quickpick `setValue` awaits `getPicks`, then filters the returned picks and gets
   icons before publishing state.
2. File picks ask for the workspace path and call `FileSearch.searchFile`.
3. The native file-search implementation ignores the query value and invokes
   `SearchFile.searchFile` with a limit of 9,999,999 and ripgrep arguments
   `--files --sort-files --hidden --glob !.git --glob !elm-stuff`.
4. The search process executes `rg`, waits for stdout, and returns the listing.
   The quickpick worker converts and filters it again for the new query.

A separate 30-iteration native reproduction, running those exact arguments in
the fixture, returned 4,417 lines / 230,639 bytes each time. Its median was
53.04 ms (range 45.37–75.93 ms). The local executable was ripgrep 15.2.0,
revision `e89fff89ac`. The standalone timings are not a same-request decomposition
of the RPC timings, but independently reproduce the expensive operation.

```sh
cd .tmp/fixture
rg --files --sort-files --hidden --glob '!.git' --glob '!elm-stuff'
```

Removing `--sort-files` reduced the local native median to about 26 ms in a
separate 20-iteration experiment. It also changed ordering. It was rejected as
an optimization under the requirement to preserve search semantics. Globally
sorting the returned paths is not an equivalent replacement: the original
listing was not globally lexicographically sorted.

## Why the JavaScript and latency charts disagree

In the published separate profiling passes, median frontend/backend sampled JS
was 151.32/121.35 ms for LVCE and 298.90/316.50 ms for VS Code per query. LVCE can
execute less sampled JS while waiting longer for native enumeration. The profiler
excludes native ripgrep, other standalone child-process CPU, and browser/GPU work;
asynchronous waits are not JavaScript execution. The frontend includes workers,
so this is not simply a thin-renderer accounting mistake.

The published rendering passes also do not support expensive style/paint as the
main explanation: LVCE median summed style recalculation/paint durations were
7.07/9.45 ms versus 46.92/29.70 ms for VS Code per query. These separate passes
cannot be subtracted from latency to derive an exact residual.

Completion still requires matching highlights, focus, no busy indicator, and two
consecutive animation frames. Frame scheduling adds a floor and quantizes gains.
The roughly 44 ms snapshot character latency includes that floor, filtering,
icons, RPC and rendering; it does not mean 44 ms of JavaScript. This investigation
does not explain every part of opening or every remaining difference from VS Code.

## Optimization attempt and correctness rejection

After preserving the original quickpick bundle, the experiment replaced its one
`const files = await searchFile(workspace, searchValue);` statement with:

```js
const files = await (globalThis.__diagnosticFileSnapshot ??=
  searchFile(workspace, searchValue));
```

This was a diagnostic edit to the extracted pinned binary only. It kept the
existing complete file list, ordering, filtering, highlights and benchmark
completion criteria. The first query populated the snapshot during the existing
warmup. Five repetitions of both queries then used the ordinary latency mode.
The roughly 60% character-latency reduction is much larger than observed baseline
variation and supports repeated enumeration as a causal contributor.

However, after warming the picker and closing it, the freshness probe created
`QuickpickFreshnessProbe.ts` in the fixture, reopened the picker and inserted that
filename. With the snapshot it did not appear within five seconds. After restoring
the original bundle byte-for-byte, the same probe found it within five seconds.
Both probes removed the temporary file and closed their isolated app. The snapshot
also lacks workspace scoping and rejection recovery. It is deliberately unsuitable
for production. **No cached binary, editor source change, or release is delivered.**

The original binary was restored before a final two-repeat latency check (four
trials, all passed): character median returned to 110.80 ms. See the
`restoredBaseline` measurements. This
baseline/snapshot/restored sequence reduces the likelihood that the speedup merely
reflects a later, less-loaded machine. It is not a randomized performance study.

## Safe optimization boundary

The next implementation should avoid repeated native enumeration using a
workspace-scoped file index or snapshot with a defined refresh contract. Current
quickpick/file-search modules do not supply a cache invalidation lifecycle. A
persistent cache alone would weaken observed behavior. A safe design must handle:

- File creation, deletion, renaming, ignore-rule changes, watcher overflow and
  workspace changes, including changes while the picker remains open.
- Native filesystem versus extension-backed/virtual providers; the query cannot
  be ignored when caching providers that already filter server-side.
- Error eviction, bounded ownership and teardown, concurrent queries, stale-result
  rejection, and closing/reopening or replacing the picker during an in-flight scan.
- Existing result order, highlights, focus, keyboard selection, rapid typing and
  cancellation, with real UI regressions and the required worker/editor CI matrix.

A refresh in the background might improve responsiveness, but publishing stale
results temporarily changes the visible behavior and needs explicit tests and a
freshness policy. The measured speedup is a target for that work, not evidence that
such a policy has been implemented. This investigation stops at the demonstrated
bottleneck and rejected unsafe optimization rather than claiming a performance fix.

## Re-running the diagnostic probes

Copy `capture-rpc-stages.txt` and `check-freshness.txt` to
`.tmp/diagnosis/stages.ts` and `.tmp/diagnosis/freshness.ts` respectively, so their
relative imports resolve. After setup, run from the repository root:

```sh
mkdir -p .tmp/diagnosis results
cp docs/investigations/quickpick-latency/capture-rpc-stages.txt .tmp/diagnosis/stages.ts
cp docs/investigations/quickpick-latency/check-freshness.txt .tmp/diagnosis/freshness.ts
xvfb-run -a node .tmp/diagnosis/stages.ts
xvfb-run -a node .tmp/diagnosis/freshness.ts baseline
```

These are archived one-off investigation scripts, not new benchmark modes.
The stage probe writes `results/stages.json`; the freshness probe writes
`results/freshness-baseline.json`. Neither patches an editor. The freshness probe
temporarily creates a uniquely named fixture file; use a clean fixture and do not
run it concurrently with benchmark trials. Before reproducing the snapshot
experiment, back up the extracted quickpick bundle; restore it in a `finally`/shell
trap even on failure. Do not publish or use the altered binary outside diagnosis.
