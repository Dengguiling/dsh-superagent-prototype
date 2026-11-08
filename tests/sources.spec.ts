import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Engine, MemoryRepositories, key, type Assessor, type Executor, type Thread, type Ticket, type Trigger } from '../src/core/index.ts'
import { backfillChat, consumerRetry, feishuKind, feishuTriggerId, feishuRef, feishuTime, feishuTrigger, historyEvent }
  from '../src/sources/feishu.ts'
import { KV } from '../src/kv.ts'
import { apply as applyFeishu, pollThreads as pollFeishuThreads } from '../src/sources/feishu.ts'
import { runFeishu } from '../src/sources/feishu-loops.ts'
import { apply as applyRedmine, pollFailure, pollRound as pollRedmine, redmineKind } from '../src/sources/redmine.ts'
import { issueTrigger, journalTrigger, SOURCE as REDMINE_SOURCE } from '../src/sources/redmine-trigger.ts'
import { apply as applyGerrit, gerritKind, pollRound as pollGerrit } from '../src/sources/gerrit.ts'
import { commentTrigger, messageTrigger, SOURCE as GERRIT_SOURCE } from '../src/sources/gerrit-trigger.ts'
import { changeEndNotices, changeOf, claimChange, observeChange, ticketTopic } from '../src/sources/gerrit-change.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { cursorAt, POLL_HORIZON_MS } from '../src/sources/poll.ts'
import { Store } from '../src/app/store.ts'
import { Commands, commandError } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment, testGerrit, testRedmine } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { SetupError, type SetupProblem } from '../src/setup.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MEMBER = 'ou_alice'
function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), 'sources-')), 'db.sqlite'))
  const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' }, redmine: { allowed: [{ id: 'alice' }] }, gerrit: { allowed: [{ id: 'bob' }] } } }, eval: { mode: 'auto' }, sources: { feishu: { enabled: true, config: { chats: [{ chatId: 'oc_team', listen: 'mentions' }, { chatId: 'oc_observed', listen: 'all' }], directMessages: true } }, redmine: { enabled: true, config: { baseUrl: 'http://redmine.test', apiKey: 'key' } }, gerrit: { enabled: true, config: { httpUrl: 'http://gerrit.test:8080', project: 'demo', user: 'agent', password: 'secret' } } } })
  store.saveSettings(settings)
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  const deployment = testDeployment({ redmine: testRedmine, gerrit: testGerrit })
  sources.register(feishuKind); sources.register(redmineKind); sources.register(gerritKind)
  // The poll tests describe ordinary rounds; the first round records what it saw instead of receiving it.
  store.set('gerrit-initialized', true)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  // Record outbound messages in the store without sending them.
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  // The Sources' functions take the context; plugin entries and kind callbacks take the host, which builds each kind's context.
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  const context = sourceContextOf(parts, { kind: 'feishu', health: ['feishu', 'history'] })
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor }
}
const healthOf = new WeakMap<SourceRegistry, HealthBoard>()
function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board)
  healthOf.set(sources, board)
  return sources
}
const subscribed = (h: ReturnType<typeof host>, ref: { source: string; id: string }, meta: Record<string, unknown> = {}) =>
  h.store.threads.save({ key: `${ref.source}:${ref.id}`, ref, createdAt: new Date().toISOString(), subscriptions: ['ticket'], correlated: [], pending: [], meta })
