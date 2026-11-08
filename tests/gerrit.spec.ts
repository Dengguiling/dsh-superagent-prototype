/** Tests of the Gerrit Source: its translation, its change rules, its polling round, and its channel. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply as applyGerrit, gerritKind, pollRound } from '../src/sources/gerrit.ts'
import { commentTrigger, issueOf, messageTrigger, SOURCE } from '../src/sources/gerrit-trigger.ts'
import { sendGerrit } from '../src/sources/gerrit-channel.ts'
import { agentChange, changeOf, claimChange, observeChange, ticketTopic } from '../src/sources/gerrit-change.ts'
import { strip } from '../src/sources/gerrit-read.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment, testGerrit } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HTTP = 'http://gerrit.test:8080'
const AGENT = 'agent'
let directory = ''

interface HttpCall { url: string; method: string; body?: string }
const calls: HttpCall[] = []
/** Answers Gerrit API calls from a table of path patterns, and records what was asked. */
function gerrit(routes: Record<string, unknown>) {
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', ...init.body !== undefined ? { body: init.body } : {} })
    const path = url.replace(`${HTTP}/a`, '').split('?')[0]!
    const answer = routes[path] ?? Object.entries(routes).find(([key]) => key.endsWith('*') && path.startsWith(key.slice(0, -1)))?.[1]
    if (answer === undefined) return { status: 404, body: ")]}'\n{}" }
    return { status: 200, body: `)]}'\n${JSON.stringify(answer)}` }
  })
}
const change = (fields: Record<string, unknown> = {}) => ({
  _number: 42, id: 'demo~master~I1234', project: 'demo', branch: 'main', subject: 'Fix the login', topic: '',
  // Gerrit names the state of a change in capitals, and its owner by the user name.
  status: 'NEW', owner: { username: AGENT, name: 'Super Agent', email: 'agent@example.com' },
  created: '2026-09-01T00:00:00Z', updated: '2026-09-02T00:00:00Z',
  url: `${HTTP}/#/c/demo/+/42`, current_revision: 'abc123', revisions: { abc123: { ref: 'refs/changes/42/1/1', kind: 'REWORK',
    // Gerrit 2.15 reports the fetch information as an object.
    fetch: { url: 'ssh://gerrit:29418/demo', ref: 'refs/changes/42/1/1' },
    commit: { message: 'Fix the login\n\nIssue: 7\n\nChange-Id: I0123456789012345678901234567890123456789\n' } } },
  messages: [], labels: { 'Code-Review': { value: '0' } }, ...fields,
})
const comment = (id: string, fields: Record<string, unknown> = {}) => ({
  id, message: 'Please rename this variable.', author: { name: 'bob' }, created: '2026-09-02T10:00:00Z', path: 'src/app.ts', line: 12, ...fields,
})

function host(overrides: Partial<SourceContextDeps> = {}, gerritConfig: Record<string, unknown> = {}) {
  const store = new Store(join(directory, 'db.sqlite'))
  // The polling tests below describe ordinary rounds; the first-round behavior has its own test.
  store.set(KV.gerrit.initialized, true)
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { gerrit: { allowed: [{ id: 'bob', name: 'Bob' }] } } }, eval: { mode: 'auto' },
    sources: { gerrit: { enabled: true, config: { httpUrl: HTTP, project: 'demo', user: AGENT, password: 'secret', ...gerritConfig } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(gerritKind)
  const deployment = testDeployment({ gerrit: testGerrit })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const context = sourceContextOf(parts, gerritKind)
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, ...context, store, engine, commands, receive, health: board.all }
}
type Host = ReturnType<typeof host>

/** A ticket that works on the change, with its execution name and its origin Trigger. */
const ticket = (fields: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1', title: 'Fix the login', decisionId: 'd-1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'redmine', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'trigger-1', triggerIds: [] }, execution: { name: 'fix-login', directory: '/w/fix-login', assignment: '' },
  ...fields,
})
/** The Redmine Trigger of issue 7, as a ticket's origin. */
const request = (issue = 7): Trigger => ({ id: 'trigger-1', source: 'redmine', threads: [{ source: 'redmine', id: String(issue) }],
  actor: { source: 'redmine', id: 'alice' }, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix the login', meta: { issueId: issue, project: 'demo' } })
const saved = (h: Host, value: Ticket): void => { h.store.tickets.save(value) }

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'gerrit-')); calls.length = 0 })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('the Gerrit API', () => {
  it('strips the prefix Gerrit puts in front of every response', () => {
    expect(strip(")]}'\n{\"a\":1}")).toBe('{"a":1}')
    expect(strip('{"a":1}')).toBe('{"a":1}')
  })
})

