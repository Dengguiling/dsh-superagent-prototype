/** Gerrit outbound channel: posts a review message on a change, exactly once. */
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { changePage, commitMessage, postReview, readChange } from './gerrit-read.ts'

/**
 * True when the change can never take the message again: it is gone (404), or Gerrit refuses the review itself (409,
 * such as a change that is already merged). A refusal of the credentials (401, 403) is retryable.
 */
const gone = (error: unknown): boolean => error instanceof CliError && (error.code === 404 || error.code === 410 || error.code === 409)
/**
 * Posts a reply on a change as a review of its current revision. Gerrit has no idempotency key, so the message carries a
 * hidden marker that a retry looks for in the change's messages before it writes again.
 */
export async function sendGerrit(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const change = message.channel.address.change
  if (!change) throw new Error('Missing Gerrit reply target')
  const marker = `<!-- dsh-superagent:${message.id} -->`
  try {
    const current = await readChange(commands, change)
    if ((current.messages ?? []).some(item => (item.message ?? '').includes(marker))) return 'sent'
    const revision = current.current_revision
    if (!revision) throw new Error(`The change ${change} has no current revision to review`)
    await postReview(commands, change, revision, `${message.text}\n\n${marker}`)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}
/** The link of a Gerrit change. */
export function gerritLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const change = address.change ?? ''
  const base = links.gerrit
  return { url: base ? changePage(base, Number(change), address.project ?? '') : '',
    label: { zh: `Gerrit 变更 ${change}`, en: `Gerrit change ${change}` } }
}
/** The commit message of a change, exposed for the panel and the workers. */
export { commitMessage }
