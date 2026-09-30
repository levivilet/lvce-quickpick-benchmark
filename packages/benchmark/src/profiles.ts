import { writeFile } from 'node:fs/promises'
import { Protocol } from './protocol.ts'
import { TargetSession } from './target-session.ts'
import type { launch } from './launch.ts'
export interface CpuProfile { nodes: { id: number; callFrame: { functionName: string; url: string } }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number }
export function summarize(profile: CpuProfile) {
  if (!profile.samples?.length || profile.samples.length !== profile.timeDeltas?.length) throw new Error('Missing or inconsistent CPU samples')
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]))
  let activeUs = 0, idleUs = 0, vmUs = 0
  for (let index = 0; index < profile.samples.length; index++) {
    const frame = nodes.get(profile.samples[index])
    const delta = profile.timeDeltas[index]
    if (!frame || !Number.isFinite(delta) || delta < 0) throw new Error('Invalid CPU sample')
    if (frame.functionName === '(idle)') idleUs += delta
    else if (['(program)', '(garbage collector)', '(root)'].includes(frame.functionName)) vmUs += delta
    else activeUs += delta
  }
  return { javascriptMs: activeUs / 1000, idleMs: idleUs / 1000, vmMs: vmUs / 1000, samples: profile.samples.length, durationMs: (profile.endTime - profile.startTime) / 1000 }
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
    const targets = (await root.send('Target.getTargets')).targetInfos.filter(t => ['page', 'worker', 'shared_worker', 'service_worker', 'iframe'].includes(t.type))
    if (!targets.some(t => t.type === 'page')) throw new Error('Missing frontend target')
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
    const utilities = async (): Promise<{ pid: number; file: string; alive: boolean }[]> => (await app.main!.send('Runtime.evaluate', { expression: 'globalThis.__benchmarkUtilities.filter(x=>x.alive)', returnByValue: true })).result.value
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
        sessions.push({ session, side: 'backend', identity: { role: 'utility', ...result.value, file: before.find(x => x.pid === result.value.pid)!.file }, owned: session })
      } catch (error) { session?.close(); inaccessible.push(String(error)) }
    }
    if (!before.length || before.some(x => !attachedPids.has(x.pid))) throw new Error(`Missing live utility inspector coverage: ${JSON.stringify({ before, attachedPids: [...attachedPids], inaccessible })}`)
    if (!sessions.some(x => x.identity.type === 'worker') && app.editorId === 'lvce') throw new Error('Missing frontend worker coverage')
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
    return { actionResult, results, inaccessible, frontendMs: results.filter(x => x.side === 'frontend').reduce((sum, x) => sum + x.javascriptMs, 0), backendMs: results.filter(x => x.side === 'backend').reduce((sum, x) => sum + x.javascriptMs, 0) }
  } finally {
    await Promise.allSettled(sessions.map(x => x.owned?.close()))
    await root.detach().catch(() => {})
  }
}
