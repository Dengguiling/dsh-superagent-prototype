/**
 * PMS view: the operator's task inbox — the Redmine issues assigned to the bound account — each task's conversation, and
 * the work in the pipeline. The inbox is read live from the task system; the local list state is kept in the KV store.
 */
import { randomUUID } from 'node:crypto'
import { key, ticketStage, type Trigger } from '../../core/index.ts'
import type { Deployment, RedmineAccount } from '../../deployment.ts'
import { workerSessionId } from '../../executor/dsh.ts'
import { CliError, type Commands } from '../../infra/commands.ts'
import { KV } from '../../kv.ts'
import { changesOf } from '../../sources/gerrit-change.ts'
import { closedStatuses, journalsOf, listIssues, postNote, projectOf, readIssue } from '../../sources/redmine-read.ts'
import { actorOf, agentNote, panelNote, panelNoteText, redmineChannel, redmineJournalPage, redminePage, SOURCE,
  type RedmineIssue } from '../../sources/redmine-trigger.ts'
import type { Store } from '../store.ts'
import { awaitingEval, ownersOf } from './records.ts'

/**
 * Where a task stands in the agent's work: not judged yet, declined by the route, worked on, waiting for the person, or
 * finished.  The workbench shows the state of every task, so an operator sees why a task was not taken.
 */
export type PmsState = 'undecided' | 'declined' | 'working' | 'waiting' | 'ended'

/** One task of the inbox, with the project that names its repository and the ticket the agent holds for it. */
export interface PmsTask {
  id: number
  subject: string
  status: string
  priority: string
  assignee: string
  author: string
  /** The Redmine project identifier, which names the Gerrit repository. */
  project: string
  updated: string
  url: string
  /** Set when the operator archived the task from the workbench. */
  archivedAt?: string
  /** Where the task stands in the agent's work. */
  state: PmsState
  /** Why the route declined the task, by reason code; set when the state is `declined`. */
  reason?: string
  /** The ticket the agent holds for the task, with its stage, its change and its worker Session. */
  ticket?: { id: string; title: string; stage: string; action?: string; change?: number; session?: string }
}

/** One message of a task's conversation: the issue description, or a note of its discussion. */
export interface PmsMessage {
  id: string
  at: string
  /** agent = a superagent reply, you = the operator, other = someone else on the task. */
  role: 'agent' | 'you' | 'other'
  name: string
  text: string
  url: string
}

/** The work in the pipeline now, and what passed it in the last 24 hours. */
export interface PmsPipeline {
  /** Tasks open in the task system. */
  tasks: number
  /** Tasks the agent holds a ticket for. */
  taken: number
  /** Triggers that arrived in the last 24 hours. */
  arrived: number
  /** The Sources the Source status lists. */
  sources: number
  /** The Threads the Trigger list shows under its Subscribed filter. */
  threads: number
  /** Threads at the Eval stage: being evaluated now, or holding a Trigger that waits for a Decision. */
  evaluating: number
  /** Open tickets. */
  tickets: number
  /** Open tickets the Executor is working on. */
  working: number
  /** Open tickets waiting for a free worker slot. */
  queued: number
  /** Open tickets waiting for a person. */
  waiting: number
  /** Open tickets idle between turns. */
  idle: number
  /** Tickets ended in the last 24 hours. */
  ended: number
}

/** The operator's task inbox: the tasks to do, the ones they archived, the pipeline, and the connection to the task system. */
export interface PmsView {
  /** The tasks assigned to the bound account and not archived: the ones the agent works on and the ones it has not judged. */
  tasks: PmsTask[]
  /** The tasks the route declined; the reason is on the task. */
  declined: PmsTask[]
  /** The tasks the operator archived; the task system is untouched. */
  archived: PmsTask[]
  pipeline: PmsPipeline
  /** The Executor's worker slots: running workers, the configured maximum, and whether processing is paused. */
  executor: { running: number; max: number; paused: boolean }
  /** The task system: configured when the deployment names one; connected when its last read succeeded. */
  source: { name: string; url: string; configured: boolean; connected: boolean; error?: string }
  updatedAt: string
}

/** One task's page: the task, its issue thread, whether the operator may reply, and the connection to the task system. */
export interface PmsTaskView {
  task: PmsTask
  /** The issue description, then its discussion, oldest first. */
  messages: PmsMessage[]
  canReply: boolean
  source: PmsView['source']
}

