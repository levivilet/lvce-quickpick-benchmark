import { readFile, mkdir, writeFile, cp } from 'node:fs/promises'
import { render } from './render.ts'
const report = JSON.parse(await readFile('results/results.json', 'utf8'))
await mkdir('site', { recursive: true })
await cp('results', 'site/raw', { recursive: true })
await writeFile('site/index.html', render(report))
