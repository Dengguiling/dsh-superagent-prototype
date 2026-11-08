import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Store } from '../src/app/store.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { redmineKind } from '../src/sources/redmine.ts'
import { snapshot, threadSummary, ticketSummary, triggerView } from '../src/app/views/records.ts'
import { basisFacts, ticketDetail } from '../src/app/views/tickets.ts'
import { threadDetail } from '../src/app/views/threads.ts'
import { droppedReplies, sourcesStatus } from '../src/app/views/sources.ts'
import { overview } from '../src/app/views/overview.ts'
import { markdown, plain } from '../src/app/views/text.ts'
import { policyHistory } from '../src/app/settings-history.ts'
import { KV } from '../src/kv.ts'
import { feishuLink } from '../src/sources/feishu-channel.ts'
import { feishuChannel, feishuTriggerId } from '../src/sources/feishu-trigger.ts'
import { redmineLink } from '../src/sources/redmine-channel.ts'
import { redmineChannel } from '../src/sources/redmine-trigger.ts'
import { followupOwners, type ChannelRef, type Ticket, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { pms, pmsArchive, pmsDelete, pmsReply, pmsTask } from '../src/app/views/pms.ts'
import { testDeployment, testRedmine } from './fixtures/deployment.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-superagent-views-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks() })
const links = (channel: ChannelRef) => (channel.source === 'feishu' ? feishuLink : redmineLink)(channel.address, {})
const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  const message = { id, channel, text: id, kind: 'reply' as const, ...ticketId ? { ticketId } : {} }
  store.receipts.add(message)
  store.receipts.settle(message, 'channelGone')
}

it('names the Thread of each dropped message: the one of the Trigger its Channel answers, or the Channel\'s own', () => {
  // A Feishu Channel names its chat; the message it answers belongs to the Thread of the topic's root message.
  store.triggers.save({ id: feishuTriggerId('om_reply'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
    actor: { source: 'feishu', id: 'ou_a' }, human: true, at: new Date().toISOString(), text: 'please', meta: {} })
  store.threads.save({ key: 'redmine:42', ref: { source: 'redmine', id: '42' }, createdAt: '', subscriptions: [], correlated: [], pending: [],
    meta: {} })
  drop('a', feishuChannel('oc_1', 'om_reply'))
  drop('b', redmineChannel(42))
  // A message whose Trigger and Thread the store no longer has links nowhere.
  drop('c', feishuChannel('oc_2', 'om_gone'))
  expect(Object.fromEntries(droppedReplies({ store, links }).map(item => [item.id, item.thread])))
    .toEqual({ a: 'feishu:oc_1:om_root', b: 'redmine:42', c: undefined })
})

function views() {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }] },
    redmine: { allowed: [{ id: 'alice' }] } },
    rules: [{ id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Fix copy' }] } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind); sources.register(redmineKind)
  return { store, sources, links }
}
const at = new Date().toISOString()
/** A live ticket with no Assignment, as a follow-up's owner needs one. */
const live = (id: string) => store.tickets.save({ id, title: id, decisionId: 'd', channels: [], undelivered: [], createdAt: at,
  updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
  origin: { triggerId: 'e0', triggerIds: ['e0'] }, assignments: [], inputs: [] })
const message = (id: string, actor: { source: string; id: string }, human = true) => ({ id, source: actor.source,
  threads: [{ source: 'feishu', id: 'oc_1:om_root' }], actor, human, at, text: `message ${id}`, meta: {} })

it('names each sender as the Policy lists it, by its id where the id is readable, and as its kind names one it does not list', () => {
  const view = snapshot(views())
  expect([view.actor({ source: 'feishu', id: 'OU_ALICE' }), view.actor({ source: 'redmine', id: 'alice' }), view.actor({ source: 'redmine',
    id: 'bob' }),
    view.actor({ source: 'feishu', id: 'ou_bob' }), view.actor({ source: 'feishu', id: 'ou_bot' }, false), view.actor({ source: 'feishu',
      id: '' })])
    .toEqual([{ source: 'feishu', id: 'OU_ALICE', name: { zh: 'Alice', en: 'Alice' } }, { source: 'redmine', id: 'alice',
      name: { zh: 'alice', en: 'alice' } },
      { source: 'redmine', id: 'bob', name: redmineKind.policy!.unnamed!.person }, { source: 'feishu', id: 'ou_bob',
        name: feishuKind.policy!.unnamed!.person },
      { source: 'feishu', id: 'ou_bot', name: feishuKind.policy!.unnamed!.bot }, { source: 'feishu', id: '' }])
  expect(view.rule('copy')).toEqual({ id: 'copy', name: 'Copy fixes' })
  expect(view.rule('gone')).toEqual({ id: 'gone', name: 'gone' })
})

it('classifies a Thread by what it is doing, and offers a filtered Trigger of a person to Eval again', () => {
  const host = views()
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: [],
    correlated: [],
    pending: ['e2'], meta: {} })
  store.triggers.save(message('e1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.save(message('e2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.save(message('e3', { source: 'feishu', id: 'ou_bot' }, false))
  for (const id of ['e1', 'e3']) store.triggers.saveDisposition(id, { filtered: { code: 'not_a_member' }, fanout: [], at })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!).stage).toBe('queued')
  const rows = ['e1', 'e2', 'e3'].map(id => triggerView(view, store.triggers.get(id)!))
  // A queued Trigger waits for Eval already, and an automated one is not offered.
  expect(rows.map(row => row.actions.requeue)).toEqual([true, false, false])
  expect(rows[0]!.actor.name).toEqual({ zh: 'Alice', en: 'Alice' })
})