const openTicket = (id: string): Ticket => ({ id, title: id, decisionId: `d-${id}`, mandate: { strength: 'explicit', policyVersion: '',
  basis: { via: 'listed' }, actor: { source: 'redmine', id: 'alice' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: `source-${id}`, triggerIds: [] } })
const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: '' })
describe('feishu source', () => {
  it('registers its kind without a bot, and names on its health what setup still needs', async () => {
    const run = async (overrides: Partial<SourceContextDeps>) => {
      // The fixture's registry already holds the kind; this one starts empty so the plugin's registration shows.
      const value = host({ sources: emptyRegistry(), ...overrides })
      const disposers: (() => unknown)[] = []
      applyFeishu({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
      await vi.waitFor(() => expect(value.health.history).toBeDefined())
      const registered = value.sources.kind('feishu')
      // Snapshot health before disposal clears the registered entries.
      const health = { ...value.health }
      for (const dispose of disposers) await dispose()
      return { ...value, registered, health }
    }
    const unset = await run({ deployment: testDeployment({ feishu: undefined }) })
    expect(unset.registered).toBe(feishuKind)
    expect(unset.health).toMatchObject({ feishu: { state: 'paused', code: 'feishuCliUnset' }, history: { state: 'paused', code: 'feishuBotMissing' } })
    const problem = new SetupError('feishuBotNotReady', { app: 'cli_bot', status: 'missing' }).problem
    const refused = await run({ deployment: testDeployment({ feishu: undefined }), feishuProblem: problem })
    // A failed bot check waits for the operator's fix and a check; it does not retry by itself like a polling error.
    expect(refused.health.feishu).toEqual({ state: 'paused', detail: problem.detail })
    expect((await run({ configured: () => false })).health.feishu).toEqual({ state: 'paused', detail: 'Waiting for the deployment check', code: 'setupPending' })
  })
  it('translates live events into triggers keyed by root message, and drops the bot\'s own messages', () => {
    const trigger = feishuTrigger({ message_id: 'om_2', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1757376000000', mentions: [{ id: 'cli_bot' }], root_id: 'om_1', parent_id: 'om_1', thread_id: 'omt_1', message_app_link: 'https://applink/x' }, 'ou_bot', 'cli_bot')!
    expect(trigger).toMatchObject({ id: key('feishu', 'om_2'), source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1:om_1' }], actor: { source: 'feishu', id: MEMBER }, human: true, at: '2025-09-09T00:00:00.000Z', url: 'https://applink/x', channel: { source: 'feishu', address: { chatId: 'oc_1', messageId: 'om_2' } }, meta: { chatId: 'oc_1', direct: false, mentioned: true, rootId: 'om_1', parentId: 'om_1', threadId: 'omt_1', messageId: 'om_2' } })
    expect(trigger.addressed).toBe('mention')
    expect(feishuTrigger({ message_id: 'om_5', chat_id: 'oc_2', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')!.addressed).toBe('direct')
    expect(feishuTrigger({ message_id: 'om_6', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: 'hi', create_time: '1' }, 'ou_bot', 'cli_bot')).not.toHaveProperty('addressed')
    expect(feishuRef(trigger)).toEqual({ triggerId: trigger.id, chatId: 'oc_1', messageId: 'om_2', at: trigger.at })
    expect(feishuTrigger({ message_id: 'om_3', chat_id: 'oc_1', chat_type: 'p2p', sender_id: 'ou_bot', sender_type: 'bot', content: 'me', create_time: '1' }, 'ou_bot', 'cli_bot')).toBeUndefined()
    expect(feishuTrigger(historyEvent({ message_id: 'om_4', chat_id: 'oc_1', create_time: '2', sender: { id: 'ou_x', sender_type: 'app' }, body: { content: '{"text":"from app"}' } }, 'oc_1', false), 'ou_bot', 'cli_bot')).toMatchObject({ human: false, text: 'from app', threads: [{ id: 'oc_1:om_4' }] })
  })
  it('polls subscribed threads and stores unseen replies as triggers on that thread', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const reply = { message_id: 'om_reply', chat_id: 'oc_1', msg_type: 'text', content: 'more details', sender: { id: 'ou_guest', sender_type: 'user' }, create_time: '1757376000000', thread_id: 'omt_1', root_id: 'om_root', mentions: [] }
    const mine = { ...reply, message_id: 'om_mine', sender: { id: 'ou_bot', sender_type: 'app', open_bot_id: 'ou_bot' } }
    const earlier = { ...reply, message_id: 'om_old', create_time: '1700000000000' }
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      return { thread_id: 'omt_1', has_more: false, messages: [mine, reply, earlier] }
    })
    await pollFeishuThreads(h)
    expect(h.receive).toHaveBeenCalledTimes(1)
    expect(h.receive.mock.calls[0]![0]).toMatchObject({ id: key('feishu', 'om_reply'), threads: [{ source: 'feishu', id: 'oc_1:om_root' }],
      actor: { id: 'ou_guest' }, human: true, text: 'more details', meta: expect.objectContaining({ threadId: 'omt_1' }) })
    expect(h.store.get('thread-seen:feishu:oc_1:om_root')).toEqual(expect.arrayContaining(['om_reply', 'om_mine', 'om_old']))
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta).toMatchObject({ threadId: 'omt_1', url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1', facts: { chat: { value: 'oc_1' } } })
    lark.mockRejectedValue(new Error('rate limited'))
    await pollFeishuThreads(h)
    expect(h.store.threads.get('feishu:oc_1:om_root')?.meta.pollError).toContain('rate limited')
    h.store.close()
  })
  it('translates a polled topic reply as the event consumer translates the live event', async () => {
    const h = host()
    // A direct-message chat the bot knows from its events.
    h.store.set('feishu-chats', { oc_dm: true })
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'fix it', create_time: '1757376000000' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_dm:om_root')!, createdAt: '2025-09-01T00:00:00Z',
      lastAt: new Date().toISOString() })
    const page = (message_id: string, sender: Record<string, string>, extra: Record<string, unknown> = {}) => ({ message_id,
      chat_id: 'oc_dm', msg_type: 'text', content: 'and the header', sender,
      create_time: '2026-09-11 12:00', thread_id: 'omt_dm', ...extra })
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_dm', thread_id: 'omt_dm' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // The page lists the reply without its root, and the bot's own message by its app.
      const messages = [page('om_mine', { id: 'cli_bot', sender_type: 'app' }), page('om_reply', { id: MEMBER, sender_type: 'user' })]
      return { thread_id: 'omt_dm', has_more: false, messages }
    })
    await pollFeishuThreads(h)
    const live = feishuTrigger({ message_id: 'om_reply', chat_id: 'oc_dm', chat_type: 'p2p', sender_id: MEMBER, sender_type: 'user',
      content: 'and the header',
      create_time: String(Date.parse('2026-09-11 12:00')), root_id: 'om_root', thread_id: 'omt_dm' }, 'ou_bot', 'cli_bot')
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([live])
    expect(live).toMatchObject({ addressed: 'direct', threads: [{ source: 'feishu', id: 'oc_dm:om_root' }] })
    h.store.close()
  })
  it('reads message times given as epoch milliseconds or as local times, and refuses others', () => {
    expect(feishuTime('1757376000000')).toBe('2025-09-09T00:00:00.000Z')
    expect(feishuTime('2026-09-11 12:00')).toBe(new Date(2026, 8, 11, 12, 0).toISOString())
    expect(() => feishuTime('soon')).toThrow('Unreadable Feishu message time')
  })
  it('polls a subscribed topic while a live ticket follows it or it had a message in the last two weeks', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: '1' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!,
      lastAt: new Date(Date.now() - 15 * 24 * 3600_000).toISOString() })
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ items: [] })
    await pollFeishuThreads(h)
    expect(lark).not.toHaveBeenCalled()
    h.store.tickets.save(openTicket('ticket'))
    await pollFeishuThreads(h)
    expect(lark).toHaveBeenCalled()
    h.store.close()
  })
  it('keeps a quiet topic in history recovery while a subscribed Thread that is polled follows it', async () => {
    const h = host()
    const day = 24 * 3600_000
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_team', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: 'fix', create_time: String(Date.now() - 30 * day), thread_id: 'omt_followed' }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!)
    h.store.tickets.save(openTicket('ticket'))
    const old = new Date(Date.now() - 30 * day).toISOString()
    h.store.set('feishu-history-threads:oc_team', { omt_followed: old, omt_quiet: old })
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [] })
    const now = new Date().toISOString()
    await backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    expect(h.store.get('feishu-history-threads:oc_team')).toEqual({ omt_followed: old })
    h.store.close()
  })
  it('refuses a history page with a message outside its chat or topic, and a page token that does not advance', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const message = (fields: Record<string, unknown>) => ({ message_id: 'om_1', chat_id: 'oc_team', create_time: String(Date.now() - 1000),
      sender: { id: MEMBER, sender_type: 'user' }, body: { content: '{"text":"hi"}' }, ...fields })
    const lark = vi.spyOn(h.commands, 'lark')
    const now = new Date().toISOString()
    const recover = () => backfillChat(h, 'oc_team', false, new Date(Date.now() - 60_000).toISOString(), now, new AbortController().signal)
    lark.mockResolvedValueOnce({ has_more: false, items: [message({ chat_id: 'oc_other' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    // A topic's page that holds a message of another topic.
    h.store.set('feishu-history-threads:oc_team', { omt_1: now })
    lark.mockResolvedValueOnce({ has_more: false, items: [] }).mockResolvedValueOnce({ has_more: false, items: [message({ thread_id: 'omt_2' })] })
    await expect(recover()).rejects.toThrow('outside the requested chat or thread')
    h.store.set('feishu-history-threads:oc_team', {})
    const stuck = { has_more: true, page_token: 'p1', items: [] }
    lark.mockResolvedValueOnce(stuck).mockResolvedValueOnce(stuck)
    await expect(recover()).rejects.toThrow('did not advance')
    lark.mockResolvedValueOnce({ has_more: true, items: [] })
    await expect(recover()).rejects.toThrow('did not advance')
    h.store.close()
  })
  it('stops reading a polled topic at the first message it knew, once the topic\'s first poll ran', async () => {
    const h = host()
    const source = feishuTrigger({ message_id: 'om_root', chat_id: 'oc_1', chat_type: 'group', sender_id: MEMBER, sender_type: 'user',
      content: '@bot fix', create_time: '1', mentions: [{ id: 'ou_bot' }] }, 'ou_bot', 'cli_bot')!
    h.store.triggers.save(source)
    subscribed(h, source.threads[0]!, { chatId: 'oc_1', messageId: 'om_root', sourceTriggerId: source.id })
    h.store.threads.save({ ...h.store.threads.get('feishu:oc_1:om_root')!, lastAt: new Date().toISOString() })
    h.store.set('thread-seen:feishu:oc_1:om_root', ['om_2'])
    h.store.set('thread-initialized:feishu:oc_1:om_root', true)
    const reply = (id: string) => ({ message_id: id, chat_id: 'oc_1', msg_type: 'text', content: `reply ${id}`, create_time: String(Date.now()),
      sender: { id: 'ou_guest', sender_type: 'user' }, thread_id: 'omt_1', root_id: 'om_root' })
    const lark = vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      if (args[0] === 'api') return { items: [{ message_id: 'om_root', chat_id: 'oc_1', thread_id: 'omt_1' }] }
      if (args[1] === '+messages-mget') return { messages: [] }
      // Newest first: a new reply, then the one the Thread knew, and an older page that is not read.
      return { thread_id: 'omt_1', has_more: true, page_token: 'older', messages: [reply('om_3'), reply('om_2')] }
    })
    await pollFeishuThreads(h)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_3'])
    expect(lark.mock.calls.filter(([args]) => args[1] === '+threads-messages-list')).toHaveLength(1)
    h.store.close()
  })
  it('recovers the topics of a chat while they had a message in the last two weeks, and forgets quieter ones', async () => {
    const h = host()
    const day = 24 * 3600_000
    const start = Date.parse('2026-09-01T00:00:00.000Z')
    h.store.set('feishu-history-threads:oc_team', { omt_old: new Date(start).toISOString() })
    let round = 0
    const scans: string[] = []
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    vi.spyOn(h.commands, 'lark').mockImplementation(async args => {
      const params = JSON.parse(args[args.indexOf('--params') + 1]!) as { container_id_type: string; container_id: string }
      scans.push(params.container_id)
      // Each day's chat scan yields one new thread; thread scans return no further messages.
      return { has_more: false, items: params.container_id_type === 'chat' ? [{ message_id: `om_${round}`, chat_id: 'oc_team',
        create_time: String(start + round * day), thread_id: `omt_${round}`,
        sender: { id: 'ou_bob', sender_type: 'user' }, body: { content: '{"text":"hi"}' } }] : [] }
    })
    for (round = 0; round < 30; round++) {
      scans.length = 0
      const since = new Date(start + round * day - 60_000).toISOString()
      await backfillChat(h, 'oc_team', false, since, new Date(start + round * day + 60_000).toISOString(), new AbortController().signal)
      if (round === 0) expect(scans).toContain('omt_old')
    }
    // The chat, and the topics with a message in the last 14 days.
    expect(scans).toHaveLength(1 + 14)
    expect(Object.keys(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!)).toHaveLength(14)
    expect(h.store.get<Record<string, string>>('feishu-history-threads:oc_team')!.omt_29).toBe(new Date(start + 29 * day).toISOString())
    h.store.close()
  })
  it('skips and counts a history message it cannot read, and takes in the others', async () => {
    const h = host()
    vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const item = (id: string) => ({ message_id: id, chat_id: 'oc_team', create_time: String(Date.now()), sender: { id: MEMBER,
      sender_type: 'user' },
      body: { content: '{"text":"@bot fix it"}' } })
    vi.spyOn(h.commands, 'lark').mockResolvedValue({ has_more: false, items: [item('om_good'), { message_id: 'om_bad',
      chat_id: 'oc_team' }] })
    const tally = { skipped: 0 }
    const since = new Date(Date.now() - 60_000).toISOString()
    await backfillChat(h, 'oc_team', false, since, new Date().toISOString(), new AbortController().signal, tally)
    expect(tally.skipped).toBe(1)
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.messageId)).toEqual(['om_good'])
    h.store.close()
  })
  it('waits a second before restarting the event consumer after a run that stayed up for a minute, and backs off otherwise', () => {
    expect(consumerRetry(undefined, 0)).toBe(1000)
    expect(consumerRetry(1000, 500)).toBe(2000)
    expect(consumerRetry(32_000, 500)).toBe(60_000)
    expect(consumerRetry(60_000, 120_000)).toBe(1000)
  })
  it('syncs its part of the Policy from the sync chat: people who left are removed, names follow the chat, new people are appended', async () => {
    const h = host()
    // The sync reads the chat under its signal, so stopping the sync stops the read.
    const withSignal = vi.spyOn(h.commands, 'withSignal').mockReturnValue(h.commands)
    const lark = vi.spyOn(h.commands, 'lark').mockResolvedValue({ users: [{ member_id: 'ou_carol', name: 'Carol' }, { member_id: MEMBER, name: 'Alice Li' }], has_more: false })
    const sync = feishuKind.policy!.sync!
    expect(sync.ready({ allowed: [] })).toBe(false)
    const signal = new AbortController().signal
    expect(await sync.run(h, { allowed: [{ id: MEMBER, name: 'Alice' }, { id: 'ou_bob', name: 'Bob' }], syncChat: 'oc_team' }, signal))
      .toEqual({ allowed: [{ id: MEMBER, name: 'Alice Li' }, { id: 'ou_carol', name: 'Carol' }], syncChat: 'oc_team', admission: {} })
    expect(withSignal).toHaveBeenCalledWith(signal)
    expect(lark.mock.calls[0]![0]).toEqual(expect.arrayContaining(['+chat-members-list', '--chat-id', 'oc_team']))
    lark.mockResolvedValue({ users: [], has_more: true })
    await expect(sync.run(h, { allowed: [], syncChat: 'oc_team' }, new AbortController().signal)).rejects.toThrow('incomplete member list')
    h.store.close()
  })
})
describe('redmine and gerrit sources', () => {
  /** A Redmine issue as the task system returns it, opened by alice. */
  const issue = (id: number, fields: Record<string, unknown> = {}) => ({ id, subject: 'Login fails', description: 'details',
    project: { id: 1, identifier: 'demo', name: 'Demo' }, tracker: { id: 1, name: 'Bug' }, status: { id: 1, name: 'New' },
    priority: { id: 2, name: 'Normal' }, author: { id: 1, name: 'alice' }, assigned_to: null,
    created_on: '2026-09-09T00:00:00Z', updated_on: '2026-09-09T00:00:00Z', ...fields })
  /** A journal of an issue, as the task system returns it. */
  const journal = (id: number, fields: Record<string, unknown> = {}) => ({ id, notes: `comment ${id}`, user: { id: 2, name: 'bob' },
    created_on: '2026-09-09T01:00:00Z', ...fields })
  /** A Gerrit change of the agent account, as the review server returns it. */
  const change = (fields: Record<string, unknown> = {}) => ({ _number: 42, id: 'demo~main~I1234', project: 'demo', branch: 'main',
    subject: 'Fix the login', topic: '', status: 'NEW', owner: { username: 'agent' }, created: '2026-09-01T00:00:00Z',
    updated: '2026-09-02T00:00:00Z', current_revision: 'abc123',
    revisions: { abc123: { commit: { message: 'Fix the login\n\nIssue: 7\n' } } }, messages: [], ...fields })
  /** Answers the task system's API calls from a table of paths, and records what was asked. */
  function redmine(routes: Record<string, unknown>) {
    vi.spyOn(Commands.prototype, 'http').mockImplementation(async (url, init = {}) => {
      const path = url.replace('http://redmine.test', '').split('?')[0]!
      const answer = routes[path]
      if (answer === undefined) return { status: 404, body: '{"errors":["Not found"]}' }
      if (init.method === 'PUT') return { status: 204, body: '' }
      return { status: 200, body: JSON.stringify(answer) }
    })
  }
  it('normalizes an issue and a journal of it into triggers, and addresses the agent when the text mentions it', () => {
    const trigger = issueTrigger(issue(7, { description: '@agent please fix' }) as never, { id: 5, login: 'agent' }, 'http://redmine.test')
    expect(trigger).toMatchObject({ id: key('redmine-issue', '7'), source: REDMINE_SOURCE, threads: [{ source: REDMINE_SOURCE, id: '7' }],
      actor: { source: REDMINE_SOURCE, id: 'alice' }, human: true, addressed: 'mention', url: 'http://redmine.test/issues/7' })
    // An issue assigned to the agent is addressed directly, and one that says nothing of it is not.
    expect(issueTrigger(issue(7, { assigned_to: { id: 5, name: 'Agent Bot' } }) as never, { id: 5, login: 'agent' }, 'http://redmine.test').addressed).toBe('direct')
    expect(issueTrigger(issue(7) as never, { id: 5, login: 'agent' }, 'http://redmine.test')).not.toHaveProperty('addressed')
    // One shared account: a note the account wrote without a marker is the operator's, so it is human input again.
    expect(journalTrigger(issue(7) as never, journal(11, { user: { id: 5, name: 'Agent Bot' } }) as never, { id: 5, login: 'agent' },
      'http://redmine.test')!.actor).toEqual({ source: REDMINE_SOURCE, id: 'Agent Bot' })
    // A marked note of the agent's own account was delivered when it was written, so the poll skips it; marker
    // text another account pasted marks nothing, so it arrives as the note of its author.
    expect(journalTrigger(issue(7) as never, journal(11, { notes: 'Done.\n\n<!-- dsh-superagent:reply-1 -->', user: { id: 5, name: 'Agent Bot' } }) as never,
      { id: 5, login: 'agent' }, 'http://redmine.test')).toBeUndefined()
    expect(journalTrigger(issue(7) as never, journal(11, { notes: 'Done.\n\n<!-- dsh-superagent:reply-1 -->' }) as never,
      { id: 5, login: 'agent' }, 'http://redmine.test')?.actor).toEqual({ source: REDMINE_SOURCE, id: 'bob' })
  })
  it('normalizes a review comment and a change message into triggers, and marks only robots as automated', () => {
    const comment = commentTrigger(change() as never, { id: 'Ic1', message: 'Please rename this.', author: { username: 'bob' },
      created: '2026-09-02T10:00:00Z', path: 'src/app.ts', line: 12 } as never, 'agent', 'http://gerrit.test:8080')!
    expect(comment).toMatchObject({ id: key('gerrit-comment', 'demo~main~I1234', 'Ic1'), source: GERRIT_SOURCE,
      threads: [{ source: GERRIT_SOURCE, id: '42' }], actor: { source: GERRIT_SOURCE, id: 'bob' }, human: true,
      text: 'src/app.ts:12\n\nPlease rename this.', url: 'http://gerrit.test:8080/#/c/demo/+/42' })
    // A robot's note asks for nothing, and the agent's own note is its work.
    expect(commentTrigger(change() as never, { id: 'Ic2', message: 'x', author: { username: 'Gerrit Robot' } } as never, 'agent', 'http://gerrit.test:8080')!.human).toBe(false)
    expect(commentTrigger(change() as never, { id: 'Ic3', message: 'x', author: { username: 'agent' } } as never, 'agent', 'http://gerrit.test:8080')).toBeUndefined()
    // A change message is machine-made: it never authorizes work on its own.
    const message = messageTrigger(change() as never, { id: 'm1', message: 'Change has been merged', author: { username: 'Gerrit Robot' } } as never, 'agent', 'http://gerrit.test:8080')!
    expect(message).toMatchObject({ id: key('gerrit-message', 'demo~main~I1234', 'm1'), human: false, meta: { kind: 'message', changeNumber: 42 } })
  })
  it('matches a change topic to a ticket by its short name as the last path segment', () => {
    expect(ticketTopic({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c')).toBe(true)
    expect(ticketTopic({ execution: execution('fix-title-1a2b3c') }, 'fix-title-1a2b3c')).toBe(true)
    expect(ticketTopic({ execution: execution('fix-title-1a2b3c') }, 'agent/fix-title-1a2b3c-2')).toBe(false)
    expect(ticketTopic({}, 'agent/x')).toBe(false)
  })
  it('reads the issues changed since the cursor, stores a Trigger for each and for its journals, and moves the cursor', async () => {
    const h = host()
    h.store.set(KV.redmine.since, '2026-08-01T00:00:00Z')
    redmine({ '/issues.json': { issues: [issue(7)] }, '/issues/7.json': { issue: issue(7, { journals: [journal(11)] }) } })
    const round = await pollRedmine(h.context(redmineKind))
    expect(round.issues).toBe(1)
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([key('redmine-issue', '7'), key('redmine-journal', '11')])
    // The issue and its journal are read once each.
    await pollRedmine(h.context(redmineKind))
    expect(h.receive.mock.calls.map(call => call[0].id)).toEqual([key('redmine-issue', '7'), key('redmine-journal', '11')])
    expect(h.store.threads.get('redmine:7')!.meta).toMatchObject({ label: '#7 Login fails' })
    h.store.close()
  })
  it('reads the agent\'s open changes and their review comments, and stores a Trigger for each', async () => {
    const h = host()
    const comment = { id: 'Ic1', message: 'Please rename this.', author: { username: 'bob' }, created: '2026-09-02T10:00:00Z' }
    vi.spyOn(Commands.prototype, 'http').mockImplementation(async url => {
      const path = url.replace('http://gerrit.test:8080/a', '').split('?')[0]!
      if (path === '/changes/') return { status: 200, body: `)]}'\n${JSON.stringify([change()])}` }
      if (path === '/changes/42/detail') return { status: 200, body: `)]}'\n${JSON.stringify(change())}` }
      if (path === '/changes/42/comments') return { status: 200, body: `)]}'\n${JSON.stringify([comment])}` }
      return { status: 404, body: '{}' }
    })
    const round = await pollGerrit(h.context(gerritKind))
    expect(round.changes).toBe(1)
    expect(h.receive.mock.calls[0]![0].id).toBe(key('gerrit-comment', 'demo~main~I1234', 'Ic1'))
    h.store.close()
  })
  it('binds a change to the ticket whose issue it names, and ends that ticket when the change merges', async () => {
    const h = host()
    const request = issueTrigger(issue(7) as never, { id: 5, login: 'agent' }, 'http://redmine.test')
    h.store.triggers.save(request)
    h.store.tickets.save({ ...openTicket('t1'), assignments: [{ id: 'a', state: 'running', createdAt: '2026-09-03T00:00:00Z' }],
      channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
      origin: { triggerId: request.id, triggerIds: [request.id] } })
    expect(claimChange(h, 't1', change() as never)).toBeUndefined()
    expect(changeOf(h.store.tickets.get('t1')!)).toBe(42)
    expect(h.store.threads.get('gerrit:42')?.subscriptions).toEqual(['t1'])
    // A change of another account is not the agent\'s, and a change that names no ticket is refused.
    expect(claimChange(h, 't1', change({ owner: { username: 'someone' } }) as never)).toContain('not by')
    expect(claimChange(h, 't1', change({ revisions: { abc123: { commit: { message: 'Other task\n\nIssue: 99\n' } } } }) as never))
      .toContain('does not name this ticket')
    // The change merges: the ticket waits for its worker, and the conversation hears of the merge once.
    expect(await observeChange(h, change({ status: 'MERGED', updated: '2026-09-02T00:00:00Z' }) as never)).toBe(true)
    expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
    h.engine.report('t1', { state: 'ready', summary: 'answered' })
    expect(h.store.tickets.get('t1')).toMatchObject({ ended: { outcome: 'merged' } })
    const notices = changeEndNotices(h.store.tickets.get('t1')!, 'Fix the login', 'http://gerrit.test:8080', 'demo')
    expect(notices).toEqual([expect.objectContaining({ kind: 'notice', text: expect.stringContaining('has been merged') })])
    h.store.close()
  })
  it('writes the terminal notice in English for a request without Han characters', async () => {
    const h = host()
    h.store.tickets.save({ ...openTicket('t2'), assignments: [{ id: 'a', state: 'running', createdAt: '2026-09-03T00:00:00Z' }],
      channels: [{ source: 'feishu', thread: 'feishu:oc_1', address: { chatId: 'oc_1', messageId: 'om_1' } }],
      follows: [{ thread: 'gerrit:12', own: true }] })
    expect(await observeChange(h, change({ _number: 12, status: 'ABANDONED', updated: '2026-09-02T00:00:00Z' }) as never)).toBe(true)
    h.engine.report('t2', { state: 'ready', summary: 'answered' })
    expect(changeEndNotices(h.store.tickets.get('t2')!, 'fix the title', 'http://gerrit.test:8080', 'demo'))
      .toEqual([expect.objectContaining({ text: expect.stringContaining('was abandoned') })])
    h.store.close()
  })
  it('waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const start = async (overrides: Partial<SourceContextDeps>,
        redmine: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} }) => {
        const board = new HealthBoard()
        const settings = SettingsSchema.parse({ sources: { redmine } })
        const sources = new SourceRegistry(() => settings, board)
        healthOf.set(sources, board)
        const value = host({ sources, ...overrides })
        const disposers: (() => unknown)[] = []
        applyRedmine({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
        return { value, stop: async () => { for (const dispose of disposers) await dispose(); value.store.close() } }
      }
      const pending = await start({ configured: () => false })
      await vi.waitFor(() => expect(pending.value.health.redmine).toMatchObject({ state: 'paused', code: 'setupPending' }))
      await pending.stop()
      const off = await start({}, { enabled: false, config: {} })
      await vi.waitFor(() => expect(off.value.health.redmine).toMatchObject({ state: 'paused', code: 'sourceOff' }))
      await off.stop()
      // Rounds fail, succeed, fail, fail: only the last two in a row make the error.
      const outcomes = [false, true, false, false]
      let round = 0
      const run = vi.spyOn(Commands.prototype, 'http').mockImplementation(async url => {
        // The round reads the changed issues and the issues assigned to the account; the second read does not change the
        // outcome of the round.
        if (!String(url).includes('assigned_to_id=me')) {
          if (!outcomes[round++]) throw new Error('network down')
        }
        return { status: 200, body: '{"issues":[]}' }
      })
      const flaky = await start({}, { enabled: true, config: { failuresBeforeError: 2 } })
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0))
          if (round < count) await vi.advanceTimersByTimeAsync(30_000)
        }
      }
      await until(3)
      expect(flaky.value.health.redmine).toMatchObject({ state: 'ready' })
      await until(4)
      await vi.waitFor(() => expect(flaky.value.health.redmine).toMatchObject({ state: 'error', code: 'pollFailures', values: { count: '2' } }))
      await flaky.stop()
      run.mockRestore()
    } finally { vi.useRealTimers() }
  })
  it('reports a failure that escapes the polling loop as its health instead of an unhandled rejection', async () => {
    // The fixture's registry already holds the kind; this one starts empty so the plugin can register it.
    const value = host({ sources: emptyRegistry(), ready: Promise.reject(new Error('lock held')) })
    const disposers: (() => unknown)[] = []
    applyGerrit({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    await vi.waitFor(() => expect(value.health.gerrit).toMatchObject({ state: 'error', detail: expect.stringContaining('lock held') }))
    for (const dispose of disposers) await dispose()
    value.store.close()
  })
})

