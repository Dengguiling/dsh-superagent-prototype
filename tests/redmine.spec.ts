/** Tests of the Redmine Source: its translation, its polling round, its channel, and its Policy part. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { apply as applyRedmine, pollRound, redmineKind } from '../src/sources/redmine.ts'
import { listIssues } from '../src/sources/redmine-read.ts'
import { agentNote, issueTrigger, journalTrigger, panelNote, panelNoteText, SOURCE } from '../src/sources/redmine-trigger.ts'
import { sendRedmine } from '../src/sources/redmine-channel.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment, testRedmine } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://redmine.test'
const AGENT = 'agent'
const ALICE = 'alice'
let directory = ''

interface HttpCall { url: string; method: string; body?: string }
const calls: HttpCall[] = []
/** Answers Redmine API calls from a table of path patterns, and records what was asked. */
function redmine(routes: Record<string, unknown>) {
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', ...init.body !== undefined ? { body: init.body } : {} })
    const path = url.replace(`${BASE}`, '').split('?')[0]!
    const answer = routes[path] ?? routes[`${path}?`] ?? Object.entries(routes).find(([key]) => key.endsWith('*') && path.startsWith(key.slice(0, -1)))?.[1]
    if (answer === undefined) return { status: 404, body: '{"errors":["Not found"]}' }
    // A write answers 204 with no body.
    if (init.method === 'PUT') return { status: 204, body: '' }
    return { status: 200, body: JSON.stringify(answer) }
  })
}
const user = (id: number, login: string) => ({ id, login, name: login, firstname: login, lastname: 'Doe', mail: `${login}@example.com` })
/** The agent as the deployment resolves it: its id and the login a person mentions it by. */
const AGENT_ID = { id: 5, login: AGENT }
const issue = (id: number, fields: Record<string, unknown> = {}) => ({
  id, subject: `Fix the login`, description: 'The login button does nothing.', project: { id: 1, identifier: 'demo', name: 'Demo' },
  tracker: { id: 1, name: 'Bug' }, status: { id: 1, name: 'New' }, priority: { id: 2, name: 'Normal' },
  author: user(1, ALICE), assigned_to: null, created_on: '2026-09-01T00:00:00Z', updated_on: '2026-09-02T00:00:00Z', ...fields,
})
const journal = (id: number, fields: Record<string, unknown> = {}) => ({
  id, notes: 'Please also handle the timeout.', user: user(2, 'bob'), created_on: '2026-09-02T00:00:00Z', ...fields,
})

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { redmine: { allowed: [{ id: ALICE, name: 'Alice' }] } } }, eval: { mode: 'auto' },
    sources: { redmine: { enabled: true, config: { baseUrl: BASE, apiKey: 'key', login: AGENT, project: 'demo' } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(redmineKind)
  const deployment = testDeployment({ redmine: testRedmine })
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const context = sourceContextOf(parts, redmineKind)
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, ...context, store, engine, commands, receive, health: board.all }
}
type Host = ReturnType<typeof host>

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'redmine-'))
  calls.length = 0
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('the Redmine translation', () => {
  it('builds a stable Trigger for an issue, with its author, its thread and its page', () => {
    const trigger = issueTrigger(issue(7) as never, AGENT_ID, BASE)
    expect(trigger.id).toBe(key('redmine-issue', '7'))
    expect(trigger.source).toBe(SOURCE)
    expect(trigger.threads).toEqual([{ source: SOURCE, id: '7' }])
    expect(trigger.actor).toEqual({ source: SOURCE, id: ALICE })
    expect(trigger.human).toBe(true)
    expect(trigger.text).toBe('Fix the login\n\nThe login button does nothing.')
    expect(trigger.url).toBe(`${BASE}/issues/7`)
    expect(trigger.channel?.address).toEqual({ issue: '7' })
    expect(trigger.addressed).toBeUndefined()
  })
  it('marks an issue that mentions the agent as addressed, and one assigned to it as direct', () => {
    expect(issueTrigger(issue(7, { description: 'Hey @agent, look at this.' }) as never, AGENT_ID, BASE).addressed).toBe('mention')
    expect(issueTrigger(issue(7, { assigned_to: user(5, AGENT) }) as never, AGENT_ID, BASE).addressed).toBe('direct')
    expect(issueTrigger(issue(7, { assigned_to: user(5, AGENT) }) as never, { id: 0, login: 'other' }, BASE).addressed).toBeUndefined()
  })
  it('builds a Trigger for a journal, and none for a note either the agent or the panel wrote', () => {
    const item = issue(7, { journals: [journal(11)] }) as never
    const trigger = journalTrigger(item, journal(11) as never, AGENT_ID, BASE)
    expect(trigger?.id).toBe(key('redmine-journal', '11'))
    expect(trigger?.actor).toEqual({ source: SOURCE, id: 'bob' })
    expect(trigger?.url).toBe(`${BASE}/issues/7#change-11`)
    // Both kinds of notes were delivered when they were written; their hidden markers keep the poll from delivering them again.
    expect([agentNote('<!-- dsh-superagent:reply-1 -->'), agentNote('<!-- dsh-superagent-panel:tok -->'),
      panelNote('<!-- dsh-superagent-panel:tok -->'), panelNote('<!-- dsh-superagent:reply-1 -->')]).toEqual([true, false, true, false])
    expect(panelNoteText('tok')).toBe('<!-- dsh-superagent-panel:tok -->')
    expect(journalTrigger(item, journal(11, { notes: 'Pushed the patch.\n\n<!-- dsh-superagent:reply-1 -->' }) as never,
      AGENT_ID, BASE)).toBeUndefined()
    expect(journalTrigger(item, journal(11, { notes: 'Please look.\n\n<!-- dsh-superagent-panel:tok -->' }) as never,
      AGENT_ID, BASE)).toBeUndefined()
    // One shared account: a note the account wrote without a marker is the operator's, so it is human input.
    expect(journalTrigger(item, journal(11, { user: user(5, AGENT) }) as never, AGENT_ID, BASE)?.actor).toEqual({ source: SOURCE, id: AGENT })
  })
  it('turns a journal without a note into the field change it records', () => {
    const changed = journal(12, { notes: '', details: [{ property: 'assigned_to_id', name: 'Assignee', old_value: '', new_value: 'agent' }] })
    const trigger = journalTrigger(issue(7) as never, changed as never, AGENT_ID, BASE)
    expect(trigger?.text).toContain('Assignee to agent')
  })
})

