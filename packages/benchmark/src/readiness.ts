import { setTimeout as delay } from 'node:timers/promises'
import type { Browser } from 'playwright'
// VS Code lazily starts its TextMate worker after the first quickpick preview.
// Require that observed startup work before freezing profiler membership.
export async function settleTargets(browser: Browser, editor: string) {
  const session = await browser.newBrowserCDPSession()
  const start = performance.now()
  let previous = '', since = start
  let observed: string[] = []
  const required = editor === 'vscode' ? ['TextMateWorker', 'editorWorkerService'] : editor === 'cursor' ? ['TextMateWorker'] : editor === 'theia' ? ['editorWorkerService'] : []
  try {
    while (performance.now() - start < 30000) {
      const { targetInfos } = await session.send('Target.getTargets')
      const targets = targetInfos.filter(x => ['page', 'worker', 'shared_worker', 'service_worker', 'iframe'].includes(x.type))
      observed = targets.map(target => target.title)
      const signature = targets.map(x => x.targetId).sort().join()
      if (signature !== previous) { previous = signature; since = performance.now() }
      const ready = required.every(title => targets.some(x => x.title === title))
      if (ready && performance.now() - since >= 500) return { milliseconds: performance.now() - start, targets }
      await delay(100)
    }
    throw new Error(`Editor workers did not finish initialization: ${JSON.stringify({ editor, required, observed })}`)
  } finally { await session.detach() }
}
