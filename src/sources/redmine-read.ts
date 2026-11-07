/** Redmine REST API access: listing changed issues, reading one issue with its journals, and adding a journal to it. */
import { z } from 'zod'
import { basic } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import { IssueSchema, JournalSchema, type RedmineIssue, type RedmineJournal } from './redmine-trigger.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/**
 * Performs an authenticated Redmine API call and returns its parsed JSON body. The API key travels in the
 * `X-Redmine-API-Key` header and as the user name of the Basic credentials, never in the URL.
 * @throws CliError with Redmine's HTTP status as `code` on failure.
 */
export async function redmineApi<T>(commands: Commands, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const account = commands.redmine
  const response = await commands.http(`${account.baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'X-Redmine-API-Key': account.apiKey, Authorization: basic(account.apiKey, ''), 'Content-Type': 'application/json', Accept: 'application/json' },
    ...init.body !== undefined ? { body: JSON.stringify(init.body) } : {},
  })
  if (response.status === 401 || response.status === 403) throw new CliError(`Redmine refused the request to ${path}`, response.status)
  if (response.status < 200 || response.status >= 300) throw new CliError(`Redmine answered ${response.status} for ${path}: ${response.body.slice(0, 300)}`, response.status)
  // A write answers 204 with no body.
  if (!response.body.trim()) return undefined as T
  try { return JSON.parse(response.body) as T }
  catch { throw new Error(`Redmine answered no JSON for ${path}`) }
}

/**
 * Redmine 4.2 reads a date filter as a second-precision timestamp, and rejects the milliseconds and the numeric offset
 * of `toISOString`. The window is therefore stated in UTC, to the second.
 */
export const stamp = (at: string): string => `${new Date(at).toISOString().slice(0, 19)}Z`

export interface IssueQuery {
  project?: string; since?: string; limit?: number; offset?: number
  /** Restrict to the issues assigned to the API-key account (`assigned_to_id=me`). */
  assignedTo?: 'me'
  /** Restrict to open issues (`status_id=open`), or `*` for every status. */
  status?: 'open' | '*'
  /** The order of the list: oldest first for the changed issues the poll reads, newest first for the operator's inbox. */
  sort?: 'asc' | 'desc'
}
/**
 * Lists the issues changed since `since`, oldest first. Redmine's `updated_on` filter accepts `>=` with an ISO timestamp,
 * which makes the window exact rather than a whole day. Returns the API-key account's own open issues when asked.
 */
export async function listIssues(commands: Commands, query: IssueQuery, tally?: Tally): Promise<RedmineIssue[]> {
  const params = new URLSearchParams()
  if (query.project) params.set('project_id', query.project)
  if (query.assignedTo) params.set('assigned_to_id', query.assignedTo)
  if (query.status) params.set('status_id', query.status)
  if (query.since) params.set('updated_on', `>=${stamp(query.since)}`)
  params.set('sort', `updated_on:${query.sort ?? 'asc'}`)
  params.set('limit', String(query.limit ?? 100))
  params.set('offset', String(query.offset ?? 0))
  const body = await redmineApi<{ issues?: unknown[] }>(commands, `/issues.json?${params}`)
  return validItems(IssueSchema, body.issues ?? [], tally)
}
/**
 * The identifiers of the projects of the instance, by project id. An issue names its project by id and display name, and
 * the identifier is what names the repository a ticket works in, so it is looked up once and kept for a while.
 */
const identifierCache = new Map<string, { at: number; ids: Map<number, string> }>()
const IDENTIFIER_TTL = 300_000

/** The identifiers of every project of the instance, by project id. */
export async function projectIdentifiers(commands: Commands): Promise<Map<number, string>> {
  const base = commands.redmine.baseUrl
  const cached = identifierCache.get(base)
  if (cached && Date.now() - cached.at < IDENTIFIER_TTL) return cached.ids
  // The company may have more projects than one page holds, so the pages are read one after the other.
  const ids = new Map<number, string>()
  for (let offset = 0; offset < 1000; offset += 100) {
    const body = await redmineApi<{ projects?: { id: number; identifier?: string | null }[]; total_count?: number }>(
      commands, `/projects.json?limit=100&offset=${offset}`)
    for (const project of body.projects ?? []) if (project.identifier) ids.set(project.id, project.identifier)
    if ((body.projects ?? []).length < 100 || offset + 100 >= (body.total_count ?? 0)) break
  }
  identifierCache.set(base, { at: Date.now(), ids })
  return ids
}

/**
 * The ids of the closed statuses of the instance: an issue in one of them is finished, and the operator's inbox keeps it
 * only when they archived it.
 */
const closedCache = new Map<string, { at: number; ids: Set<number> }>()

/** The ids of the closed statuses of the instance. */
export async function closedStatuses(commands: Commands): Promise<Set<number>> {
  const base = commands.redmine.baseUrl
  const cached = closedCache.get(base)
  if (cached && Date.now() - cached.at < IDENTIFIER_TTL) return cached.ids
  const body = await redmineApi<{ issue_statuses?: { id: number; is_closed?: boolean }[] }>(commands, '/issue_statuses.json')
  const ids = new Set((body.issue_statuses ?? []).filter(status => status.is_closed).map(status => status.id))
  closedCache.set(base, { at: Date.now(), ids })
  return ids
}

/**
 * The identifier of the project an issue belongs to, which names the repository a ticket works in. The name Redmine shows
 * is the fallback, for an instance that does not answer the project list.
 */
export async function projectOf(commands: Commands, issue: RedmineIssue): Promise<string> {
  if (issue.project?.identifier) return issue.project.identifier
  const id = issue.project?.id
  if (!id) return issue.project?.name ?? ''
  try {
    return (await projectIdentifiers(commands)).get(id) ?? issue.project?.name ?? ''
  } catch { return issue.project?.name ?? '' }
}

/** Reads one issue with its journals and the field changes of each. */
export async function readIssue(commands: Commands, id: number): Promise<RedmineIssue> {
  const body = await redmineApi<{ issue?: unknown }>(commands, `/issues/${id}.json?include=journals`)
  return IssueSchema.parse(body.issue)
}
/**
 * Adds a note to an issue as a new journal. Redmine 4.2 reads the attributes of an issue from the `issue` key of the
 * body, so a note sent at the top level is silently ignored.
 */
export async function postNote(commands: Commands, id: number, notes: string, privateNotes = false): Promise<void> {
  await redmineApi<unknown>(commands, `/issues/${id}.json`, { method: 'PUT', body: { issue: { notes, private_notes: privateNotes } } })
}
/** The journals of an issue, oldest first. */
export const journalsOf = (issue: RedmineIssue): RedmineJournal[] =>
  [...(issue.journals ?? [])].sort((a, b) => a.id - b.id)

/** The messages of one issue, as an assessment reads them: the issue itself first, then its journals. */
export function issueMessages(issue: RedmineIssue, baseUrl: string): ContextMessage[] {
  const messages: ContextMessage[] = [{ id: String(issue.id), from: issue.author?.name ?? '', at: issue.created_on ?? '',
    text: `${issue.subject}\n\n${issue.description ?? ''}`.trim(), url: `${baseUrl.replace(/\/+$/, '')}/issues/${issue.id}` }]
  for (const journal of journalsOf(issue)) {
    const text = (journal.notes ?? '').trim()
    if (!text) continue
    messages.push({ id: String(journal.id), from: journal.user?.name ?? '', at: journal.created_on ?? '', text,
      url: `${baseUrl.replace(/\/+$/, '')}/issues/${issue.id}#change-${journal.id}` })
  }
  return messages
}

