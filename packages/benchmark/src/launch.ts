import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser } from 'playwright'
import { Protocol } from './protocol.ts'

export interface Editor { id: string; name: string; version: string; binary: string }
export const utilityInstrumentation = `(()=>{
  const electron=process.getBuiltinModule('module').createRequire(process.cwd()+'/benchmark.cjs')('electron');
  globalThis.__benchmarkElectron=electron;
  const original=electron.utilityProcess.fork;
  globalThis.__benchmarkUtilities=[];
  electron.utilityProcess.fork=function(file,args,options={}){
    const child=original.call(this,file,args,{...options,execArgv:[...(options.execArgv||[]).filter(x=>!x.startsWith('--inspect')),'--inspect=0']});
    const record={pid:0,file,alive:true};
    child.on('spawn',()=>{record.pid=child.pid;globalThis.__benchmarkUtilities.push(record)});
    child.on('exit',()=>record.alive=false);
    child.stderr?.on('data',d=>process.stderr.write(d));return child;
  };return true;
})()`

export async function launch(editor: Editor, profile: boolean, logPath: string, startupTimeout = 30000) {
  const root = await mkdtemp(`${tmpdir()}/quickpick-benchmark-${editor.id}-`)
  const env = { ...process.env, VSCODE_CLI: '1' }
  for (const name of ['CONFIG', 'DATA', 'CACHE', 'STATE']) {
    const path = `${root}/${name}`
    ;(env as NodeJS.ProcessEnv)[`XDG_${name}_HOME`] = path
    await mkdir(path)
  }
  await mkdir(`${root}/profile/User`, { recursive: true })
  await writeFile(`${root}/profile/User/settings.json`, JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false }))
  const child = spawn(resolve(`.tmp/apps/${editor.id}/${editor.binary}`), ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', ...(profile ? ['--inspect-brk=0'] : []), '--user-data-dir', `${root}/profile`, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', resolve('.tmp/fixture')], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let spawnError: Error | undefined
  child.on('error', error => { spawnError = error })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  let main: Protocol | undefined
  let browser: Browser | undefined
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    process.off('SIGINT', interrupted)
    process.off('SIGTERM', interrupted)
    main?.close()
    // Kill only the dedicated process group, including utility descendants.
    const exited = child.exitCode !== null || child.signalCode !== null || spawnError ? Promise.resolve() : new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    if (child.pid) { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
    await exited
    await browser?.close().catch(() => {})
    try { await writeFile(logPath, output) } finally { await rm(root, { recursive: true, force: true }) }
  }
  const interrupted = () => { void close().finally(() => process.exit(130)) }
  process.once('SIGINT', interrupted)
  process.once('SIGTERM', interrupted)
  const wait = async (pattern: RegExp) => {
    const deadline = Date.now() + startupTimeout
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Editor exited during startup: ${child.exitCode}/${child.signalCode}`)
      const match = output.match(pattern)
      if (match) return match[1]
      await delay(50)
    }
    throw new Error(`Editor startup timeout: ${pattern}`)
  }
  try {
    if (profile) {
      main = await Protocol.connect(await wait(/Debugger listening on (ws:\/\/[^\s]+)/))
      await main.send('Debugger.enable')
      const paused = main.event('Debugger.paused')
      await main.send('Runtime.runIfWaitingForDebugger')
      await paused
      const injected = await main.send('Runtime.evaluate', { expression: utilityInstrumentation, returnByValue: true })
      if (injected.exceptionDetails || injected.result.value !== true) throw new Error(`Inspector instrumentation failed: ${JSON.stringify(injected)}`)
      await main.send('Debugger.resume')
      await main.send('Debugger.disable')
    }
    browser = await chromium.connectOverCDP(await wait(/DevTools listening on (ws:\/\/[^\s]+)/), { timeout: 30000 })
    const deadline = Date.now() + startupTimeout
    while (!browser.contexts()[0]?.pages().some(page => page.url() !== 'about:blank') && Date.now() < deadline) await delay(100)
    const page = browser.contexts()[0]?.pages().find(page => page.url() !== 'about:blank')
    if (!page) throw new Error('No workbench page')
    page.setDefaultTimeout(20000)
    await page.locator(editor.id === 'lvce' ? '[role=tree]' : '.monaco-workbench').first().waitFor()
    return { root, editorId: editor.id, browser, page, main, close, inspectorUrls: () => [...new Set([...output.matchAll(/Debugger listening on (ws:\/\/[^\s]+)/g)].map(match => match[1]))] }
  } catch (error) { await close(); throw error }
}
