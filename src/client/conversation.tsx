/** The task opened in the Workbench: its Redmine conversation, the ticket that works it, and the reply box that continues it. */
import { useState, type FormEvent } from 'react'
import { Button, Icon } from './controls.tsx'
import { usePoll, type TaskDetailView, type TaskMessage } from './api.ts'
import { useAction, usePanel } from './provider.tsx'
import { errorText, type T } from './text.ts'
import { ConfirmButton, Hint, LoadState, When } from './widgets.tsx'

/** The author label of one message: the superagent, the operator, or whoever else wrote on the issue. */
function authorName(t: T, message: TaskMessage): string {
  return message.role === 'agent' ? t('pmsAgent') : message.role === 'you' ? t('pmsYou') : message.name
}
/** One message of the conversation: the author, when it was written, its text, and the anchor in Redmine. */
function Message({ message }: { message: TaskMessage }) {
  const { t } = usePanel()
  return <li className="dt-chat-msg" data-role={message.role}>
    <span className="dt-chat-meta"><span className="dt-chat-author">{authorName(t, message)}</span>
      <When at={message.at} /></span>
    <p className="dt-chat-text">{message.text}</p>
    <a className="dt-chat-link" href={message.url} target="_blank" rel="noreferrer">{t('pmsOpenInRedmine')}</a>
  </li>
}
/** The ticket that works the task, with its stage and its session. */
function TicketLine({ task, session, open }: { task: NonNullable<TaskDetailView['task']['ticket']>; session: string; open: () => void }) {
  const { t } = usePanel()
  const stage = task.stage === 'person' ? t('pmsTicketWaiting') : task.stage === 'idle' ? t('pmsTicketIdle')
    : task.stage === 'ended' ? t('pmsTicketEnded') : t('pmsTicketWorking')
  return <div className="dt-taskview-ticket">
    <span className="dt-taskview-ticket-stage" data-state={task.stage}>{stage}</span>
    <span className="dt-taskview-ticket-title">{t('pmsTicket', { title: task.title })}</span>
    {task.change && <span className="dt-taskview-ticket-change">{t('pmsChange', { number: task.change })}</span>}
    <Button variant="outline" size="sm" icon={<Icon name="session" size={14} />} onClick={open}>{t('openSession')}</Button>
  </div>
}
/** The task inbox's right pane: header, description, conversation and the reply box (or a hint when replying is not possible). */
export function Conversation({ id, onBack, onChanged }: { id: string; onBack: () => void; onChanged: () => Promise<unknown> }) {
  const { t, call, notify, openSession } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET pms/:id', { id }), [id], 4000)
  const [text, setText] = useState('')
  const archived = !!data?.task.archivedAt
  const archive = useAction(async () => { await call('POST pms/:id/archive', { id, body: { archived: !archived } }); await onChanged() }, { reload })
  const remove = useAction(async () => { await call('POST pms/:id/delete', { id }); await onChanged() })
  const send = useAction(async (value: string) => {
    await call('POST pms/:id/reply', { id, body: { text: value } })
    setText('')
    notify(t('pmsReplySent'))
  }, { reload })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    if (value && !send.busy) void send.run(value)
  }
  const ticket = data?.task.ticket
  return <div className="dt-taskview">
    {error && !data && <LoadState error={error} loading={false} />}
    {!data && !error && <Hint>{t('loading')}</Hint>}
    {error && data && <p className="dt-hint dt-error">{errorText(error)}</p>}
    {data && <>
      <header className="dt-taskview-head">
        <button type="button" className="dt-back" aria-label={t('pmsBackToList')} onClick={onBack}>
          <Icon name="chevron-left" /><span>{t('pmsBackToList')}</span></button>
        <div className="dt-taskview-title">
          <h2 className="dt-taskview-subject">{data.task.subject}</h2>
          <span className="dt-taskview-meta">#{data.task.id}<span>{data.task.project}</span><span>{t('pmsStatus', { status: data.task.status })}</span>
            {data.task.assignee && <span>{t('pmsAssignee', { name: data.task.assignee })}</span>}<When at={data.task.updated} /></span>
        </div>
        <div className="dt-taskview-actions">
          <a className="dt-btn dt-btn-outline dt-btn-sm" href={data.task.url} target="_blank" rel="noreferrer">
            <span className="dt-btn-icon"><Icon name="external" size={14} /></span>{t('pmsOpenIssue')}</a>
          <Button variant="outline" size="sm" icon={<Icon name={archived ? 'refresh' : 'inbox'} size={14} />} disabled={archive.busy}
            onClick={() => { void archive.run() }}>{archived ? t('pmsUnarchive') : t('pmsArchive')}</Button>
          <ConfirmButton variant="ghost" icon="trash" label={t('pmsDelete')} title={t('pmsDeleteTitle')} message={t('pmsDeleteMessage')}
            onConfirm={async () => { if (await remove.run()) onBack() }} />
        </div>
      </header>
      {ticket && <TicketLine task={ticket} session={ticket.session ?? ticket.id} open={() => { void openSession(ticket.session ?? ticket.id) }} />}
      {data.task.archivedAt && <p className="dt-hint">{t('pmsArchivedHint')}</p>}
      <div className="dt-chat">
        <h3 className="dt-chat-heading">{t('pmsConversation')}</h3>
        <ol className="dt-chat-list">{data.messages.map(message => <Message key={message.id} message={message} />)}</ol>
      </div>
      {data.canReply ? <form className="dt-chat-composer" onSubmit={submit}>
        <textarea className="dt-chat-input" aria-label={t('pmsReplyPlaceholder')} placeholder={t('pmsReplyPlaceholder')}
          value={text} rows={3} maxLength={4000} onChange={event => setText(event.target.value)} />
        <div className="dt-chat-actions">
          <span className="dt-chat-hint">{t('pmsReplyHint')}</span>
          <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || send.busy}>{t('pmsReplySend')}</Button>
        </div>
      </form> : <p className="dt-hint">{t('pmsNoReply')}</p>}
    </>}
  </div>
}
