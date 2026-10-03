import type { Page } from 'playwright'

interface ContentLayer { layerId: string; drawsContent: boolean }
export interface PaintCommandCount { method: string; count: number; durationMs?: number }
export interface PaintMetrics {
  available: boolean
  reason?: string
  contentLayerCount?: number
  commands?: PaintCommandCount[]
  timingsAvailable?: boolean
  timingReason?: string
}

interface CDPSessionLike {
  on(event: string, listener: (payload: any) => void): void
  off(event: string, listener: (payload: any) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}

const profileRepeatCount = 1
const profileTimeoutMs = 10000

function averageStepDurations(timings: unknown, stepCount: number): number[] {
  if (!Array.isArray(timings) || timings.length !== profileRepeatCount) throw new Error('Paint Profiler returned an unexpected number of timing runs')
  const totals = Array.from({ length: stepCount }, () => 0)
  for (const run of timings) {
    if (!Array.isArray(run) || run.length !== stepCount || run.some(duration => typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0)) {
      throw new Error('Paint Profiler timings did not match the command log')
    }
    run.forEach((duration, index) => { totals[index] += duration })
  }
  return totals.map(duration => duration / profileRepeatCount * 1000)
}

async function profileSnapshot(cdp: CDPSessionLike, snapshotId: string, stepCount: number, timeoutMs: number): Promise<number[]> {
  let timer: NodeJS.Timeout | undefined
  try {
    const { timings } = await Promise.race([
      cdp.send('LayerTree.profileSnapshot', { snapshotId, minRepeatCount: profileRepeatCount }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Paint Profiler timed out after ${timeoutMs} ms`)), timeoutMs) }),
    ])
    return averageStepDurations(timings, stepCount)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function collectPaintMetrics(page: Page, timeoutMs = 5000, timingTimeoutMs = profileTimeoutMs): Promise<PaintMetrics> {
  let cdp: CDPSessionLike
  try { cdp = await page.context().newCDPSession(page) as unknown as CDPSessionLike }
  catch (error) { return { available: false, reason: error instanceof Error ? error.message : String(error) } }
  let layers: ContentLayer[] | undefined
  let resolveLayers: (() => void) | undefined
  const layerTreeChanged = (event: { layers?: ContentLayer[] }) => {
    if (!event.layers) return
    layers = event.layers
    resolveLayers?.()
  }
  cdp.on('LayerTree.layerTreeDidChange', layerTreeChanged)
  const snapshots: string[] = []
  let domainsEnabled = false
  let profileTimedOut = false
  try {
    await Promise.all([cdp.send('DOM.enable'), cdp.send('Page.enable')])
    await cdp.send('DOM.getDocument')
    await cdp.send('LayerTree.enable')
    domainsEnabled = true
    if (!layers) {
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          new Promise<void>(resolve => { resolveLayers = resolve }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out waiting for composited layers')), timeoutMs) }),
        ])
      } finally { if (timer) clearTimeout(timer) }
    }
    const contentLayers = layers?.filter(layer => layer.drawsContent) ?? []
    if (!contentLayers.length) return { available: false, reason: 'No content layers in final snapshot' }

    const counts = new Map<string, number>()
    const durationMs = new Map<string, number>()
    let timingReason: string | undefined
    const profiledLayers: Array<{ snapshotId: string; methods: string[] }> = []
    let profiledLayerCount = 0
    for (const layer of contentLayers) {
      try {
        const { snapshotId } = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId })
        snapshots.push(snapshotId)
        const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId })
        const methods: string[] = commandLog.map((command: { method?: unknown }) => typeof command.method === 'string' && command.method ? command.method : 'unknown')
        for (const method of methods) {
          counts.set(method, (counts.get(method) ?? 0) + 1)
        }
        profiledLayers.push({ snapshotId, methods })
        profiledLayerCount++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Layer does not draw content|Layer does not produce picture/.test(message)) continue
        throw error
      }
    }
    if (!profiledLayerCount) return { available: false, reason: 'No content layer produced a paint snapshot' }
    for (const { snapshotId, methods } of profiledLayers) {
      try {
        const stepDurations = await profileSnapshot(cdp, snapshotId, methods.length, timingTimeoutMs)
        methods.forEach((method, index) => durationMs.set(method, (durationMs.get(method) ?? 0) + stepDurations[index]))
      } catch (error) {
        timingReason = error instanceof Error ? error.message : String(error)
        profileTimedOut = /Paint Profiler timed out/.test(timingReason)
        break
      }
    }
    return {
      available: true,
      contentLayerCount: profiledLayerCount,
      timingsAvailable: !timingReason,
      ...(timingReason ? { timingReason } : {}),
      commands: [...counts].map(([method, count]) => ({ method, count, ...(!timingReason ? { durationMs: durationMs.get(method) ?? 0 } : {}) })).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    cdp.off('LayerTree.layerTreeDidChange', layerTreeChanged)
    if (profileTimedOut) {
      // Detaching drops snapshots still owned by this CDP session and abandons the stalled command.
      await cdp.detach().catch(() => {})
    } else {
      await Promise.all(snapshots.map(snapshotId => cdp.send('LayerTree.releaseSnapshot', { snapshotId }).catch(() => undefined)))
      if (domainsEnabled) {
        await Promise.allSettled([cdp.send('DOM.disable'), cdp.send('LayerTree.disable'), cdp.send('Page.disable')])
      }
      await cdp.detach().catch(() => {})
    }
  }
}