it('states each Source by the first state that holds', () => {
  const host = views()
  const states = (setup: Parameters<typeof sourcesStatus>[2], health: Parameters<typeof sourcesStatus>[1] = {}) =>
    Object.fromEntries(sourcesStatus(host, health, setup).map(source => [source.id, source.state]))
  expect(states({})).toEqual({ feishu: 'starting', redmine: 'starting' })
  expect(states({}, { feishu: { state: 'ready', detail: '' }, history: { state: 'paused', detail: '' }, redmine: { state: 'error',
    detail: 'x' } }))
    .toEqual({ feishu: 'paused', redmine: 'error' })
  const problem = { place: 'deployment', code: 'stateDirUnset', values: {}, detail: '' } as never
  expect(states({ problem }, { feishu: { state: 'ready', detail: '' }, history: { state: 'ready', detail: '' }, redmine: { state: 'ready',
    detail: '' } }))
    .toEqual({ feishu: 'setup', redmine: 'setup' })
})

it('follows the Ticket\'s stage: a blocked Ticket a person answered since is working, with no retry, note or turn end', () => {
  const host = views()
  const blocked = { state: 'blocked' as const, summary: 'Needs the design file', at: '2026-09-22T00:01:00Z' }
  const ticket = { id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit' as const, policyVersion: 'v', basis: { via: 'listed' as const }, actor: { source: 'feishu',
      id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [{ id: 'a1', state: 'running' as const, createdAt: at, startedAt: at,
      report: blocked }],
    inputs: [] as { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }[] }
  store.tickets.save(ticket)
  const row = ticketSummary(store.tickets.get('t1')!)
  expect(row).toMatchObject({ stage: 'person', action: 'blocked', actions: { retry: true }, note: { text: 'Needs the design file',
    error: false } })
  expect(ticketDetail(host, 't1')!.assignments[0]).toMatchObject({ turnEndedAt: blocked.at })
  store.tickets.save({ ...ticket, inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'e2', at: '2026-09-22T00:02:00Z', human: true }] })
  const answered = ticketSummary(store.tickets.get('t1')!)
  expect(answered).toMatchObject({ stage: 'working', actions: { retry: false } })
  expect(answered).not.toHaveProperty('note')
  expect(ticketDetail(host, 't1')!.assignments[0]).not.toHaveProperty('turnEndedAt')
})

it('does not show a follow-up that reached a ticket as waiting for an Eval, though an older version queued it', () => {
  const host = views()
  live('t1')
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_bob' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, at })
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: ['f1'], meta: {} })
  const view = snapshot(host)
  expect(threadSummary(view, store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'subscribed', pending: 0 })
  expect(triggerView(view, store.triggers.get('f1')!).disposition.queued).toBe(false)
  // One a person sent to Eval again waits for it.
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1', 'f2'] })
  expect(threadSummary(snapshot(host), store.threads.get('feishu:oc_1:om_root')!)).toMatchObject({ stage: 'queued', pending: 1 })
})

const load = { running: 0, queued: 0 }
const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, 'v1', load).problems

