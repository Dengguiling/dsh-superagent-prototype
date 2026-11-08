/** Pure mappers from domain states (Tickets, Threads, Sources, Decisions) to UI status indicators. */
import type { DecisionRow, SourceStatusRow, ThreadRow, TicketSummary } from './api.ts'
import type { DshSuperagentKey } from './locales.ts'
import { valueLabel, type T } from './text.ts'
import type { DotState, IconName, TagTone } from './controls.tsx'

export interface Mark { label: string; tone: TagTone; dot: DotState; icon: IconName }
/** A state without its label: the label comes from the locale, the shape of the state comes from here. */
type StateMark = Omit<Mark, 'label'>

/**
 * The status vocabulary of the panel: every state names one dot, one icon and one tone, so the same state
 * looks the same wherever it appears. A tone names the host state token that paints it — `success` is
 * `--dsw-alias-state-success-primary`, `warning` is `--dsw-alias-state-warn-primary`, `danger` is
 * `--dsw-alias-state-error-primary`, `info` is `--dsw-alias-state-business-primary` for work in flight, and
 * `quiet` is the idle state, whose dot carries `--dsw-alias-state-idle-primary`.
 */
const TONE = {
  idle: 'quiet', running: 'info', success: 'success', warn: 'warning', error: 'danger',
} as const satisfies Record<string, TagTone>

/** The glyph a state carries: one state never shows two icons. */
const ICON = {
  alert: 'alert', ask: 'ask', blocked: 'blocked', clock: 'clock', close: 'close', decision: 'decision', dismiss: 'dismiss',
  hash: 'hash', inbox: 'inbox', pause: 'pause', play: 'play', queue: 'queue', refresh: 'refresh', review: 'review',
  running: 'running', stop: 'stop',
} as const satisfies Record<string, IconName>

/** What a Ticket waits for, when it waits for a person. */
const PERSON_ACTIONS = ['delivery', 'answer', 'review', 'blocked', 'failed'] as const
/**
 * The mark of a Ticket. The stage and the action may arrive as plain strings — the workbench's task view sends the
 * Ticket it holds without its record — so an unknown action reads as the plain "waiting for an answer".
 */
export function ticketMark(t: T, ticket: { stage: string; action?: string | undefined
  ended?: Pick<TicketSummary, 'ended'>['ended'] }): Mark {
  switch (ticket.stage) {
    case 'ended': return { label: valueLabel(t, 'outcome', ticket.ended?.outcome), tone: 'neutral', dot: 'idle', icon: ICON.stop }
    case 'person': {
      const action = PERSON_ACTIONS.find(item => item === ticket.action) ?? 'answer'
      const icon: IconName = action === 'review' ? ICON.review : action === 'failed' ? ICON.alert : action === 'blocked' ? ICON.blocked
        : action === 'delivery' ? ICON.inbox : ICON.ask
      return { label: t(`stage.${action}`), tone: action === 'failed' ? TONE.error : TONE.warn, dot: action === 'failed' ? 'error'
        : 'warning', icon }
    }
    case 'working': return ticket.action === 'queued' ? { label: t('stage.queued'), tone: 'neutral', dot: 'idle', icon: ICON.queue }
      : { label: t('stage.working'), tone: TONE.running, dot: 'ongoing', icon: ICON.running }
    default: return { label: t('stage.idle'), tone: 'neutral', dot: 'idle', icon: ICON.clock }
  }
}

/** The state an Assignment reports; a report the panel does not know reads as work in flight. */
const REPORT_MARKS: Record<string, StateMark> = {
  failed: { dot: 'error', icon: ICON.alert, tone: TONE.error },
  blocked: { dot: 'warning', icon: ICON.blocked, tone: TONE.warn },
  waiting: { dot: 'warning', icon: ICON.clock, tone: TONE.warn },
  ready: { dot: 'done', icon: ICON.decision, tone: TONE.success },
  progress: { dot: 'ongoing', icon: ICON.running, tone: TONE.running },
}
/** The whole mark of a report state, so a report reads like every other state. */
export const reportMark = (report: string | undefined): StateMark => REPORT_MARKS[report ?? '']
  ?? { dot: 'ongoing', icon: ICON.running, tone: TONE.running }
export const reportDot = (report: string | undefined): DotState => reportMark(report).dot

const THREAD_MARKS: Record<ThreadRow['stage'], StateMark & { label: DshSuperagentKey }> = {
  error: { dot: 'error', icon: ICON.alert, tone: TONE.error, label: 'threadPollFailed' },
  evaluating: { dot: 'ongoing', icon: ICON.running, tone: TONE.running, label: 'threadEvaluating' },
  queued: { dot: 'warning', icon: ICON.queue, tone: TONE.warn, label: 'threadQueued' },
  subscribed: { dot: 'done', icon: ICON.inbox, tone: TONE.success, label: 'threadSubscribed' },
  dormant: { dot: 'idle', icon: ICON.clock, tone: TONE.idle, label: 'threadDormantShort' },
  unsubscribed: { dot: 'idle', icon: ICON.hash, tone: TONE.idle, label: 'threadUnsubscribed' },
}
export function threadMark(t: T, thread: Pick<ThreadRow, 'stage' | 'pending'>): Mark {
  const { dot, icon, tone, label } = THREAD_MARKS[thread.stage]
  return { dot, icon, tone, label: t(label, { count: thread.pending }) }
}

/**
 * A Source's state. The three idle states mean different things — the plugin is not installed, it is
 * switched off, or it waits for its deployment check — so each carries its own tone and icon.
 */
const SOURCE_MARKS: Record<SourceStatusRow['state'], StateMark & { label: DshSuperagentKey }> = {
  missing: { dot: 'idle', icon: ICON.close, tone: TONE.warn, label: 'sourceNotInstalled' },
  off: { dot: 'idle', icon: ICON.stop, tone: TONE.idle, label: 'sourceOff' },
  error: { dot: 'error', icon: ICON.alert, tone: TONE.error, label: 'sourceState.error' },
  setup: { dot: 'idle', icon: ICON.clock, tone: TONE.running, label: 'sourceState.setup' },
  starting: { dot: 'ongoing', icon: ICON.running, tone: TONE.running, label: 'sourceState.ongoing' },
  paused: { dot: 'warning', icon: ICON.pause, tone: TONE.warn, label: 'sourceState.warning' },
  ready: { dot: 'done', icon: ICON.play, tone: TONE.success, label: 'sourceState.done' },
}
export function sourceMark(t: T, state: SourceStatusRow['state']): Mark {
  const { dot, icon, tone, label } = SOURCE_MARKS[state]
  return { dot, icon, tone, label: t(label) }
}

type Outcome = DecisionRow['outcome']
const DECISION_MARKS: Record<Outcome, StateMark> = {
  accept: { dot: 'done', icon: ICON.decision, tone: TONE.success }, reopen: { dot: 'done', icon: ICON.refresh, tone: TONE.success },
  stop: { dot: 'idle', icon: ICON.stop, tone: TONE.error }, ignore: { dot: 'idle', icon: ICON.dismiss, tone: 'neutral' },
  unavailable: { dot: 'warning', icon: ICON.alert, tone: TONE.warn }, wouldAccept: { dot: 'idle', icon: ICON.dismiss, tone: TONE.warn },
}
/** Maps a Decision outcome to its visual mark, distinguishing `wouldAccept` (an ignore that observe mode would have accepted). */
export function decisionMark(t: T, outcome: Outcome): Mark {
  return { ...DECISION_MARKS[outcome], label: outcome === 'wouldAccept' ? t('wouldAccept') : valueLabel(t, 'decision', outcome) }
}