describe('a Redmine polling round', () => {
  it('lists the API-key account\'s own open issues when asked', async () => {
    const h = host()
    redmine({ '/issues.json': { issues: [issue(7, { assigned_to: user(5, AGENT) })] } })
    expect((await listIssues(h.commands, { assignedTo: 'me', status: 'open', limit: 20 })).map(item => item.id)).toEqual([7])
    expect(calls[0]!.url).toContain('assigned_to_id=me')
    expect(calls[0]!.url).toContain('status_id=open')
    expect(calls[0]!.url).toContain('limit=20')
    h.store.close()
  })
  it('reads the changed issues, stores a Trigger for each, and moves the cursor after them', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7) } })
    const round = await pollRound(h, new AbortController().signal)
    expect(round.issues).toBe(1)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('redmine-issue', '7'))
    expect(h.store.get(KV.redmine.since)).toBeTruthy()
    expect(calls[0]!.url).toContain('/issues.json?')
    expect(calls[0]!.url).toContain('updated_on')
    expect(calls[0]!.url).toContain('project_id=demo')
    expect(h.commands.deployment.redmine?.apiKey).toBe('key')
    h.store.close()
  })
  it('reads the open issues assigned to the account, so a task assigned before the Source started is not left behind', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    redmine({ '/issues.json': { issues: [issue(7, { assigned_to: user(5, AGENT) })] },
      '/issues/7.json': { issue: issue(7, { assigned_to: user(5, AGENT) }) } })
    await pollRound(h, new AbortController().signal)
    // The round reads the issues assigned to the account, besides the ones that changed.
    expect(calls.some(call => call.url.includes('assigned_to_id=me'))).toBe(true)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([key('redmine-issue', '7')])
    h.store.close()
  })
  it('names the repository of a task by the identifier of its project, which Redmine does not send with the issue', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    redmine({ '/issues.json': { issues: [issue(7, { project: { id: 2, name: 'Demo SDK' } })] },
      '/issues/7.json': { issue: issue(7, { project: { id: 2, name: 'Demo SDK' } }) },
      '/projects.json': { projects: [{ id: 2, identifier: 'sdk' }] } })
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls[0]![0].meta.project).toBe('sdk')
    h.store.close()
  })
  it('stores a Trigger for each new journal, and reads a journal only once', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7, { journals: [journal(11)] }) } })
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([key('redmine-issue', '7'), key('redmine-journal', '11')])
    await pollRound(h, new AbortController().signal)
    // The issue and its journal are read once each.
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([key('redmine-issue', '7'), key('redmine-journal', '11')])
    h.store.close()
  })
  it('delivers a panel reply the panel did not hand over, and records it, so it is delivered once', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    const note = journal(11, { notes: 'Please also cover the last page.\n\n<!-- dsh-superagent-panel:token-1 -->', user: user(5, AGENT) })
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7, { journals: [note] }) } })
    await pollRound(h, new AbortController().signal)
    // The note of the panel reaches the agent through the poll, without the marker in its text.
    const delivered = h.receive.mock.calls.map(call => call[0])
    expect(delivered.map(trigger => trigger.id)).toContain(key('redmine-journal', '11'))
    const reply = delivered.find(trigger => trigger.id === key('redmine-journal', '11'))!
    expect(reply.text).toBe('Please also cover the last page.')
    expect(reply.meta).toMatchObject({ issueId: 7, kind: 'journal' })
    expect(h.store.get(KV.pms.delivered('token-1'))).toBe(true)
    // The next round reads it again, but the recorded token says it was delivered.
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls.filter(call => call[0].id === key('redmine-journal', '11'))).toHaveLength(1)
    h.store.close()
  })
  it('skips a panel reply the panel handed over itself', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    h.store.set(KV.pms.delivered('token-2'), true)
    const note = journal(12, { notes: 'Already delivered.\n\n<!-- dsh-superagent-panel:token-2 -->', user: user(5, AGENT) })
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7, { journals: [note] }) } })
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls.map(call => call[0].id)).not.toContain(key('redmine-journal', '12'))
    h.store.close()
  })
  it('fails the round on a poll error, and keeps the window, so the next round reads it again', async () => {
    const h = host()
    vi.spyOn(Commands.prototype, 'http').mockRejectedValue(new Error('network down'))
    await expect(pollRound(h, new AbortController().signal)).rejects.toThrow('network down')
    const window = h.store.get(KV.redmine.since)
    expect(window).toBeTruthy()
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7) } })
    await pollRound(h, new AbortController().signal)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('redmine-issue', '7'))
    h.store.close()
  })
})

