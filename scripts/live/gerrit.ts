/**
 * Live check of the Gerrit Source against a running Gerrit 2.15: it lists the agent's changes, reads one with its
 * comments and messages, posts a review message, and runs a poll round that must turn a comment into a Trigger.
 */
import { Engine, type Assessor, type Executor } from '../../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../../src/policy.ts'
import { SourceRegistry } from '../../src/sources/registry.ts'
import { gerritKind, pollRound } from '../../src/sources/gerrit.ts'
import { readChange, listChanges, listComments, postReview, commitMessage } from '../../src/sources/gerrit-read.ts'
import { Store } from '../../src/app/store.ts'
import { Commands } from '../../src/infra/commands.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../../src/app/source-context.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTTP = process.env.GERRIT_URL ?? 'http://127.0.0.1:8081'
const USER = process.env.GERRIT_USER ?? 'agent'
const PASS = process.env.GERRIT_PASS ?? 'agentpass'
const PROJECT = process.env.GERRIT_PROJECT ?? 'demo'
const BRANCH = process.env.GERRIT_BRANCH ?? 'master'

const deployment = {
  stateDir: mkdtempSync(join(tmpdir(), 'live-gerrit-')), promptMaxChars: 100000, admissionContextMaxPages: 10,
  admissionContextTimeoutMs: 15000, repository: '', github: undefined,
  gerrit: { httpUrl: HTTP, sshUrl: 'ssh://agent@127.0.0.1:29419', project: PROJECT, user: USER, password: PASS,
    keyPath: '', branch: BRANCH, email: 'agent@example.com' },
}
const store = new Store(join(deployment.stateDir, 'db.sqlite'))
store.saveSettings(SettingsSchema.parse({
  policy: { sources: { gerrit: { allowed: [{ id: 'bob' }] } } }, eval: { mode: 'auto' },
  sources: { gerrit: { enabled: true, config: { httpUrl: HTTP, sshUrl: 'ssh://agent@127.0.0.1:29419', project: PROJECT, user: USER, password: PASS, branch: BRANCH } } },
}))
const board = new HealthBoard()
const sources = new SourceRegistry(() => store.settings(), board)
sources.register(gerritKind)
const commands = new Commands(() => deployment as never, {}, new AbortController().signal)

console.log('== the changes of the agent ==')
const changes = await listChanges(commands, { project: PROJECT, owner: USER, status: 'open' })
console.log('  listed:', changes.map(change => `#${change._number} ${change.subject} [${change.status}] topic=${change.topic}`))
console.log('  owner:', changes[0]?.owner?.username, changes[0]?.owner?.name)
console.log('  commit message:', JSON.stringify(commitMessage(changes[0] ?? ({} as never)).slice(0, 120)))

console.log('== one change with its comments and messages ==')
const number = String(changes[0]?._number ?? 1001)
const change = await readChange(commands, number)
console.log('  status:', change.status, 'current revision:', change.current_revision)
console.log('  messages:', change.messages?.map(message => `${message.author?.username}: ${(message.message ?? '').slice(0, 40)}`))
console.log('  comments:', await listComments(commands, number))

console.log('== a review message on the change ==')
if (change.current_revision) {
  await postReview(commands, number, change.current_revision, 'A review message from the live check.')
  const after = await readChange(commands, number)
  console.log('  messages now:', after.messages?.length, 'last:', after.messages?.at(-1)?.message?.slice(0, 60))
}

console.log('== a poll round ==')
const assessor: Assessor = { request: () => {} }
const executor: Executor = { start: () => {}, deliver: () => {}, stop: () => {} }
const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
const received: string[] = []
const parts: SourceContextDeps = { store, engine, outbox, commands, sources, deployment: deployment as never,
  ready: Promise.resolve(), configured: () => true, receive: trigger => { received.push(`${trigger.meta.kind}:${trigger.actor.id}:${trigger.text.slice(0, 40)}`); return engine.receive(trigger) } }
const context = sourceContextOf(parts, gerritKind)
const round = await pollRound(context, new AbortController().signal)
console.log('  round:', round)
console.log('  triggers:', received)
console.log('  health:', board.all.gerrit)
store.close()