it('lists an Eval past its deadline, and as dsh-superagent\'s own errors only parts no Source or Policy sync reports', () => {
  const host = views()
  const evaluating = { id: 'e1', threadKey: 'redmine:1', triggerIds: ['t1'], strength: 'explicit' as const, actor: { source: 'redmine',
    id: 'alice' },
    basis: { via: 'addressed' as const, addressed: 'mention' as const }, policyVersion: 'v1', startedAt: '2026-01-01T00:00:00Z',
    deadline: '2026-01-01T00:02:00Z' }
  store.threads.save({ key: 'redmine:1', ref: { source: 'redmine', id: '1' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating, meta: {} })
  const error = (detail: string) => ({ state: 'error' as const, detail })
  const health = { relay: error('relay failing'), reply: error('reply failing'), feishu: error('socket closed'),
    history: error('read failed'),
    'sync:feishu': error('sync failed'), evals: error('unavailable'), launch: { state: 'ready' as const, detail: '' } }
  const found = problems(host, health)
  expect(found).toContainEqual({ kind: 'eval-overdue', thread: expect.objectContaining({ key: 'redmine:1', stage: 'evaluating' }) })
  // Effects are dsh-superagent's own; a Source shows its parts and its Policy sync, and the Evals are listed one by one.
  expect(found.filter(item => item.kind === 'runtime-error')).toEqual([{ kind: 'runtime-error', name: 'relay', detail: 'relay failing' },
    { kind: 'runtime-error', name: 'reply', detail: 'reply failing' }])
  expect(found.filter(item => item.kind === 'source-error').map(item => item.source.health.name)).toEqual(['feishu', 'history'])
})

it('says no Source runs when every Source is off, and states a Source missing or off', () => {
  const host = views()
  expect(problems(host).map(item => item.kind)).not.toContain('no-source')
  const settings = store.settings()
  store.saveSettings({ ...settings, sources: { feishu: { enabled: false, config: {} }, redmine: { enabled: false, config: {} },
    jira: { enabled: true, config: { site: 'acme' } } } })
  expect(problems(host).map(item => item.kind)).toContain('no-source')
  expect(Object.fromEntries(sourcesStatus(host, {}, {}).map(source => [source.id, [source.state, source.installed]])))
    .toEqual({ feishu: ['off', true], redmine: ['off', true], jira: ['missing', false] })
})

it('sends text without HTML, entity-encoded tags included, and with images named', () => {
  const text = '<div>Hello <b>there</b></div> &lt;script&gt;alert(1)&lt;/script&gt; <!-- note --> ![shot](https://x/y.png) [Image: diagram]'
  expect(plain(text)).toBe('Hello there alert(1) [image] [image]')
  expect(markdown(`**Fix** ${text}\n\n- one`)).toBe('**Fix** Hello there alert(1)  [image] [image]\n\n- one')
  expect(plain('[the docs](https://example.com) and `code` &amp; more')).toBe('the docs and code & more')
})

it('words each settings save by what it changed from the one before, and nothing after a gap in the history', () => {
  const host = views()
  const first = store.settings()
  const allowed = (entries: { id: string; name?: string }[]) => ({ ...first.policy, sources: { ...first.policy.sources,
    feishu: { ...first.policy.sources.feishu!, allowed: entries } } })
  const alice = { id: 'ou_alice', name: 'Alice Liu' }, bob = { id: 'ou_bob', name: 'Bob' }
  store.saveSettings({ ...first, policy: allowed([alice, bob, { id: 'ou_carol' }]), paused: true,
    sources: { ...first.sources, feishu: { enabled: false, config: {} } },
    executor: { ...first.executor, directory: '/srv/work', prepare: 'npm ci', blockedCommands: ['rm', 'curl'] } })
  const second = store.settings()
  store.saveSettings({ ...second, policy: allowed([alice, { id: 'ou_carol' }]), paused: false, sources: { ...second.sources,
    feishu: { enabled: true, config: {} } } })
  const changes = (revision: number) => policyHistory(store, host.sources, 'v').items.find(item => item.revision === revision)!.changes
  const revision = store.get(KV.settings.revision)!
  expect(changes(revision - 1)).toEqual([
    { code: 'sourceRowsAdded', source: 'feishu', part: true, field: 'allowed', items: ['Bob', 'ou_carol'] },
    { code: 'sourceRowsChanged', source: 'feishu', part: true, field: 'allowed', items: ['Alice Liu'] },
    { code: 'paused' }, { code: 'executionDirectory', from: '', to: '/srv/work' }, { code: 'prepareCommand' },
    { code: 'blockedCommands', from: '', to: 'rm curl' }, { code: 'sourceDisabled', source: 'feishu' }])
  expect(changes(revision)).toEqual([{ code: 'sourceRowsRemoved', source: 'feishu', part: true, field: 'allowed', items: ['Bob'] },
    { code: 'resumed' }, { code: 'sourceEnabled', source: 'feishu' }])
  // A save whose predecessor is missing from the history has nothing to compare with.
  store.delete(KV.settings.version(revision))
  store.saveSettings({ ...store.settings(), paused: true })
  expect(changes(revision + 1)).toBeNull()
})

it('names a listed bot as the Policy lists it, and gives a bot\'s Mandate a basis fact of its own', () => {
  store.saveSettings(SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [], bots: [{ id: 'cli_review', name: '评审机器人' }] } } } }))
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  const view = snapshot({ store, sources, links })
  expect(view.actor({ source: 'feishu', id: 'cli_review' }, false).name).toEqual({ zh: '评审机器人', en: '评审机器人' })
  expect(basisFacts({ via: 'bot', sender: '评审机器人', addressed: 'mention', observation: { mode: 'auto' } }, view.rule).facts)
    .toEqual([{ name: 'sender', value: '评审机器人' }, { name: 'bot' }, { name: 'addressed', value: 'mention' }, { name: 'mode', value: 'auto' }])
})

