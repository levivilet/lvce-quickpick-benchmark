import type { Page } from 'playwright'

interface ContentLayer { layerId: string; drawsContent: boolean; width: number; height: number }
export interface PaintCommandCount { method: string; count: number; durationMs?: number; timedCount?: number }
export interface PaintMetrics {
  available: boolean
  reason?: string
  contentLayerCount?: number
  commands?: PaintCommandCount[]
  timingsAvailable?: boolean
  timingReason?: string
  timingsComplete?: boolean
}

interface CDPSessionLike {
  on(event: string, listener: (payload: any) => void): void
  off(event: string, listener: (payload: any) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}

const profileRepeatCount = 1
const profileTimeoutMs = 10000
// Chromium allocates a 4-byte raster pixel for the entire layer before applying clipRect.
// Bound each replay surface to 64 MiB; retain counts and report missing timing coverage.
const maxProfilePixels = 16 * 1024 * 1024

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

async function collectPaintMetricsAttempt(page: Page, timeoutMs: number, timingTimeoutMs: number): Promise<PaintMetrics> {
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
    const timedCounts = new Map<string, number>()
    const timingReasons = new Set<string>()
    const profiledLayers: Array<{ layer: ContentLayer; methods: string[] }> = []
    let profiledLayerCount = 0
    for (const layer of contentLayers) {
      let snapshotId: string | undefined
      try {
        const snapshot = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId })
        if (typeof snapshot.snapshotId !== 'string') throw new Error('LayerTree.makeSnapshot returned no snapshot id')
        const id: string = snapshot.snapshotId
        snapshotId = id
        snapshots.push(id)
        const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId: id })
        const methods: string[] = commandLog.map((command: { method?: unknown }) => typeof command.method === 'string' && command.method ? command.method : 'unknown')
        for (const method of methods) {
          counts.set(method, (counts.get(method) ?? 0) + 1)
        }
        profiledLayers.push({ layer, methods })
        profiledLayerCount++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Layer does not draw content|Layer does not produce picture/.test(message)) continue
        throw error
      } finally {
        if (snapshotId) {
          await cdp.send('LayerTree.releaseSnapshot', { snapshotId }).catch(() => undefined)
          snapshots.splice(snapshots.indexOf(snapshotId), 1)
        }
      }
    }
    if (!profiledLayerCount) return { available: false, reason: 'No content layer produced a paint snapshot' }
    for (const { layer, methods } of profiledLayers) {
      const { layerId, width, height } = layer
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0 || width * height > maxProfilePixels) {
        timingReasons.add('Some layers exceed the 64 MiB replay surface limit or have unknown dimensions; their timings are unavailable')
        continue
      }
      let snapshotId: string | undefined
      try {
        const snapshot = await cdp.send('LayerTree.makeSnapshot', { layerId })
        if (typeof snapshot.snapshotId !== 'string') throw new Error('LayerTree.makeSnapshot returned no snapshot id')
        const id: string = snapshot.snapshotId
        snapshotId = id
        snapshots.push(id)
        // A recreated snapshot can change even when the number of commands does not.
        const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId: id })
        if (commandLog.length !== methods.length || commandLog.some((command: { method?: unknown }, index: number) => (typeof command.method === 'string' && command.method ? command.method : 'unknown') !== methods[index])) {
          throw new Error('Paint snapshot changed between count and timing capture')
        }
        const stepDurations = await profileSnapshot(cdp, id, methods.length, timingTimeoutMs)
        methods.forEach((method, index) => {
          durationMs.set(method, (durationMs.get(method) ?? 0) + stepDurations[index])
          timedCounts.set(method, (timedCounts.get(method) ?? 0) + 1)
        })
      } catch (error) {
        const timingReason = error instanceof Error ? error.message : String(error)
        timingReasons.add(timingReason)
        profileTimedOut = /Paint Profiler timed out/.test(timingReason)
        if (profileTimedOut) break
      } finally {
        if (snapshotId && !profileTimedOut) {
          await cdp.send('LayerTree.releaseSnapshot', { snapshotId }).catch(() => undefined)
          snapshots.splice(snapshots.indexOf(snapshotId), 1)
        }
      }
    }
    const timingReason = [...timingReasons].join('; ') || undefined
    return {
      available: true,
      contentLayerCount: profiledLayerCount,
      timingsAvailable: !timingReason || timedCounts.size > 0,
      ...(timingReason && timedCounts.size > 0 ? { timingsComplete: false } : {}),
      ...(timingReason ? { timingReason } : {}),
      commands: [...counts].map(([method, count]) => ({ method, count, ...(timedCounts.has(method) ? { durationMs: durationMs.get(method), timedCount: timedCounts.get(method) } : {}) })).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    cdp.off('LayerTree.layerTreeDidChange', layerTreeChanged)
    if (profileTimedOut) {
      // Detaching drops snapshots still owned by this CDP session and abandons the stalled command.
      void cdp.detach().catch(() => {})
    } else {
      await Promise.all(snapshots.map(snapshotId => cdp.send('LayerTree.releaseSnapshot', { snapshotId }).catch(() => undefined)))
      if (domainsEnabled) {
        await Promise.allSettled([cdp.send('DOM.disable'), cdp.send('LayerTree.disable'), cdp.send('Page.disable')])
      }
      await cdp.detach().catch(() => {})
    }
  }
}

export async function collectPaintMetrics(page: Page, timeoutMs = 5000, timingTimeoutMs = profileTimeoutMs): Promise<PaintMetrics> {
  for (let attempt = 0; ; attempt++) {
    const metrics = await collectPaintMetricsAttempt(page, timeoutMs, timingTimeoutMs)
    // A composited layer can disappear between the tree event and makeSnapshot.
    // Discard the incomplete sample and obtain a fresh tree/session, at most twice.
    if (metrics.available || attempt === 2 || !/No layer matching given id found/.test(metrics.reason ?? '')) return metrics
  }
}
