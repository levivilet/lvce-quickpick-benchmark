import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, type Browser } from 'playwright'
import { Protocol } from './protocol.ts'
import { trafficPreload } from './traffic-runtime.ts'
import { prepareCursorProfile } from './cursor-profile.ts'

export interface Editor { id: string; name: string; version: string; binary: string }
export const utilityInstrumentation = `(()=>{
  const electron=process.getBuiltinModule('module').createRequire(process.cwd()+'/benchmark.cjs')('electron');
  globalThis.__benchmarkElectron=electron;
  globalThis.__benchmarkProcesses=[];
  globalThis.__benchmarkUtilities=globalThis.__benchmarkProcesses;
  const instrument=(original,kind)=>function(file,args,options={}){
    if(!Array.isArray(args)){options=args||{};args=undefined}
    const child=original.call(this,file,args,{...options,execArgv:[...(options.execArgv||process.execArgv).filter(x=>!x.startsWith('--inspect')),'--inspect=0']});
    const record={pid:0,file,kind,alive:true};
    child.on('spawn',()=>{record.pid=child.pid;globalThis.__benchmarkProcesses.push(record)});
    child.on('exit',()=>record.alive=false);
    child.stderr?.on('data',d=>process.stderr.write(d));return child;
  };
  electron.utilityProcess.fork=instrument(electron.utilityProcess.fork,'utility');
  if(process.versions.electron.startsWith('42.')){
    const childProcess=process.getBuiltinModule('node:child_process');
    childProcess.fork=instrument(childProcess.fork,'fork');
  }
  return true;
})()`

async function descendantsOf(rootPid: number): Promise<number[]> {
  let entries: string[]
  try { entries = await readdir('/proc') } catch { return [] }
  const parents = new Map<number, number[]>()
  await Promise.all(entries.filter(entry => /^\d+$/.test(entry)).map(async entry => {
    try {
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      const pid = Number(entry), parent = Number(fields[1])
      if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent)) parents.set(parent, [...(parents.get(parent) ?? []), pid])
    } catch { /* The process exited while the snapshot was being read. */ }
  }))
  const result: number[] = []
  const visit = (pid: number) => { for (const child of parents.get(pid) ?? []) { visit(child); result.push(child) } }
  visit(rootPid)
  return result
}

export async function launch(editor: Editor, profile: boolean, logPath: string, startupTimeout = 30000, traffic = false) {
  const root = await mkdtemp(`${tmpdir()}/quickpick-benchmark-${editor.id}-`)
  const env = { ...process.env, VSCODE_CLI: '1' }
  if (editor.id === 'cursor') (env as NodeJS.ProcessEnv).HOME = root
  for (const name of ['CONFIG', 'DATA', 'CACHE', 'STATE']) {
    const path = `${root}/${name}`
    ;(env as NodeJS.ProcessEnv)[`XDG_${name}_HOME`] = path
    await mkdir(path)
  }
  const profileDir = editor.id === 'theia' ? `${root}/CONFIG/Theia IDE` : `${root}/profile`
  await mkdir(`${profileDir}/User`, { recursive: true })
  await writeFile(`${profileDir}/User/settings.json`, JSON.stringify({ 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false }))
  const preload = `${root}/traffic-preload.cjs`
  if (traffic) await writeFile(preload, trafficPreload)
  const workspace = resolve('.tmp/fixture')
  const args = editor.id === 'theia'
    ? [workspace, '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', ...(profile || traffic ? ['--inspect-brk=0'] : []), '--user-data-dir', profileDir, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust']
    : ['--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', ...(profile || traffic ? ['--inspect-brk=0'] : []), '--user-data-dir', profileDir, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', ...(editor.id === 'cursor' ? ['--new-window'] : []), workspace]
  if (editor.id === 'cursor') {
    try { await prepareCursorProfile(resolve(`.tmp/apps/${editor.id}/${editor.binary}`), profileDir, workspace, env) }
    catch (error) { await rm(root, { recursive: true, force: true }); throw error }
  }
  const child = spawn(resolve(`.tmp/apps/${editor.id}/${editor.binary}`), args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
    // Include descendants that Electron may have detached from the process group.
    const exited = child.exitCode !== null || child.signalCode !== null || spawnError ? Promise.resolve() : new Promise<void>(resolve => { child.once('exit', () => resolve()); child.once('error', () => resolve()) })
    if (child.pid) {
      for (const pid of await descendantsOf(child.pid)) { try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error } }
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
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
    if (profile || traffic) {
      main = await Protocol.connect(await wait(/Debugger listening on (ws:\/\/[^\s]+)/))
      await main.send('Debugger.enable')
      const paused = main.event('Debugger.paused')
      await main.send('Runtime.runIfWaitingForDebugger')
      await paused
      const expression = profile ? utilityInstrumentation : `(() => {
        const { app } = process.getBuiltinModule('module').createRequire(process.cwd()+'/benchmark.cjs')('electron');
        app.on('session-created', session => session.registerPreloadScript({type:'frame',filePath:${JSON.stringify(preload)}}));
        return true;
      })()`
      const injected = await main.send('Runtime.evaluate', { expression, returnByValue: true })
      if (injected.exceptionDetails || injected.result.value !== true) throw new Error(`Inspector instrumentation failed: ${JSON.stringify(injected)}`)
      await main.send('Debugger.resume')
      await main.send('Debugger.disable')
    }
    browser = await chromium.connectOverCDP(await wait(/DevTools listening on (ws:\/\/[^\s]+)/), { timeout: 30000 })
    const deadline = Date.now() + startupTimeout
    const findWorkbench = () => browser!.contexts()[0]?.pages().find(page => editor.id === 'theia' ? /\/frontend\/index\.html(?:\?|$)/.test(page.url()) : page.url() !== 'about:blank')
    while (!findWorkbench() && Date.now() < deadline) await delay(100)
    const page = findWorkbench()
    if (!page) {
      const pages = browser.contexts()[0]?.pages().map(candidate => candidate.url())
      throw new Error(`No workbench page: ${JSON.stringify({ pages })}`)
    }
    page.setDefaultTimeout(20000)
    await page.locator(editor.id === 'lvce' ? '[role=tree]' : '.monaco-workbench').first().waitFor()
    if (editor.id === 'theia') {
      if (!page.url().includes(`#${workspace}`)) throw new Error(`Theia did not open the fixture workspace: ${page.url()}`)
      const untrusted = page.getByRole('button', { name: "No, I don't trust the authors" })
      await untrusted.waitFor({ state: 'visible' })
      await untrusted.click()
      await page.locator('#theia-dialog-shell.workspace-trust-dialog').waitFor({ state: 'hidden' })
    }
    if (editor.id === 'cursor') {
      const welcome = page.getByRole('heading', { name: /welcome to cursor|cursor setup/i })
      if (await welcome.isVisible().catch(() => false)) throw new Error('Cursor welcome screen is visible despite seeded profile state')
    }
    await page.bringToFront()
    await page.evaluate(() => window.focus())
    return { root, editorId: editor.id, browser, page, main, close, inspectorUrls: () => [...new Set([...output.matchAll(/Debugger listening on (ws:\/\/[^\s]+)/g)].map(match => match[1]))] }
  } catch (error) { await close(); throw error }
}