it('shows a follow-up that reached a ticket as delivered, the tickets that handed a Trigger back with why, and the Threads a ticket follows for context', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  store.triggers.save(message('f2', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f2', { fanout: ['t1'], requeued: true, handbacks: [{ ticketId: 't1', reason: 'Asks for a new feature', at }], at })
  const view = snapshot(host)
  expect(triggerView(view, store.triggers.get('f1')!).disposition).toMatchObject({ delivered: true, queued: false, handbacks: [] })
  // A Trigger handed back goes to Eval as any message on its Thread; the Ticket that handed it back is named by its title once it has one.
  expect(triggerView(view, store.triggers.get('f2')!).disposition).toMatchObject({ delivered: false,
    handbacks: [{ ticketId: 't1', title: 't1', reason: 'Asks for a new feature' }] })
  store.threads.save({ key: 'redmine:7', ref: { source: 'redmine', id: '7' }, createdAt: at, subscriptions: ['t1'], context: ['t1'],
    correlated: [], pending: [], meta: {} })
  expect(threadDetail(host, 'redmine:7', undefined, 50)?.context).toEqual(['t1'])
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_alice' }, scope: '' },
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [],
    inputs: [{ id: 'i1', kind: 'trigger', triggerId: 'f1', at }, { id: 'i2', kind: 'trigger', triggerId: 'f2', at }] })
  const page = ticketDetail(host, 't1')!
  expect(Object.fromEntries(page.threads.map(thread => [thread.key, !!thread.context]))).toEqual({ 'feishu:oc_1:om_root': false,
    'redmine:7': true })
  expect(page.inputs.map(input => input.kind === 'trigger' && input.trigger?.handback)).toEqual([{ reason: 'Asks for a new feature', at },
    undefined])
  expect(triggerView(snapshot(host), store.triggers.get('f2')!).disposition.handbacks[0]?.title).toBe('Fix')
})

it('names a bot\'s Mandate as a bot once the Policy no longer lists it', () => {
  const host = views()
  const mandate = { strength: 'inferred' as const, policyVersion: 'v', basis: { via: 'bot' as const,
    observation: { mode: 'auto' as const } },
    actor: { source: 'feishu', id: 'cli_removed' }, scope: '' }
  store.tickets.save({ id: 't1', title: 'Fix', decisionId: 'd', channels: [], undelivered: [], createdAt: at, updatedAt: at, mandate,
    origin: { triggerId: 'e1', triggerIds: ['e1'] }, assignments: [], inputs: [] })
  expect(ticketDetail(host, 't1')!.mandate.actor).toEqual({ source: 'feishu', id: 'cli_removed', name: feishuKind.policy!.unnamed!.bot })
})

it('offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [],
    pending: [], meta: {} })
  store.triggers.save(message('f1', { source: 'feishu', id: 'ou_alice' }))
  store.triggers.saveDisposition('f1', { fanout: ['t1'], at })
  const row = () => triggerView(snapshot(host), store.triggers.get('f1')!)
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } })
  // A ticket that ended after its worker had it leaves it to nobody: a person may still send it to Eval.
  store.tickets.save({ ...store.tickets.get('t1')!, ended: { at, by: 'executor', reason: 'done', outcome: 'completed' } })
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } })
  // Not once its worker acknowledged it, which took it up; a stop on it decided only the ticket's work.
  store.triggers.saveDisposition('f1', { fanout: ['t1'], acked: ['t1'], at })
  expect(row().actions.requeue).toBe(false)
  store.decisions.save({ id: 'stop', evalId: 'e', threadKey: 'feishu:oc_1:om_root', triggerIds: ['f1'], policyVersion: 'v', at, kind: 'stop',
    reason: [{ code: 'humanStop' }], strength: 'explicit', ticketId: 't1' })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // So once the stop ended the ticket, which let go of the message, as the Engine records it.
  store.triggers.saveDisposition('f1', { fanout: [], decisionId: 'stop', at })
  expect(row().actions.requeue).toBe(true)
  // Once sent, it waits for the Eval.
  store.threads.save({ ...store.threads.get('feishu:oc_1:om_root')!, pending: ['f1'] })
  store.triggers.saveDisposition('f1', { fanout: ['t1'], requeued: true, at })
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } })
})

