// This function is serialized into the renderer and Electron's isolated preload world.
export function installTrafficRuntime() {
  const host = globalThis as any
  if (host.__quickpickTraffic) throw new Error('Traffic collector already installed')
  const encoder = new TextEncoder()
  const size = (value: any, seen = new Set<any>()): number => {
    if (value == null) return 0
    switch (typeof value) {
      case 'string': return encoder.encode(value).byteLength
      case 'number': return 8
      case 'boolean': return 1
      case 'bigint': return encoder.encode(String(value)).byteLength
      case 'undefined': return 0
      case 'object': break
      default: throw new Error(`Unsupported payload: ${typeof value}`)
    }
    if (seen.has(value)) return 0
    seen.add(value)
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (value instanceof ArrayBuffer) return value.byteLength
    if (value instanceof Date) return 8
    if (value instanceof Map) return [...value].reduce((n, [k, v]) => n + size(k, seen) + size(v, seen), 0)
    if (value instanceof Set) return [...value].reduce((n, v) => n + size(v, seen), 0)
    if (Array.isArray(value)) return value.reduce((n, v) => n + size(v, seen), 0)
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) return Object.entries(value).reduce((n, [k, v]) => n + size(k, seen) + size(v, seen), 0)
    throw new Error(`Unsupported payload object: ${Object.prototype.toString.call(value)}`)
  }
  let current: any = null
  const samples: any[] = []
  const observed = new WeakSet<object>()
  const events = new WeakSet<object>()
  const coverage = { ports: 0, workers: 0, ipc: false }
  const record = (transport: string, data: any) => {
    if (!current) return
    const counter = current.transports[transport] ??= { messages: 0, logicalBytes: 0, unsupportedPayloads: 0 }
    counter.messages++
    try { counter.logicalBytes += size(data) } catch { counter.unsupportedPayloads++ }
  }
  const observe = (target: any, transport: 'port' | 'worker') => {
    if (observed.has(target)) return
    observed.add(target)
    coverage[transport === 'port' ? 'ports' : 'workers']++
    // Do not start paused ports; merely observe messages already delivered to the app.
    EventTarget.prototype.addEventListener.call(target, 'message', (rawEvent: Event) => {
      const event = rawEvent as MessageEvent
      receive(event, event.data, transport)
    }, true)
  }
  const receive = (event: MessageEvent, data: any, transport: 'port' | 'worker') => {
    if (events.has(event)) return
    events.add(event)
    record(transport, data)
    for (const port of event.ports) observe(port, 'port')
  }
  const begin = () => {
    if (current) throw new Error('Overlapping traffic windows')
    current = { start: performance.now(), transports: {} }
  }
  const end = () => {
    if (!current) throw new Error('Missing traffic window')
    current.end = performance.now()
    samples.push(current)
    current = null
  }
  host.__quickpickTraffic = { size, record, observe, receive, coverage, samples, begin, end }
}

export function installPortHooks() {
  const collector = (globalThis as any).__quickpickTraffic
  // Existing handlers precede newly installed observers. Account at first data access
  // before they can mutate or detach a received buffer; the observer is the fallback.
  const data = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!
  Object.defineProperty(MessageEvent.prototype, 'data', { ...data, get() {
    const value = data.get!.call(this)
    const target = this.currentTarget
    if (target instanceof MessagePort || target instanceof Worker) {
      const transport = target instanceof MessagePort ? 'port' : 'worker'
      collector.observe(target, transport)
      collector.receive(this, value, transport)
    }
    return value
  } })
  for (const [type, transport] of [[MessagePort, 'port'], [Worker, 'worker']] as const) {
    const original = type.prototype.addEventListener
    type.prototype.addEventListener = function (...args: any[]) {
      if (args[0] === 'message') collector.observe(this, transport)
      return Reflect.apply(original, this, args)
    }
    const descriptor = Object.getOwnPropertyDescriptor(type.prototype, 'onmessage')!
    Object.defineProperty(type.prototype, 'onmessage', { ...descriptor, set(value) { collector.observe(this, transport); descriptor.set!.call(this, value) } })
  }
  window.addEventListener('message', event => {
    // Window messages often forward an IPC notification inside the same renderer.
    // Only discover transferred ports here; do not count the forwarded notification twice.
    for (const port of event.ports) collector.observe(port, 'port')
  }, true)
}

export const trafficPreload = `(${installTrafficRuntime.toString()})();
(() => {
  const c = globalThis.__quickpickTraffic;
  const { ipcRenderer } = require('electron');
  const emit = ipcRenderer.emit;
  ipcRenderer.emit = function(channel, event, ...args) {
    if (event?.sender !== this) return Reflect.apply(emit, this, [channel, event, ...args]);
    if (channel === '__quickpickTrafficProbe') c.probe = { messages: (c.probe?.messages ?? 0) + 1, logicalBytes: c.size(args) };
    else c.record('electron-event', args);
    return Reflect.apply(emit, this, [channel, event, ...args]);
  };
  const invoke = ipcRenderer.invoke;
  ipcRenderer.invoke = async function(...args) {
    try { const result = await Reflect.apply(invoke, this, args); c.record('electron-invoke-reply', result); return result }
    catch(error) { c.record('electron-invoke-error', String(error)); throw error }
  };
  c.coverage.ipc = true;
  document.addEventListener('__quickpickTrafficBegin', c.begin);
  document.addEventListener('__quickpickTrafficEnd', c.end);
})();`
