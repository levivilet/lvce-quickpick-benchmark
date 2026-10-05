import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { arm, collect, adapters } from '../src/adapters.ts'
import { rendererJavaScriptMs, summarize } from '../src/profiles.ts'
import { cursorWelcomeValues, prepareCursorProfile, seedCursorWelcomeState } from '../src/cursor-profile.ts'
import { render, statistics } from '../../report/src/render.ts'
import { benchmarkViewport, launch, profileCapabilities, setBenchmarkViewport, utilityInstrumentation } from '../src/launch.ts'
import { createLegacyCdpProxy } from '../src/cdp-compat.ts'
import { WebSocket, WebSocketServer } from 'ws'
import { summarizeRenderingTrace } from '../src/rendering.ts'
import { collectPaintMetrics } from '../src/paintMetrics.ts'
import { readdir, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'

const profile = { startTime: 0, endTime: 6000, nodes: [{ id: 1, callFrame: { functionName: 'filter', url: 'app.js' } }, { id: 2, callFrame: { functionName: '(idle)', url: '' } }, { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } }], samples: [1, 2, 3], timeDeltas: [1000, 2000, 3000] }
test('profile accounting excludes idle and VM samples and rejects incomplete data', () => {
  assert.deepEqual(summarize(profile), { javascriptMs: 1, idleMs: 2, vmMs: 3, samples: 3, discardedSamples: 0, durationMs: 6 })
  assert.deepEqual(summarize({ ...profile, timeDeltas: [1000, -2, 3000] }), { javascriptMs: 1, idleMs: 0, vmMs: 3, samples: 2, discardedSamples: 1, durationMs: 6 })
  assert.throws(() => summarize({ ...profile, timeDeltas: [1000, -1001, 3000] }), /Invalid CPU sample/)
  assert.throws(() => summarize({ ...profile, timeDeltas: [] }))
  assert.throws(() => summarize({ ...profile, samples: [99, 2, 3] }))
  assert.throws(() => summarize({ ...profile, samples: [], timeDeltas: [] }))
})
test('benchmark viewport is fixed across editor trials', async () => {
  assert.deepEqual(benchmarkViewport, { width: 1280, height: 900 })
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await setBenchmarkViewport(page)
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })), benchmarkViewport)
  } finally {
    await browser.close()
  }
})
test('renderer JavaScript uses only the application page profile and requires its coverage', () => {
  const results = [
    { side: 'frontend', identity: { targetId: 'application-page', type: 'page' }, javascriptMs: 3 },
    { side: 'frontend', identity: { targetId: 'worker', type: 'worker' }, javascriptMs: 100 },
    { side: 'frontend', identity: { targetId: 'iframe', type: 'iframe' }, javascriptMs: 200 },
    { side: 'backend', identity: { targetId: 'application-page', role: 'main' }, javascriptMs: 300 },
  ]
  assert.equal(rendererJavaScriptMs(results, 'application-page'), 3)
  assert.equal(rendererJavaScriptMs([{ ...results[0], javascriptMs: 0 }], 'application-page'), 0)
  assert.throws(() => rendererJavaScriptMs(results.slice(1), 'application-page'), /coverage/)
  assert.throws(() => rendererJavaScriptMs([results[0], results[0]], 'application-page'), /coverage/)
})
test('statistics and report preserve unavailable data and escape external labels', () => {
  assert.equal(statistics([4, 1, 2, 3]).median, 2.5)
  assert.equal(statistics([4, 1, 2, 3]).p95, 4)
  assert.throws(() => statistics([NaN]))
  const html = render({ created: 'today', editors: [{ id: 'lvce', name: '<script>x</script>', version: '1' }], trials: [], repeats: 1, fixture: { commit: 'abc' } })
  assert(html.includes('Unavailable'))
  assert(html.includes('Renderer JavaScript'))
  assert(html.includes('application page isolate'))
  assert(!html.includes('<script>x</script>'))
  assert(html.includes('&lt;script&gt;'))
  assert(html.includes('raw/results.json'))
  const fourEditors = render({ created: 'today', editors: [{ id: 'lvce', name: 'LVCE Editor', version: '1' }, { id: 'vscode', name: 'VS Code', version: '1' }, { id: 'cursor', name: 'Cursor', version: '3.22.12' }, { id: 'theia', name: 'Eclipse Theia IDE', version: '1' }], trials: [], repeats: 1, fixture: { commit: 'abc' } })
  assert(fourEditors.includes('LVCE Editor × VS Code × Cursor × Eclipse Theia'))
  assert(fourEditors.includes('viewBox="0 0 640 300"'))
  assert(fourEditors.includes('Cursor 3.22.12'))
  const fiveEditors = render({ created: 'today', editors: [{ id: 'lvce', name: 'LVCE Editor', version: '1' }, { id: 'vscode', name: 'VS Code', version: '1' }, { id: 'cursor', name: 'Cursor', version: '3.22.12' }, { id: 'theia', name: 'Eclipse Theia IDE', version: '1' }, { id: 'atom', name: 'Atom (archived)', version: '1.60.0' }], trials: [], repeats: 1, fixture: { commit: 'abc' } })
  assert(fiveEditors.includes('LVCE Editor × VS Code × Cursor × Eclipse Theia IDE × Atom (archived)'))
  assert(fiveEditors.includes('viewBox="0 0 640 365"'))
  assert(fiveEditors.includes('Atom (archived) 1.60.0'))
})
test('benchmark charts and tables sort each metric by median, retain ties, and keep unavailable results last', () => {
  const editors = [
    { id: 'lvce', name: 'LVCE Editor', version: '1' },
    { id: 'vscode', name: 'VS Code', version: '1' },
    { id: 'alpha', name: 'Alpha', version: '1' },
    { id: 'beta', name: 'Beta', version: '1' },
    { id: 'zero', name: 'Zero', version: '1' },
    { id: 'missing', name: 'Missing', version: '1' },
  ]
  const measurements = {
    lvce: { latency: [4, 4, 4], renderer: 3, frontend: 4, backend: 1, traffic: [4, 400], rendering: [4, 1, 4, 1] },
    vscode: { latency: [1, 1, 1], renderer: 4, frontend: 5, backend: 3, traffic: [1, 100], rendering: [1, 3, 1, 3] },
    alpha: { latency: [2, 5, 5], renderer: 1, frontend: 2, backend: 4, traffic: [2, 200], rendering: [2, 4, 2, 4] },
    beta: { latency: [3, 2, 2], renderer: 2, frontend: 3, backend: 2, traffic: [3, 300], rendering: [3, 2, 3, 2] },
    zero: { latency: [0, 0, 0], renderer: 0, frontend: 0, backend: 0, traffic: [0, 0], rendering: [0, 0, 0, 0] },
  }
  const trials = editors.flatMap(editor => {
    const value = measurements[editor.id as keyof typeof measurements]
    if (!value) return []
    return [
      { editor: editor.id, mode: 'latency', status: 'passed', samples: value.latency.map(milliseconds => ({ milliseconds })) },
      { editor: editor.id, mode: 'profile', status: 'passed', profile: { rendererJavaScriptMs: value.renderer, frontendMs: value.frontend, backendMs: value.backend } },
      { editor: editor.id, mode: 'traffic', status: 'passed', traffic: { samples: [{ messages: value.traffic[0], logicalBytes: value.traffic[1] }, { messages: value.traffic[0], logicalBytes: value.traffic[1] }] } },
      { editor: editor.id, mode: 'render', status: 'passed', rendering: { styleRecalculationMs: value.rendering[0], paintMs: value.rendering[1], styleRecalculationCount: value.rendering[2], paintEventCount: value.rendering[3] } },
    ]
  })
  const html = render({ created: 'today', editors, trials, repeats: 1, fixture: { commit: 'abc' } })
  const sections = [...html.matchAll(/<section><h2>(.*?)<\/h2>([\s\S]*?)<\/section>/g)]
  const expectedByChart: Record<string, string[]> = {
    'Open quickpick': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Filter each character': ['Zero', 'VS Code', 'Beta', 'LVCE Editor', 'Alpha', 'Missing'],
    'Complete filename search': ['Zero', 'VS Code', 'Beta', 'LVCE Editor', 'Alpha', 'Missing'],
    'Renderer JavaScript': ['Zero', 'Alpha', 'Beta', 'LVCE Editor', 'VS Code', 'Missing'],
    'Frontend JavaScript': ['Zero', 'Alpha', 'Beta', 'LVCE Editor', 'VS Code', 'Missing'],
    'Backend JavaScript': ['Zero', 'LVCE Editor', 'Beta', 'VS Code', 'Alpha', 'Missing'],
    'Open quickpick: incoming messages': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Filter each character: incoming messages': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Open quickpick: incoming payload': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Filter each character: incoming payload': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'CSS style recalculation': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Paint work': ['Zero', 'LVCE Editor', 'Beta', 'VS Code', 'Alpha', 'Missing'],
    'Style recalculation events': ['Zero', 'VS Code', 'Alpha', 'Beta', 'LVCE Editor', 'Missing'],
    'Paint events': ['Zero', 'LVCE Editor', 'Beta', 'VS Code', 'Alpha', 'Missing'],
  }
  assert.equal(sections.length, Object.keys(expectedByChart).length)
  for (const section of sections) {
    const [, title, body] = section
    const expected = expectedByChart[title]
    assert(expected, `Unexpected chart: ${title}`)
    const tableOrder = [...body.matchAll(/<tr><td>(.*?)<\/td>/g)].map(match => match[1])
    const chartOrder = [...body.matchAll(/<text x="0" y="\d+" fill="currentColor">(.*?)<\/text>/g)].map(match => match[1])
    assert.deepEqual(tableOrder, expected, `${title} table order`)
    assert.deepEqual(chartOrder, expected, `${title} chart order`)
  }
  assert.match(html, /LVCE Editor<\/text><rect[^>]+fill="#0f766e"/)
  assert.match(html, /0\.00 ms/)
})
test('Cursor welcome state is seeded repeat-safely without replacing unrelated profile state', async () => {
  const root = await mkdtemp(`${tmpdir()}/quickpick-cursor-state-`)
  const databasePath = `${root}/state.vscdb`
  const database = new DatabaseSync(databasePath)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('existing-setting', 'preserved')
  database.close()
  try {
    seedCursorWelcomeState(databasePath)
    seedCursorWelcomeState(databasePath)
    const seeded = new DatabaseSync(databasePath)
    try {
      const actual = new Map(seeded.prepare('SELECT key, value FROM ItemTable').all().map((row: any) => [row.key, row.value]))
      assert.equal(actual.get('existing-setting'), 'preserved')
      for (const [key, value] of Object.entries(cursorWelcomeValues)) assert.equal(actual.get(key), value)
      assert.equal(actual.size, Object.keys(cursorWelcomeValues).length + 1)
    } finally { seeded.close() }
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('failed Cursor profile bootstrap stops its detached process', async () => {
  const root = await mkdtemp(`${tmpdir()}/quickpick-cursor-bootstrap-`)
  const profile = `${root}/profile`
  let pid = 0
  try {
    await assert.rejects(prepareCursorProfile('unused', profile, root, process.env, 200, (_binary, _args, options) => {
      const child = spawn(process.execPath, ['-e', `setInterval(() => {}, 60000)`], { ...options, stdio: 'ignore' })
      pid = child.pid!
      return child
    }), /did not create a compatible profile database/)
    assert(pid > 0)
    await assert.rejects(readFile(`/proc/${pid}/stat`))
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('Cursor profile bootstrap reports a missing executable without waiting for timeout', async () => {
  const root = await mkdtemp(`${tmpdir()}/quickpick-cursor-missing-`)
  const started = performance.now()
  try {
    await assert.rejects(prepareCursorProfile(`${root}/missing`, `${root}/profile`, root, process.env, 10000), /ENOENT/)
    assert(performance.now() - started < 2000)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('Cursor report includes its version, query statistics, screenshot, and raw profile links', () => {
  const html = render({ created: 'today', editors: [
    { id: 'lvce', name: 'LVCE Editor', version: '1' },
    { id: 'vscode', name: 'VS Code', version: '1' },
    { id: 'cursor', name: 'Cursor', version: '3.22.12' },
    { id: 'theia', name: 'Eclipse Theia IDE', version: '1' },
  ], repeats: 1, fixture: { commit: 'abc' }, trials: [
    { editor: 'cursor', mode: 'latency', status: 'passed', filename: 'quickOpenModel.ts', repeat: 0, samples: [{ milliseconds: 12 }, { milliseconds: 6 }], screenshot: 'cursor-latency.png' },
    { editor: 'cursor', mode: 'profile', status: 'passed', filename: 'quickOpenModel.ts', repeat: 0, profile: { rendererJavaScriptMs: 2, frontendMs: 3, backendMs: 4, results: [{ side: 'frontend', identity: { type: 'page', targetId: 'cursor-page' }, file: 'cursor.cpuprofile' }] }, screenshot: 'cursor-profile.png' },
  ] })
  assert(html.includes('Cursor 3.22.12'))
  assert(html.includes('12.00'))
  assert(html.includes('raw/cursor-latency.png'))
  assert(html.includes('raw/cursor-profile.png'))
  assert(html.includes('raw/cursor.cpuprofile'))
})
test('report renders zero renderer activity and keeps missing renderer data unavailable', () => {
  const base = { created: 'today', editors: [{ id: 'lvce', name: 'LVCE', version: '1' }], repeats: 1, fixture: { commit: 'abc' } }
  const trials = (rendererJavaScriptMs?: number) => [
    { editor: 'lvce', mode: 'latency', status: 'passed', repeat: 0, samples: [{ milliseconds: 0 }, { milliseconds: 0 }] },
    { editor: 'lvce', mode: 'profile', status: 'passed', repeat: 0, profile: { rendererJavaScriptMs, frontendMs: 0, backendMs: 0 } },
  ]
  const html = render({ ...base, trials: trials(0) })
  assert(html.includes('0.00 ms'))
  const unavailable = render({ ...base, trials: trials() })
  assert(unavailable.includes('Renderer JavaScript'))
  assert(unavailable.includes('Unavailable'))
})
test('rendering metrics use only complete main-frame events and convert trace microseconds', () => {
  const trace = { traceEvents: [
    { name: 'UpdateLayoutTree', ph: 'X', ts: 10, dur: 1250, args: { data: { frame: 'main' } } },
    { name: 'UpdateLayoutTree', ph: 'X', ts: 20, dur: 750, args: { beginData: { frame: 'main' } } },
    { name: 'Paint', ph: 'X', ts: 30, dur: 500, args: { data: { frame: 'main' } } },
    { name: 'Paint', ph: 'X', ts: 40, dur: 9000, args: { data: { frame: 'other' } } },
    { name: 'Paint', ph: 'B', ts: 50, dur: 1000, args: { data: { frame: 'main' } } },
  ] }
  assert.deepEqual(summarizeRenderingTrace(trace, 'main'), { styleRecalculationCount: 2, styleRecalculationMs: 2, paintEventCount: 1, paintMs: 0.5 })
  assert.deepEqual(summarizeRenderingTrace({ traceEvents: [
    { name: 'UpdateLayoutTree', ph: 'X', ts: 1, dur: 0, args: { data: { frame: 'main' } } },
    { name: 'Paint', ph: 'X', ts: 2, dur: 0, args: { data: { frame: 'main' } } },
  ] }, 'main'), { styleRecalculationCount: 1, styleRecalculationMs: 0, paintEventCount: 1, paintMs: 0 })
  assert.throws(() => summarizeRenderingTrace({ traceEvents: [] }, 'main'), /No main-frame style recalculation/)
  assert.throws(() => summarizeRenderingTrace({ traceEvents: [
    { name: 'RecalculateStyles', ph: 'X', ts: 1, dur: 1, args: { beginData: { frame: 'main' } } },
    { name: 'Paint', ph: 'X', ts: 2, dur: 1, args: { data: { frame: 'main' } } },
  ] }, 'main'), /No main-frame style recalculation/)
  assert.throws(() => summarizeRenderingTrace({ traceEvents: [{ name: 'UpdateLayoutTree', ph: 'X', ts: 1, dur: 1, args: { data: { frame: 'other' } } }] }, 'main'), /No main-frame style recalculation/)
})
test('render report shows rendering units, unavailable states, and raw trace links', () => {
  const html = render({ created: 'today', editors: [{ id: 'lvce', name: 'LVCE', version: '1' }, { id: 'vscode', name: 'VS Code', version: '2' }], trials: [
    { editor: 'lvce', mode: 'render', status: 'passed', rendering: { styleRecalculationMs: 2, styleRecalculationCount: 3, paintMs: 1, paintEventCount: 4, trace: 'lvce.trace.json' } },
  ], repeats: 1, fixture: { commit: 'abc' } })
  assert(html.includes('CSS style recalculation'))
  assert(html.includes('Paint work'))
  assert(html.includes('main-frame ms'))
  assert(html.includes('raw/lvce.trace.json'))
  assert(html.includes('Unavailable'))
})
test('paint metrics sum exact commands across content layers and release every snapshot', async () => {
  const released: string[] = []
  const handlers = new Map<string, (event: any) => void>()
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string, params?: any) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [
        { layerId: 'one', drawsContent: true, width: 1280, height: 900 }, { layerId: 'empty', drawsContent: false }, { layerId: 'two', drawsContent: true, width: 1280, height: 900 },
      ] })
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: `snapshot-${params.layerId}` }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: params.snapshotId.endsWith('one') ? [{ method: 'drawTextBlob' }, { method: 'clipRect' }] : [{ method: 'drawTextBlob' }, { method: 'drawTextBlob' }] }
      if (method === 'LayerTree.profileSnapshot') return { timings: params.snapshotId.endsWith('one') ? [[0.001, 0.002]] : [[0.003, 0.004]] }
      if (method === 'LayerTree.releaseSnapshot') released.push(params.snapshotId)
      return {}
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as any
  assert.deepEqual(await collectPaintMetrics(page), { available: true, contentLayerCount: 2, timingsAvailable: true, commands: [{ method: 'drawTextBlob', count: 3, durationMs: 8, timedCount: 3 }, { method: 'clipRect', count: 1, durationMs: 2, timedCount: 1 }] })
  assert.deepEqual(released.sort(), ['snapshot-one', 'snapshot-one', 'snapshot-two', 'snapshot-two'])
  assert.equal(handlers.size, 0)
})
test('paint metrics release earlier snapshots when a later layer fails', async () => {
  const released: string[] = []
  const handlers = new Map<string, (event: any) => void>()
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string, params?: any) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [{ layerId: 'one', drawsContent: true, width: 1280, height: 900 }, { layerId: 'two', drawsContent: true, width: 1280, height: 900 }] })
      if (method === 'LayerTree.makeSnapshot' && params.layerId === 'two') throw new Error('snapshot unavailable')
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: 'snapshot-one' }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [] }
      if (method === 'LayerTree.releaseSnapshot') released.push(params.snapshotId)
      return {}
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as any
  assert.deepEqual(await collectPaintMetrics(page), { available: false, reason: 'snapshot unavailable' })
  assert.deepEqual(released, ['snapshot-one'])
  assert.equal(handlers.size, 0)
})
test('paint timing failures keep command counts and mark timings unavailable', async () => {
  const handlers = new Map<string, (event: any) => void>()
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string, _params?: any) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [{ layerId: 'one', drawsContent: true, width: 1280, height: 900 }] })
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: 'snapshot-one' }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [{ method: 'drawRect' }, { method: 'drawRect' }] }
      if (method === 'LayerTree.profileSnapshot') return { timings: [[0.001]] }
      return {}
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as any
  assert.deepEqual(await collectPaintMetrics(page), { available: true, contentLayerCount: 1, timingsAvailable: false, timingReason: 'Paint Profiler timings did not match the command log', commands: [{ method: 'drawRect', count: 2 }] })
})
test('stalled paint profiling times out, preserves all counts, and detaches its CDP session', async () => {
  let detached = false
  const released: string[] = []
  const handlers = new Map<string, (event: any) => void>()
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => { detached = true; await new Promise(() => {}) },
    send: async (method: string, params?: any) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [{ layerId: 'one', drawsContent: true, width: 1280, height: 900 }, { layerId: 'two', drawsContent: true, width: 1280, height: 900 }] })
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: `snapshot-${params.layerId}` }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [{ method: params.snapshotId.endsWith('one') ? 'drawRect' : 'drawTextBlob' }] }
      if (method === 'LayerTree.profileSnapshot') return new Promise(() => {})
      if (method === 'LayerTree.releaseSnapshot') released.push(params.snapshotId)
      return {}
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as any
  assert.deepEqual(await collectPaintMetrics(page, 5000, 1), {
    available: true,
    contentLayerCount: 2,
    timingsAvailable: false,
    timingReason: 'Paint Profiler timed out after 1 ms',
    commands: [{ method: 'drawRect', count: 1 }, { method: 'drawTextBlob', count: 1 }],
  })
  assert.equal(detached, true)
  assert.deepEqual(released.sort(), ['snapshot-one', 'snapshot-two'])
  assert.equal(handlers.size, 0)
})
test('paint snapshots with no content layers are unavailable', async () => {
  const handlers = new Map<string, (event: any) => void>()
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [{ layerId: 'empty', drawsContent: false }] })
      return {}
    },
  }
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as any
  assert.deepEqual(await collectPaintMetrics(page), { available: false, reason: 'No content layers in final snapshot' })
})
test('paint report keeps counts, ranks measured methods by replay duration, and reads count-only results', () => {
  const html = render({ created: 'today', editors: [{ id: 'lvce', name: '<script>LVCE</script>', version: '1' }, { id: 'other', name: 'Other', version: '2' }], repeats: 2, fixture: { commit: 'abc' }, trials: [
    { editor: 'lvce', mode: 'paint', status: 'passed', paintMetrics: { available: true, timingsAvailable: true, commands: [{ method: 'drawTextBlob', count: 2, durationMs: 0.006 }, { method: 'draw<Rect>', count: 1, durationMs: 0.003 }] } },
    { editor: 'lvce', mode: 'paint', status: 'passed', paintMetrics: { available: true, timingsAvailable: true, commands: [{ method: 'drawTextBlob', count: 1, durationMs: 0.003 }] } },
    { editor: 'lvce', mode: 'paint', status: 'passed', paintMetrics: { available: true, commands: [{ method: 'drawTextBlob', count: 5 }, { method: 'draw<Rect>', count: 1 }] } },
    { editor: 'lvce', mode: 'paint', status: 'failed', paintMetrics: { available: true, commands: [{ method: 'drawTextBlob', count: 99 }] } },
    { editor: 'other', mode: 'paint', status: 'passed', paintMetrics: { available: false, reason: 'No layers' } },
  ] })
  assert(html.includes('Paint command breakdown'))
  assert(html.includes('drawTextBlob</code></td><td>2.67 (1–5)</td><td>0.0045</td><td>0.0030</td>'))
  assert(html.includes('draw&lt;Rect&gt;'))
  assert(html.includes('0.0015'))
  assert(html.includes('3 available observations'))
  assert(html.includes('2 with timings'))
  assert(html.includes('Average measured total (ms/load)'))
  assert(!html.includes('99'))
  assert(html.includes('Unavailable: no valid final content-layer snapshots'))
  assert(!html.includes('<script>LVCE</script>'))
})
test('current highlights distinguish unchanged filenames from stale results; timeout and page crash reject', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await page.setContent('<input name="QuickPickInput" value="a"><div class="QuickPickItem"><div class="QuickPickItemLabel"><span class="QuickPickHighlight">a</span>bc.ts</div></div>')
    await page.locator('input').focus()
    await page.keyboard.press('End')
    await arm(page, adapters.lvce, 'ab', 2000)
    await page.keyboard.press('b')
    await page.evaluate(() => { (window as any).settled = false; (window as any).quickpickSample.then(() => { (window as any).settled = true }) })
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => (window as any).settled), false, 'Stale a highlight must not complete ab')
    await page.evaluate(() => { document.querySelector('.QuickPickItemLabel')!.innerHTML = '<span class="QuickPickHighlight">ab</span>c.ts' })
    const result = await collect(page)
    assert.equal(result.rows[0].label, 'abc.ts')
    assert.equal(result.query, 'ab')
    assert(result.milliseconds >= 100)
    await arm(page, adapters.lvce, 'abc', 150)
    await page.keyboard.press('c')
    await assert.rejects(collect(page), /timeout/)
    // A timed-out observer must not consume or complete a subsequent trial.
    await arm(page, adapters.lvce, 'abcd', 2000)
    await page.keyboard.press('d')
    const pending = collect(page)
    const rejected = assert.rejects(pending, /closed|crash/i)
    await page.close()
    await rejected
  } finally { await browser.close() }
})
test('Theia quick-open uses its query-qualified Monaco adapter', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await page.setContent('<div class="quick-input-widget"><input aria-label="Search files by name" value=""></div><div class="quick-input-list"><div class="monaco-list-row"><span class="label-name"><span class="highlight"></span>est.ts</span></div></div>')
    await page.evaluate(() => document.querySelector('input')!.addEventListener('input', event => { document.querySelector('.highlight')!.textContent = (event.target as HTMLInputElement).value }))
    await page.locator('input').focus()
    await arm(page, adapters.theia, 't')
    await page.keyboard.press('t')
    const result = await collect(page)
    assert.equal(result.query, 't')
    assert.equal(result.rows[0].label, 'test.ts')
  } finally { await browser.close() }
})
test('Atom fuzzy finder uses mini-editor text and only filename highlight spans', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await page.setContent('<div class="fuzzy-finder"><atom-text-editor><div class="line"></div><input class="hidden-input"></atom-text-editor><ol><li class="FuzzyFinderResult"><div class="primary-line"><span class="character-match"></span>uick.ts</div><div class="secondary-line"><span class="character-match">stale</span></div></li></ol></div>')
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.hidden-input')!
      input.focus()
      document.addEventListener('keydown', event => {
        if (event.key === 'q') {
          document.querySelector('.line')!.innerHTML = '<span>q</span>'
          document.querySelector('.primary-line .character-match')!.textContent = 'q'
        }
      })
    })
    await arm(page, adapters.atom, 'q')
    await page.keyboard.press('q')
    const result = await collect(page)
    assert.equal(result.query, 'q')
    assert.equal(result.rows[0].label, 'quick.ts')
    assert.equal(result.rows[0].highlights, 'q')
  } finally { await browser.close() }
})
test('Atom profile uses legacy fork instrumentation without assuming a utility process', () => {
  assert.deepEqual(profileCapabilities.atom, { requireBackendProcess: false, requireRendererWorker: false, processApis: ['childProcessFork'], legacyRequire: true })
  assert(utilityInstrumentation(profileCapabilities.atom).includes('child_process'))
  assert(!profileCapabilities.atom.processApis.includes('utilityProcess'))
})
test('legacy CDP proxy absorbs only Playwright download behavior and forwards other commands', async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>(resolve => upstream.once('listening', resolve))
  const address = upstream.address()
  assert(address && typeof address !== 'string')
  const received: string[] = []
  upstream.on('connection', socket => socket.on('message', data => {
    const request = JSON.parse(data.toString())
    received.push(request.method)
    socket.send(JSON.stringify({ id: request.id, result: { product: 'Chrome/83' } }))
  }))
  const proxy = await createLegacyCdpProxy(`ws://127.0.0.1:${address.port}`)
  const client = new WebSocket(proxy.endpoint)
  try {
    await new Promise<void>((resolve, reject) => { client.once('open', resolve); client.once('error', reject) })
    const request = (id: number, method: string) => new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP response timeout: ${method}`)), 2000)
      const onMessage = (data: WebSocket.RawData) => {
        const response = JSON.parse(data.toString())
        if (response.id === id) { clearTimeout(timer); client.off('message', onMessage); resolve(response) }
      }
      client.on('message', onMessage)
      client.send(JSON.stringify({ id, method }))
    })
    assert.deepEqual(await request(1, 'Browser.setDownloadBehavior'), { id: 1, result: {} })
    assert.deepEqual(await request(2, 'Browser.getVersion'), { id: 2, result: { product: 'Chrome/83' } })
    assert.deepEqual(received, ['Browser.getVersion'])
  } finally {
    client.close()
    await proxy.close()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
  }
})
test('startup failure and timeout dispose the isolated profile and detached child processes', async () => {
  const before = (await readdir(tmpdir())).filter(x => x.startsWith('quickpick-benchmark-test-cleanup-')).sort()
  await mkdir('.tmp/apps/test-cleanup', { recursive: true })
  const marker = '.tmp/test-cleanup-child.pid'
  await writeFile('.tmp/apps/test-cleanup/sleep.cjs', `const { spawn } = require('node:child_process'); const { writeFileSync } = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { detached: true, stdio: 'ignore' }); writeFileSync('${marker}', String(child.pid)); setInterval(() => {}, 60000)\n`)
  await writeFile('.tmp/apps/test-cleanup/sleep.sh', '#!/bin/sh\nexec node .tmp/apps/test-cleanup/sleep.cjs\n', { mode: 0o755 })
  try {
    await assert.rejects(launch({ id: 'test-cleanup', name: 'test', version: '0', binary: 'missing' }, false, '.tmp/missing.log', 200), /ENOENT/)
    await assert.rejects(launch({ id: 'test-cleanup', name: 'test', version: '0', binary: 'sleep.sh' }, false, '.tmp/timeout.log', 200), /timeout/)
    const childPid = Number(await readFile(marker, 'utf8'))
    let running = true
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      try { const stat = await readFile(`/proc/${childPid}/stat`, 'utf8'); running = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z' } catch { running = false }
      if (running) await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.equal(running, false, 'detached descendants must be stopped before profile cleanup')
    assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith('quickpick-benchmark-test-cleanup-')).sort(), before)
  } finally { await rm('.tmp/apps/test-cleanup', { recursive: true, force: true }); await rm(marker, { force: true }) }
})

test('oversized layers retain counts without replaying, and later layers still have timings', async () => {
  const handlers = new Map<string, (event: any) => void>()
  const replayed: string[] = []
  const released: string[] = []
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string, params?: any) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [
        { layerId: 'huge', drawsContent: true, width: 16777216, height: 16777217 },
        { layerId: 'normal', drawsContent: true, width: 1280, height: 900 },
      ] })
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: params.layerId }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [{ method: 'drawRect' }, { method: params.snapshotId === 'huge' ? 'drawPaint' : 'drawTextBlob' }] }
      if (method === 'LayerTree.profileSnapshot') { replayed.push(params.snapshotId); return { timings: [[0.001, 0.002]] } }
      if (method === 'LayerTree.releaseSnapshot') released.push(params.snapshotId)
      return {}
    },
  }
  const metrics = await collectPaintMetrics({ context: () => ({ newCDPSession: async () => cdp }) } as any)
  assert.equal(metrics.timingsAvailable, true)
  assert.equal(metrics.timingsComplete, false)
  assert.match(metrics.timingReason!, /64 MiB/)
  assert.deepEqual(metrics.commands, [
    { method: 'drawRect', count: 2, durationMs: 1, timedCount: 1 },
    { method: 'drawPaint', count: 1 },
    { method: 'drawTextBlob', count: 1, durationMs: 2, timedCount: 1 },
  ])
  assert.deepEqual(replayed, ['normal'])
  assert.deepEqual(released, ['huge', 'normal', 'normal'])
  assert.equal(handlers.size, 0)
})

test('changed snapshot methods cannot silently acquire another command timing', async () => {
  const handlers = new Map<string, (event: any) => void>()
  let captures = 0
  const cdp = {
    on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    detach: async () => {},
    send: async (method: string) => {
      if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [{ layerId: 'one', drawsContent: true, width: 10, height: 10 }] })
      if (method === 'LayerTree.makeSnapshot') return { snapshotId: 'snapshot' }
      if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [{ method: captures++ ? 'drawTextBlob' : 'drawRect' }] }
      if (method === 'LayerTree.profileSnapshot') assert.fail('Changed command log must not be profiled')
      return {}
    },
  }
  const metrics = await collectPaintMetrics({ context: () => ({ newCDPSession: async () => cdp }) } as any)
  assert.equal(metrics.timingsAvailable, false)
  assert.match(metrics.timingReason!, /snapshot changed/)
  assert.deepEqual(metrics.commands, [{ method: 'drawRect', count: 1 }])
})

test('partial paint timings show measured coverage without turning missing timings into zeros', () => {
  const html = render({ created: 'today', editors: [{ id: 'vscode', name: 'VS Code', version: '1' }], repeats: 2, fixture: { commit: 'abc' }, trials: [
    { editor: 'vscode', mode: 'paint', status: 'passed', paintMetrics: { available: true, timingsAvailable: true, timingsComplete: false, timingReason: 'Oversized <layer>', commands: [{ method: 'drawRect', count: 10, timedCount: 2, durationMs: 4 }, { method: 'drawPaint', count: 1 }] } },
    { editor: 'vscode', mode: 'paint', status: 'passed', paintMetrics: { available: true, timingsAvailable: true, commands: [{ method: 'drawRect', count: 2, timedCount: 2, durationMs: 2 }] } },
  ] })
  assert(html.includes('1 partial'))
  assert(html.includes('Oversized &lt;layer&gt;'))
  assert(html.includes('drawRect</code></td><td>6.00 (2–10)</td><td>3.0000</td><td>1.5000</td><td>4/12</td>'))
  assert(html.includes('drawPaint</code></td><td>0.50 (0–1)</td><td>Unavailable</td><td>Unavailable</td><td>0/1</td>'))
})

test('a disappearing layer restarts the whole capture with fresh layers and bounded retries', async () => {
  for (const alwaysDisappears of [false, true]) {
    let sessions = 0
    let detached = 0
    const released: string[] = []
    const page = { context: () => ({ newCDPSession: async () => {
      const session = ++sessions
      const handlers = new Map<string, (event: any) => void>()
      return {
        on: (name: string, handler: (event: any) => void) => handlers.set(name, handler),
        off: (name: string) => handlers.delete(name),
        detach: async () => { detached++; assert.equal(handlers.size, 0) },
        send: async (method: string, params?: any) => {
          if (method === 'LayerTree.enable') handlers.get('LayerTree.layerTreeDidChange')?.({ layers: [
            { layerId: `first-${session}`, drawsContent: true, width: 10, height: 10 },
            { layerId: `second-${session}`, drawsContent: true, width: 10, height: 10 },
          ] })
          if (method === 'LayerTree.makeSnapshot') {
            if (params.layerId.startsWith('second') && (alwaysDisappears || session === 1)) throw new Error('No layer matching given id found')
            return { snapshotId: params.layerId }
          }
          if (method === 'LayerTree.snapshotCommandLog') return { commandLog: [{ method: session === 1 ? 'discardedCommand' : 'drawRect' }] }
          if (method === 'LayerTree.profileSnapshot') return { timings: [[0.001]] }
          if (method === 'LayerTree.releaseSnapshot') released.push(params.snapshotId)
          return {}
        },
      }
    } }) } as any
    const metrics = await collectPaintMetrics(page)
    assert.equal(sessions, alwaysDisappears ? 3 : 2)
    assert.equal(detached, sessions)
    assert(released.includes('first-1'))
    if (alwaysDisappears) {
      assert.equal(metrics.available, false)
      assert.match(metrics.reason!, /No layer matching/)
    } else {
      assert.deepEqual(metrics.commands, [{ method: 'drawRect', count: 2, durationMs: 2, timedCount: 2 }])
      assert.equal(metrics.timingsAvailable, true)
    }
  }
})

test('editor job reports combine only complete compatible measurements', async () => {
  const { combine } = await import('../../report/src/combine.ts')
  const editors = [{ id: 'lvce', version: '1' }, { id: 'atom', version: '2' }]
  const reports = editors.map(editor => ({
    protocol: 'query-highlights-two-frames-v1', created: editor.id,
    fixture: { commit: 'abc' }, editors, environment: { platform: 'linux', viewport: benchmarkViewport }, repeats: 1, filenames: ['file.ts'],
    trials: (editor.id === 'atom' ? ['latency', 'profile'] : ['latency', 'profile', 'traffic', 'render', 'paint']).map(mode => ({ editor: editor.id, repeat: 0, mode, filename: 'file.ts', status: 'passed' })),
  }))
  const result = combine([...reports].reverse(), editors)
  assert.equal(result.trials.length, 7)
  assert.deepEqual(result.trials.map((trial: any) => trial.editor), ['lvce', 'lvce', 'lvce', 'lvce', 'lvce', 'atom', 'atom'])
  assert.throws(() => combine(reports.slice(0, 1), editors), /Missing editor/)
  for (const mutation of [
    (data: any[]) => data[0].trials.pop(),
    (data: any[]) => data[0].trials.push(data[0].trials[0]),
    (data: any[]) => { data[0].trials[0].status = 'failed' },
    (data: any[]) => { data[0].fixture.commit = 'different' },
    (data: any[]) => { data[0].editors[0].version = 'different' },
  ]) {
    const data = structuredClone(reports)
    mutation(data)
    assert.throws(() => combine(data, editors))
  }
})
