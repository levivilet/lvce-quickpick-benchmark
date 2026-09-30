import { writeFile } from 'node:fs/promises'
import type { CDPSession } from 'playwright'
import type { launch } from './launch.ts'

interface TraceEvent {
  name?: string
  ph?: string
  ts?: number
  dur?: number
  args?: { data?: { frame?: string }; beginData?: { frame?: string } }
}
interface Trace { traceEvents?: TraceEvent[] }

export interface RenderingMetrics {
  styleRecalculationCount: number
  styleRecalculationMs: number
  paintEventCount: number
  paintMs: number
}

export function summarizeRenderingTrace(trace: Trace, frameId: string): RenderingMetrics {
  if (!frameId) throw new Error('Missing main-frame identity for rendering trace')
  const events = trace.traceEvents
  if (!Array.isArray(events)) throw new Error('Chromium rendering trace has no events')
  const isMeasuredEvent = (event: TraceEvent, names: string[]) =>
    names.includes(event.name ?? '') && event.ph === 'X' && (event.args?.data?.frame ?? event.args?.beginData?.frame) === frameId &&
    Number.isFinite(event.ts) && Number.isFinite(event.dur) && event.dur! >= 0
  const styles = events.filter(event => isMeasuredEvent(event, ['UpdateLayoutTree']))
  const paints = events.filter(event => isMeasuredEvent(event, ['Paint']))
  if (!styles.length) throw new Error(`No main-frame style recalculation events for frame ${frameId}`)
  if (!paints.length) throw new Error(`No main-frame Paint events for frame ${frameId}`)
  return {
    styleRecalculationCount: styles.length,
    styleRecalculationMs: styles.reduce((total, event) => total + event.dur!, 0) / 1_000,
    paintEventCount: paints.length,
    paintMs: paints.reduce((total, event) => total + event.dur!, 0) / 1_000,
  }
}

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = 30_000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

async function stopTrace(session: CDPSession): Promise<string> {
  let stream = ''
  let resolveCompletion!: () => void
  let rejectCompletion!: (error: Error) => void
  const onComplete = (event: { stream?: string }) => {
    clearTimeout(timer)
    stream = event.stream ?? ''
    resolveCompletion()
  }
  const completed = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  const timer = setTimeout(() => {
    session.off('Tracing.tracingComplete', onComplete)
    rejectCompletion(new Error('Chromium trace completion timed out'))
  }, 30_000)
  session.once('Tracing.tracingComplete', onComplete)
  try {
    await session.send('Tracing.end')
    await completed
  } catch (error) {
    clearTimeout(timer)
    session.off('Tracing.tracingComplete', onComplete)
    throw error
  }
  if (!stream) throw new Error('Chromium did not return a rendering trace stream')
  let source = ''
  try {
    let eof = false
    while (!eof) {
      const result = await withTimeout(session.send('IO.read', { handle: stream }), 'Chromium trace stream read') as { data?: string; eof?: boolean }
      source += result.data ?? ''
      eof = Boolean(result.eof)
    }
    return source
  } finally {
    await session.send('IO.close', { handle: stream }).catch(() => undefined)
  }
}

export async function measureRenderingWorkload(
  app: Awaited<ReturnType<typeof launch>>,
  tracePath: string,
  action: () => Promise<unknown>,
): Promise<RenderingMetrics & { trace: string }> {
  const session = await app.page.context().newCDPSession(app.page)
  let tracing = false
  try {
    const { frameTree } = await session.send('Page.getFrameTree')
    const frameId = frameTree?.frame?.id
    if (!frameId) throw new Error('Could not identify quickpick main frame')
    await session.send('Tracing.start', { categories: 'devtools.timeline', transferMode: 'ReturnAsStream' })
    tracing = true
    let actionError: unknown
    try { await action() } catch (error) { actionError = error }
    const source = await stopTrace(session)
    tracing = false
    await writeFile(tracePath, source)
    if (actionError) throw actionError
    return { ...summarizeRenderingTrace(JSON.parse(source) as Trace, frameId), trace: tracePath.split('/').at(-1)! }
  } finally {
    if (tracing) await stopTrace(session).catch(() => undefined)
    await session.detach().catch(() => undefined)
  }
}