describe('the Gerrit translation', () => {
  it('builds a stable Trigger for a review comment, with its author and the change it is on', () => {
    const trigger = commentTrigger(change(), comment('Ic1'), AGENT, HTTP)!
    expect(trigger.id).toBe(key('gerrit-comment', 'demo~master~I1234', 'Ic1'))
    expect(trigger.source).toBe(SOURCE)
    expect(trigger.threads).toEqual([{ source: SOURCE, id: '42' }])
    expect(trigger.actor).toEqual({ source: SOURCE, id: 'bob' })
    expect(trigger.human).toBe(true)
    expect(trigger.text).toBe('src/app.ts:12\n\nPlease rename this variable.')
    expect(trigger.channel?.address).toEqual({ change: '42', project: 'demo' })
    expect(trigger.url).toBe(`${HTTP}/#/c/demo/+/42`)
    expect(trigger.meta).toMatchObject({ kind: 'comment', changeNumber: 42, project: 'demo', branch: 'main' })
  })
  it('builds no Trigger for the agent\'s own comment, and none for a robot\'s request', () => {
    expect(commentTrigger(change(), comment('Ic1', { author: { name: AGENT } }), AGENT, HTTP)).toBeUndefined()
    const robot = commentTrigger(change(), comment('Ic1', { author: { name: 'Gerrit Robot' } }), AGENT, HTTP)!
    expect(robot.human).toBe(false)
  })
  it('addresses the agent directly on its own change, whoever writes the comment', () => {
    expect(commentTrigger(change(), comment('Ic1'), AGENT, HTTP)!.addressed).toBe('direct')
    expect(commentTrigger(change({ owner: { username: 'bob', name: 'Bob' } }), comment('Ic1'), AGENT, HTTP)!.addressed).toBeUndefined()
    expect(commentTrigger(change({ owner: null }), comment('Ic1'), AGENT, HTTP)!.addressed).toBeUndefined()
    // A change message is a status note, never a request, on the agent's own change too.
    expect(messageTrigger(change(), { id: 'm1', message: 'Change has been merged.', author: { username: 'bob' } }, AGENT, HTTP)!.addressed).toBeUndefined()
  })
  it('carries the change first and the issue it answers second, when the commit message names an issue', () => {
    const review = commentTrigger(change(), comment('Ic1'), AGENT, HTTP, '7')!
    expect(review.threads).toEqual([{ source: SOURCE, id: '42' }, { source: 'redmine', id: '7' }])
    expect(review.meta).toMatchObject({ kind: 'comment', issueId: 7 })
    const note = messageTrigger(change(), { id: 'm1', message: 'Please rebase.', author: { username: 'bob' } }, AGENT, HTTP, '7')!
    expect(note.threads).toEqual([{ source: SOURCE, id: '42' }, { source: 'redmine', id: '7' }])
    expect(note.meta).toMatchObject({ kind: 'message', issueId: 7 })
    // A change that names no issue keeps the change's Thread alone.
    expect(commentTrigger(change(), comment('Ic1'), AGENT, HTTP)!.threads).toEqual([{ source: SOURCE, id: '42' }])
  })
  it('reads the task a change names from the trailers of its commit message', () => {
    expect(issueOf('Fix it\n\nIssue: 7\n')).toBe('7')
    expect(issueOf('Fix it\n\nIssue: #12\n')).toBe('12')
    expect(issueOf('Fix it\n\nRedmine-Issue: 33\n')).toBe('33')
    expect(issueOf('Fix it')).toBeUndefined()
  })
})

