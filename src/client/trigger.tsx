/** Trigger status view listing Threads filtered by subscription and evaluation activity. */
import { useState } from 'react'
import { THREAD_FILTERS, type ThreadFilter } from '../app/api.ts'
import { usePoll } from './api.ts'
import { Pill } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { ThreadLine } from './rows.tsx'
import { Hint, ListTotal, LoadMore, LoadState, StatusHead } from './widgets.tsx'

export function TriggerStatus({ filter, threads }: { filter: ThreadFilter; threads: number }) {
  const { t, call, navigate } = usePanel()
  const [limit, setLimit] = useState(20)
  const { data, error } = usePoll(() => call('GET threads', { query: { filter, limit } }), [filter, limit])
  const go = (next: ThreadFilter) => { setLimit(20); navigate({ page: 'trigger', query: next !== 'subscribed' ? { filter: next } : {} },
    true) }
  return <>
    <StatusHead title={t('tab.trigger')} hint={t('triggerIntro')} />
    {/* The chart counts the Threads; the section says the same number, so the two can be checked. */}
    <p className="dt-hint">{t('triggerThreads', { count: threads })}</p>
    <div className="dt-filters" role="group" aria-label={t('threadFilters')}>
      {THREAD_FILTERS.map(value => <Pill key={value} active={filter === value}
        onClick={() => go(value)}>{t(`threadFilter.${value}`)}</Pill>)}
    </div>
    <LoadState error={error} loading={!data} />
    {data && (data.items.length ? <ul className="dt-list">{data.items.map(thread => <ThreadLine key={thread.key} thread={thread} />)}</ul>
      : <Hint>{t('threadsNone')}</Hint>)}
    {data && data.total > data.items.length && <ListTotal shown={data.items.length} total={data.total} />}
    {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 20)} />}
  </>
}
