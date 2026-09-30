import type { Page } from 'playwright'
export interface Selectors { input: string; row: string; label: string; highlight: string; busy: string }
export const adapters: Record<string, Selectors> = {
  lvce: { input: 'input[name="QuickPickInput"]', row: '.QuickPickItem', label: '.QuickPickItemLabel', highlight: '.QuickPickHighlight', busy: '[role=progressbar], [aria-busy=true]' },
  vscode: { input: '.quick-input-widget input', row: '.quick-input-list .monaco-list-row', label: '.label-name', highlight: '.label-name .highlight', busy: '.quick-input-widget .monaco-progress-container.active' },
  theia: { input: '.quick-input-widget input', row: '.quick-input-list .monaco-list-row', label: '.label-name', highlight: '.label-name .highlight', busy: '.quick-input-widget .monaco-progress-container.active' },
}
// Runs wholly in the renderer: trusted keydown to query-qualified DOM + two frames.
// The query is checked again on each frame, so stale/unchanged filenames cannot end a sample.
export async function arm(page: Page, selectors: Selectors, query: string, timeoutMs = 15000): Promise<void> {
  await page.evaluate(({ selectors, query, timeoutMs }) => {
    const host = window as unknown as { quickpickSample: Promise<unknown> }
    host.quickpickSample = new Promise((resolve, reject) => {
      let started: number | undefined
      let frame = 0
      let done = false
      let consecutive = 0
      const clean = () => { done = true; clearTimeout(timer); cancelAnimationFrame(frame); document.removeEventListener('keydown', keydown, true) }
      const timer = setTimeout(() => {
        const input = document.querySelector<HTMLInputElement>(selectors.input)
        const state = { started: started !== undefined, value: input?.value, visible: Boolean(input?.getClientRects().length), focused: document.activeElement === input, rows: document.querySelectorAll(selectors.row).length, busy: [...document.querySelectorAll(selectors.busy)].some(el => Boolean(el.getClientRects().length)) }
        clean()
        reject(new Error(`Quickpick update timeout: ${query} (${JSON.stringify(state)})`))
      }, timeoutMs)
      const keydown = (event: KeyboardEvent) => {
        if (!event.isTrusted || event.key === 'Control') return
        if (started === undefined) {
          started = performance.now()
          const traffic = (window as any).__quickpickTraffic
          if (traffic) { traffic.begin(); document.dispatchEvent(new Event('__quickpickTrafficBegin')) }
        }
      }
      document.addEventListener('keydown', keydown, true)
      const tick = () => {
        if (done) return
        const input = document.querySelector<HTMLInputElement>(selectors.input)
        const visible = (el: Element) => Boolean(el.getClientRects().length)
        const rows = [...document.querySelectorAll(selectors.row)].filter(visible)
        const busy = [...document.querySelectorAll(selectors.busy)].some(visible)
        const matched = rows.some(row => [...row.querySelectorAll(selectors.highlight)].map(x => x.textContent).join('').toLowerCase() === query.toLowerCase())
        const ready = started !== undefined && input && visible(input) && document.activeElement === input && input.value === query && !busy && (query === '' || matched)
        consecutive = ready ? consecutive + 1 : 0
        if (consecutive >= 2) {
          const traffic = (window as any).__quickpickTraffic
          if (traffic) { traffic.end(); document.dispatchEvent(new Event('__quickpickTrafficEnd')) }
          clean()
          resolve({ query, milliseconds: performance.now() - started!, rows: rows.map(row => ({ label: row.querySelector(selectors.label)?.textContent, text: row.textContent, highlights: [...row.querySelectorAll(selectors.highlight)].map(x => x.textContent).join('') })) })
          return
        }
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    })
    // Retrieval happens after key dispatch; retain rejection without an unhandled page error.
    host.quickpickSample.catch(() => {})
  }, { selectors, query, timeoutMs })
}
export interface Sample { query: string; milliseconds: number; rows: { label: string; text: string; highlights: string }[] }
export const collect = (page: Page): Promise<Sample> => page.evaluate(() => (window as any).quickpickSample)
export async function search(page: Page, editor: string, filename: string): Promise<Sample[]> {
  const selectors = adapters[editor]
  const input = page.locator(selectors.input)
  if (await input.isVisible()) {
    await page.keyboard.press('Escape')
    await input.waitFor({ state: 'hidden' })
  }
  if (editor === 'theia') {
    await page.bringToFront()
    await page.locator('.theia-ApplicationShell').click({ position: { x: 20, y: 20 } })
  }
  await arm(page, selectors, '')
  await page.keyboard.press('Control+p')
  await input.waitFor({ state: 'visible' })
  const samples = [await collect(page)]
  for (let index = 0; index < filename.length; index++) {
    await arm(page, selectors, filename.slice(0, index + 1))
    await page.keyboard.press(filename[index])
    samples.push(await collect(page))
  }
  if (!samples.at(-1)!.rows.some(row => row.label === filename)) throw new Error(`Expected fixture file missing: ${filename}`)
  return samples
}
