// Non-flattened target sessions let Playwright's browser CDP session reach worker isolates.
import type { CDPSession } from 'playwright'

interface CdpMessage {
  id: number
  result?: unknown
  error?: unknown
}

interface PendingRequest {
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
  timer: NodeJS.Timeout
}

export class TargetSession {
  private readonly root: CDPSession
  private readonly sessionId: string
  private nextId = 0
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listener: (event: { sessionId: string; message: string }) => void

  constructor(root: CDPSession, sessionId: string) {
    this.root = root
    this.sessionId = sessionId
    this.nextId = 0
    this.pending = new Map()
    this.listener = ({ sessionId, message }) => {
      if (sessionId !== this.sessionId) return
      const data = JSON.parse(message) as CdpMessage
      const pending = this.pending.get(data.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(data.id)
      if (data.error) pending.reject(new Error(JSON.stringify(data.error)))
      else pending.resolve(data.result)
    }
    root.on('Target.receivedMessageFromTarget', this.listener)
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.root.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) }).catch((error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error)
      })
    })
  }
  async close() {
    this.root.off('Target.receivedMessageFromTarget', this.listener)
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('CDP session closed')) }
    this.pending.clear()
    await this.root.send('Target.detachFromTarget', { sessionId: this.sessionId })
  }
}
