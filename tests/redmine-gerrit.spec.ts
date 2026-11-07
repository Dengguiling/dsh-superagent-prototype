/**
 * The whole loop of a corporate installation: a Redmine issue becomes a Trigger, the Trigger opens a Ticket, the agent
 * submits a patch to Gerrit and the change is bound to that Ticket, a review comment on the change reaches the worker,
 * and the merge of the change ends the Ticket with a notice back to the issue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Assignment, type Candidate, type Executor, type OutboundMessage, type Policy, type Ticket, type Trigger } from '../src/core/index.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { redmineKind } from '../src/sources/redmine.ts'
import { issueTrigger } from '../src/sources/redmine-trigger.ts'
import { gerritKind } from '../src/sources/gerrit.ts'
import { changeEndNotices, claimChange, observeChange } from '../src/sources/gerrit-change.ts'
import { commentTrigger } from '../src/sources/gerrit-trigger.ts'
import { Store } from '../src/app/store.ts'
import { ticketEnvironment } from '../src/app/execution-environment.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { testDeployment, testGerrit, testRedmine } from './fixtures/deployment.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://redmine.test'
const HTTP = 'http://gerrit.test:8080'
const AGENT = { id: 5, login: 'agent' }
const ALICE = 'Alice Smith'
let directory = ''

/** The issue a person opened, addressed to the agent. */
const issue = { id: 7, subject: 'Fix the login', description: 'The login button does nothing. @agent please fix it.',
  project: { id: 1, name: 'Demo' }, tracker: { id: 1, name: 'Bug' }, status: { id: 1, name: 'New' }, priority: { id: 2, name: 'Normal' },
  author: { id: 3, name: ALICE }, assigned_to: null, created_on: '2026-09-01T00:00:00Z', updated_on: '2026-09-01T00:00:00Z' }
/** The change the agent pushed for that issue. */
const change = (fields: Record<string, unknown> = {}) => ({
  _number: 1003, id: 'demo~main~Iabc', project: 'demo', branch: 'main', subject: 'Fix the login', topic: '',
  status: 'NEW', owner: { username: 'agent', name: 'Super Agent' }, created: '2026-09-01 00:00:00.000000000',
  updated: '2026-09-01 00:00:00.000000000', current_revision: 'abc123',
  revisions: { abc123: { fetch: { url: 'ssh://gerrit:29418/demo', ref: 'refs/changes/03/1003/1' },
    commit: { message: 'Fix the login\n\nIssue: 7\n\nChange-Id: Iabc\n' } } },
  messages: [], labels: {}, ...fields,
})

/** The Trigger of a Redmine issue, as a Ticket's origin. */
const request = (issue = 7, project = 'demo'): Trigger => ({ id: 'trigger-1', source: 'redmine', threads: [{ source: 'redmine', id: String(issue) }],
  actor: { source: 'redmine', id: ALICE }, human: true, at: '2026-09-01T00:00:00Z', text: 'Fix the login', meta: { issueId: issue, project } })
