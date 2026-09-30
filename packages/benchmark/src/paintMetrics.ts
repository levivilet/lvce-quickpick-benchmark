import type { Page } from 'playwright'

interface ContentLayer { layerId: string; drawsContent: boolean }
export interface PaintCommandCount { method: string; count: number }
export interface PaintMetrics {
  available: boolean
  reason?: string
  contentLayerCount?: number
  commands?: PaintCommandCount[]
}

interface CDPSessionLike {
  on(event: string, listener: (payload: any) => void): void
  off(event: string, listener: (payload: any) => void): void
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}

export async function collectPaintMetrics(page: Page, timeoutMs = 5000): Promise<PaintMetrics> {
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
    let profiledLayerCount = 0
    for (const layer of contentLayers) {
      try {
        const { snapshotId } = await cdp.send('LayerTree.makeSnapshot', { layerId: layer.layerId })
        snapshots.push(snapshotId)
        const { commandLog } = await cdp.send('LayerTree.snapshotCommandLog', { snapshotId })
        for (const command of commandLog) {
          const method = typeof command.method === 'string' && command.method ? command.method : 'unknown'
          counts.set(method, (counts.get(method) ?? 0) + 1)
        }
        profiledLayerCount++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/Layer does not draw content|Layer does not produce picture/.test(message)) continue
        throw error
      }
    }
    if (!profiledLayerCount) return { available: false, reason: 'No content layer produced a paint snapshot' }
    return {
      available: true,
      contentLayerCount: profiledLayerCount,
      commands: [...counts].map(([method, count]) => ({ method, count })).sort((a, b) => b.count - a.count || a.method.localeCompare(b.method)),
    }
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    await Promise.all(snapshots.map(snapshotId => cdp.send('LayerTree.releaseSnapshot', { snapshotId }).catch(() => undefined)))
    cdp.off('LayerTree.layerTreeDidChange', layerTreeChanged)
    if (domainsEnabled) {
      await Promise.allSettled([cdp.send('DOM.disable'), cdp.send('LayerTree.disable'), cdp.send('Page.disable')])
    }
    await cdp.detach().catch(() => {})
  }
}
