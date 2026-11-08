/** Workbench: the Redmine tasks assigned to the bound account, and the conversation that continues the opened one. */
import { useEffect, useState } from 'react'
import { Icon, Pill } from './controls.tsx'
import type { PmsView, TaskRow } from './api.ts'
import { Conversation } from './conversation.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { PMS_FILTERS, type PmsFilter } from './route.ts'
import { reasonLabel } from './text.ts'
import { ConfirmButton, Hint, LoadState, When } from './widgets.tsx'

/** One row of the list: the task's name and status, where it stands, and the actions of the list. */
function TaskLine({ task, selected, archived, onOpen, onChanged }: {
  task: TaskRow; selected: boolean; archived: boolean; onOpen: () => void; onChanged: () => Promise<void>
}) {
  const { t, call } = usePanel()
  const toggle = useAction(() => call('POST pms/:id/archive', { id: String(task.id), body: { archived: !archived } }), { reload: onChanged })
  const remove = useAction(() => call('POST pms/:id/delete', { id: String(task.id) }), { reload: onChanged })
  const label = archived ? t('pmsUnarchive') : t('pmsArchive')
  return <li className="dt-task-row" data-selected={selected || undefined} data-archived={archived || undefined}>
    <button type="button" className="dt-task-open" aria-current={selected ? 'true' : undefined} onClick={onOpen}>
      <span className="dt-task-subject">{task.subject}</span>
      <span className="dt-task-meta"><span>#{task.id}</span><span>{task.project}</span><span>{task.status}</span><When at={task.updated} /></span>
      <span className="dt-task-state" data-state={task.state}>{t(`pmsState.${task.state}`)}</span>
      {task.reason && <span className="dt-task-reason">{reasonLabel(t, task.reason)}</span>}
      {task.ticket && <span className="dt-task-ticket"><Icon name="review" size={12} />{t('pmsTicket', { title: task.ticket.title })}</span>}
    </button>
    <span className="dt-task-actions">
      <button type="button" className="dt-icon-btn" title={label} aria-label={label} disabled={toggle.busy}
        onClick={() => { void toggle.run() }}><Icon name={archived ? 'refresh' : 'inbox'} size={14} /></button>
      <ConfirmButton variant="ghost" icon="trash" iconOnly label={t('pmsDelete')} title={t('pmsDeleteTitle')}
        message={t('pmsDeleteMessage')} onConfirm={() => remove.run()} />
    </span>
  </li>
}
/**
 * The task list of one filter. The filters are the states a task stands in and never overlap: a task waits for a person,
 * or the agent is on it, or it is finished, or the route declined it, or the operator archived it.
 */
function TaskList({ data, filter, selected, onOpen, onChanged }: {
  data: PmsView; filter: PmsFilter; selected: string | undefined; onOpen: (task: TaskRow) => void; onChanged: () => Promise<void>
}) {
  const { t } = usePanel()
  const tasks = tasksOf(data, filter)
  // A task system that does not answer leaves the list empty; saying "no task is assigned to you" would assert a
  // falsehood about the world, so the empty state names the failure instead.
  if (!tasks.length) return <Hint>{!data.source.connected ? t('pmsTasksUnreachable') : t(`pmsEmpty.${filter}`)}</Hint>
  return <ul className="dt-task-rows">{tasks.map(task => <TaskLine key={task.id} task={task} archived={filter === 'archived'}
    selected={selected === String(task.id)} onOpen={() => onOpen(task)} onChanged={onChanged} />)}</ul>
}
/** The tasks of one filter; the states never overlap, so every task sits in exactly one list. */
export function tasksOf(data: PmsView, filter: PmsFilter): TaskRow[] {
  if (filter === 'declined') return data.declined
  if (filter === 'archived') return data.archived
  const active = data.tasks
  return filter === 'waiting' ? active.filter(task => task.state === 'waiting')
    : active.filter(task => task.state !== 'waiting')
}

/** The Workbench page: the filters and the task list on the left, the opened task's conversation on the right. */
export function PmsPage({ id, filter }: { id?: string; filter: PmsFilter }) {
  const { t, call, navigate } = usePanel()
  const { tasks: data, tasksError: error, reloadTasks: reload } = usePanelData()
  // The list is the context, the conversation is the work: opening this page opens the first task of the view, so
  // coming back to it does not ask the operator to pick the task again. A task the operator closed stays closed.
  const [closed, setClosed] = useState(false)
  useEffect(() => {
    if (id || closed || !data) return
    const first = tasksOf(data, filter)[0]
    // The filter stays: opening the first task of a view does not move the operator to another view.
    if (first) navigate({ page: 'pms', id: String(first.id), ...filter === 'active' ? {} : { query: { filter } } }, true)
  }, [closed, data, filter, id, navigate])
  const list = (next: PmsFilter) => ({ page: 'pms' as const, ...next === 'active' ? {} : { query: { filter: next } } })
  const openFilter = (next: PmsFilter) => { setClosed(false); navigate(list(next), true) }
  const close = () => { setClosed(true); navigate(list(filter), true) }
  const counts: Record<PmsFilter, number> = { waiting: 0, active: 0, declined: 0, archived: 0 }
  if (data) for (const value of PMS_FILTERS) counts[value] = tasksOf(data, value).length
  const filterLabel = (value: PmsFilter) => t(`pmsFilter.${value}`)
  return <>
    <LoadState error={error} loading={!data} />
    {data && <>
      {data.source.error && <p className="dt-error dt-mono dt-clamp">{data.source.error}</p>}
      <div className="dt-inbox" data-selected={id || undefined}>
        <aside className="dt-inbox-list">
          <div className="dt-inbox-filters" role="group" aria-label={t('pmsFilters')}>
            {PMS_FILTERS.map(value => <Pill key={value} active={filter === value} onClick={() => openFilter(value)}>
              {filterLabel(value)}<span className="dt-count">{counts[value]}</span></Pill>)}
          </div>
          <TaskList data={data} filter={filter} selected={id} onChanged={reload}
            onOpen={task => navigate({ page: 'pms', id: String(task.id), ...filter === 'active' ? {} : { query: { filter } } })} />
        </aside>
        <section className="dt-inbox-detail">
          {id ? <Conversation key={id} id={id} onBack={close} onChanged={reload} />
            : <div className="dt-inbox-empty"><Hint>{t('pmsIntro')}</Hint></div>}
        </section>
      </div>
    </>}
  </>
}
