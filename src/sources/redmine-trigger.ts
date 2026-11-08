/** Redmine source kind: normalizes issues and their journals into domain Triggers. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'redmine'
/** Redmine reply address: the issue a journal is added to. */
export const redmineChannel = (issueId: number): ChannelRef =>
  ({ source: SOURCE, thread: `redmine:${issueId}`, address: { issue: String(issueId) } })
/** The web page of an issue. */
export const redminePage = (baseUrl: string, issueId: number): string => `${baseUrl.replace(/\/+$/, '')}/issues/${issueId}`
/** The anchor of one journal on the page of its issue. */
export const redmineJournalPage = (baseUrl: string, issueId: number, journalId: number): string =>
  `${redminePage(baseUrl, issueId)}#change-${journalId}`

/**
 * A Redmine user as the API renders it. An issue and a journal carry only the id and the display name of their author;
 * the login and the mail appear only on the account itself, which `GET /users/current.json` returns.
 */
export const UserSchema = z.looseObject({
  id: z.number().int(), login: z.string().nullish(), name: z.string().nullish(),
  firstname: z.string().nullish(), lastname: z.string().nullish(), mail: z.string().nullish(),
})
export type RedmineUser = z.infer<typeof UserSchema>

/** One journal of an issue: a note, and the field changes Redmine records beside it. */
export const JournalSchema = z.looseObject({
  id: z.number().int(), notes: z.string().nullish(), user: UserSchema.nullish(),
  created_on: z.string().nullish(), updated_on: z.string().nullish(), private_notes: z.boolean().optional(),
  details: z.array(z.looseObject({
    property: z.string().nullish(), name: z.string().nullish(), old_value: z.unknown().optional(), new_value: z.unknown().optional(),
  })).nullish(),
})
export type RedmineJournal = z.infer<typeof JournalSchema>

/** An issue as the API returns it, with its journals when they were requested. */
export const IssueSchema = z.looseObject({
  id: z.number().int(), subject: z.string(), description: z.string().nullish(),
  project: z.looseObject({ id: z.number().int(), identifier: z.string().nullish(), name: z.string().nullish() }).nullish(),
  tracker: z.looseObject({ id: z.number().int(), name: z.string().nullish() }).nullish(),
  status: z.looseObject({ id: z.number().int(), name: z.string().nullish() }).nullish(),
  priority: z.looseObject({ id: z.number().int(), name: z.string().nullish() }).nullish(),
  author: UserSchema.nullish(), assigned_to: UserSchema.nullish(),
  created_on: z.string().nullish(), updated_on: z.string().nullish(),
  journals: z.array(JournalSchema).nullish(),
  custom_fields: z.array(z.looseObject({ id: z.number().int(), name: z.string(), value: z.unknown().optional() })).nullish(),
})
export type RedmineIssue = z.infer<typeof IssueSchema>

/**
 * The identity of a Redmine user in the vocabulary the Policy lists. The API reports a display name beside the id, and
 * no login, so the name is what a person sees in Redmine and what a Policy entry names.  The name is trimmed: the API
 * joins the first and the last name with a space, and a name that has no first name arrives with a leading space.
 */
export const actorOf = (user: RedmineUser | null | undefined): string =>
  (user?.name ?? user?.login ?? (user?.id ? String(user.id) : '')).trim()
