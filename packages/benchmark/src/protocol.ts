export class Protocol {
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private socket: WebSocket
  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data))
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => this.fail(new Error('Inspector disconnected')))
  }
  static async connect(url: string): Promise<Protocol> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connect timeout')) }, 10000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }, { once: true })
    })
    return new Protocol(socket)
  }
  event(method: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const listener = ({ data }: MessageEvent) => {
        const message = JSON.parse(String(data))
        if (message.method === method) { clearTimeout(timer); this.socket.removeEventListener('message', listener); resolve(message.params) }
      }
      const timer = setTimeout(() => { this.socket.removeEventListener('message', listener); reject(new Error(`Event timeout: ${method}`)) }, 15000)
      this.socket.addEventListener('message', listener)
    })
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  private fail(error: Error): void {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error) }
    this.pending.clear()
  }
  close(): void { this.fail(new Error('Inspector closed')); this.socket.close() }
}
