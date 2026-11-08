/** Redmine source kind definition, issue polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey } from '../core/index.ts'
import { RedmineAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { cursorAt, pause } from './poll.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { retired, type Localized, type SourceKind } from './kind.ts'
import { redmineLink, sendRedmine } from './redmine-channel.ts'
import { journalsOf, listIssues, projectOf, readIssue, redmineThreadContext } from './redmine-read.ts'
import { issueTrigger, journalTrigger, panelToken, SOURCE, type RedmineIssue } from './redmine-trigger.ts'

const RedmineConfigSchema = retired(RedmineAccountsSchema.extend({
  pollSeconds: z.number().int().min(10).max(3600).default(30),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  pageSize: z.number().int().min(1).max(100).default(100),
  observeIssues: z.boolean().default(false),
  observeJournals: z.boolean().default(false),
}).strict(), ['login', 'project'])
export type RedmineConfig = z.infer<typeof RedmineConfigSchema>
const OBSERVED = { issue: 'observeIssues', journal: 'observeJournals' } as const
type Scope = keyof typeof OBSERVED
/** The receiving scope of a Redmine Trigger: the issue itself, or one of its journals. */
const scopeOf = (meta: Record<string, unknown>): Scope => meta.kind === 'journal' ? 'journal' : 'issue'

