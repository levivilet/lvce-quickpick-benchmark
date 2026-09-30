import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

export const cursorWelcomeValues = {
  'cursorai/donotchange/privacyMode': 'true',
  'workbench.services.onFirstStartupService.isVeryFirstTime': 'false',
  'cursorAuth/stripeMembershipType': 'free',
  'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser': JSON.stringify({ authenticationSettings: { githubLoggedIn: false } }),
}

export function seedCursorWelcomeState(databasePath: string) {
  const database = new DatabaseSync(databasePath)
  try {
    const columns = new Set(database.prepare('PRAGMA table_info(ItemTable)').all().map((row: any) => row.name))
    if (!columns.has('key') || !columns.has('value')) throw new Error('Cursor profile database has no compatible ItemTable')
    database.exec('BEGIN')
    const insert = database.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(cursorWelcomeValues)) insert.run(key, value)
    const keys = Object.keys(cursorWelcomeValues)
    const placeholders = keys.map(() => '?').join(',')
    const actual = new Map(database.prepare(`SELECT key, value FROM ItemTable WHERE key IN (${placeholders})`).all(...keys).map((row: any) => [row.key, row.value]))
    if (actual.size !== keys.length || keys.some(key => actual.get(key) !== cursorWelcomeValues[key as keyof typeof cursorWelcomeValues])) throw new Error('Cursor profile welcome state was not saved')
    database.exec('COMMIT')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* The transaction may not have started. */ }
    throw error
  } finally {
    database.close()
  }
}

function hasCursorProfileDatabase(databasePath: string) {
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(databasePath)
    const columns = new Set(database.prepare('PRAGMA table_info(ItemTable)').all().map((row: any) => row.name))
    return columns.has('key') && columns.has('value')
  } catch { return false }
  finally { database?.close() }
}

async function terminate(process: ChildProcess) {
  if (!process.pid) return
  if (process.pid && process.exitCode === null && process.signalCode === null) {
    try { globalThis.process.kill(-process.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    try { process.kill('SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  if (process.exitCode === null && process.signalCode === null) await new Promise<void>(resolve => { process.once('exit', () => resolve()); process.once('error', () => resolve()) })
}

type StartProcess = (binary: string, args: string[], options: SpawnOptions) => ChildProcess

export async function prepareCursorProfile(binary: string, profileDir: string, workspace: string, environment: NodeJS.ProcessEnv, timeoutMs = 30000, start: StartProcess = (command, args, options) => spawn(command, args, options)) {
  const databasePath = `${profileDir}/User/globalStorage/state.vscdb`
  await mkdir(`${profileDir}/User`, { recursive: true })
  if (!hasCursorProfileDatabase(databasePath)) {
    const process = start(binary, ['--no-sandbox', '--disable-gpu', '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--new-window', '--user-data-dir', profileDir, workspace], { env: environment, detached: true, stdio: 'ignore' })
    let spawnError: Error | undefined
    process.once('error', error => { spawnError = error })
    const interrupt = (signal: NodeJS.Signals) => {
      void terminate(process).finally(async () => {
        await rm(dirname(profileDir), { recursive: true, force: true })
        globalThis.process.exit(signal === 'SIGINT' ? 130 : 143)
      })
    }
    const onSigint = () => interrupt('SIGINT')
    const onSigterm = () => interrupt('SIGTERM')
    globalThis.process.once('SIGINT', onSigint)
    globalThis.process.once('SIGTERM', onSigterm)
    try {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (hasCursorProfileDatabase(databasePath)) break
        if (spawnError) throw spawnError
        if (process.exitCode !== null || process.signalCode !== null) throw new Error(`Cursor exited while creating its profile (${process.exitCode}/${process.signalCode})`)
        await delay(100)
      }
      if (!hasCursorProfileDatabase(databasePath)) throw new Error('Cursor did not create a compatible profile database')
    } finally {
      globalThis.process.off('SIGINT', onSigint)
      globalThis.process.off('SIGTERM', onSigterm)
      await terminate(process)
    }
  }
  seedCursorWelcomeState(databasePath)
}
