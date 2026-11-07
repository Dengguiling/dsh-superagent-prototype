/**
 * Live check of the Redmine Source against a running Redmine 4.2: it lists the changed issues, reads one with its
 * journals, posts a note, and runs a poll round that must turn an issue and a journal into Triggers.
 */
import { Engine, MemoryRepositories, type Assessor, type Executor } from '../../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { redmineKind, pollRound } from '../../src/sources/redmine.ts'
import { readIssue, listIssues, postNote } from '../../src/sources/redmine-read.ts'
import { sendRedmine } from '../../src/sources/redmine-channel.ts'
import { Store } from '../../src/app/store.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.REDMINE_URL ?? 'http://127.0.0.1:3010'
const KEY = process.env.REDMINE_KEY ?? ''
const LOGIN = process.env.REDMINE_LOGIN ?? 'admin'
const NAME = process.env.REDMINE_NAME ?? 'Redmine Admin'
const ID = Number(process.env.REDMINE_ID ?? '1')
const PROJECT = process.env.REDMINE_PROJECT ?? 'demo'

const deployment = {
  stateDir: mkdtempSync(join(tmpdir(), 'live-redmine-')), promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000, repository: '', github: undefined,
  redmine: { baseUrl: BASE, apiKey: KEY, id: ID, login: LOGIN, name: NAME, mail: '', project: PROJECT },
}
const store = new Store(join(deployment.stateDir, 'db.sqlite'))
store.saveSettings(SettingsSchema.parse({
  policy: { sources: { redmine: { allowed: [{ id: NAME }] } } }, eval: { mode: 'auto' },
  sources: { redmine: { enabled: true, config: { baseUrl: BASE, apiKey: KEY, login: LOGIN, project: PROJECT } } },
}))
const board = new HealthBoard()
const sources = new SourceRegistry(() => store.settings(), board)
sources.register(redmineKind)
const commands = new Commands(() => deployment as never, {}, new AbortController().signal)

console.log('== the account ==')
const me = await readIssue(commands, 1).catch(() => undefined)
console.log('  issue 1 readable:', !!me)

console.log('== the changed issues ==')
const listed = await listIssues(commands, { project: PROJECT, since: '2020-01-01T00:00:00Z', limit: 10 })
console.log('  listed:', listed.map(issue => `#${issue.id} ${issue.subject}`))
console.log('  author of the first:', JSON.stringify(listed[0]?.author))

console.log('== one issue with its journals ==')
const issue = await readIssue(commands, Number(listed[0]?.id ?? 1))
console.log('  created_on:', issue.created_on, 'updated_on:', issue.updated_on)
console.log('  journals:', issue.journals?.map(journal => ({ id: journal.id, user: journal.user, at: journal.created_on, notes: journal.notes?.slice(0, 40) })))

console.log('== a note on the issue ==')
await postNote(commands, issue.id, 'A note from the live check.')
const after = await readIssue(commands, issue.id)
console.log('  journals now:', after.journals?.length, 'last:', after.journals?.at(-1)?.notes)

console.log('== the agent writes back to the issue ==')
const reply = { id: 'live-reply-1', channel: { source: 'redmine', thread: `redmine:${issue.id}`, address: { issue: String(issue.id) } },
  text: 'The patch is ready for review.', kind: 'reply' as const }
console.log('  first send:', await sendRedmine({ commands }, reply))
const once = await readIssue(commands, issue.id)
console.log('  journals now:', once.journals?.length)
console.log('  second send:', await sendRedmine({ commands }, reply))
const twice = await readIssue(commands, issue.id)
console.log('  journals after the retry:', twice.journals?.length, '(the marker keeps the retry from writing twice)')

console.log('== a poll round ==')
const assessor: Assessor = { request: () => {} }
const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
const received: string[] = []
const parts: SourceContextDeps = { store, engine, outbox, commands, sources, deployment: deployment as never,
  ready: Promise.resolve(), configured: () => true, receive: trigger => { received.push(`${trigger.meta.kind}:${trigger.text.slice(0, 30)}`); return engine.receive(trigger) } }
const context = sourceContextOf(parts, redmineKind)
const round = await pollRound(context, new AbortController().signal)
console.log('  round:', round)
console.log('  triggers:', received)
console.log('  health:', board.all.redmine)
store.close()