it('reads each ticket a page\'s follow-ups reached once, and nothing for a message no ticket can decide', () => {
  const host = views()
  live('t1')
  store.threads.save({ key: 'feishu:oc_1:om_root', ref: { source: 'feishu', id: 'oc_1:om_root' }, createdAt: at, subscriptions: ['t1'],
    correlated: [], pending: [], meta: {} })
  for (const id of ['f1', 'f2', 'f3']) {
    store.triggers.save(message(id, { source: 'feishu', id: 'ou_alice' }))
    store.triggers.saveDisposition(id, { fanout: ['t1'], at })
  }
  const view = snapshot(host)
  const tickets = vi.spyOn(store.tickets, 'get')
  expect(['f1', 'f2', 'f3'].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([true, true, true])
  expect(tickets).toHaveBeenCalledOnce()
  tickets.mockRestore()
  // A message the ticket handed back is decided by no ticket, which needs no read.
  store.triggers.saveDisposition('f3', { fanout: ['t1'], handbacks: [{ ticketId: 't1', reason: 'Another change', at }], at })
  const records = { tickets: { get: vi.fn() }, threads: { get: vi.fn() }, triggers: store.triggers }
  expect(followupOwners(store.triggers.get('f3')!, records)).toEqual([])
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0])
})

const INBOX_AT = '2026-11-05T00:00:00Z'
/** An open issue of the demo SDK, assigned to the bound account. */
const inboxIssue = (id: number, fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, subject: `Fix the login ${id}`, description: 'The login button does nothing.',
  project: { id: 1, identifier: 'sdk', name: 'Demo SDK' },
  tracker: { id: 1, name: 'Bug' }, status: { id: 1, name: 'New' }, priority: { id: 2, name: 'Normal' },
  author: { id: 1, name: 'Team Leader', login: 'li.na' }, assigned_to: { id: 5, name: 'Software Developer', login: 'dev' },
  created_on: '2026-11-04T00:00:00Z', updated_on: INBOX_AT, ...fields,
})
/** A ticket of the fixture: held for the deployment's Redmine account, with no assignment yet. */
const inboxTicket = (id: string, fields: Partial<Ticket> = {}): Ticket => ({ id, title: id, decisionId: 'd', channels: [], undelivered: [],
  createdAt: at, updatedAt: at,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'redmine', id: 'dev' }, scope: '' },
  origin: { triggerId: 'none', triggerIds: [] }, assignments: [], inputs: [], ...fields })
/** A Redmine Trigger of an issue, as the Source builds it. */
const inboxTrigger = (id: string, issueId: number | undefined, when: string): Trigger => ({ id, source: 'redmine',
  threads: [{ source: 'redmine', id: String(issueId ?? 1) }], actor: { source: 'redmine', id: 'li.na' }, human: true, at: when, text: id,
  meta: issueId === undefined ? {} : { issueId } })
/** A Commands stub that answers the open-issue list with `issues`, URL-report and any other path with `others`. */
function inboxCommands(issues: Record<string, unknown>[], answers: Record<string, { status: number; body: string }> = {}) {
  const deployment = testDeployment({ redmine: testRedmine })
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async url => {
    if (url.includes('/issues.json')) return { status: 200, body: JSON.stringify({ issues }) }
    const path = url.replace('http://redmine.test', '').split('?')[0]!
    // The instance answers which statuses are closed; an issue in one of them is finished.
    if (path === '/issue_statuses.json') return { status: 200, body: JSON.stringify({ issue_statuses: [
      { id: 1, name: 'New', is_closed: false }, { id: 5, name: 'Closed', is_closed: true }] }) }
    return answers[path] ?? { status: 404, body: '{"errors":["Not found"]}' }
  })
  return { deployment, commands: new Commands(() => deployment, {}, new AbortController().signal) }
}
/** Seeds the inbox work: a ticket for issue 7 that follows change 1003, and the rest of the pipeline. */
function inboxWork(): void {
  store.saveSettings(SettingsSchema.parse({ executor: { maxWorkers: 4 } }))
  store.triggers.save(inboxTrigger('e7', 7, at))
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString()
  for (const id of ['e9', 'e10']) store.triggers.save(inboxTrigger(id, undefined, at))
  store.triggers.save(inboxTrigger('e-old', undefined, twoDaysAgo))
  // A taken ticket still queued and following a change, another waiting for a person, one idle between turns, and one ended today.
  store.tickets.save(inboxTicket('t-taken', { follows: [{ thread: 'gerrit:1003', own: true }],
    origin: { triggerId: 'e7', triggerIds: ['e7'] } }))
  store.tickets.save(inboxTicket('t-waiting', { attention: { id: 'q1', question: 'Which colour?' } }))
  store.tickets.save(inboxTicket('t-idle', { assignments: [{ id: 'a1', state: 'running', createdAt: at,
    report: { state: 'waiting', summary: 'Waiting for a reply', at } }] }))
  store.tickets.save(inboxTicket('t-ended', { ended: { at, by: 'executor', outcome: 'completed' } }))
  store.tickets.save(inboxTicket('t-ended-old', { ended: { at: twoDaysAgo, by: 'human', outcome: 'stopped' } }))
  // One Eval runs now; another Thread merely holds a Trigger for the next one.
  store.threads.save({ key: 'redmine:7', ref: { source: 'redmine', id: '7' }, createdAt: at, subscriptions: [], correlated: [], pending: [],
    evaluating: { id: 'ev1', threadKey: 'redmine:7', triggerIds: ['e7'], strength: 'explicit', actor: { source: 'redmine', id: 'li.na' },
      basis: { via: 'listed' }, policyVersion: 'v', startedAt: at, deadline: at }, meta: {} })
  store.threads.save({ key: 'redmine:8', ref: { source: 'redmine', id: '8' }, createdAt: at, subscriptions: [], correlated: [], pending: ['e9'],
    meta: {} })
}

