import { writeFile } from 'node:fs/promises'
import { Protocol } from './protocol.ts'
import { TargetSession } from './target-session.ts'
import type { launch } from './launch.ts'
export interface CpuProfile { nodes: { id: number; callFrame: { functionName: string; url: string } }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
const maxNegativeSampleDeltaUs = 1000
export function summarize(profile: CpuProfile) {
  if (!profile.samples?.length || profile.samples.length !== profile.timeDeltas?.length) throw new Error('Missing or inconsistent CPU samples')
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  let activeUs = 0, idleUs = 0, vmUs = 0, discardedSamples = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const frame = nodes.get(profile.samples[index])
    const delta = profile.timeDeltas[index]
    if (!frame || !Number.isFinite(delta) || delta < -maxNegativeSampleDeltaUs) throw new Error('Invalid CPU sample')
    // Chromium can report a tiny negative interval when its sampling clock moves backwards.
    // Exclude that sample from totals instead of letting it subtract time or fail the trial.
    if (delta < 0) { discardedSamples++; continue }
    if (frame.functionName === '(idle)') idleUs += delta
    else if (['(program)', '(garbage collector)', '(root)'].includes(frame.functionName)) vmUs += delta
    else activeUs += delta
  }
  return { javascriptMs: activeUs / 1000, idleMs: idleUs / 1000, vmMs: vmUs / 1000, samples: profile.samples.length - discardedSamples, discardedSamples, durationMs: (profile.endTime - profile.startTime) / 1000 }
}
export function rendererJavaScriptMs(results: { side: string; identity: { targetId?: string }; javascriptMs: number }[], applicationTargetId: string) {
  const profiles = results.filter(result => result.side === 'frontend' && result.identity.targetId === applicationTargetId)
  if (profiles.length !== 1) throw new Error(`Missing or duplicate application renderer profile coverage: ${applicationTargetId}`)
  return profiles[0].javascriptMs
}
interface Session { send(method: string, params?: Record<string, unknown>): Promise<any> }
export async function profileWorkload(app: Awaited<ReturnType<typeof launch>>, output: string, action: () => Promise<unknown>) {
  const root = await app.browser.newBrowserCDPSession()
  const sessions: { session: Session; side: string; identity: any; owned?: Protocol | TargetSession }[] = []
  let actionResult: unknown
  try {
    // Initialize dedicated-worker targets before attaching their profilers.
    const pageSession = await app.page.context().newCDPSession(app.page)
    await pageSession.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    const { targetInfo: applicationTarget } = await pageSession.send('Target.getTargetInfo')
    if (!applicationTarget?.targetId || applicationTarget.type !== 'page') throw new Error('Missing application page target')
    const targets = (await root.send('Target.getTargets')).targetInfos.filter(t => ['page', 'worker', 'shared_worker', 'service_worker', 'iframe'].includes(t.type))
    if (!targets.some(t => t.targetId === applicationTarget.targetId && t.type === 'page')) throw new Error('Missing application page target coverage')
    const isolateIds = new Set<string>()
    for (const target of targets) {
      const { sessionId } = await root.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })
      const session = new TargetSession(root, sessionId)
      const { id } = await session.send('Runtime.getIsolateId')
      if (isolateIds.has(id)) { await session.close(); continue }
      isolateIds.add(id)
      sessions.push({ session, side: 'frontend', identity: { ...target, isolateId: id }, owned: session })
    }
    if (!app.main) throw new Error('Missing main-process inspector')
    const mainMetadata = await app.main.send('Runtime.evaluate', { expression: '({pid:process.pid,argv:process.argv})', returnByValue: true })
    sessions.push({ session: app.main, side: 'backend', identity: { role: 'main', ...mainMetadata.result.value } })
    const utilities = async (): Promise<{ pid: number; file: string; kind: string; alive: boolean }[]> => (await app.main!.send('Runtime.evaluate', { expression: 'globalThis.__benchmarkProcesses.filter(x=>x.alive)', returnByValue: true })).result.value
    const before = await utilities()
    const attachedPids = new Set<number>([mainMetadata.result.value.pid])
    const inaccessible: string[] = []
    for (const url of app.inspectorUrls().slice(1)) {
      let session: Protocol | undefined
      try {
        session = await Protocol.connect(url)
        const { result } = await session.send('Runtime.evaluate', { expression: '({pid:process.pid,argv:process.argv})', returnByValue: true })
        if (!before.some(x => x.pid === result.value.pid) || attachedPids.has(result.value.pid)) { session.close(); continue }
        attachedPids.add(result.value.pid)
        const record = before.find(x => x.pid === result.value.pid)!
        sessions.push({ session, side: 'backend', identity: { role: record.kind === 'fork' ? 'child-process' : 'utility', ...result.value, file: record.file }, owned: session })
      } catch (error) { session?.close(); inaccessible.push(String(error)) }
    }
    const uncovered = before.filter(x => !attachedPids.has(x.pid))
    if ((app.profileCapabilities.requireBackendProcess && !before.length) || uncovered.length) throw new Error(`Missing live backend inspector coverage: ${JSON.stringify({ before, attachedPids: [...attachedPids], inaccessible, uncovered })}`)
    if (app.profileCapabilities.requireRendererWorker && !sessions.some(x => x.identity.type === 'worker')) throw new Error('Missing frontend worker coverage')
    for (const { session } of sessions) { await session.send('Profiler.enable'); await session.send('Profiler.setSamplingInterval', { interval: 1000 }) }
    for (const { session } of sessions) await session.send('Profiler.start')
    actionResult = await action()
    const results = []
    for (const [index, { session, side, identity }] of sessions.entries()) {
      const { profile } = await session.send('Profiler.stop')
      const file = `${output}-${side}-${index}.cpuprofile`
      await writeFile(file, JSON.stringify(profile))
      results.push({ side, identity, file: file.split('/').at(-1), ...summarize(profile) })
    }
    const after = await utilities()
    const targetAfter = (await root.send('Target.getTargets')).targetInfos.filter(t => ['page', 'worker', 'shared_worker', 'service_worker', 'iframe'].includes(t.type))
    if (before.map(x => x.pid).sort().join() !== after.map(x => x.pid).sort().join() || targets.map(x => x.targetId).sort().join() !== targetAfter.map(x => x.targetId).sort().join()) throw new Error(`Profiler process/target membership changed during workload: ${JSON.stringify({before,after,targets,targetAfter})}`)
    await pageSession.detach()
    return { actionResult, results, inaccessible, rendererJavaScriptMs: rendererJavaScriptMs(results, applicationTarget.targetId), frontendMs: results.filter(x => x.side === 'frontend').reduce((sum, x) => sum + x.javascriptMs, 0), backendMs: results.filter(x => x.side === 'backend').reduce((sum, x) => sum + x.javascriptMs, 0) }
  } finally {
    await Promise.allSettled(sessions.map(x => x.owned?.close()))
    await root.detach().catch(() => {})
  }
}