describe('the Gerrit change rules', () => {
  it('claims the agent\'s change that names the ticket by its issue', () => {
    const h = host()
    saved(h, ticket())
    h.store.triggers.save(request())
    expect(claimChange(h, 'ticket-1', change())).toBeUndefined()
    // The ticket opened it, so it is the ticket's own change.
    expect(h.store.tickets.get('ticket-1')?.follows).toEqual([{ thread: 'gerrit:42', own: true }])
    h.store.close()
  })
  it('claims the agent\'s change in any repository, since the issue trailer names the ticket', () => {
    const h = host()
    saved(h, ticket())
    h.store.triggers.save(request())
    expect(claimChange(h, 'ticket-1', change({ project: 'sdk', id: 'sdk~main~I42' }))).toBeUndefined()
    expect(h.store.tickets.get('ticket-1')?.follows).toEqual([{ thread: 'gerrit:42', own: true }])
    // A change belongs to the agent by its owner, not by the configured project.
    expect(agentChange(change({ project: 'sdk' }), h.deployment)).toBe(true)
    h.store.close()
  })
  it('claims a change whose topic names the ticket', () => {
    const h = host()
    saved(h, ticket())
    expect(claimChange(h, 'ticket-1', change({ topic: 'agent/fix-login' }))).toBeUndefined()
    expect(h.store.tickets.get('ticket-1')?.follows).toEqual([{ thread: 'gerrit:42', own: true }])
    expect(ticketTopic(ticket(), 'agent/fix-login')).toBe(true)
    h.store.close()
  })
  it('refuses a change of another account, and one that names no ticket', () => {
    const h = host()
    saved(h, ticket())
    h.store.triggers.save(request())
    expect(claimChange(h, 'ticket-1', change({ owner: { username: 'someone', name: 'Someone' } }))).toContain('not by')
    expect(claimChange(h, 'ticket-1', change({ revisions: { abc123: { commit: { message: 'Other task\n\nIssue: 99\n' } } } })))
      .toContain('does not name this ticket')
    expect(claimChange(h, 'ticket-1', change({ revisions: { abc123: { commit: { message: 'No trailer here\n' } } } })))
      .toContain('does not name this ticket')
    h.store.close()
  })
  it('binds an open change to the ticket that works its issue, as a followed Thread when somebody else pushed it', async () => {
    const h = host()
    saved(h, ticket())
    h.store.triggers.save(request())
    // A colleague's patch for the same issue: the ticket follows it, so the review comments on it reach its worker.
    expect(await observeChange(h, change({ owner: { username: 'bob', name: 'Bob' }, project: 'sdk' }))).toBe(false)
    expect(h.store.tickets.get('ticket-1')?.follows).toEqual([{ thread: 'gerrit:42', own: false }])
    h.store.close()
  })
  it('reports a merged change to the ticket that follows it', async () => {
    const h = host()
    saved(h, ticket({ follows: [{ thread: 'gerrit:42', own: true }] }))
    expect(await observeChange(h, change({ status: 'MERGED' }))).toBe(true)
    expect(changeOf(ticket({ follows: [{ thread: 'gerrit:42', own: true }] }))).toBe(42)
    h.store.close()
  })
  it('leaves the ticket open when a colleague\'s change for its issue is merged, because the agent\'s own change is still open', async () => {
    const h = host()
    saved(h, ticket({ follows: [{ thread: 'gerrit:42', own: true }, { thread: 'gerrit:43', own: false }] }))
    // The colleague's patch is merged; the ticket still waits for its own change.
    expect(await observeChange(h, change({ _number: 43, status: 'MERGED', owner: { username: 'bob', name: 'Bob' } }))).toBe(true)
    expect(h.store.tickets.get('ticket-1')?.follows?.find(follow => follow.thread === 'gerrit:43')?.closed?.outcome).toBe('merged')
    expect(h.store.tickets.get('ticket-1')?.ended).toBeUndefined()
    h.store.close()
  })
})

