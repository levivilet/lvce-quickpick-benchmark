import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { installTrafficRuntime, installPortHooks, trafficPreload } from '../src/traffic-runtime.ts'
import { discoverTrafficObjects } from '../src/traffic.ts'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'

test('logical bytes handle Unicode, binary slices, shared references and cycles; unsupported values stay unavailable', () => {
  const context: any = { TextEncoder, performance }
  runInNewContext(`(${installTrafficRuntime.toString()})();
    const c=globalThis.__quickpickTraffic;
    const binary=new Uint8Array([1,2,3,4]).subarray(1,3);
    const shared={x:'é'}; const cycle={a:shared,b:shared,bin:binary}; cycle.self=cycle;
    globalThis.bytes=c.size(cycle);
    c.record('port','outside'); c.begin(); c.record('port',binary); c.record('port',/unsupported/); c.end(); c.record('port','outside');
  `, context)
  assert.equal(context.bytes, 14) // a+b+bin+self keys (9), x+é (3), view (2)
  const samples = context.__quickpickTraffic.samples
  assert.equal(samples.length, 1)
  assert.equal(samples[0].transports.port.messages, 2)
  assert.equal(samples[0].transports.port.logicalBytes, 2)
  assert.equal(samples[0].transports.port.unsupportedPayloads, 1)
})

test('Electron preload counts each delivery once regardless of listeners, and invoke replies on completion', async () => {
  const ipc: any = new EventEmitter()
  ipc.invoke = async () => 'é'
  let delivered = 0
  ipc.on('test', () => delivered++)
  ipc.on('test', () => delivered++)
  const doc = new EventTarget()
  const context: any = { TextEncoder, performance, document: doc, require: () => ({ ipcRenderer: ipc }) }
  runInNewContext(trafficPreload, context)
  doc.dispatchEvent(new Event('__quickpickTrafficBegin'))
  ipc.emit('test', { sender: ipc }, 'abc')
  assert.equal(await ipc.invoke('test'), 'é')
  doc.dispatchEvent(new Event('__quickpickTrafficEnd'))
  ipc.emit('test', { sender: ipc }, 'outside')
  assert.equal(delivered, 4)
  const transports = context.__quickpickTraffic.samples[0].transports
  assert.equal(transports['electron-event'].messages, 1)
  assert.equal(transports['electron-event'].logicalBytes, 3)
  assert.equal(transports['electron-invoke-reply'].logicalBytes, 2)
})

test('real ports count one event with multiple listeners, preserve paused ports and track transferred ports', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await page.evaluate(installTrafficRuntime)
    await page.evaluate(installPortHooks)
    const result = await page.evaluate(async () => {
      const c = (globalThis as any).__quickpickTraffic
      const channel = new MessageChannel()
      let deliveries = 0
      channel.port1.addEventListener('message', () => deliveries++)
      channel.port1.addEventListener('message', () => deliveries++)
      c.observe(channel.port1, 'port') // repeated discovery must not add another observer
      channel.port2.postMessage('outside')
      await new Promise(resolve => setTimeout(resolve, 30))
      const paused = deliveries
      channel.port1.start()
      await new Promise(resolve => channel.port1.addEventListener('message', resolve, { once: true }))
      c.begin()
      const received = new Promise(resolve => channel.port1.addEventListener('message', resolve, { once: true }))
      const bytes = new Uint8Array([1, 2, 3, 4])
      channel.port2.postMessage(bytes, [bytes.buffer])
      await received
      const next = new MessageChannel()
      const transferred = new Promise<MessageEvent>(resolve => channel.port1.addEventListener('message', resolve, { once: true }))
      channel.port2.postMessage('é', [next.port1])
      const event = await transferred
      const port = event.ports[0]
      const nested = new Promise(resolve => { port.onmessage = resolve })
      next.port2.postMessage('ok')
      await nested
      c.end()
      channel.port1.close(); channel.port2.close(); port.close(); next.port2.close()
      return { paused, samples: c.samples }
    })
    assert.equal(result.paused, 0)
    assert.equal(result.samples[0].transports.port.messages, 3)
    assert.equal(result.samples[0].transports.port.logicalBytes, 8)
  } finally { await browser.close() }
})


test('debugger discovery recovers ports with handlers installed before attachment', { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN })
  try {
    const page = await browser.newPage()
    await page.evaluate(() => {
      const channel = new MessageChannel()
      ;(globalThis as any).existingReceived = new Promise(resolve => { channel.port1.onmessage = event => {
        // Detach immediately in a handler installed before the collector.
        const bytes = event.data
        structuredClone(bytes, { transfer: [bytes.buffer] })
        resolve(null)
      } })
      ;(globalThis as any).existingChannel = channel
    })
    const session = await page.context().newCDPSession(page)
    let contextId = 0
    session.on('Runtime.executionContextCreated', ({ context }) => { if (context.auxData?.isDefault) contextId = context.id })
    await session.send('Runtime.enable')
    await page.evaluate(installTrafficRuntime)
    await page.evaluate(installPortHooks)
    await discoverTrafficObjects(session, contextId)
    const result = await page.evaluate(async () => {
      const c = (globalThis as any).__quickpickTraffic
      const channel = (globalThis as any).existingChannel
      c.begin()
      const received = (globalThis as any).existingReceived
      channel.port2.postMessage(new Uint8Array(9))
      await received
      await new Promise(resolve => setTimeout(resolve, 0))
      c.end()
      channel.port1.close(); channel.port2.close()
      return c.samples
    })
    assert.equal(result[0].transports.port.messages, 1)
    assert.equal(result[0].transports.port.logicalBytes, 9)
    await session.detach()
  } finally { await browser.close() }
})
