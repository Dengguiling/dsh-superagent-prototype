/** Workbench: the Redmine tasks assigned to the bound account, and the conversation that continues the opened one. */
import { Icon, Pill } from './controls.tsx'
import { usePoll, type PmsView, type TaskRow } from './api.ts'
import { Conversation } from './conversation.tsx'
import { useAction, usePanel } from './provider.tsx'
import { PMS_FILTERS, type PmsFilter } from './route.ts'
import { reasonLabel } from './text.ts'
import { ConfirmButton, Hint, LoadState, PageHead, When } from './widgets.tsx'

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
/** The task list of one filter, with its empty state. */
function TaskList({ data, filter, selected, onOpen, onChanged }: {
  data: PmsView; filter: PmsFilter; selected: string | undefined; onOpen: (task: TaskRow) => void; onChanged: () => Promise<void>
}) {
  const { t } = usePanel()
  const tasks = filter === 'archived' ? data.archived : filter === 'declined' ? data.declined : data.tasks
  if (!tasks.length) return <Hint>{filter === 'archived' ? t('pmsNoArchived') : filter === 'declined' ? t('pmsNoDeclined') : t('pmsNoTasks')}</Hint>
  return <ul className="dt-task-rows">{tasks.map(task => <TaskLine key={task.id} task={task} archived={filter === 'archived'}
    selected={selected === String(task.id)} onOpen={() => onOpen(task)} onChanged={onChanged} />)}</ul>
}

/** The Workbench page: filters and the task list on the left, the opened task's conversation on the right. */
export function PmsPage({ id, filter }: { id?: string; filter: PmsFilter }) {
  const { t, call, navigate } = usePanel()
  const { data, error, reload } = usePoll(() => call('GET pms'), [], 5000)
  const list = (next: PmsFilter) => ({ page: 'pms' as const, ...next === 'active' ? {} : { query: { filter: next } } })
  const counts: Record<PmsFilter, number> = { active: data?.tasks.length ?? 0, declined: data?.declined.length ?? 0,
    archived: data?.archived.length ?? 0 }
  const filterLabel = (value: PmsFilter) => value === 'archived' ? t('pmsFilterArchived')
    : value === 'declined' ? t('pmsFilterDeclined') : t('pmsFilterActive')
  return <>
    <PageHead title={t('pmsTitle')}>{t('pmsIntro')}</PageHead>
    <LoadState error={error} loading={!data} />
    {data && <>
      {data.source.error && <p className="dt-error dt-mono dt-clamp">{data.source.error}</p>}
      <div className="dt-inbox" data-selected={id || undefined}>
        <aside className="dt-inbox-list">
          <div className="dt-inbox-filters" role="group" aria-label={t('pmsFilters')}>
            {PMS_FILTERS.map(value => <Pill key={value} active={filter === value} onClick={() => navigate(list(value), true)}>
              {filterLabel(value)}<span className="dt-count">{counts[value]}</span></Pill>)}
          </div>
          <TaskList data={data} filter={filter} selected={id} onChanged={reload}
            onOpen={task => navigate({ page: 'pms', id: String(task.id), ...filter === 'active' ? {} : { query: { filter } } })} />
        </aside>
        <section className="dt-inbox-detail">
          {id ? <Conversation key={id} id={id} onBack={() => navigate(list(filter), true)} onChanged={reload} />
            : <div className="dt-inbox-empty"><Hint>{t('pmsSelectTask')}</Hint></div>}
        </section>
      </div>
    </>}
  </>
}