it('files the tasks the route did not take under their own filter, with the reason it gave', async () => {
  inboxWork()
  const { deployment, commands } = inboxCommands([inboxIssue(7), inboxIssue(8)])
  // Before the judgement the task waits for it: it is neither declined nor worked on.
  expect((await pms(store, commands, deployment, 0)).tasks.map(task => [task.id, task.state])).toEqual([[7, 'working'], [8, 'undecided']])
  // The route judged the second task and did not take it: the sender is not on the list of the source.
  store.decisions.save({ id: 'd1', evalId: 'ev2', threadKey: 'redmine:8', triggerIds: ['e9'], policyVersion: 'v', at,
    kind: 'ignore', reason: [{ code: 'not_a_member' }], strength: 'inferred' })
  const view = await pms(store, commands, deployment, 0)
  // The task the agent works on stays in the inbox, the one it declined has its own list with the reason.
  expect(view.tasks.map(task => task.id)).toEqual([7])
  expect(view.tasks[0]).toMatchObject({ id: 7, state: 'working' })
  expect(view.declined).toMatchObject([{ id: 8, state: 'declined', reason: 'not_a_member' }])
})

it('builds the task inbox from the issues assigned to the bound account, the operator\'s list state, and the tickets held for them', async () => {
  inboxWork()
  // The task system lists four bugs assigned to the account; the operator archived one and hid another for good.
  const { deployment, commands } = inboxCommands([inboxIssue(7), inboxIssue(8), inboxIssue(9, { project: { id: 2, identifier: 'sdk-cli' } }),
    inboxIssue(10)])
  store.set(KV.pms.task(9), { archivedAt: at })
  store.set(KV.pms.task(10), { deletedAt: at })
  const view = await pms(store, commands, deployment, 2)
  // The inbox is the live read; the archived task leaves the list, the hidden one is gone, and the ticket is named with its change and Session.
  expect(view.tasks.map(task => task.id)).toEqual([7, 8])
  expect(view.archived.map(task => [task.id, task.archivedAt])).toEqual([[9, at]])
  expect(view.tasks[0]).toMatchObject({ id: 7, subject: 'Fix the login 7', status: 'New', priority: 'Normal', assignee: 'Software Developer',
    author: 'Team Leader', project: 'sdk', updated: INBOX_AT, url: 'http://redmine.test/issues/7',
    ticket: { id: 't-taken', title: 't-taken', stage: 'working', change: 1003, session: 'worker-t-taken' } })
  expect(view.tasks[1]).toMatchObject({ id: 8, project: 'sdk' })
  expect(view.tasks[1]).not.toHaveProperty('ticket')
  // The pipeline counts the tasks of the inbox, the Triggers of the last day, and the work in the Executor now.
  // The Eval stage holds both the Thread under evaluation and the one whose Trigger waits for the next Eval.
  expect(view.pipeline).toEqual({ tasks: 2, taken: 1, arrived: 3, sources: 0, threads: 0, evaluating: 2, tickets: 3, working: 1, queued: 1, waiting: 1, idle: 1, ended: 1 })
  expect(view.executor).toEqual({ running: 2, max: 4, paused: false })
  expect(view.source).toEqual({ name: 'agent', url: 'http://redmine.test', configured: true, connected: true })
  // A task system that does not answer leaves the inbox empty and says why, but the pipeline is still there.
  vi.spyOn(Commands.prototype, 'http').mockRejectedValue(new Error('network down'))
  const down = await pms(store, commands, deployment, 0)
  expect([down.tasks, down.archived]).toEqual([[], []])
  expect(down.source).toEqual({ name: 'agent', url: 'http://redmine.test', configured: true, connected: false, error: 'network down' })
  expect(down.pipeline).toEqual({ tasks: 0, taken: 0, arrived: 3, sources: 0, threads: 0, evaluating: 2, tickets: 3, working: 1, queued: 1, waiting: 1, idle: 1, ended: 1 })
  // An HTTP error is reported like any other failure.
  vi.spyOn(Commands.prototype, 'http').mockResolvedValue({ status: 404, body: '{"errors":["Not found"]}' })
  expect((await pms(store, commands, deployment, 0)).source).toMatchObject({ connected: false, error: expect.stringContaining('404') })
  // Without a task system in the deployment there is none to configure or connect to, and nothing is read.
  expect((await pms(store, commands, testDeployment(), 0)).source).toEqual({ name: '', url: '', configured: false, connected: false })
})

