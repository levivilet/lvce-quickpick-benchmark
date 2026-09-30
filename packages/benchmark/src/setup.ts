import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

await mkdir('.tmp/apps', { recursive: true })
const editors = JSON.parse(await readFile('config/editors.lock.json', 'utf8'))
for (const editor of editors) {
  const archive = `.tmp/apps/${editor.archive}`
  if (!existsSync(archive)) {
    const response = await fetch(editor.url, { signal: AbortSignal.timeout(180000) })
    if (!response.ok) throw new Error(`Download ${editor.id}: ${response.status}`)
    await writeFile(archive, Buffer.from(await response.arrayBuffer()))
  }
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (hash !== editor.sha256) throw new Error(`Checksum mismatch: ${editor.id}`)
  await mkdir(`.tmp/apps/${editor.id}`, { recursive: true })
  execFileSync(editor.archive.endsWith('.deb') ? 'dpkg-deb' : 'tar', editor.archive.endsWith('.deb') ? ['-x', archive, `.tmp/apps/${editor.id}`] : ['-xzf', archive, '-C', `.tmp/apps/${editor.id}`])
  console.log(`Verified ${editor.id} ${editor.version}`)
}
if (!existsSync('.tmp/fixture/.git')) execFileSync('git', ['clone', '--depth=1', '--branch', '1.39.0', 'https://github.com/microsoft/vscode.git', '.tmp/fixture'], { stdio: 'inherit' })
const commit = execFileSync('git', ['-C', '.tmp/fixture', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const tag = execFileSync('git', ['-C', '.tmp/fixture', 'rev-parse', '1.39.0^{commit}'], { encoding: 'utf8' }).trim()
if (tag !== commit || execFileSync('git', ['-C', '.tmp/fixture', 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Fixture must be clean at tag 1.39.0')
await writeFile('.tmp/fixture.json', JSON.stringify({ repository: 'microsoft/vscode', tag: '1.39.0', commit }, null, 2))