export const redmineKind: SourceKind<RedmineConfig> = {
  kind: SOURCE,
  order: 1,
  title: { zh: 'Redmine', en: 'Redmine' },
  description: { zh: '任务系统（ PMS ）；接收事务与事务下的讨论，智能体在其中接单并把结果写回事务。',
    en: 'The task system (PMS); receives issues and their discussion, where the agent takes work and writes its result back to the issue.' },
  schema: RedmineConfigSchema,
  fields: [
    { key: 'baseUrl', type: 'text', label: { zh: 'Redmine 地址', en: 'Redmine address' },
      hint: { zh: '例如 http://redmine.example.com。保存时检查 API 密钥对应的账号，然后重启 dsh-superagent。',
        en: 'For example http://redmine.example.com. Saving checks the account of the API key, then restarts dsh-superagent.' } },
    { key: 'apiKey', type: 'text', label: { zh: 'API 密钥', en: 'API key' },
      hint: { zh: '智能体账号在 Redmine 的“我的账号”里的 API 访问密钥；这是凭据，不会进入智能体的运行环境。',
        en: 'The REST web services key of the agent account in Redmine; it is a credential and never reaches the agent environment.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeIssues', type: 'switch', label: { zh: '接收没有 @ 智能体的新事务', en: 'Receive new issues that do not mention the agent' },
      hint: { zh: '打开后，没有 @ 智能体的新事务也会收到，由策略的接收表决定是否成为候选。从打开的时候开始，不读以前的。',
        en: 'New issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates. Starts when switched on; earlier ones are not read.' } },
    { key: 'observeJournals', type: 'switch', label: { zh: '接收没有 @ 智能体的讨论', en: 'Receive discussion that does not mention the agent' },
      hint: { zh: '打开后，事务下没有 @ 智能体的评论也会收到，由策略的接收表决定是否成为候选。',
        en: 'Comments on issues that do not mention the agent are received too, and the Policy\'s admission table decides whether they become candidates.' } },
  ],
  // The Source receives every issue of the project; whether an unaddressed one may become a candidate is the Policy's decision.
  scope: ({ meta }, config) => {
    const scope = scopeOf(meta)
    return { listened: true, observed: config[OBSERVED[scope]], row: scope }
  },
  health: ['redmine'],
  channel: { send: sendRedmine, link: redmineLink },
  threadContext: redmineThreadContext,
  // `#12` or a Redmine issue URL names Thread 12.
  find: query => {
    const number = (/^#?(\d+)$/.exec(query.trim()) ?? /\/issues\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    relation: true,
    schema: retired(z.object({}).strict(), ['allowed']),
    // No form fields: a relation Source keeps no sender list. The retired `allowed` is dropped, not refused, on save.
    fields: [],
    explicit: { zh: '任何 Redmine 账号把事务指派给智能体，或在事务或讨论里 @ 它的账号；不设名单，谁发起都可以。',
      en: 'Any Redmine account assigns an issue to the agent, or mentions its login in an issue or its discussion; no list is kept, everyone may originate work.' },
    // Redmine's API reports the display name of an author beside its id, and no login, so panels show the names Redmine shows.
    unnamed: { person: { zh: 'Redmine 账号', en: 'Redmine account' }, bot: { zh: 'Redmine 机器人', en: 'Redmine robot' } },
    rows(stored) {
      const config = RedmineConfigSchema.parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅指派或 @', en: 'Assigned or @ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('issue', { zh: '新事务', en: 'New issues' }), row('journal', { zh: '事务下的讨论', en: 'Issue discussion' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_REDMINE_URL', description: { zh: '任务系统的地址。', en: 'The address of the task system.' } },
      { key: 'DSH_SUPERAGENT_REDMINE_PROJECT', description: { zh: '接下工单的事务所在的项目。', en: 'The project of the issue that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_REDMINE_ISSUE_ID', description: { zh: '接下工单的事务编号。', en: 'The number of the issue that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_REDMINE_ISSUE_URL', description: { zh: '接下工单的事务页面地址。', en: 'The page of the issue that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_REDMINE_LOGIN', description: { zh: '绑定的 Redmine 账号；@ 它或把事务指派给它，就视为对它说话。', en: 'The bound Redmine account; mentioning it addresses the agent.' } },
    ],
    values: ({ deployment, config, trigger }) => {
      const base = deployment.redmine?.baseUrl ?? config.baseUrl
      const login = deployment.redmine?.login ?? ''
      const issue = trigger?.source === SOURCE ? Number(trigger.meta.issueId) || 0 : 0
      // The project of the ticket is the project of the issue that started it.
      const project = trigger?.source === SOURCE ? String(trigger.meta.project ?? '') : ''
      return { DSH_SUPERAGENT_REDMINE_URL: base, DSH_SUPERAGENT_REDMINE_PROJECT: project,
        DSH_SUPERAGENT_REDMINE_ISSUE_ID: issue ? String(issue) : '',
        DSH_SUPERAGENT_REDMINE_ISSUE_URL: issue && base ? `${base.replace(/\/+$/, '')}/issues/${issue}` : '',
        DSH_SUPERAGENT_REDMINE_LOGIN: login }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.redmine ? {
    login: { zh: `当前账号 ${deployment.redmine.login}`, en: `Current account ${deployment.redmine.login}` },
  } : {},
}

export const name = 'dsh-superagent-redmine'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(redmineKind), 'redmine: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, redmineKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('redmine', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('redmine', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<RedmineConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('redmine', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('redmine', failed)
    }
    await pause(Math.max(config?.pollSeconds ?? 30) * 1000, signal)
  }
}
export interface Round { read: number; triggers: number; unreadable: number; issues: number }
/**
 * One polling round: the issues changed since the cursor, each read with its journals. Every issue fails on its own, so
 * one unreadable issue does not stop the round. The cursor moves only after every covered trigger was stored.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<Round> {
  const config = ctx.config<RedmineConfig>(SOURCE)
  if (!config) return { read: 0, triggers: 0, unreadable: 0, issues: 0 }
  const commands = ctx.commands.withSignal(signal)
  // The window starts when the Source is switched on, and only moves after a round that read everything it covered.
  const since = ctx.state.get(KV.redmine.since) ?? new Date().toISOString()
  if (ctx.state.get(KV.redmine.since) === undefined) ctx.state.set(KV.redmine.since, since)
  const tally: Tally = { skipped: 0 }
  const changed = await listIssues(commands, { since, limit: config.pageSize }, tally)
  // The work of the operator is the issues assigned to the bound account: they are read as well, so a task that was
  // assigned before the Source started is not left behind. An issue read already is skipped below.
  const assigned = await listIssues(commands, { assignedTo: 'me', status: 'open', limit: config.pageSize }, tally)
  const issues = new Map<number, RedmineIssue>()
  for (const issue of [...assigned, ...changed]) issues.set(issue.id, issue)
  const account = ctx.deployment.redmine
  // The agent's identity in Redmine: the id its issues carry, and the login a person mentions it by.
  const agent = { id: account?.id ?? 0, login: account?.login ?? '' }
  const base = account?.baseUrl || config.baseUrl
  let triggers = 0
  let read = 0
  let unreadable = 0
  for (const item of issues.values()) {
    // Stopping mid-round aborts before the cursor moves, so unread issues are read again.
    if (signal?.aborted) throw new Error('The Redmine Source stopped during the poll')
    read += 1
    let issue = item
    if (!item.journals?.length) {
      // The issue list carries no journals, so the issue is read once more for them.
      try { issue = await readIssue(commands, item.id) }
      catch (error) {
        if (error instanceof CliError && (error.code === 404 || error.code === 410)) continue
        unreadable += 1
        ctx.threads.patch(`${SOURCE}:${item.id}`, { pollError: String(error) })
        continue
      }
    }
    // An issue read for the first time becomes a Trigger of its own, whether it was opened a moment ago or is an old one
    // a person has just written on.
    // The project of the issue names the repository the ticket works in; Redmine names it by id and display name only.
    const project = await projectOf(commands, issue)
    const state = ctx.state.get(KV.redmine.issue(item.id))
    if (!state) {
      const trigger = issueTrigger(issue, agent, base, project)
      await ctx.receive(trigger)
      triggers += 1
    }
    // Every journal newer than the one last seen on this issue becomes a Trigger of its own.
    const seen = state?.journal ?? 0
    let newest = seen
    for (const journal of journalsOf(issue)) {
      if (journal.id <= seen) continue
      const token = panelToken(journal.notes ?? '')
      // A panel reply the panel did not hand over to the agent itself is delivered here. The cursor stays before it
      // until it is delivered, so a note of the operator is never skipped for good.
      if (token !== undefined && !ctx.state.get(KV.pms.delivered(token))) {
        const trigger = journalTrigger(issue, journal, agent, base, project, { panel: true })
        if (!trigger) { newest = journal.id; continue }
        await ctx.receive(trigger)
        ctx.state.set(KV.pms.delivered(token), true)
        newest = journal.id
        triggers += 1
        continue
      }
      newest = journal.id
      const trigger = journalTrigger(issue, journal, agent, base, project)
      if (!trigger) continue
      await ctx.receive(trigger)
      triggers += 1
    }
    ctx.state.set(KV.redmine.issue(item.id), { journal: newest })
    ctx.threads.patch(`${SOURCE}:${item.id}`, { pollError: undefined })
    ctx.threads.describe(`${SOURCE}:${item.id}`, { label: `#${issue.id} ${issue.subject}`,
      url: `${base.replace(/\/+$/, '')}/issues/${issue.id}`,
      facts: { number: { value: `#${issue.id}` }, ...issue.status?.name ? { status: { value: issue.status.name } } : {} } })
  }
  // The cursor steps back five seconds so an issue written during the round is read again; stable ids make that harmless.
  ctx.state.set(KV.redmine.since, cursorAt(new Date().toISOString()))
  ctx.report('redmine', { state: 'ready', detail: `${read} issues, ${triggers} triggers${tally.skipped ? `, ${tally.skipped} unreadable` : ''}`,
    at: new Date().toISOString() })
  return { read, triggers, unreadable, issues: issues.size }
}