it('reads a task\'s conversation: the description, then the notes with their markers stripped and their roles', async () => {
  const journal = (id: number, notes: string, user: { id: number; name?: string } = { id: 1, name: 'Team Leader' }) =>
    ({ id, notes, user, created_on: `2026-11-0${id - 10}T00:00:00Z` })
  const issue = inboxIssue(7, { journals: [
    journal(11, 'The retry tests need to pass too.'),
    journal(12, 'Panel answer\n\n<!-- dsh-superagent-panel:6f0c -->', { id: 5, name: 'Software Developer' }),
    journal(13, 'Patch is pushed\n\n<!-- dsh-superagent:reply-1 -->', { id: 5, name: 'Software Developer' }),
    journal(14, 'Looks good.', { id: 5, name: 'Software Developer' }),
    // A field change without a note is not part of the conversation.
    { id: 15, notes: '', user: { id: 5, name: 'Software Developer' }, details: [{ property: 'status_id', name: 'Status', old_value: '1', new_value: '2' }] },
  ] })
  const { deployment, commands } = inboxCommands([issue], { '/issues/7.json': { status: 200, body: JSON.stringify({ issue }) } })
  const detail = await pmsTask(store, commands, deployment, 7)
  expect(detail?.task).toMatchObject({ id: 7, project: 'sdk', url: 'http://redmine.test/issues/7' })
  expect(detail?.canReply).toBe(true)
  expect(detail?.source).toEqual({ name: 'agent', url: 'http://redmine.test', configured: true, connected: true })
  expect(detail?.messages.map(message => [message.role, message.name, message.text, message.url])).toEqual([
    ['other', 'Team Leader', 'The login button does nothing.', 'http://redmine.test/issues/7'],
    ['other', 'Team Leader', 'The retry tests need to pass too.', 'http://redmine.test/issues/7#change-11'],
    ['you', 'Software Developer', 'Panel answer', 'http://redmine.test/issues/7#change-12'],
    ['agent', 'Software Developer', 'Patch is pushed', 'http://redmine.test/issues/7#change-13'],
    ['you', 'Software Developer', 'Looks good.', 'http://redmine.test/issues/7#change-14'],
  ])
  // A task the operator hid, an issue assigned to someone else, and a missing issue are not tasks of the inbox.
  store.set(KV.pms.task(8), { deletedAt: at })
  expect(await pmsTask(store, commands, deployment, 8)).toBeUndefined()
  const foreign = inboxIssue(9, { assigned_to: { id: 99, name: 'Someone Else' } })
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async () => ({ status: 200, body: JSON.stringify({ issue: foreign }) }))
  expect(await pmsTask(store, commands, deployment, 9)).toBeUndefined()
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async () => ({ status: 404, body: '{"errors":["Not found"]}' }))
  expect(await pmsTask(store, commands, deployment, 7)).toBeUndefined()
  // Without a task system there is no conversation to read.
  expect(await pmsTask(store, commands, testDeployment(), 7)).toBeUndefined()
})

it('shows the formatting of Redmine as plain text: a heading loses its marker, inline code keeps its code, a bullet a dot', async () => {
  const issue = inboxIssue(7, { description: 'h3. Symptoms\n\nThe page @count@ is wrong.\n\n* first\n* second\n' })
  const { deployment, commands } = inboxCommands([issue], { '/issues/7.json': { status: 200, body: JSON.stringify({ issue }) } })
  const detail = await pmsTask(store, commands, deployment, 7)
  expect(detail?.messages[0]?.text).toBe('Symptoms\n\nThe page `count` is wrong.\n\n• first\n• second')
})