describe('the Redmine channel', () => {
  const message = { id: 'reply-1', channel: { source: SOURCE, thread: `${SOURCE}:7`, address: { issue: '7' } }, text: 'Done.', kind: 'reply' as const }
  it('adds a note on the issue, with a marker that keeps a retry from writing twice', async () => {
    const h = host()
    redmine({ '/issues/7.json': { issue: issue(7, { journals: [] }) } })
    expect(await sendRedmine(h, message)).toBe('sent')
    const note = calls.at(-1)!
    expect(note.method).toBe('PUT')
    // Redmine 4.2 reads the attributes of an issue from the `issue` key of the body.
    expect(JSON.parse(note.body!)).toEqual({ issue: { notes: expect.stringContaining('Done.'), private_notes: false } })
    expect(note.body).toContain('dsh-superagent:reply-1')
    h.store.close()
  })
  it('does not write again when the note is already on the issue', async () => {
    const h = host()
    redmine({ '/issues/7.json': { issue: issue(7, { journals: [journal(11, { notes: 'Done.\n\n<!-- dsh-superagent:reply-1 -->' })] }) } })
    expect(await sendRedmine(h, message)).toBe('sent')
    expect(calls.filter(call => call.method === 'PUT')).toHaveLength(0)
    h.store.close()
  })
  it('reports a gone issue as gone, and any other failure as a failure', async () => {
    const h = host()
    vi.spyOn(Commands.prototype, 'http').mockResolvedValue({ status: 404, body: '{}' })
    expect(await sendRedmine(h, message)).toBe('gone')
    vi.spyOn(Commands.prototype, 'http').mockRejectedValue(new Error('network down'))
    await expect(sendRedmine(h, message)).rejects.toThrow('network down')
    h.store.close()
  })
})

describe('the Redmine Source kind', () => {
  it('listens to every issue of the project and observes only what the operator switched on', () => {
    const config = redmineKind.schema.parse({ baseUrl: BASE, apiKey: 'key', login: AGENT, project: 'demo' })
    expect(redmineKind.scope?.({ meta: { kind: 'issue' } }, config)).toEqual({ listened: true, observed: false, row: 'issue' })
    expect(redmineKind.scope?.({ meta: { kind: 'journal' } }, config)).toEqual({ listened: true, observed: false, row: 'journal' })
    const observed = redmineKind.schema.parse({ baseUrl: BASE, apiKey: 'key', observeIssues: true, observeJournals: true })
    expect(redmineKind.scope?.({ meta: { kind: 'journal' } }, observed)).toEqual({ listened: true, observed: true, row: 'journal' })
  })
  it('names the people who may originate work, and the rows of its admission table', () => {
    const policy = redmineKind.policy!
    expect(policy.schema.parse({}).allowed).toEqual([])
    const rows = policy.rows!({ baseUrl: BASE, apiKey: 'key', observeIssues: true })
    expect(rows.map(row => row.id)).toEqual(['issue', 'journal'])
    expect(rows[0]!.cells.unlistedAddressed).toBe(true)
    expect(rows[0]!.cells.listedUnaddressed).toBe(true)
    expect(rows[1]!.cells.listedUnaddressed).toBe(false)
  })
  it('names the project of the issue that started the ticket, not the watched project', () => {
    const config = redmineKind.schema.parse({ baseUrl: BASE, apiKey: 'key', project: 'demo' })
    const trigger = issueTrigger(issue(7, { project: { id: 2, identifier: 'sdk', name: 'Demo SDK' } }) as never, AGENT_ID, BASE)
    const values = redmineKind.environment!.values
    expect(values({ deployment: testDeployment({ redmine: testRedmine }), config, trigger }).DSH_SUPERAGENT_REDMINE_PROJECT).toBe('sdk')
    // A Trigger without an issue of its own keeps the watched project.
    expect(values({ deployment: testDeployment({ redmine: testRedmine }), config }).DSH_SUPERAGENT_REDMINE_PROJECT).toBe('demo')
  })
  it('registers the kind, reports that it waits for setup, and unregisters it again', async () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
    const h = host({ configured: () => false, sources })
    const disposers: (() => unknown)[] = []
    applyRedmine({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(board.all.redmine).toMatchObject({ state: 'paused', code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(board.all.redmine).toBeUndefined()
    h.store.close()
  })
})