describe('the Gerrit environment', () => {
  /** The environment values of a deployment whose project override is `project`, for an optional Trigger. */
  const environment = (project: string, trigger?: Trigger) => gerritKind.environment!.values({
    deployment: testDeployment({ gerrit: { ...testGerrit, project } }),
    config: gerritKind.schema.parse({ httpUrl: HTTP, project, user: AGENT, password: 'secret' }),
    ...trigger ? { trigger } : {},
  })
  const issueTrigger = (project: string): Trigger => ({ id: 't1', source: 'redmine', threads: [{ source: 'redmine', id: '7' }],
    actor: { source: 'redmine', id: 'alice' }, human: true, at: '', text: 'Fix', meta: { issueId: 7, project } })
  const patchTrigger = (project: string, changeNumber: number): Trigger => ({ id: 't2', source: SOURCE, threads: [{ source: SOURCE, id: String(changeNumber) }],
    actor: { source: SOURCE, id: 'bob' }, human: true, at: '', text: 'Fix', meta: { changeNumber, project, branch: 'main' } })
  it('names the repository of the ticket: the issue\'s project or the change\'s, for cloning and for the change page', () => {
    // The project is empty: the ticket names its repository, and the variables follow it.
    expect(environment('', issueTrigger('sdk'))).toMatchObject({
      DSH_SUPERAGENT_GERRIT_PROJECT: 'sdk', DSH_SUPERAGENT_GERRIT_SSH_URL: 'ssh://gerrit.test:29418/sdk',
      DSH_SUPERAGENT_GERRIT_BRANCH: '', DSH_SUPERAGENT_GERRIT_CHANGE_NUMBER: '', DSH_SUPERAGENT_GERRIT_CHANGE_URL: '' })
    // A Gerrit Trigger names the change's project, and the change page follows the change, not the issue.
    expect(environment('', patchTrigger('sdk-cli', 12))).toMatchObject({
      DSH_SUPERAGENT_GERRIT_PROJECT: 'sdk-cli', DSH_SUPERAGENT_GERRIT_SSH_URL: 'ssh://gerrit.test:29418/sdk-cli',
      DSH_SUPERAGENT_GERRIT_BRANCH: 'main', DSH_SUPERAGENT_GERRIT_CHANGE_NUMBER: '12', DSH_SUPERAGENT_GERRIT_CHANGE_URL: `${HTTP}/#/c/sdk-cli/+/12` })
  })
  it('lets the legacy project override name the repository of every ticket', () => {
    expect(environment('demo', issueTrigger('sdk'))).toMatchObject({
      DSH_SUPERAGENT_GERRIT_PROJECT: 'demo', DSH_SUPERAGENT_GERRIT_SSH_URL: 'ssh://gerrit.test:29418/demo' })
  })
})