/** A Ticket that works on the issue, with its execution name. */
const ticket = (fields: Partial<Ticket> = {}): Ticket => ({ id: 'ticket-1', title: 'Fix the login', decisionId: 'd-1',
  mandate: { strength: 'explicit', policyVersion: '', basis: { via: 'listed' }, actor: { source: 'redmine', id: ALICE }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
  origin: { triggerId: 'trigger-1', triggerIds: [] }, execution: { name: 'fix-login', directory: '/w/fix-login', assignment: '' }, ...fields })

function harness(gerritAccount = testGerrit, gerritConfig: Record<string, unknown> = {}) {
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    policy: { sources: { redmine: { allowed: [{ id: ALICE }] }, gerrit: { allowed: [{ id: 'bob' }] } } }, eval: { mode: 'auto' },
    sources: { redmine: { enabled: true, config: { baseUrl: BASE, apiKey: 'key', login: 'agent', project: 'demo' } },
      gerrit: { enabled: true, config: { httpUrl: HTTP, project: 'demo', user: 'agent', password: 'secret', branch: 'main', ...gerritConfig } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(redmineKind); sources.register(gerritKind)
  const deployment = testDeployment({ redmine: testRedmine, gerrit: gerritAccount })
  const outbox: OutboundMessage[] = []
  const requests: Candidate[] = []
  const assessor: Assessor = { request: candidate => { requests.push(candidate) }, release: () => {} }
  const launched: Assignment[] = []
  const executor: Executor = { start: vi.fn((_ticket, assignment) => { launched.push(assignment) }), deliver: vi.fn(), stop: vi.fn() }
  // The gate admits a person on the list, and a follow-up on a thread a Ticket follows.
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: trigger => trigger.actor.id === ALICE || trigger.actor.id === 'bob'
      ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not on the list' },
    revalidate: () => true, admitsInferred: () => true,
  }
  const engine = new Engine({ repo: store, scope: sources, policy: () => policy, assessor, executor,
    outbox: { send: message => { if (!outbox.some(item => item.id === message.id)) outbox.push(message) },
      status: id => (outbox.some(item => item.id === id) ? 'pending' : undefined), withdraw: () => {} },
    prepareTicket: (ticket): Ticket => ({ ...ticket, execution: { name: 'fix-login', directory: '/w/fix-login', assignment: '' } }) })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive: trigger => engine.receive(trigger) }
  const redmine = sourceContextOf(parts, redmineKind)
  const gerrit = sourceContextOf(parts, gerritKind)
  return { store, engine, requests, outbox, redmine, gerrit, parts, launched }
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'loop-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('the loop of a corporate installation', () => {
  it('turns a Redmine issue into a Ticket, binds the patch to it, and ends it when the change merges', async () => {
    const h = harness()
    // A person opens an issue and addresses the agent.
    const trigger = issueTrigger(issue as never, AGENT, BASE)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.actor).toEqual({ source: 'redmine', id: ALICE })
    h.engine.receive(trigger)
    h.engine.evaluateDue()
    expect(h.requests).toHaveLength(1)
    // The assessment accepts it, and the Ticket opens.
    h.engine.decide(h.requests[0]!.triggers[0]!.id, { kind: 'accept', title: 'Fix the login', scope: 'the login button',
      reason: 'asked for', acknowledgement: 'On it', intent_evidence: 'the issue asks for the fix' } as never)
    const ticket = h.store.tickets.list()[0]!
    expect(ticket.title).toBe('Fix the login')
    expect(ticket.execution?.name).toBe('fix-login')
    expect(ticket.follows ?? []).toEqual([])

    // The worker starts, and the agent reports that it pushed the patch.
    const assignment = h.launched[0]!
    h.engine.assignmentStarted(ticket.id, assignment.id)
    h.engine.report(ticket.id, { state: 'progress', summary: 'Pushed the patch for review' })

    // The change it pushed is bound to the Ticket as its own patch.
    expect(claimChange(h.gerrit, ticket.id, change() as never)).toBeUndefined()
    expect(h.store.tickets.get(ticket.id)!.follows).toEqual([{ thread: 'gerrit:1003', own: true }])

    // A reviewer comments on the change; the comment carries the change's Thread and the issue's, and reaches the Ticket.
    const comment = { id: 'Ic1', message: 'Please rename this.', author: { username: 'bob', name: 'Bob' },
      created: '2026-09-02 10:00:00.000000000', path: 'src/app.ts', line: 12 }
    const review = commentTrigger(change() as never, comment as never, 'agent', HTTP, '7')!
    expect(review.threads).toEqual([{ source: 'gerrit', id: '1003' }, { source: 'redmine', id: '7' }])
    expect(review.meta).toMatchObject({ issueId: 7 })
    h.engine.receive(review)
    h.engine.evaluateDue()
    // The comment reaches the worker of the Ticket that follows the change, rather than a new assessment.
    expect(h.requests).toHaveLength(1)
    expect(h.store.tickets.get(ticket.id)!.inputs.map(input => input.kind === 'trigger' ? input.triggerId : '')).toContain(review.id)

    // A person merges the change; the Ticket waits for the worker to finish.
    expect(await observeChange(h.gerrit, change({ status: 'MERGED' }) as never)).toBe(true)
    expect(h.store.tickets.get(ticket.id)!.ended).toBeUndefined()
    // The worker reports that it is done, and the Ticket ends with the change.
    h.engine.report(ticket.id, { state: 'ready', summary: 'The patch is ready for review' })
    const ended = h.store.tickets.get(ticket.id)!
    expect(ended.ended?.outcome).toBe('merged')

    // The outcome goes back to the issue as a notice.
    const notices = changeEndNotices(ended, 'Fix the login', HTTP, 'demo')
    expect(notices.map(notice => notice.text)).toEqual([`[Gerrit change 1003](${HTTP}/#/c/demo/+/1003) has been merged.`])
    h.store.close()
  })

  it('refuses a change that names another task', () => {
    const h = harness()
    h.store.tickets.save(ticket())
    h.store.triggers.save(request())
    expect(claimChange(h.gerrit, 'ticket-1', change({ revisions: { abc123: { commit: { message: 'Other task\n\nIssue: 99\n' } } } }) as never))
      .toContain('does not name this ticket')
    h.store.close()
  })

  it('tracks a patch for a ticket in another repository, and names that repository to the worker', () => {
    const h = harness({ ...testGerrit, project: '' }, { project: '' })
    h.store.triggers.save(request(7, 'sdk'))
    h.store.tickets.save(ticket())
    const sdk = change({ project: 'sdk', id: 'sdk~main~Iabc' })
    expect(claimChange(h.gerrit, 'ticket-1', sdk as never)).toBeUndefined()
    expect(h.store.tickets.get('ticket-1')!.follows).toEqual([{ thread: 'gerrit:1003', own: true }])
    // The prepare command clones the repository the issue's project names, since no project is configured.
    const values = Object.fromEntries(ticketEnvironment({ deployment: h.parts.deployment, sources: h.parts.sources, settings: h.store.settings(),
      ticket: h.store.tickets.get('ticket-1')!, trigger: h.store.triggers.get('trigger-1') }).map(variable => [variable.key, variable.value]))
    expect(values).toMatchObject({ DSH_SUPERAGENT_GERRIT_PROJECT: 'sdk', DSH_SUPERAGENT_GERRIT_SSH_URL: 'ssh://agent@gerrit.test:29418/sdk',
      DSH_SUPERAGENT_GERRIT_PUSH_REF: 'refs/for/main', DSH_SUPERAGENT_GERRIT_CHANGE_NUMBER: '' })
    h.store.close()
  })
})