it('posts a panel reply as a marker note, then delivers it to the agent at once as a human Trigger of the issue', async () => {
  const issue = inboxIssue(7)
  const put: { body?: string } = {}
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => {
    if (init.method === 'PUT') { put.body = init.body; return { status: 204, body: '' } }
    return { status: 200, body: JSON.stringify({ issue }) }
  })
  const deployment = testDeployment({ redmine: { ...testRedmine, name: 'Software Developer' } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn()
  await pmsReply(store, commands, deployment, 7, 'On it.', receive)
  // The note is on the issue at once, with a panel marker the poll skips, and without the agent's outbox marker.
  const notes = (JSON.parse(put.body!).issue as { notes: string }).notes
  expect(notes).toMatch(/^On it\.\n\n<!-- dsh-superagent-panel:[^>]+ -->$/)
  expect(notes).not.toContain('<!-- dsh-superagent:')
  // The Trigger is the operator's own human message on the issue, addressed to the agent because the issue is assigned to them.
  expect(receive).toHaveBeenCalledTimes(1)
  expect(receive.mock.calls[0]![0]).toMatchObject({ source: 'redmine', threads: [{ source: 'redmine', id: '7' }], human: true,
    addressed: 'direct', text: 'On it.', url: 'http://redmine.test/issues/7', channel: { source: 'redmine', thread: 'redmine:7',
      address: { issue: '7' } }, meta: { issueId: 7, project: 'sdk', kind: 'journal' } })
  expect(receive.mock.calls[0]![0].actor).toEqual({ source: 'redmine', id: 'Software Developer' })
  // An issue assigned to someone else is still answered, but the note does not claim to address the agent.
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => init.method === 'PUT'
    ? { status: 204, body: '' } : { status: 200, body: JSON.stringify({ issue: inboxIssue(7, { assigned_to: null }) }) })
  await pmsReply(store, commands, deployment, 7, 'Please look.', receive)
  expect(receive.mock.calls[1]![0]).not.toHaveProperty('addressed')
})

it('records the panel reply it handed to the agent, so the Source does not deliver the note twice', async () => {
  const issue = inboxIssue(7)
  const put: { body?: string } = {}
  vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => {
    if (init.method === 'PUT') { put.body = init.body; return { status: 204, body: '' } }
    return { status: 200, body: JSON.stringify({ issue }) }
  })
  const deployment = testDeployment({ redmine: { ...testRedmine, name: 'Software Developer' } })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  await pmsReply(store, commands, deployment, 7, 'On it.', vi.fn())
  // The token of the note is the key of the record that tells the Source the note was delivered.
  const token = /dsh-superagent-panel:([^>]+?)-->/.exec((JSON.parse(put.body!).issue as { notes: string }).notes)![1]!.trim()
  expect(store.get(KV.pms.delivered(token))).toBe(true)
})

it('keeps an archived task in the list after the issue is closed, and hides a closed task that was not archived', async () => {
  const closed = { id: 5, name: 'Closed' }
  const { deployment, commands } = inboxCommands([
    inboxIssue(7, { status: { id: 5, name: 'Closed' } }), inboxIssue(8, { status: { id: 1, name: 'New' } })])
  store.set(KV.pms.task(7), { archivedAt: at })
  const view = await pms(store, commands, deployment, 0)
  expect(view.archived.map(task => task.id)).toEqual([7])
  expect(view.tasks.map(task => task.id)).toEqual([8])
})

it('archives, restores and deletes tasks in the operator\'s own list, never in the task system', () => {
  pmsArchive(store, 7, true)
  expect(store.get(KV.pms.task(7))).toEqual({ archivedAt: expect.any(String) })
  const archivedAt = store.get(KV.pms.task(7))!.archivedAt
  // Archiving again keeps the time it was archived at.
  pmsArchive(store, 7, true)
  expect(store.get(KV.pms.task(7))!.archivedAt).toBe(archivedAt)
  pmsArchive(store, 7, false)
  expect(store.get(KV.pms.task(7))).toBeUndefined()
  // A hidden task keeps its archive time, and restoring an archived one does not unhide it.
  pmsArchive(store, 8, true)
  pmsDelete(store, 8)
  expect(store.get(KV.pms.task(8))).toMatchObject({ archivedAt: expect.any(String), deletedAt: expect.any(String) })
  pmsArchive(store, 8, false)
  expect(store.get(KV.pms.task(8))).toMatchObject({ deletedAt: expect.any(String) })
  expect(store.get(KV.pms.task(8))).not.toHaveProperty('archivedAt')
})