describe('a Gerrit polling round', () => {
  it('reads the issue-referencing open changes and their review comments, and stores a Trigger for each', async () => {
    const h = host()
    gerrit({ '/changes/': [change()], '/changes/42/detail': change(), '/changes/42/comments': [comment('Ic1')] })
    const round = await pollRound(h, new AbortController().signal)
    expect(round.changes).toBe(1)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('gerrit-comment', 'demo~master~I1234', 'Ic1'))
    // A configured project is the legacy single-repository override, and the account does not narrow the list.
    expect(calls[0]!.url).toContain('/a/changes/?q=project%3Ademo%20status%3Aopen')
    h.store.close()
  })
  it('tracks the open changes of every repository when the project is empty, and ignores a change that names no issue', async () => {
    const h = host({}, { project: '' })
    const unrelated = change({ _number: 43, id: 'sdk~main~I43', project: 'sdk', current_revision: 'def456',
      revisions: { def456: { commit: { message: 'Refactor the client\n\nChange-Id: I999\n' } } } })
    gerrit({ '/changes/': [change({ project: 'sdk' }), unrelated], '/changes/42/detail': change({ project: 'sdk' }),
      '/changes/42/comments': [comment('Ic1')] })
    const round = await pollRound(h, new AbortController().signal)
    expect(round.changes).toBe(2)
    expect(calls[0]!.url).toContain('/a/changes/?q=status%3Aopen')
    // Only the change that names an issue is read and produces a Trigger, whose Threads hold the change and its issue.
    expect(calls.map(call => call.url.split('?')[0])).toEqual([`${HTTP}/a/changes/`, `${HTTP}/a/changes/42/detail`, `${HTTP}/a/changes/42/comments`])
    expect(h.receive.mock.calls.map(call => call[0].threads)).toEqual([[{ source: SOURCE, id: '42' }, { source: 'redmine', id: '7' }]])
    h.store.close()
  })
  it('binds an issue-naming change to the ticket that works its issue, and the review comment reaches that ticket', async () => {
    const h = host({}, { project: '' })
    saved(h, ticket())
    h.store.triggers.save(request())
    gerrit({ '/changes/': [change({ project: 'sdk' })], '/changes/42/detail': change({ project: 'sdk' }), '/changes/42/comments': [comment('Ic1')] })
    await pollRound(h, new AbortController().signal)
    // The agent pushed the change, so the ticket owns it even though the configured project is empty.
    expect(h.store.tickets.get('ticket-1')?.follows).toEqual([{ thread: 'gerrit:42', own: true }])
    const trigger = h.receive.mock.calls[0]![0]
    expect(trigger.threads).toEqual([{ source: SOURCE, id: '42' }, { source: 'redmine', id: '7' }])
    // The issue's ticket received the review comment as an Input, not as a fresh assessment.
    expect(h.store.tickets.get('ticket-1')!.inputs.map(input => input.kind === 'trigger' ? input.triggerId : '')).toContain(trigger.id)
    h.store.close()
  })
  it('reads a comment only once', async () => {
    const h = host()
    gerrit({ '/changes/': [change()], '/changes/42/detail': change(), '/changes/42/comments': [comment('Ic1')] })
    await pollRound(h, new AbortController().signal)
    expect(h.store.get(KV.gerrit.comment('42'))).toEqual(['Ic1'])
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls.length).toBe(1)
    h.store.close()
  })
  it('reads a reviewer\'s note on the change as a Trigger of the change and its issue, and none of the agent\'s own', async () => {
    const h = host()
    const review = { id: 'm1', message: 'Patch Set 1: please rename this.', author: { username: 'bob', name: 'Bob' }, date: '2026-09-02T10:00:00Z' }
    gerrit({ '/changes/': [change()], '/changes/42/detail': change({ messages: [review] }),
      '/changes/42/comments': [] })
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('gerrit-message', 'demo~master~I1234', 'm1'))
    expect(h.receive.mock.calls[0]![0].actor).toEqual({ source: SOURCE, id: 'bob' })
    expect(h.receive.mock.calls[0]![0].meta).toMatchObject({ kind: 'message', issueId: 7 })
    h.store.close()
  })
  it('records what it saw on its first round, and receives only what arrives after it', async () => {
    const h = host()
    h.store.delete(KV.gerrit.initialized)
    const review = { id: 'm1', message: 'Patch Set 1: an old note.', author: { username: 'bob', name: 'Bob' }, date: '2026-09-02T10:00:00Z' }
    gerrit({ '/changes/': [change()], '/changes/42/detail': change({ messages: [review] }), '/changes/42/comments': [comment('Ic1')] })
    const first = await pollRound(h, new AbortController().signal)
    // The first round receives nothing: the history of the tracked changes is not fresh input.
    expect(first.triggers).toBe(0)
    expect(h.receive).not.toHaveBeenCalled()
    expect(h.store.get(KV.gerrit.comment('42'))).toEqual(['Ic1'])
    expect(h.store.get(KV.gerrit.message('42'))).toEqual(['m1'])
    expect(h.store.get(KV.gerrit.initialized)).toBe(true)
    // A comment that arrives after the first round is received.
    gerrit({ '/changes/': [change()], '/changes/42/detail': change({ messages: [review] }),
      '/changes/42/comments': [comment('Ic1'), comment('Ic2')] })
    const second = await pollRound(h, new AbortController().signal)
    expect(second.triggers).toBe(1)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('gerrit-comment', 'demo~master~I1234', 'Ic2'))
    h.store.close()
  })
  it('lists past one page while the last change of a page carries _more_changes', async () => {
    const h = host({}, { limit: 3 })
    const numbered = (number: number) => change({ _number: number, id: `demo~master~I${number}`,
      revisions: { [`abc${number}`]: { commit: { message: 'Fix it\n\nIssue: 7\n' } } } })
    vi.spyOn(Commands.prototype, 'http').mockImplementation(async url => {
      calls.push({ url, method: 'GET' })
      const path = url.replace(`${HTTP}/a`, '').split('?')[0]!
      if (path === '/changes/') {
        const query = new URL(url).searchParams
        const start = Number(query.get('start') ?? 0), n = Number(query.get('n') ?? 100)
        const numbers = [40, 41, 42, 43, 44], slice = numbers.slice(start, start + n)
        const body = slice.map(numbered)
        if (start + n < numbers.length) (body.at(-1)! as { _more_changes?: boolean })._more_changes = true
        return { status: 200, body: `)]}'\n${JSON.stringify(body)}` }
      }
      const detail = /^\/changes\/(\d+)\/detail$/.exec(path)
      if (detail) return { status: 200, body: `)]}'\n${JSON.stringify(numbered(Number(detail[1])))}` }
      if (/^\/changes\/\d+\/comments$/.test(path)) return { status: 200, body: `)]}'\n[]` }
      return { status: 404, body: ")]}'\n{}" }
    })
    const round = await pollRound(h, new AbortController().signal)
    expect(round.changes).toBe(5)
    // Two list requests: the second continued the query with `start`, which is how Gerrit pages it.
    const lists = calls.filter(call => call.url.includes('/a/changes/?'))
    expect(lists).toHaveLength(2)
    expect(lists[0]!.url).toContain('start=0')
    expect(lists[1]!.url).toContain('start=3')
    h.store.close()
  })
})