type SourceView = PmsView['source']
type TicketView = NonNullable<PmsTask['ticket']>
type TaskFlags = { archivedAt?: string; deletedAt?: string }

const day = 86_400_000
/** The hidden markers on agent and panel notes, which the panel strips from the conversation. */
const NOTES_MARKER = /<!--\s*dsh-superagent(?:-panel)?:[^>]*-->/g
const withoutMarkers = (text: string): string => text.replace(NOTES_MARKER, '').trim()
/**
 * Redmine's own formatting, as plain text a person can read in the panel: a heading loses its marker, inline code keeps
 * its code, a bullet becomes a dot, and a bold word loses its stars.
 */
const readable = (text: string): string => text
  .replace(/^[ \t]*h[1-6]\.[ \t]*/gm, '')
  .replace(/^[ \t]*pre\.[ \t]*$/gm, '')
  .replace(/^[ \t]*>[ \t]?/gm, '    ')
  .replace(/^[ \t]*\*[ \t]/gm, '• ')
  .replace(/@([^@\n]+)@/g, '`$1`')
  .replace(/^([^\n*]*)\*([^*\n]+)\*([^\n]*)$/gm, '$1$2$3')
  .replace(/\n{3,}/g, '\n\n')
  .trim()

/** The task system as the workbench names it: configured when the deployment has an account; connected when it answered. */
const sourceOf = (account: RedmineAccount | undefined, connected: boolean, error?: string): SourceView =>
  ({ name: account?.login ?? '', url: account?.baseUrl ?? '', configured: !!account, connected, ...error ? { error } : {} })

/**
 * Reads the operator's inbox: every open issue assigned to the bound account, in every project, read live. When the task
 * system cannot be reached the inbox is empty and the failure is kept for the view.
 */
async function readInbox(commands: Commands, deployment: Deployment): Promise<{ account: RedmineAccount | undefined
  issues: RedmineIssue[]; closed: Set<number>; connected: boolean; error?: string }> {
  const account = deployment.redmine
  if (!account) return { account, issues: [], closed: new Set(), connected: false }
  try {
    // The closed statuses tell a finished issue from an open one; without them the list holds the open issues only.
    const closed = await closedStatuses(commands).catch(() => undefined)
    // The newest issues first, so a task that was assigned today is never behind a hundred older ones, and every
    // status, so a task the operator archived stays in the list after the issue is closed.
    const issues = await listIssues(commands, { assignedTo: 'me', status: closed ? '*' : 'open', sort: 'desc', limit: 100 })
    return { account, issues, closed: closed ?? new Set(), connected: true }
  } catch (failure) {
    return { account, issues: [], closed: new Set(), connected: false, error: failure instanceof Error ? failure.message : String(failure) }
  }
}

/** The tickets the agent holds, by the Redmine issue each one answers; the newest ticket of an issue wins. */
function heldTickets(store: Store): Map<number, TicketView> {
  const held = new Map<number, TicketView>()
  for (const ticket of store.tickets.list()) {
    const trigger = store.triggers.get(ticket.origin.triggerId)
    const issue = Number(trigger?.meta.issueId ?? NaN)
    if (!Number.isFinite(issue) || held.has(issue)) continue
    const change = changesOf(ticket, true).at(-1)
    const stage = ticketStage(ticket)
    held.set(issue, { id: ticket.id, title: ticket.title, stage: stage.stage,
      ...('action' in stage ? { action: stage.action } : {}), session: workerSessionId(ticket.id),
      ...change === undefined ? {} : { change } })
  }
  return held
}

/** The reason the route declined a task, by code: the decision of the last eval of the issue's thread. */
function declineOf(store: Store, issue: number): string | undefined {
  const decision = store.decisions.byThread(`redmine:${issue}`).at(-1)
  if (decision?.kind !== 'ignore') return undefined
  return decision.reason[0]?.code
}

