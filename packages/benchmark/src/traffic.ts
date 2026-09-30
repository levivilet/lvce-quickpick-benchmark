import { installTrafficRuntime, installPortHooks } from './traffic-runtime.ts'
import type { CDPSession } from 'playwright'
import type { launch } from './launch.ts'

type App = Awaited<ReturnType<typeof launch>>
export async function attachTraffic(app: App) {
  const session = await app.page.context().newCDPSession(app.page)
  const contexts = new Map<number, any>()
  let changed = false
  let measuring = false
  session.on('Runtime.executionContextCreated', ({ context }) => { contexts.set(context.id, context); if (measuring) changed = true })
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => { contexts.delete(executionContextId); if (measuring) changed = true })
  const evaluate = async (contextId: number, expression: string) => {
    const result = await session.send('Runtime.evaluate', { contextId, expression, returnByValue: true })
    if (result.exceptionDetails) throw new Error(`Traffic evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
    return result.result.value
  }
  try {
    await session.send('Runtime.enable')
    const { frameTree } = await session.send('Page.getFrameTree')
    const top = [...contexts.values()].filter(context => context.auxData?.frameId === frameTree.frame.id)
    const main = top.find(context => context.auxData?.isDefault)
    if (!main) throw new Error('Missing workbench execution context')
    const ipc: number[] = []
    for (const context of top) if (await evaluate(context.id, 'Boolean(globalThis.__quickpickTraffic?.coverage.ipc)')) ipc.push(context.id)
    if (ipc.length !== 1 || ipc[0] === main.id) throw new Error(`Expected one isolated IPC collector, found ${ipc.length}`)
    await app.page.evaluate(installTrafficRuntime)
    await app.page.evaluate(installPortHooks)
    await discoverTrafficObjects(session, main.id)
    // Verify actual Electron delivery, including binary accounting, before trusting zero.
    const sent = await app.main!.send('Runtime.evaluate', { expression: `(() => {
      const { webContents } = process.getBuiltinModule('module').createRequire(process.cwd()+'/benchmark.cjs')('electron');
      const matches = webContents.getAllWebContents().filter(w => w.getURL() === ${JSON.stringify(app.page.url())});
      if (matches.length !== 1) throw new Error('Ambiguous traffic probe destination');
      matches[0].send('__quickpickTrafficProbe', new Uint8Array([1,2,3,4])); return true;
    })()`, returnByValue: true })
    if (sent.exceptionDetails || sent.result.value !== true) throw new Error('Failed to send IPC coverage probe')
    // Await delivery in the isolated world without introducing additional application IPC.
    const probe = await session.send('Runtime.evaluate', { contextId: ipc[0], expression: `new Promise((resolve,reject) => {
      const deadline=performance.now()+5000;
      const tick=()=>{ const c=globalThis.__quickpickTraffic;
        if(c.probe){resolve(c.probe);return}
        if(performance.now()>deadline){reject(new Error('IPC probe not observed'));return}
        setTimeout(tick,10);
      };setTimeout(tick,10);
    })`, awaitPromise: true, returnByValue: true })
    if (probe.exceptionDetails || probe.result.value?.logicalBytes !== 4 || probe.result.value?.messages !== 1) throw new Error(`IPC coverage probe failed: ${JSON.stringify(probe)}`)
    measuring = true
    return {
      async results() {
        if (changed) throw new Error('Renderer context membership changed during traffic measurement')
        const worlds: any[] = []
        for (const id of [main.id, ...ipc]) worlds.push({ context: contexts.get(id), ...await evaluate(id, '({coverage:globalThis.__quickpickTraffic.coverage,samples:globalThis.__quickpickTraffic.samples})') })
        const samples = worlds[0].samples.map((sample: any, index: number) => {
          const transports: Record<string, any> = {}
          for (const world of worlds) {
            if (world.samples.length !== worlds[0].samples.length) throw new Error('Traffic window mismatch')
            Object.assign(transports, world.samples[index].transports)
          }
          const counts = Object.values(transports)
          if (counts.some(c => c.unsupportedPayloads)) throw new Error('Unsupported payload type: byte measurement unavailable')
          return { start: sample.start, end: sample.end, transports, messages: counts.reduce((n, c) => n + c.messages, 0), logicalBytes: counts.reduce((n, c) => n + c.logicalBytes, 0) }
        })
        if (!worlds[0].coverage.ports && !worlds[0].coverage.workers) throw new Error('No renderer port/worker coverage')
        return { protocol: 'renderer-logical-payload-v1', ipcProbe: 'passed', worlds, samples }
      },
      close: () => session.detach(),
    }
  } catch (error) { await session.detach(); throw error }
}

export async function discoverTrafficObjects(session: CDPSession, contextId: number) {
  // Recover ports/workers whose listeners were registered before debugger attachment.
  for (const [name, transport] of [['MessagePort', 'port'], ['Worker', 'worker']]) {
    const prototype = await session.send('Runtime.evaluate', { contextId, expression: `${name}.prototype`, objectGroup: 'traffic' })
    if (!prototype.result.objectId) throw new Error(`Missing ${name} prototype`)
    const objects = await session.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId, objectGroup: 'traffic' })
    const observed = await session.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId!, functionDeclaration: `function() { for (const object of this) globalThis.__quickpickTraffic.observe(object, ${JSON.stringify(transport)}); }` })
    if (observed.exceptionDetails) throw new Error(`Port discovery failed: ${JSON.stringify(observed.exceptionDetails)}`)
  }
  await session.send('Runtime.releaseObjectGroup', { objectGroup: 'traffic' })
}
