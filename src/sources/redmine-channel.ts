/** Redmine outbound channel: adds a journal to the issue a reply belongs to, exactly once. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { postNote, readIssue } from './redmine-read.ts'
import { agentMarker } from './redmine-trigger.ts'

/**
 * True when the issue can never take the note again: it is gone (404), or Redmine refuses the note itself (422, such as
 * a locked issue). A refusal of the credentials (401, 403) is retryable, because it may be a temporary permission loss.
 */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410 || error.code === 422)
/**
 * Posts a reply as a journal on the issue. Redmine has no idempotency key, so the note carries a hidden marker that a
 * retry looks for before it writes again.
 */
export async function sendRedmine(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const issue = Number(message.channel.address.issue)
  if (!issue) throw new Error('Missing Redmine reply target')
  const marker = agentMarker(message.id)
  try {
    // A note may have gone out before the reply was recorded, so the issue is read before the note is written.
    const current = await readIssue(commands, issue)
    if ((current.journals ?? []).some(journal => (journal.notes ?? '').includes(marker))) return 'sent'
    await postNote(commands, issue, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The link of a Redmine issue. */
export function redmineLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const issue = address.issue ?? ''
  const base = links.redmine
  return { url: base ? `${base.replace(/\/+$/, '')}/issues/${issue}` : '',
    label: { zh: `Redmine 事务 #${issue}`, en: `Redmine issue #${issue}` } }
}