/** The display name of a Redmine user. */
export const nameOf = (user: RedmineUser | null | undefined): string =>
  [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.name || actorOf(user)
/**
 * True when the text addresses the agent by its Redmine login. Redmine has no mention of its own, so `@login` in plain text
 * is the convention its users follow.
 */
export const mentions = (text: string, login: string): boolean =>
  !!login && new RegExp(`(?:^|[^a-zA-Z0-9_@])@${escapeRegExp(login)}(?![a-zA-Z0-9_-])`, 'i').test(text)
/** True when the issue is assigned to the agent account, which the API reports by the account's id. */
export const assignedTo = (issue: RedmineIssue, agentId: number): boolean => !!agentId && issue.assigned_to?.id === agentId
/** The field changes of a journal, as text; Redmine records them beside the note. */
export const detailsText = (journal: RedmineJournal): string =>
  (journal.details ?? []).map(detail => {
    const field = detail.name ?? detail.property ?? 'a field'
    const from = detail.old_value == null || detail.old_value === '' ? '' : ` from ${String(detail.old_value)}`
    return `${field}${from} to ${String(detail.new_value ?? '')}`
  }).join('\n')
/** The hidden marker of a reply the agent sent through the outbox; `id` is the outbound message's ID. */
export const agentMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`
/** The hidden marker of a note the operator posted from the panel; `id` is a token unique to that reply. */
export const panelMarker = (id: string): string => `<!-- dsh-superagent-panel:${id} -->`
const AGENT_NOTE = /<!--\s*dsh-superagent:[^>]*-->/
const PANEL_NOTE = /<!--\s*dsh-superagent-panel:[^>]*-->/
const PANEL_MARKER = /<!--\s*dsh-superagent-panel:[^>]*-->/
/** True when the notes carry the marker of an outbound reply the agent sent, which the Source has already delivered. */
export const agentNote = (notes: string): boolean => AGENT_NOTE.test(notes)
/** True when the notes carry the marker of a panel reply. */
export const panelNote = (notes: string): boolean => PANEL_NOTE.test(notes)
/** The token of a panel reply, which tells two notes of the operator apart; undefined when the notes carry none. */
export const panelToken = (notes: string): string | undefined =>
  /<!--\s*dsh-superagent-panel:([^>]+?)-->/.exec(notes)?.[1]?.trim() || undefined
/** The marker text appended to a note the panel posts; `id` is the token of that reply. */
export const panelNoteText = (id: string = randomUUID()): string => panelMarker(id)
/** The text of a journal: its note, or the field changes it records when it carries no note. */
export const journalText = (journal: RedmineJournal): string => {
  const notes = (journal.notes ?? '').trim()
  if (notes) return notes
  const details = detailsText(journal)
  return details ? `The issue changed: ${details}` : ''
}
/**
 * The issue's own facts, kept in every Trigger of it so the panel and the worker can name them. `project` is the
 * identifier of the project, which names the repository the ticket works in; the caller resolves it, because an issue
 * names its project by id and display name only.
 */
const issueMeta = (issue: RedmineIssue, project?: string): Record<string, unknown> => ({
  issueId: issue.id, project: project ?? issue.project?.identifier ?? issue.project?.name ?? '', tracker: issue.tracker?.name ?? '',
  status: issue.status?.name ?? '', priority: issue.priority?.name ?? '',
  assignedTo: actorOf(issue.assigned_to), ...issue.journals ? { journalCount: issue.journals.length } : {},
})
/**
 * Builds the Trigger of an issue: its subject and description. The ID is stable, so an issue read again is stored once and
 * never creates a second Ticket.
 */
export function issueTrigger(issue: RedmineIssue, agent: { id: number; login: string }, baseUrl: string, project?: string): Trigger {
  const body = issue.description ?? ''
  const text = `${issue.subject}\n\n${body}`.trim()
  const said = mentions(text, agent.login)
  const direct = assignedTo(issue, agent.id)
  return { id: key('redmine-issue', String(issue.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.id) }],
    actor: { source: SOURCE, id: actorOf(issue.author) }, human: true,
    ...(said ? { addressed: 'mention' as const } : direct ? { addressed: 'direct' as const } : {}),
    at: issue.created_on ?? issue.updated_on ?? new Date().toISOString(), text,
    channel: redmineChannel(issue.id), url: redminePage(baseUrl, issue.id), meta: { ...issueMeta(issue, project), kind: 'issue' } }
}
/**
 * Builds the Trigger of one journal of an issue: the note a person wrote, or the field changes Redmine recorded. A note the
 * agent wrote carries a hidden marker and was already delivered when it was written, so it produces no Trigger; every other
 * note is human input, including the operator's own on the shared account.
 */
export function journalTrigger(issue: RedmineIssue, journal: RedmineJournal, agent: { id: number; login: string }, baseUrl: string,
  project?: string, { panel = false }: { panel?: boolean } = {}): Trigger | undefined {
  const notes = journal.notes ?? ''
  // A panel reply is skipped, because the panel handed it to the agent itself; the Source delivers it only when that
  // hand-off did not happen.
  if (agentNote(notes) || (panelNote(notes) && !panel)) return undefined
  // The marker of a panel reply is for the Source, not for the agent.
  const text = panel ? journalText(journal).replace(PANEL_MARKER, '').trim() : journalText(journal)
  if (!text) return undefined
  const author = journal.user
  return { id: key('redmine-journal', String(journal.id)), source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.id) }],
    actor: { source: SOURCE, id: actorOf(author) }, human: true,
    ...(panel && assignedTo(issue, agent.id) ? { addressed: 'direct' as const }
      : mentions(text, agent.login) ? { addressed: 'mention' as const } : {}),
    at: journal.created_on ?? journal.updated_on ?? issue.updated_on ?? new Date().toISOString(), text,
    channel: redmineChannel(issue.id), url: redmineJournalPage(baseUrl, issue.id, journal.id),
    meta: { ...issueMeta(issue, project), kind: 'journal', journalId: journal.id } }
}