/**
 * Reads a Redmine issue or its journals as the model-facing resource the panel and the workers use:
 * `redmine/issues/<id>` and `redmine/issues/<id>/journals`.
 */
export async function readRedmine(commands: Commands, resource: string): Promise<unknown> {
  const match = /^redmine\/issues\/([1-9]\d*)(?:\/(journals))?$/.exec(resource)
  if (!match) throw new Error('Use redmine/issues/<id> or redmine/issues/<id>/journals')
  const id = Number(match[1]!)
  const issue = await readIssue(commands, id)
  const base = commands.redmine.baseUrl
  if (!match[2]) return { id: issue.id, subject: issue.subject, status: issue.status?.name ?? '', tracker: issue.tracker?.name ?? '',
    project: issue.project?.identifier ?? issue.project?.name ?? '', assigned_to: issue.assigned_to?.name ?? '', author: issue.author?.name ?? '',
    created_on: issue.created_on ?? '', updated_on: issue.updated_on ?? '', url: `${base}/issues/${issue.id}`,
    description: issue.description ?? '', journal_count: (issue.journals ?? []).length }
  const tally = { skipped: 0 }
  const journals = validItems(JournalSchema, issue.journals ?? [], tally)
  return { items: journals.map(journal => ({ id: journal.id, at: journal.created_on ?? '', from: journal.user?.name ?? '',
    notes: journal.notes ?? '', private: journal.private_notes === true })), ...tally.skipped ? { skipped: tally.skipped } : {} }
}

/**
 * Context reader for a Redmine Trigger: the issue and its journals. Redmine has no threads, so the issue is the whole
 * conversation and its first page holds the issue itself and every journal.
 */
export const redmineThreadContext: ThreadContext<unknown> = {
  messageId: trigger => String(trigger.meta.journalId ?? trigger.meta.issueId ?? ''),
  read: async (commands, trigger) => {
    const id = Number(trigger.meta.issueId)
    if (!id) return { messages: [], body: { messages: [] } }
    const issue = await readIssue(commands, id)
    const messages = issueMessages(issue, commands.redmine.baseUrl)
    return { messages, body: { messages } }
  },
}
