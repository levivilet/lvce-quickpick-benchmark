import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { launch, type Editor } from './launch.ts'
import { settleTargets } from './readiness.ts'
import { search } from './adapters.ts'
import { attachTraffic } from './traffic.ts'
import { profileWorkload } from './profiles.ts'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { repeats: { type: 'string', default: '5' }, editor: { type: 'string' }, mode: { type: 'string' } } })
const repeats = Number(values.repeats)
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('repeats must be 1–100')
const editors: Editor[] = JSON.parse(await readFile('config/editors.lock.json', 'utf8'))
if (values.editor && !editors.some(x => x.id === values.editor)) throw new Error('Unknown editor')
if (values.mode && !['latency', 'profile', 'traffic'].includes(values.mode)) throw new Error('Unknown mode')
const fixture = JSON.parse(await readFile('.tmp/fixture.json', 'utf8'))
const expectedCommit = '9df03c6d6ce97c6645c5846f6dfa2a6a7d276515'
if (fixture.commit !== expectedCommit || execFileSync('git', ['-C', '.tmp/fixture', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== expectedCommit || execFileSync('git', ['-C', '.tmp/fixture', 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Fixture changed')
const filenames = ['quickOpenModel.ts', 'editorOptions.ts']
for (const file of filenames) {
  if (!execFileSync('git', ['-C', '.tmp/fixture', 'ls-files'], { encoding: 'utf8' }).split('\n').some(path => path.endsWith(`/${file}`))) throw new Error(`Missing fixture file ${file}`)
}
await mkdir('results', { recursive: true })
const report: any = { protocol: 'query-highlights-two-frames-v1', created: new Date().toISOString(), fixture, editors, environment: { platform: process.platform, arch: process.arch, node: process.version }, repeats, filenames, trials: [] }
for (let repeat = 0; repeat < repeats; repeat++) {
  // Alternate editor order across repetitions to reduce order bias.
  const order = repeat % 2 ? [...editors].reverse() : editors
  for (const editor of order.filter(x => !values.editor || x.id === values.editor)) for (const mode of ['latency', 'profile', 'traffic'].filter(x => !values.mode || x === values.mode)) for (const filename of filenames) {
    const key = `${editor.id}-${mode}-${repeat}-${filename}`
    const trial: any = { editor: editor.id, mode, repeat, filename, status: 'failed' }
    let app: Awaited<ReturnType<typeof launch>> | undefined
    try {
      app = await launch(editor, mode === 'profile', `results/${key}.log`, 30000, mode === 'traffic')
      await search(app.page, editor.id, filename)
      await app.page.keyboard.press('Escape')
      trial.readiness = await settleTargets(app.browser, editor.id)
      if (mode === 'profile') trial.profile = await profileWorkload(app, `results/${key}`, () => search(app!.page, editor.id, filename))
      else if (mode === 'traffic') {
        const collector = await attachTraffic(app)
        try {
          trial.samples = await search(app.page, editor.id, filename)
          trial.traffic = await collector.results()
          if (trial.traffic.samples.length !== trial.samples.length) throw new Error('Missing traffic samples')
          trial.traffic.samples.forEach((sample: any, index: number) => { sample.query = trial.samples[index].query })
        } finally { await collector.close() }
      }
      else trial.samples = await search(app.page, editor.id, filename)
      await app.page.screenshot({ path: `results/${key}.png` })
      trial.screenshot = `${key}.png`
      trial.status = 'passed'
    } catch (error) { trial.error = String(error); console.error(key, error) }
    finally {
      await app?.close().catch(error => { trial.status = 'failed'; trial.cleanupError = String(error) })
    }
    report.trials.push(trial)
    await writeFile('results/results.json', JSON.stringify(report, null, 2))
    console.log(key, trial.status)
  }
}
if (report.trials.some((trial: any) => trial.status !== 'passed')) process.exitCode = 1
