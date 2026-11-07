/** Gerrit REST API access: listing changes, reading one change with its comments, and posting a review message. */
import { z } from 'zod'
import { basic, strip } from '../deployment.ts'
import { CliError, validItems, type Commands, type Tally } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'

/** Gerrit puts an anti-hijacking prefix in front of every JSON response; it must be removed before the body is parsed. */
export { strip } from '../deployment.ts'

/**
 * Performs an authenticated Gerrit API call against the `/a/` prefix and returns its parsed JSON body. Gerrit 2.15
 * answers HTTP 200 with the prefix in front of the payload even for errors, so the body is checked for its shape.
 * @throws CliError with Gerrit's HTTP status as `code` on failure.
 */
export async function gerritApi<T>(commands: Commands, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const account = commands.gerrit
  const response = await commands.http(`${account.httpUrl}/a${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: basic(account.user, account.password), 'Content-Type': 'application/json', Accept: 'application/json' },
    ...init.body !== undefined ? { body: JSON.stringify(init.body) } : {},
  })
  if (response.status === 401 || response.status === 403) throw new CliError(`Gerrit refused the request to ${path}`, response.status)
  if (response.status < 200 || response.status >= 300) throw new CliError(`Gerrit answered ${response.status} for ${path}: ${response.body.slice(0, 300)}`, response.status)
  const body = strip(response.body)
  try { return JSON.parse(body) as T }
  catch { throw new Error(`Gerrit answered no JSON for ${path}: ${body.slice(0, 300)}`) }
}

/** The account of a change, a comment, or a message. Gerrit names it by its user name and its display name. */
export const AccountSchema = z.looseObject({ name: z.string().optional(), username: z.string().optional(), email: z.string().optional() })
/** The identity of a Gerrit account: its user name, which is what a person and the Policy name it by. */
export const accountOf = (account: { username?: string; name?: string } | null | undefined): string => account?.username ?? account?.name ?? ''
/** One revision of a change; the commit holds the message that names the task the change answers. */
export const RevisionSchema = z.looseObject({
  ref: z.string().nullish(), _number: z.number().int().optional(),
  // Gerrit 2.15 reports the fetch information as an object; older servers report it as a string.
  fetch: z.union([z.string(), z.looseObject({ url: z.string().optional(), ref: z.string().optional() })]).nullish(),
  kind: z.string().nullish(), created: z.string().nullish(),
  uploader: AccountSchema.nullish(),
  commit: z.looseObject({ message: z.string().nullish(), author: AccountSchema.nullish(), committer: AccountSchema.nullish() }).nullish(),
})
/** A change as Gerrit 2.15 returns it; `_number` is the change number people name it by. */
export const ChangeSchema = z.looseObject({
  _number: z.number().int(), id: z.string(), project: z.string(), branch: z.string(),
  subject: z.string().nullish(), topic: z.string().nullish(), status: z.string().nullish(),
  owner: AccountSchema.nullish(), created: z.string().nullish(), updated: z.string().nullish(), url: z.string().nullish(),
  current_revision: z.string().nullish(),
  revisions: z.record(z.string(), RevisionSchema).nullish(),
  messages: z.array(z.looseObject({ id: z.string().nullish(), message: z.string().nullish(), author: AccountSchema.nullish(),
    real_author: AccountSchema.nullish(), date: z.string().nullish() })).nullish(),
  labels: z.record(z.string(), z.looseObject({ value: z.union([z.string(), z.number()]).nullish(), optional: z.boolean().optional() })).nullish(),
})
export type GerritChange = z.infer<typeof ChangeSchema>
/** One review comment on a change. */
export const CommentSchema = z.looseObject({
  id: z.string(), path: z.string().nullish(), line: z.number().nullish(), message: z.string(),
  author: AccountSchema.nullish(), created: z.string().nullish(), updated: z.string().nullish(),
  in_reply_to: z.string().nullish(), unresolved: z.boolean().nullish(), patch_set: z.number().nullish(),
})
export type GerritComment = z.infer<typeof CommentSchema>

export interface ChangeQuery { project?: string; owner?: string; status?: string; limit?: number }
/**
 * Lists the changes matching the query, with their current revision, its commit message, and their labels. Gerrit's
 * query language joins terms with a space, and every term must hold.
 */
export async function listChanges(commands: Commands, query: ChangeQuery, tally?: Tally): Promise<GerritChange[]> {
  const terms = [
    ...query.project ? [`project:${query.project}`] : [],
    ...query.owner ? [`owner:${query.owner}`] : [],
    ...query.status ? [`status:${query.status}`] : [],
  ]
  // The terms are joined with `%20` rather than `+`, which a servlet would read as a space only by convention.
  const search = terms.map(encodeURIComponent).join('%20')
  const url = `/changes/?q=${search}&o=CURRENT_REVISION&o=CURRENT_COMMIT&o=DETAILED_LABELS&n=${query.limit ?? 100}`
  const body = await gerritApi<unknown[]>(commands, url)
  return validItems(ChangeSchema, body, tally)
}
/** Reads one change with its current revision, its commit message, and its change messages. */
export async function readChange(commands: Commands, change: string): Promise<GerritChange> {
  const body = await gerritApi<unknown>(commands, `/changes/${encodeURIComponent(change)}/detail?o=CURRENT_REVISION&o=CURRENT_COMMIT&o=MESSAGES`)
  return ChangeSchema.parse(body)
}
/**
 * Reads the review comments of a change, oldest first. Gerrit 2.15 answers an empty object rather than an empty array
 * when a change carries no comment, so the answer is read as a list only when it is one.
 */
export async function listComments(commands: Commands, change: string, tally?: Tally): Promise<GerritComment[]> {
  const body = await gerritApi<unknown>(commands, `/changes/${encodeURIComponent(change)}/comments`)
  if (!Array.isArray(body)) return []
  return validItems(CommentSchema, body, tally).sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''))
}
/** Posts a message on a change as a review of its current revision. */
export async function postReview(commands: Commands, change: string, revision: string, message: string): Promise<void> {
  await gerritApi<unknown>(commands, `/changes/${encodeURIComponent(change)}/revisions/${encodeURIComponent(revision)}/review`,
    { method: 'POST', body: { message } })
}
/** The commit message of a change, which names the task it answers. */
export const commitMessage = (change: GerritChange): string => {
  const revision = change.current_revision ? change.revisions?.[change.current_revision] : undefined
  return revision?.commit?.message ?? ''
}
/** The web page of a change, in the form Gerrit 2.15 uses. */
export const changePage = (httpUrl: string, change: number, project = ''): string =>
  `${httpUrl.replace(/\/+$/, '')}/#/c/${project}/+/${change}`
/** The web page of a review comment, which Gerrit links from the change. */
export const commentPage = (httpUrl: string, change: number, project: string, comment: string): string =>
  `${changePage(httpUrl, change, project)}/${comment}`

/** The messages of a change, as an assessment reads them: its change messages and its review comments. */
export function changeMessages(change: GerritChange, httpUrl: string): ContextMessage[] {
  const messages: ContextMessage[] = []
  for (const message of change.messages ?? []) {
    const text = (message.message ?? '').trim()
    if (!text) continue
    messages.push({ id: `m-${message.id ?? messages.length}`, from: message.author?.name ?? '', at: message.date ?? '', text,
      url: changePage(httpUrl, change._number) })
  }
  return messages
}

/**
 * Reads a Gerrit change as the model-facing resource the panel and the workers use: `gerrit/changes/<number>` and
 * `gerrit/changes/<number>/comments`.
 */
export async function readGerrit(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gerrit\/changes\/([1-9]\d*)(?:\/(comments|messages))?$/.exec(resource)
  if (!match) throw new Error('Use gerrit/changes/<number> or gerrit/changes/<number>/comments')
  const number = match[1]!
  const change = await readChange(commands, number)
  const base = commands.gerrit.httpUrl
  if (!match[2]) return { number: change._number, id: change.id, project: change.project, branch: change.branch,
    subject: change.subject ?? '', topic: change.topic ?? '', status: change.status ?? '', owner: change.owner?.username ?? change.owner?.name ?? '',
    updated: change.updated ?? '', url: changePage(base, change._number, change.project), message: commitMessage(change),
    labels: Object.fromEntries(Object.entries(change.labels ?? {}).map(([name, label]) => [name, String(label.value ?? '')])) }
  if (match[2] === 'messages') return { items: (change.messages ?? []).map(message => ({ id: message.id, at: message.date ?? '',
    from: message.author?.name ?? '', message: message.message ?? '' })) }
  const tally = { skipped: 0 }
  const comments = await listComments(commands, number!, tally)
  return { items: comments.map(comment => ({ id: comment.id, at: comment.created ?? '', from: comment.author?.name ?? '',
    path: comment.path ?? '', line: comment.line ?? null, message: comment.message, unresolved: comment.unresolved === true })),
    ...tally.skipped ? { skipped: tally.skipped } : {} }
}

/**
 * Context reader for a Gerrit Trigger: the change the comment was written on, with its change messages and its other
 * review comments.
 */
export const gerritThreadContext: ThreadContext<unknown> = {
  messageId: trigger => String(trigger.meta.commentId ?? ''),
  read: async (commands, trigger) => {
    const number = String(trigger.meta.changeNumber ?? '')
    if (!number) return { messages: [], body: { messages: [] } }
    const change = await readChange(commands, number)
    const base = commands.gerrit.httpUrl
    const messages = changeMessages(change, base)
    const tally = { skipped: 0 }
    const comments = await listComments(commands, number!, tally)
    for (const comment of comments) {
      messages.push({ id: comment.id, from: comment.author?.name ?? '', at: comment.created ?? '', text: comment.message,
        url: commentPage(base, change._number, change.project, comment.id), ...comment.path ? { path: comment.path, ...comment.line != null ? { line: comment.line } : {} } : {} })
    }
    return { messages, body: { messages } }
  },
}