describe('source context', () => {
  it('gives each kind the setup problem whose place it is', () => {
    const feishu: SetupProblem = { place: 'feishu', code: 'feishuNoBot', values: {}, detail: 'No bot' }
    const redmine: SetupProblem = { place: 'redmine', code: 'redmineUrlUnset', values: {}, detail: 'No address' }
    const h = host({ feishuProblem: feishu, setupProblem: redmine })
    expect(h.context(feishuKind).problem).toBe(feishu)
    expect(h.context(redmineKind).problem).toBe(redmine)
    expect(h.context({ kind: 'probe', health: [] }).problem).toBeUndefined()
    h.store.close()
  })
  it('lets a kind report only its own health entries', () => {
    const h = host()
    const redmine = h.context(redmineKind)
    redmine.report('redmine', { state: 'ready', detail: 'ok' })
    expect(h.health.redmine).toEqual({ state: 'ready', detail: 'ok' })
    expect(() => redmine.report('feishu', { state: 'error', detail: 'x' })).toThrow('no health entry feishu')
    h.store.close()
  })
  it('patches a Thread\'s meta as it is now, so a change another writer made meanwhile stays', () => {
    const h = host()
    h.store.threads.save({ key: 'redmine:7', ref: { source: 'redmine', id: '7' }, createdAt: '', subscriptions: [], correlated: [],
      pending: [], meta: { title: 'old', pollError: 'boom' } })
    const snapshot = h.store.threads.get('redmine:7')!
    h.store.threads.save({ ...snapshot, subscriptions: ['t'], meta: { ...snapshot.meta, label: '#7 old' } })
    h.threads.patch('redmine:7', { title: 'new', pollError: undefined })
    expect(h.store.threads.get('redmine:7')).toMatchObject({ subscriptions: ['t'], meta: { title: 'new', label: '#7 old' } })
    expect(h.store.threads.get('redmine:7')!.meta).not.toHaveProperty('pollError')
    // A Thread that does not exist is not created.
    h.threads.patch('redmine:8', { title: 'x' })
    expect(h.store.threads.get('redmine:8')).toBeUndefined()
    h.store.close()
  })
  it('reads the configuration of an instance that is on, removes a record set to undefined, and merges ticket meta', () => {
    const h = host()
    expect(h.config('feishu')).toMatchObject({ directMessages: true })
    h.store.saveSettings({ ...h.store.settings(), sources: { ...h.store.settings().sources, feishu: { enabled: false, config: {} } } })
    expect(h.config('feishu')).toBeUndefined()
    h.state.set('redmine-issue:1', { journal: 0 })
    h.state.set('redmine-issue:1', undefined)
    expect(h.store.keys('redmine-issue:1')).toEqual([])
    h.store.tickets.save({ ...openTicket('t1'), execution: execution('one') })
    h.tickets.bindThread('t1', { source: 'redmine', id: '4' }, true)
    // The ticket follows the Thread; its other fields stay as they were.
    expect(h.store.tickets.get('t1')).toMatchObject({ follows: [{ thread: 'redmine:4', own: true }], execution: execution('one'),
      origin: { triggerId: 'source-t1' } })
    h.store.close()
  })
})
it('reports the task system as failing only after the configured number of consecutive failed polls', () => {
  const eof = new Error('Get "http://redmine.test/issues.json": EOF')
  expect(pollFailure(1, 3, eof)).toBeUndefined()
  expect(pollFailure(2, 3, eof)).toBeUndefined()
  expect(pollFailure(3, 3, eof)).toEqual({ state: 'error', detail: '3 consecutive failed polls; last: Error: Get "http://redmine.test/issues.json": EOF', code: 'pollFailures', values: { count: '3', error: 'Error: Get "http://redmine.test/issues.json": EOF' } })
  expect(redmineKind.schema.parse({})).toEqual({ baseUrl: '', apiKey: '', pollSeconds: 30, failuresBeforeError: 3,
    pageSize: 100, observeIssues: false, observeJournals: false })
})
describe('feishu event consumer', () => {
  let dir: string
  let controller: AbortController
  let running: Promise<unknown> | undefined
  // The fake CLI is a real process, which starts slower while the whole suite runs.
  const until = { timeout: 10_000 }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'feishu-consumer-')); controller = new AbortController() })
  afterEach(async () => {
    controller.abort()
    await running
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })
  /**
   * A bot CLI whose `event consume` behaves as `mode` says: `never` gets ready, `warn` warns once ready, `ready` stays up,
   * and `flaky` exits after its first ready. It records each run and the PID of the latest.
   */
  function cli(mode: 'never' | 'warn' | 'ready' | 'flaky' | 'events' | 'late'): string {
    const path = join(dir, 'lark-bot')
    writeFileSync(path, `#!/bin/sh
  [ "$1" = event ] || { echo '{"ok":true,"data":{}}'; exit 0; }
  n=$(cat '${dir}/runs' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${dir}/runs'; echo $$ > '${dir}/pid'
  case ${mode} in
    never) exec sleep 60 ;;
    warn) echo '[event] ready' >&2; echo 'WARN the connection was reset' >&2; exec sleep 60 ;;
    ready) echo '[event] ready' >&2; exec sleep 60 ;;
    flaky) echo '[event] ready' >&2; [ "$n" -gt 1 ] && exec sleep 60; exit 1 ;;
    events) echo '[event] ready' >&2; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
    late) echo '[event] ready' >&2; sleep 1; cat '${dir}/events'; touch '${dir}/printed'; exec sleep 60 ;;
  esac
  `, { mode: 0o755 })
    return path
  }
  const runs = () => existsSync(join(dir, 'runs')) ? Number(readFileSync(join(dir, 'runs'), 'utf8')) : 0
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
  /** The Feishu Source's context, on a fresh Store whose Feishu Source is on, with `cli` as the bot CLI. */
  function consumerSource(path: string, config: Record<string, unknown> = { chats: [] }) {
    const store = new Store(join(dir, 'db.sqlite'))
    store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: true, config } } }))
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    sources.register(feishuKind)
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const policy = () => settingsPolicy(store.settings(), sources)
    const engine = new Engine({ repo: store, scope: sources, policy, assessor, executor, outbox })
    const deployment = testDeployment({ feishu: { ...testDeployment().feishu!, cli: path } })
    const health = board.all
    const commands = new Commands(() => deployment, {}, controller.signal)
    const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment, ready: Promise.resolve(), configured: () => true,
      receive: (trigger: Trigger) => engine.receive(trigger) }
    const turnOff = () => store.saveSettings(SettingsSchema.parse({ sources: { feishu: { enabled: false, config: { chats: [] } } } }))
    return { ctx: sourceContextOf(deps, feishuKind), health, store, turnOff }
  }

  /** A message event line as `event consume` prints it; a group message mentions the bot. */
  const event = (id: string, chat: string, type: 'group' | 'p2p') => JSON.stringify({ message_id: id, chat_id: chat, chat_type: type,
    sender_id: 'ou_alice', sender_type: 'user', content: 'fix it', create_time: String(Date.now()),
    ...type === 'group' ? { mentions: [{ id: 'ou_bot', name: 'Bot' }] } : {} })
  it('takes in the event lines it reads, records each chat as direct or not, and reports a malformed line without stopping', async () => {
    writeFileSync(join(dir, 'events'), [event('om_1', 'oc_group', 'group'), event('om_2', 'oc_dm', 'p2p'), 'not json',
      event('om_3', 'oc_group', 'group')].join('\n') + '\n')
    const { ctx, health, store } = consumerSource(cli('events'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(store.triggers.get(feishuTriggerId('om_3'))).toBeDefined(), until)
    expect(['om_1', 'om_2'].map(id => store.triggers.get(feishuTriggerId(id))?.meta.direct)).toEqual([false, true])
    expect(store.get(KV.feishu.chats)).toEqual({ oc_group: false, oc_dm: true })
    expect(health.feishu).toMatchObject({ state: 'error', detail: expect.stringContaining('JSON') })
    controller.abort(); await running; store.close()
  }, 20_000)
  it('drops the events it reads once the Source is off', async () => {
    writeFileSync(join(dir, 'events'), event('om_9', 'oc_group', 'group') + '\n')
    const { ctx, health, store, turnOff } = consumerSource(cli('late'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    turnOff()
    // The CLI prints the event a second after it is ready, before the consumer stops for the Source being off.
    await vi.waitFor(() => expect(existsSync(join(dir, 'printed'))).toBe(true), until)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(store.triggers.get(feishuTriggerId('om_9'))).toBeUndefined()
    controller.abort(); await running; store.close()
  }, 20_000)
  it('keeps a chat\'s history cursor when its read fails, and recovers known direct chats only while direct messages are on', async () => {
    const hour = new Date(Date.now() - 3_600_000).toISOString()
    const recovered = async (directMessages: boolean) => {
      const chat = (chatId: string) => ({ chatId, listen: 'mentions' })
      const { ctx, health, store } = consumerSource(cli('ready'), { chats: [chat('oc_a'), chat('oc_b')], directMessages })
      store.set(KV.feishu.chats, { oc_dm: true, oc_a: false })
      for (const chat of ['oc_a', 'oc_b', 'oc_dm']) store.set(KV.feishu.history(chat), hour)
      const chats: string[] = []
      const lark = vi.spyOn(Commands.prototype, 'lark').mockImplementation(async args => {
        const params = args[2] === '/open-apis/im/v1/messages' ? JSON.parse(args.at(-1)!) as { container_id: string } : undefined
        if (params) chats.push(params.container_id)
        if (params?.container_id === 'oc_a') throw new Error('rate limited')
        return { has_more: false, items: [] }
      })
      const stop = new AbortController()
      const loops = runFeishu(ctx, AbortSignal.any([stop.signal, controller.signal]))
      await vi.waitFor(() => expect(['ready', 'error']).toContain(health.history?.state), until)
      stop.abort(); await loops; lark.mockRestore()
      const cursors = Object.fromEntries(['oc_a', 'oc_b', 'oc_dm'].map(chat => [chat, store.get(KV.feishu.history(chat))]))
      const result = { chats, cursors, history: health.history }
      store.close(); rmSync(join(dir, 'db.sqlite'), { force: true }); rmSync(join(dir, 'db.sqlite-wal'), { force: true })
      rmSync(join(dir, 'db.sqlite-shm'), { force: true })
      return result
    }
    const on = await recovered(true)
    expect(on.chats).toEqual(['oc_a', 'oc_b', 'oc_dm'])
    expect(on.history).toMatchObject({ state: 'error', detail: expect.stringContaining('oc_a: Error: rate limited') })
    expect(on.cursors.oc_a).toBe(hour)
    expect(Date.parse(on.cursors.oc_b!)).toBeGreaterThan(Date.parse(hour))
    expect(Date.parse(on.cursors.oc_dm!)).toBeGreaterThan(Date.parse(hour))
    const off = await recovered(false)
    expect(off.chats).toEqual(['oc_a', 'oc_b'])
    expect(off.cursors.oc_dm).toBe(hour)
  }, 20_000)
  it('reports an error when the consumer is not ready within 45 seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { ctx, health, store } = consumerSource(cli('never'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(runs()).toBe(1), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    await vi.advanceTimersByTimeAsync(45_000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error',
      detail: expect.stringContaining('did not become ready within 45 seconds') }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('reports a warning the consumer prints as an error', async () => {
    const { ctx, health, store } = consumerSource(cli('warn'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'error', detail: 'WARN the connection was reset' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('stops the consumer within five seconds once the Source is off', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const { ctx, health, store, turnOff } = consumerSource(cli('ready'))
    running = runFeishu(ctx, controller.signal)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready', detail: 'Listening for bot events' }), until)
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'))
    turnOff()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'paused', code: 'sourceOff' }), until)
    expect(alive(pid)).toBe(false)
    controller.abort(); await running; store.close()
  }, 20_000)
  it('starts the consumer again after it exits, and is ready once the next run listens', async () => {
    const { ctx, health, store } = consumerSource(cli('flaky'))
    running = runFeishu(ctx, controller.signal)
    const exited = { state: 'error', detail: expect.stringContaining('exited (1, ready=true)') }
    await vi.waitFor(() => expect(health.feishu).toMatchObject(exited), until)
    // The first restart waits a second.
    await vi.waitFor(() => expect(runs()).toBe(2), until)
    await vi.waitFor(() => expect(health.feishu).toMatchObject({ state: 'ready' }), until)
    controller.abort(); await running; store.close()
  }, 20_000)
})
