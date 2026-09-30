import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { arm, collect, adapters } from '../src/adapters.ts'
import { summarize } from '../src/profiles.ts'
import { render, statistics } from '../../report/src/render.ts'
import { launch } from '../src/launch.ts'
import { summarizeRenderingTrace } from '../src/rendering.ts'
import { readdir, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const profile = { startTime: 0, endTime: 6000, nodes: [{ id: 1, callFrame: { functionName: 'filter', url: 'app.js' } }, { id: 2, callFrame: { functionName: '(idle)', url: '' } }, { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } }], samples: [1, 2, 3], timeDeltas: [1000, 2000, 3000] }
test('profile accounting excludes idle and VM samples and rejects incomplete data', () => {
  assert.deepEqual(summarize(profile), { javascriptMs: 1, idleMs: 2, vmMs: 3, samples: 3, durationMs: 6 })
  assert.throws(() => summarize({ ...profile, timeDeltas: [] }))
  assert.throws(() => summarize({ ...profile, samples: [99, 2, 3] }))
  assert.throws(() => summarize({ ...profile, samples: [], timeDeltas: [] }))
})
test('statistics and report preserve unavailable data and escape external labels', () => {
  assert.equal(statistics([4, 1, 2, 3]).median, 2.5)
  assert.equal(statistics([4, 1, 2, 3]).p95, 4)
  assert.throws(() => statistics([NaN]))
  const html = render({ created: 'today', editors: [{ id: 'lvce', name: '<script>x</script>', version: '1' }], trials: [], repeats: 1, fixture: { commit: 'abc' } })
  assert(html.includes('Unavailable'))
  assert(!html.includes('<script>x</script>'))
  assert(html.includes('&lt;script&gt;'))
  assert(html.includes('raw/results.json'))
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
test('startup failure and timeout dispose the isolated profile and child process group', async () => {
  const before = (await readdir(tmpdir())).filter(x => x.startsWith('quickpick-benchmark-test-cleanup-')).sort()
  await mkdir('.tmp/apps/test-cleanup', { recursive: true })
  await writeFile('.tmp/apps/test-cleanup/sleep.sh', '#!/bin/sh\nsleep 60 &\nwait\n', { mode: 0o755 })
  try {
    await assert.rejects(launch({ id: 'test-cleanup', name: 'test', version: '0', binary: 'missing' }, false, '.tmp/missing.log', 200), /ENOENT/)
    await assert.rejects(launch({ id: 'test-cleanup', name: 'test', version: '0', binary: 'sleep.sh' }, false, '.tmp/timeout.log', 200), /timeout/)
    assert.deepEqual((await readdir(tmpdir())).filter(x => x.startsWith('quickpick-benchmark-test-cleanup-')).sort(), before)
  } finally { await rm('.tmp/apps/test-cleanup', { recursive: true, force: true }) }
})