describe('the Gerrit channel', () => {
  const message = { id: 'reply-1', channel: { source: SOURCE, thread: `${SOURCE}:42`, address: { change: '42' } }, text: 'Renamed.', kind: 'reply' as const }
  it('posts a review message on the change, with a marker that keeps a retry from writing twice', async () => {
    const h = host()
    gerrit({ '/changes/42/detail': change(), '/changes/42/revisions/abc123/review': { message: 'Renamed.' } })
    expect(await sendGerrit(h, message)).toBe('sent')
    const post = calls.at(-1)!
    expect(post.method).toBe('POST')
    expect(post.url).toContain('/a/changes/42/revisions/abc123/review')
    expect(post.body).toContain('Renamed.')
    expect(post.body).toContain('dsh-superagent:reply-1')
    h.store.close()
  })
  it('does not write again when the message is already on the change', async () => {
    const h = host()
    gerrit({ '/changes/42/detail': change({ messages: [{ id: 'm1', message: 'Renamed.\n\n<!-- dsh-superagent:reply-1 -->' }] }) })
    expect(await sendGerrit(h, message)).toBe('sent')
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(0)
    h.store.close()
  })
  it('reports a gone change as gone', async () => {
    const h = host()
    vi.spyOn(Commands.prototype, 'http').mockResolvedValue({ status: 404, body: '{}' })
    expect(await sendGerrit(h, message)).toBe('gone')
    h.store.close()
  })
})

describe('the Gerrit Source kind', () => {
  it('keeps no sender list, admits by relation, and shows the rows of its admission table', () => {
    const policy = gerritKind.policy!
    expect(policy.relation).toBe(true)
    expect(policy.fields).toEqual([])
    expect(policy.schema.parse({ allowed: [{ id: 'lead' }] })).toEqual({})
    const rows = policy.rows!({ httpUrl: HTTP, observeComments: true })
    expect(rows.map(row => row.id)).toEqual(['comment', 'message'])
    expect(rows[0]!.cells.unlistedUnaddressed).toBe(true)
    expect(rows[0]!.cells.listedUnaddressed).toBe(false)
    expect(rows[1]!.cells.listedUnaddressed).toBe(false)
    expect(rows[1]!.cells.unlistedUnaddressed).toBe(false)
  })
  it('registers the kind, reports that it waits for setup, and unregisters it again', async () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const h = host({ configured: () => false, sources })
    const disposers: (() => unknown)[] = []
    applyGerrit({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.gerrit).toMatchObject({ state: 'paused', code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(board.all.gerrit).toBeUndefined()
    h.store.close()
  })
})
