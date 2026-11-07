/** Gerrit source kind definition, change polling loop, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { GerritAccountsSchema } from '../deployment.ts'
import { CliError, validItems, type Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { pause } from './poll.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { changePage, commitMessage, gerritThreadContext, listChanges, listComments, readChange, type GerritChange } from './gerrit-read.ts'
import { gerritLink, sendGerrit } from './gerrit-channel.ts'
import { bindIssue, changesOf, observeChange } from './gerrit-change.ts'
import { commentTrigger, issueOf, messageTrigger, SOURCE } from './gerrit-trigger.ts'

const GerritConfigSchema = GerritAccountsSchema.extend({
  pollSeconds: z.number().int().min(10).max(3600).default(30),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  observeComments: z.boolean().default(false),
  observeMessages: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
}).strict()
export type GerritConfig = z.infer<typeof GerritConfigSchema>
const OBSERVED = { comment: 'observeComments', message: 'observeMessages' } as const
type Scope = keyof typeof OBSERVED
/** The receiving scope of a Gerrit Trigger: a review comment, or a change message. */
const scopeOf = (meta: Record<string, unknown>): Scope => meta.kind === 'message' ? 'message' : 'comment'

export const gerritKind: SourceKind<GerritConfig> = {
  kind: SOURCE,
  title: { zh: 'Gerrit', en: 'Gerrit' },
  description: { zh: '代码评审系统；不论仓库，跟踪提交信息带 Redmine 任务号的开放变更，接收它们上面的评审意见与变更消息，智能体在这里答复评审。',
    en: 'The code review server; wherever a change lives, it tracks the open changes whose commit message names a Redmine task and receives their review comments and change messages, where the agent answers reviewers.' },
  schema: GerritConfigSchema,
  fields: [
    { key: 'httpUrl', type: 'text', label: { zh: 'Gerrit 地址', en: 'Gerrit address' },
      hint: { zh: '评审系统的 HTTP 地址，例如 http://gerrit.example.com:8080。保存时检查账号，然后重启 dsh-superagent。',
        en: 'The HTTP address of the review server, such as http://gerrit.example.com:8080. Saving checks the account, then restarts dsh-superagent.' } },
    { key: 'sshUrl', type: 'text', label: { zh: '推送用的 SSH 地址', en: 'SSH address for pushes' },
      hint: { zh: '智能体推送补丁的地址，例如 ssh://agent@gerrit.example.com:29418；补丁推到 refs/for/<分支>。',
        en: 'The address the agent pushes patches to, such as ssh://agent@gerrit.example.com:29418; patches go to refs/for/<branch>.' } },
    { key: 'project', type: 'text', label: { zh: '项目（可选）', en: 'Project (optional)' },
      hint: { zh: '留空时跟踪所有仓库里提交信息带 Redmine 任务号（如 Issue: #12）的变更；填写时只跟踪这个项目，兼容旧的单仓库设置。',
        en: 'Empty tracks the changes of every repository whose commit message names a Redmine task, such as Issue: #12; a name narrows tracking to that one project, the legacy single-repository setting.' } },
    { key: 'user', type: 'text', label: { zh: '绑定的 Gerrit 账号', en: 'The bound Gerrit account' },
      hint: { zh: 'Gerrit 上的用户名；智能体用它推送补丁，它名下的变更算工单自己的补丁。',
        en: 'The user name on Gerrit; the agent pushes patches as this account, and a change it owns is the ticket\'s own patch.' } },
    { key: 'password', type: 'text', label: { zh: 'HTTP 密码', en: 'HTTP password' },
      hint: { zh: 'Gerrit 账号的 HTTP 密码，用于读取评审意见；这是凭据，不会进入智能体的运行环境。',
        en: 'The HTTP password of the Gerrit account, used to read review comments; it is a credential and never reaches the agent environment.' } },
    { key: 'keyPath', type: 'text', label: { zh: 'SSH 私钥', en: 'SSH private key' },
      hint: { zh: '推送补丁用的私钥路径；公钥要注册在 Gerrit 账号上。', en: 'The path of the private key used to push patches; its public key must be registered with the Gerrit account.' } },
    { key: 'email', type: 'text', label: { zh: '提交邮箱', en: 'Commit email' },
      hint: { zh: 'Gerrit 接受的提交邮箱；gerrit 没有身份时，提示词要求按它署名提交。', en: 'The commit email Gerrit accepts; git has no identity here, so commits are made as the instructions name.' } },
    { key: 'branch', type: 'text', label: { zh: '目标分支', en: 'Target branch' },
      hint: { zh: '补丁推送到的分支，如 main；推送到 refs/for/<分支>。', en: 'The branch patches are pushed to, such as main; they go to refs/for/<branch>.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observeComments', type: 'switch', label: { zh: '接收没有 @ 智能体的评审意见', en: 'Receive review comments that do not mention the agent' },
      hint: { zh: '打开后，评审意见也会收到，由策略的接收表决定是否成为候选。',
        en: 'Review comments are received too, and the Policy\'s admission table decides whether they become candidates.' } },
    { key: 'observeMessages', type: 'switch', label: { zh: '接收变更消息', en: 'Receive change messages' },
      hint: { zh: '打开后，合入、放弃等变更消息也会收到；这些是机器消息，永远不会单独发起工作。',
        en: 'Merge and abandonment messages are received too; they are machine messages and never originate work on their own.' } },
  ],
  scope: ({ meta }, config) => {
    const scope = scopeOf(meta)
    return { listened: true, observed: config[OBSERVED[scope]], row: scope }
  },
  health: ['gerrit'],
  channel: { send: sendGerrit, link: gerritLink },
  threadContext: gerritThreadContext,
  // `gerrit/12` or the page of a change names Thread 12.
  find: query => {
    const number = (/^gerrit\/(\d+)$/.exec(query.trim()) ?? /\/c\/(\d+)/.exec(query))?.[1]
    return { threads: number ? [`${SOURCE}:${number}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Gerrit 账号', en: 'Gerrit accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' } },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] }],
    explicit: { zh: '名单里的 Gerrit 账号在评审意见里 @ 智能体的账号。', en: 'A Gerrit account on the list mentions the agent\'s account in a review comment.' },
    rows(stored) {
      const config = GerritConfigSchema.partial().parse(stored)
      const note = (observed: boolean | undefined) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @', en: '@ only' }
      const row = (id: Scope, label: { zh: string; en: string }) => ({ id, label, note: note(config[OBSERVED[id]]),
        cells: { listedUnaddressed: !!config[OBSERVED[id]], unlistedAddressed: true, unlistedUnaddressed: !!config[OBSERVED[id]] } })
      return [row('comment', { zh: '评审意见', en: 'Review comments' }), row('message', { zh: '变更消息', en: 'Change messages' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GERRIT_SSH_URL', description: { zh: '克隆和推送用的 SSH 地址，含工单所在仓库的名字。', en: 'The SSH address of the ticket\'s repository, used to clone and to push.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_PUSH_REF', description: { zh: '推送补丁的引用，如 refs/for/main。', en: 'The ref patches are pushed to, such as refs/for/main.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_HTTP_URL', description: { zh: '评审系统的 HTTP 地址。', en: 'The HTTP address of the review server.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_PROJECT', description: { zh: '工单所在的仓库：事务的项目，或变更的项目；设置里指定了项目时按设置。',
        en: 'The ticket\'s repository: the issue\'s project, or the change\'s project; a configured project overrides it.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_BRANCH', description: { zh: '补丁推送到的分支。', en: 'The branch patches are pushed to.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_USER', description: { zh: '绑定的 Gerrit 账号；没有署名要求时按它提交。', en: 'The bound Gerrit account; commit as it when no author is named.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_EMAIL', description: { zh: 'Gerrit 接受的提交邮箱。', en: 'The commit email Gerrit accepts.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_CHANGE_NUMBER', description: { zh: '接下工单的变更编号。', en: 'The number of the change that started the ticket.' } },
      { key: 'DSH_SUPERAGENT_GERRIT_CHANGE_URL', description: { zh: '接下工单的变更页面地址。', en: 'The page of the change that started the ticket.' } },
    ],
    values: ({ deployment, config, trigger }) => {
      const account = deployment.gerrit
      const number = trigger?.source === SOURCE ? Number(trigger.meta.changeNumber) || 0 : 0
      const http = account?.httpUrl ?? config.httpUrl
      // The project names the repository the ticket works in: a configured project is the legacy single-repository
      // override, otherwise a Redmine Trigger's issue project or a Gerrit Trigger's change project names it.
      const project = account?.project || config.project || String(trigger?.meta.project ?? '')
      const ssh = account?.sshUrl ?? config.sshUrl
      const branch = account?.branch ?? config.branch
      return { DSH_SUPERAGENT_GERRIT_SSH_URL: ssh ? `${ssh.replace(/\/+$/, '')}/${project}` : '',
        DSH_SUPERAGENT_GERRIT_PUSH_REF: `refs/for/${branch}`, DSH_SUPERAGENT_GERRIT_HTTP_URL: http,
        DSH_SUPERAGENT_GERRIT_PROJECT: project, DSH_SUPERAGENT_GERRIT_BRANCH: branch,
        DSH_SUPERAGENT_GERRIT_USER: account?.user ?? config.user, DSH_SUPERAGENT_GERRIT_EMAIL: account?.email ?? config.email,
        DSH_SUPERAGENT_GERRIT_CHANGE_NUMBER: number ? String(number) : '',
        DSH_SUPERAGENT_GERRIT_CHANGE_URL: number && http ? changePage(http, number, project) : '' }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gerrit ? {
    user: { zh: `当前账号 ${deployment.gerrit.user}`, en: `Current account ${deployment.gerrit.user}` },
  } : {},
}

export const name = 'dsh-superagent-gerrit'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gerritKind), 'gerrit: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gerritKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('gerrit', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gerrit', health('paused', 'setupPending')); return }
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<GerritConfig>(SOURCE)
    try {
      if (config) await pollRound(ctx, signal)
      else ctx.report('gerrit', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gerrit', failed)
    }
    await pause(Math.max(config?.pollSeconds ?? 30) * 1000, signal)
  }
}
export interface Round { changes: number; triggers: number; closed: number; unreadable: number }
/** Keeps the identifiers of the comments already read, so the list stays bounded on a long-lived change. */
const SEEN_LIMIT = 200
/**
 * One polling round: the open changes whose commit message names a Redmine issue, wherever they are, their review comments
 * and change messages, and the changes the open tickets follow. Every change fails on its own, so one unreadable change
 * does not stop the round.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<Round> {
  const config = ctx.config<GerritConfig>(SOURCE)
  const account = ctx.deployment.gerrit
  if (!config || !account) return { changes: 0, triggers: 0, closed: 0, unreadable: 0 }
  const commands = ctx.commands.withSignal(signal)
  const tally: Tally = { skipped: 0 }
  // Empty means every repository, which is the usual corporate setting; a configured project is the legacy override.
  // The account's project is not a fallback: an account resolved before the setting was emptied still names one, and
  // the company tracks every repository.
  const project = config.project
  const changes = await listChanges(commands, { ...project ? { project } : {}, status: 'open', limit: config.limit }, tally)
  let triggers = 0
  let closed = 0
  let unreadable = 0
  // The changes read in this round, so a change a Ticket follows is read once and not twice.
  const read = new Map<string, GerritChange>()
  for (const listed of changes) {
    if (signal?.aborted) throw new Error('The Gerrit Source stopped during the poll')
    // Only a change whose commit message names a Redmine issue is tracked; the list carries the message.
    const issue = issueOf(commitMessage(listed))
    if (!issue) continue
    const number = String(listed._number)
    try {
      // The change is read once more: the list names its owner only by an account id, and its messages and its current
      // revision are only in the detail.
      const change = await readChange(commands, number)
      read.set(number, change)
      // The change belongs to the ticket that works its issue, whether the agent or somebody else pushed it.
      bindIssue(ctx, change)
      // A reviewer's note on the change is a change message; the ones Gerrit writes about a patch set ask for nothing.
      const seenMessages = ctx.state.get(KV.gerrit.message(number)) ?? []
      const freshMessages = (change.messages ?? []).filter(message => !!message.id && !seenMessages.includes(message.id))
      for (const message of freshMessages) {
        const trigger = messageTrigger(change, message, account.user, account.httpUrl, issue)
        if (!trigger) continue
        await ctx.receive(trigger)
        triggers += 1
      }
      ctx.state.set(KV.gerrit.message(number), [...seenMessages, ...freshMessages.map(message => message.id!)].slice(-SEEN_LIMIT))
      // A comment on a file of the change is a review comment, and it carries the issue's Thread as well as the change's.
      const seen = ctx.state.get(KV.gerrit.comment(number)) ?? []
      const comments = await listComments(commands, number, tally)
      const fresh = comments.filter(comment => !seen.includes(comment.id))
      for (const comment of fresh) {
        const trigger = commentTrigger(change, comment, account.user, account.httpUrl, issue)
        if (!trigger) continue
        await ctx.receive(trigger)
        triggers += 1
      }
      ctx.state.set(KV.gerrit.comment(number), [...seen, ...fresh.map(comment => comment.id)].slice(-SEEN_LIMIT))
      ctx.threads.describe(`${SOURCE}:${change._number}`, { label: `#${change._number} ${change.subject ?? ''}`,
        url: changePage(account.httpUrl, change._number, change.project),
        facts: { number: { value: `#${change._number}` }, ...change.status ? { status: { value: change.status } } : {} } })
    } catch (error) {
      if (signal?.aborted) throw error
      unreadable += 1
      ctx.threads.patch(`${SOURCE}:${number}`, { pollError: String(error) })
    }
  }
  // The changes the open tickets follow are read one by one, so a merge is noticed even when the change left the open list.
  for (const number of [...new Set(ctx.tickets.open().flatMap(ticket => changesOf(ticket, true)))].map(String)) {
    if (signal?.aborted) throw new Error('The Gerrit Source stopped during the poll')
    try {
      const change = read.get(number) ?? await readChange(commands, number)
      if (await observeChange(ctx, change)) closed += 1
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof CliError && (error.code === 404 || error.code === 410)) {
        // The change is gone; its thread ends as closed.
        ctx.tickets.threadClosed({ source: SOURCE, id: String(number) }, 'closed', new Date().toISOString())
        closed += 1
        continue
      }
      unreadable += 1
      ctx.threads.patch(`${SOURCE}:${number}`, { pollError: String(error) })
    }
  }
  ctx.state.set(KV.gerrit.since, new Date().toISOString())
  ctx.report('gerrit', { state: 'ready', detail: `${changes.length} changes, ${triggers} triggers${closed ? `, ${closed} closed` : ''}`,
    at: new Date().toISOString() })
  return { changes: changes.length, triggers, closed, unreadable }
}
/** The commit message of a change, which names the task it answers. */
export { commitMessage }