/** Projects one issue into an inbox task, with the operator's local list state and the ticket held for it. */
function taskOf(issue: RedmineIssue, account: RedmineAccount, held: Map<number, TicketView>, flags: TaskFlags | undefined,
  project: string, decline: string | undefined): PmsTask {
  const ticket = held.get(issue.id)
  const stage = ticket?.stage
  const state: PmsState = stage === 'person' ? 'waiting' : stage === 'ended' ? 'ended'
    : stage ? 'working' : decline ? 'declined' : 'undecided'
  return {
    id: issue.id, subject: issue.subject, status: issue.status?.name ?? '', priority: issue.priority?.name ?? '',
    // The API joins the first and the last name of an account with a space; a name without a first name arrives with a leading one.
    assignee: (issue.assigned_to?.name ?? '').trim(), author: (issue.author?.name ?? '').trim(),
    project,
    updated: issue.updated_on ?? '', url: redminePage(account.baseUrl, issue.id),
    state,
    ...decline && state === 'declined' ? { reason: decline } : {},
    ...flags?.archivedAt ? { archivedAt: flags.archivedAt } : {},
    ...ticket ? { ticket } : {},
  }
}

/**
 * Builds the operator's inbox: the open issues assigned to the bound account, the ones they archived, and the work in the
 * pipeline now. The task system is read live, so the list shows what is there now; when it cannot be reached the lists are
 * empty and the view says why. `running` is the number of workers the Executor has busy.
 */
export async function pms(store: Store, commands: Commands, deployment: Deployment, running: number, sources = 0): Promise<PmsView> {
  const inbox = await readInbox(commands, deployment)
  const held = heldTickets(store)
  const tasks: PmsTask[] = []
  const declined: PmsTask[] = []
  const archived: PmsTask[] = []
  for (const issue of inbox.issues) {
    const flags = store.get(KV.pms.task(issue.id))
    if (flags?.deletedAt) continue
    const task = taskOf(issue, inbox.account!, held, flags, await projectOf(commands, issue), declineOf(store, issue.id))
    if (task.archivedAt) archived.push(task)
    // A closed issue is finished: it stays in the list only when the operator archived it.
    else if (!inbox.closed.has(issue.status?.id ?? 0)) {
      // A task the route declined is not work in progress; it has its own list.
      if (task.state === 'declined') declined.push(task)
      else tasks.push(task)
    }
  }
  const settings = store.settings()
  // The work in the pipeline now, by the stage each open ticket is in, and what passed through in the last 24 hours.
  const open = store.tickets.open()
  const stages = open.map(ticket => ticketStage(ticket))
  const since = new Date(Date.now() - day).toISOString()
  const arrived = Object.values(store.read.triggerStats(since)).reduce((sum, stats) => sum + stats.received, 0)
  const ended = store.tickets.list().filter(ticket => ticket.ended && Date.parse(ticket.ended.at ?? '') >= Date.now() - day)
  // The Eval stage holds the Threads the Assessor is judging and the ones holding a Trigger that waits for a Decision:
  // the same Threads the Trigger list shows under its 评估中 filter.
  const owners = ownersOf(store)
  const evaluating = store.threads.active()
    .filter(thread => thread.evaluating || awaitingEval({ store, owners }, thread).length > 0).length
  // The Threads the Trigger list shows: the ones subscribed to a Ticket that is still open.
  const openIds = new Set(open.map(ticket => ticket.id))
  const threads = store.read.subscribedThreads().filter(thread => thread.subscriptions.some(id => openIds.has(id))).length
  return {
    tasks,
    declined,
    archived,
    pipeline: {
      tasks: tasks.length,
      taken: tasks.filter(task => !!task.ticket).length,
      arrived,
      sources,
      threads,
      evaluating,
      tickets: open.length,
      working: stages.filter(stage => stage.stage === 'working').length,
      queued: stages.filter(stage => stage.stage === 'working' && stage.action === 'queued').length,
      waiting: stages.filter(stage => stage.stage === 'person').length,
      idle: stages.filter(stage => stage.stage === 'idle').length,
      ended: ended.length,
    },
    executor: { running, max: settings.executor.maxWorkers, paused: settings.paused },
    source: sourceOf(inbox.account, inbox.connected, inbox.error),
    updatedAt: new Date().toISOString(),
  }
}

