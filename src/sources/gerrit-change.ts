/** Gerrit change binding: claims a change for a ticket, watches its state, and reports its end. */
import { key, liveTicket, type OutboundMessage, type Ticket, type Trigger } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { accountOf, changePage, commitMessage, type GerritChange } from './gerrit-read.ts'
import { issueOf, SOURCE, topicOf } from './gerrit-trigger.ts'

const changeNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
/** The change numbers a ticket follows, newest last. */
export const changesOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => changeNumber(item.thread) ?? [])
/** The change a ticket follows, the open one when it has one. */
export const changeOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => changesOf(ticket, true).at(-1) ?? changesOf(ticket).at(-1)
/**
 * True when the change was opened by the agent account, in any repository: a company has many, and the issue its commit
 * message names says which one the change belongs to. A change read from the list of changes names its owner only by an
 * account id, so a change without a user name is not the agent's.
 */
export const agentChange = (change: { owner?: { username?: string; name?: string } | null }, deployment: Pick<Deployment, 'gerrit'>): boolean =>
  !!deployment.gerrit && !!change.owner?.username && sameName(accountOf(change.owner), deployment.gerrit.user)
/** True when a change's topic names the ticket, as the agent names the topic it pushes the change under. */
export const ticketTopic = (ticket: Pick<Ticket, 'execution'>, topic: string): boolean =>
  !!ticket.execution?.name && topic.split('/').at(-1) === ticket.execution.name
/** The Redmine issue a ticket answers, from the Trigger it started on. */
export const issueOfTicket = (ticket: Ticket, triggers: { get(id: string): Trigger | undefined }): string | undefined => {
  const origin = triggers.get(ticket.origin.triggerId)
  return origin?.source === 'redmine' ? String(origin.meta.issueId ?? '') || undefined : undefined
}
/**
 * Validates and binds a change to a ticket. The change must be the agent's own, in any repository, and it must name the
 * ticket: either its commit message carries an `Issue:` trailer with the ticket's Redmine issue, or its topic carries the
 * ticket's short name, as the agent pushes the change under the topic `agent/<ticket name>` (kept for installations that
 * already rely on it).
 * @returns an error message when binding is rejected, or undefined when the change is bound.
 */
export function claimChange(ctx: SourceContext, ticketId: string, change: GerritChange): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'The ticket ended because its change was closed'
  const account = ctx.deployment.gerrit
  if (!agentChange(change, ctx.deployment)) {
    return `The change is not by ${account?.user ?? 'the agent account'}`
  }
  const issue = issueOfTicket(ticket, ctx.triggers)
  const byTopic = ticketTopic(ticket, topicOf(change))
  const byIssue = !!issue && issueOf(commitMessage(change)) === issue
  if (!byTopic && !byIssue) {
    const name = ticket.execution?.name ?? '<ticket name>'
    return `The change does not name this ticket: push it under the topic agent/${name} or add an "Issue: ${issue ?? '<issue number>'}" trailer to the commit message`
  }
  const owner = ctx.tickets.open().find(item => changesOf(item, true).includes(change._number))
  if (owner && owner.id !== ticketId) return 'The change already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${change._number}`)
  // The agent's own change is the ticket's, so following it as `own` ends the ticket once the change closes.
  if (!follow || follow.closed || !follow.own) bind(ctx, ticketId, change, true)
  return undefined
}
/**
 * Binds a change to the open ticket that works the issue its commit message names, `own` when the change is the agent's
 * own patch and followed otherwise: comments on somebody else's patch for the issue reach that ticket too. A change that
 * names no issue, or an issue no open ticket works, is ignored.
 */
export function bindIssue(ctx: SourceContext, change: GerritChange): void {
  const issue = issueOf(commitMessage(change))
  if (!issue) return
  const ticket = ctx.tickets.open().find(item => issueOfTicket(item, ctx.triggers) === issue)
  if (ticket) bind(ctx, ticket.id, change, agentChange(change, ctx.deployment))
}
function bind(ctx: SourceContext, ticketId: string, change: GerritChange, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(change._number) }, own)
    ctx.threads.patch(`${SOURCE}:${change._number}`, { number: change._number, changeId: change.id, project: change.project,
      branch: change.branch, topic: change.topic ?? '', url: change.url ?? '' })
  })
}
/**
 * Reconciles a polled change's state with the ticket that works its issue. A merged or abandoned change ends the ticket's
 * wait for it; an open one is bound to the ticket by the issue its commit message names.
 * @returns whether the change ended.
 */
export async function observeChange(ctx: SourceContext, change: GerritChange): Promise<boolean> {
  // Gerrit reports the status of a change in capitals: NEW, MERGED, ABANDONED or DRAFT.
  const ended = isEnded(change)
  if (ended) closeChange(ctx, change)
  else bindIssue(ctx, change)
  ctx.threads.describe(`${SOURCE}:${change._number}`, { facts: { status: { value: change.status ?? 'unknown' } } })
  return ended
}
/** True when the change was merged or abandoned, the two states that end the wait for it. */
const isEnded = (change: GerritChange): boolean => ['MERGED', 'ABANDONED'].includes((change.status ?? '').toUpperCase())
/** Reports a merged or abandoned change once to the open tickets that follow it, whose end the core decides. */
function closeChange(ctx: SourceContext, change: GerritChange): void {
  if (!ctx.tickets.open().some(ticket => changesOf(ticket, true).includes(change._number))) return
  const merged = (change.status ?? '').toUpperCase() === 'MERGED'
  ctx.tickets.threadClosed({ source: SOURCE, id: String(change._number) }, merged ? 'merged' : 'closed',
    change.updated ?? new Date().toISOString())
}
/**
 * Builds idempotent outbound notices for other conversations when a ticket ends with its change: the change was merged
 * or abandoned. The notice language follows the ticket's source request: Chinese when it contains Han characters and no
 * kana, otherwise English.
 */
export function changeEndNotices(ticket: Ticket, request: string, httpUrl: string, project = ''): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && changeNumber(item.thread) !== undefined)
  const latest = (items: typeof follows) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const number = changeNumber(follow.thread)!
  const url = changePage(httpUrl, number, project)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[Gerrit 变更 ${number}](${url}) 已合入。` : `[Gerrit 变更 ${number}](${url}) 已关闭，未合入。`
    : outcome === 'merged' ? `[Gerrit change ${number}](${url}) has been merged.` : `[Gerrit change ${number}](${url}) was abandoned.`
  // The change itself shows the merge or the abandonment, so the Gerrit channel is skipped.
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('change-terminal', String(number), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id }))
}
