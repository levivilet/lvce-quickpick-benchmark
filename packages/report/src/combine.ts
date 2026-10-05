import { isDeepStrictEqual } from 'node:util'

// Reject partial or mixed runs before publishing comparisons across editor jobs.
export function combine(reports: any[], editors: any[]): any {
  if (reports.length !== editors.length) throw new Error('Missing editor results')
  const first = reports[0]
  const trials: any[] = []
  for (const editor of editors) {
    const matching = reports.filter(report => report.trials.length && report.trials.every((trial: any) => trial.editor === editor.id))
    if (matching.length !== 1) throw new Error(`Missing or duplicate results for ${editor.id}`)
    const report = matching[0]
    if (!isDeepStrictEqual(report.editors, editors)) throw new Error('Editor versions changed')
    for (const field of ['protocol', 'fixture', 'environment', 'repeats', 'filenames']) {
      if (!isDeepStrictEqual(report[field], first[field])) throw new Error(`Incompatible editor results: ${field}`)
    }
    if (!Number.isSafeInteger(report.repeats) || report.repeats < 1) throw new Error('Invalid repeat count')
    const modes = editor.id === 'atom' ? ['latency', 'profile'] : ['latency', 'profile', 'traffic', 'render', 'paint']
    const expected = new Set<string>()
    for (let repeat = 0; repeat < report.repeats; repeat++) for (const mode of modes) for (const filename of report.filenames) expected.add(JSON.stringify([repeat, mode, filename]))
    for (const trial of report.trials) {
      if (trial.status !== 'passed' || !expected.delete(JSON.stringify([trial.repeat, trial.mode, trial.filename]))) throw new Error(`Failed, duplicate or unexpected trial for ${editor.id}`)
    }
    if (expected.size) throw new Error(`Incomplete trials for ${editor.id}`)
    trials.push(...report.trials)
  }
  return { ...first, editors, trials }
}