/** The conversation of an issue: the reporter's description first, then the notes of the discussion, oldest first. */
function messagesOf(issue: RedmineIssue, account: RedmineAccount): PmsMessage[] {
  const base = account.baseUrl
  const author = issue.author
  const messages: PmsMessage[] = [{ id: `issue-${issue.id}`, at: issue.created_on ?? '',
    role: !!account.id && author?.id === account.id ? 'you' : 'other', name: actorOf(author),
    text: readable(issue.description ?? ''), url: redminePage(base, issue.id) }]
  for (const journal of journalsOf(issue)) {
    const notes = (journal.notes ?? '').trim()
    if (!notes) continue
    // The agent's notes are the ones carrying the outbox marker; every other note of the bound account is the operator's.
    const role = agentNote(notes) ? 'agent' : panelNote(notes) || (!!account.id && journal.user?.id === account.id) ? 'you' : 'other'
    messages.push({ id: `journal-${journal.id}`, at: journal.created_on ?? issue.updated_on ?? '', role, name: actorOf(journal.user),
      text: readable(withoutMarkers(notes)), url: redmineJournalPage(base, issue.id, journal.id) })
  }
  return messages
}

/**
 * Reads one task of the inbox: the issue with its conversation, the project it belongs to, and the ticket the agent holds
 * for it. Returns undefined when the issue is not a task of the inbox: the task system is not configured, the operator hid
 * the task, the issue is gone, or it is assigned to someone else.
 */
export async function pmsTask(store: Store, commands: Commands, deployment: Deployment, issue: number): Promise<PmsTaskView | undefined> {
  const account = deployment.redmine
  if (!account) return undefined
  if (store.get(KV.pms.task(issue))?.deletedAt) return undefined
  let item: RedmineIssue
  try { item = await readIssue(commands, issue) } catch (failure) {
    if (failure instanceof CliError && (failure.code === 404 || failure.code === 410)) return undefined
    throw failure
  }
  if (item.assigned_to?.id !== account.id) return undefined
  return {
    task: taskOf(item, account, heldTickets(store), store.get(KV.pms.task(item.id)), await projectOf(commands, item),
      declineOf(store, item.id)),
    messages: messagesOf(item, account),
    canReply: true,
    source: sourceOf(account, true),
  }
}

/**
 * Posts the operator's reply on the issue as a note carrying the panel marker, then hands it to the agent at once as a
 * human Trigger of the issue thread, so the agent continues the task without waiting for the poll. Redmine remains the record.
 */
export async function pmsReply(store: Store, commands: Commands, deployment: Deployment, issue: number, text: string,
  receive: (trigger: Trigger) => unknown): Promise<void> {
  const account = deployment.redmine
  if (!account) throw new Error('The task system is not configured')
  // The issue supplies what the Trigger needs beyond the note: its project, and whether it is assigned to the account.
  const item = await readIssue(commands, issue)
  const project = await projectOf(commands, item)
  const token = randomUUID()
  await postNote(commands, issue, `${text}\n\n${panelNoteText(token)}`)
  const direct = item.assigned_to?.id === account.id
  // The note is written to the task system first, so it is the record even when the hand-off to the agent fails. The
  // token is recorded only after the hand-off, so the Source delivers the note on its next poll when it failed.
  receive({
    id: key('redmine-panel', token),
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue) }],
    actor: { source: SOURCE, id: actorOf({ id: account.id, login: account.login, name: account.name }) },
    human: true,
    ...direct ? { addressed: 'direct' as const } : {},
    at: new Date().toISOString(),
    text,
    channel: redmineChannel(issue),
    url: redminePage(account.baseUrl, issue),
    meta: { issueId: issue, project, kind: 'journal' },
  })
  store.set(KV.pms.delivered(token), true)
}

/** Archives or restores a task in the operator's own list; the task system is untouched. */
export function pmsArchive(store: Store, issue: number, archived: boolean): void {
  const current = store.get(KV.pms.task(issue)) ?? {}
  if (archived) { store.set(KV.pms.task(issue), { ...current, archivedAt: current.archivedAt ?? new Date().toISOString() }); return }
  const { archivedAt: _archivedAt, ...kept } = current
  if (kept.deletedAt) store.set(KV.pms.task(issue), kept)
  else store.delete(KV.pms.task(issue))
}

/** Hides a task from the operator's list for good; the task system keeps the issue. */
export function pmsDelete(store: Store, issue: number): void {
  store.set(KV.pms.task(issue), { ...store.get(KV.pms.task(issue)) ?? {}, deletedAt: new Date().toISOString() })
}
