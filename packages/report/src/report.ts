import { readFile, mkdir, writeFile, cp, readdir } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { render } from './render.ts'
import { combine } from './combine.ts'
const { values } = parseArgs({ options: { editors: { type: 'string' } } })
let report: any
if (values.editors) {
  const directories = (await readdir(values.editors, { withFileTypes: true })).filter(entry => entry.isDirectory())
  const reports = await Promise.all(directories.map(async entry => JSON.parse(await readFile(`${values.editors}/${entry.name}/results.json`, 'utf8'))))
  const editors = JSON.parse(await readFile('config/editors.lock.json', 'utf8'))
  report = combine(reports, editors)
  for (const entry of directories) await cp(`${values.editors}/${entry.name}`, 'results', { recursive: true, force: false, errorOnExist: true, filter: source => !source.endsWith('/results.json') })
  await writeFile('results/results.json', JSON.stringify(report, null, 2))
} else report = JSON.parse(await readFile('results/results.json', 'utf8'))
await mkdir('site', { recursive: true })
await cp('results', 'site/raw', { recursive: true, filter: source => source !== values.editors })
await writeFile('site/index.html', render(report))
