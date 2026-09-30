import { WebSocket, WebSocketServer } from 'ws'

// Electron 9 implements the CDP target/page commands used by Playwright, but not
// Browser.setDownloadBehavior. The benchmark never downloads from the editor.
export async function createLegacyCdpProxy(upstreamUrl: string) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Legacy CDP proxy did not bind a TCP port')
  const clients = new Set<WebSocket>()
  server.on('connection', client => {
    clients.add(client)
    const upstream = new WebSocket(upstreamUrl)
    const queued: string[] = []
    client.on('message', data => {
      let message: { id?: number; method?: string }
      try { message = JSON.parse(data.toString()) } catch { client.close(1002, 'Invalid CDP message'); return }
      if (message.method === 'Browser.setDownloadBehavior' && message.id !== undefined) {
        client.send(JSON.stringify({ id: message.id, result: {} }))
        return
      }
      const serialized = JSON.stringify(message)
      if (upstream.readyState === WebSocket.OPEN) upstream.send(serialized)
      else queued.push(serialized)
    })
    upstream.on('open', () => { for (const message of queued) upstream.send(message); queued.length = 0 })
    upstream.on('message', (data, isBinary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary }) })
    upstream.on('error', () => client.close(1011, 'Editor CDP connection failed'))
    client.on('close', () => { clients.delete(client); upstream.close() })
    client.on('error', () => { clients.delete(client); upstream.close() })
  })
  return {
    endpoint: `ws://127.0.0.1:${address.port}/`,
    close: async () => {
      for (const client of clients) client.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
