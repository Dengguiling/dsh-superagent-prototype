/** The live dashboard of the agent: the pipeline's state, the workers running now, and the work waiting, above the flow chart. */
import { usePanel } from './provider.tsx'
import { InfoTip, Tag } from './controls.tsx'
import { PipelineChart, type PipelineStation, type StationTone } from './pipeline.tsx'
import type { Route } from './route.ts'
import { when, type T } from './text.ts'
import type { PmsView } from './api.ts'

/** How the whole system reads: the agent runs, processing is paused, the task system does not answer, or none is configured. */
export type LiveState = 'running' | 'paused' | 'down' | 'unconfigured'
/** The worker slots of the Executor: one pip per slot, lit while a worker runs in it. */
function Slots({ running, max }: { running: number; max: number }) {
  return <span className="dt-live-slots" aria-hidden="true">
    {Array.from({ length: Math.max(max, 1) }, (_, index) => <span key={index} className="dt-live-slot"
      data-on={index < running || undefined} />)}
  </span>
}
/** The state of one load of the PMS view: live, paused, the task system down, or not configured. */
export function liveState(data: PmsView): LiveState {
  return !data.source.configured ? 'unconfigured' : !data.source.connected ? 'down' : data.executor.paused ? 'paused' : 'running'
}
/** The live banner: the system's state, the workers running now of those configured, and the work that waits. */
export function LiveBanner({ data }: { data: PmsView }) {
  const { t } = usePanel()
  const state = liveState(data)
  const source = data.source.name || t('pmsSource')
  const title = t(state === 'running' ? 'pmsRunning' : state === 'paused' ? 'pmsPaused'
    : state === 'down' ? 'pmsDisconnected' : 'pmsNotConfigured')
  const detail = state === 'running' ? t('pmsConnected', { source }) : state === 'paused' ? t('pmsPausedDetail')
    : state === 'unconfigured' ? t('pmsUnconfiguredDetail') : t('pmsDownDetail')
  const { running, max } = data.executor
  return <div className="dt-live" data-state={state}>
    <span className="dt-live-beacon" aria-hidden="true" />
    <div className="dt-live-main">
      <strong className="dt-live-state">{title}</strong>
      {detail && <span className="dt-live-detail">{detail}</span>}
    </div>
    {(data.pipeline.queued > 0 || data.pipeline.waiting > 0) && <div className="dt-live-chips">
      {data.pipeline.queued > 0 && <Tag tone="neutral">{t('queuedLabel')} {data.pipeline.queued}</Tag>}
      {data.pipeline.waiting > 0 && <Tag tone="warning">{t('pmsFlow.waiting')} {data.pipeline.waiting}</Tag>}
    </div>}
    <div className="dt-live-load">
      <span className="dt-live-figure">{running}<span className="dt-live-max"> / {max}</span></span>
      <span className="dt-live-caption">{t('pmsProjectsRunning')}</span>
      {max <= 10 && <Slots running={running} max={max} />}
    </div>
  </div>
}
/**
 * The stations of the pipeline chart, in the order work passes them. Each station with work in it opens the page that
 * holds that work: the inbox, the Source, the Evals, the Tickets.
 */
export function stationsOf(t: T, data: PmsView, navigate: (route: Route, replace?: boolean) => void): PipelineStation[] {
  const tone = (live: boolean, tone: StationTone = 'active'): StationTone => live ? tone : 'idle'
  const open = (route: Route) => () => navigate(route, true)
  return [
    { id: 'tasks', label: t('pmsFlow.tasks'), count: data.pipeline.tasks, note: t('pmsFlowNote.tasks', { taken: data.pipeline.taken }), tone: 'idle',
      onOpen: open({ page: 'pms' }) },
    { id: 'arrived', label: t('pmsFlow.arrived'), count: data.pipeline.arrived, note: t('pmsFlowNote.arrived'), tone: tone(data.pipeline.arrived > 0),
      onOpen: open({ page: 'source' }) },
    { id: 'evaluating', label: t('pmsFlow.evaluating'), count: data.pipeline.evaluating, note: t('pmsFlowNote.evaluating'), tone: tone(data.pipeline.evaluating > 0),
      onOpen: open({ page: 'eval' }) },
    { id: 'tickets', label: t('pmsFlow.tickets'), count: data.pipeline.tickets, note: t('pmsFlowNote.tickets'), tone: 'idle',
      onOpen: open({ page: 'execution' }) },
    { id: 'running', label: t('pmsFlow.running'), count: data.executor.running, note: t('pmsFlowNote.running', { queued: data.pipeline.queued }),
      tone: tone(data.executor.running > 0), onOpen: open({ page: 'execution', query: { filter: 'working' } }) },
    { id: 'waiting', label: t('pmsFlow.waiting'), count: data.pipeline.waiting, note: t('pmsFlowNote.waiting'),
      tone: tone(data.pipeline.waiting > 0, 'waiting'), onOpen: open({ page: 'execution', query: { filter: 'person' } }) },
    { id: 'ended', label: t('pmsFlow.ended'), count: data.pipeline.ended, note: t('pmsFlowNote.ended'),
      tone: data.pipeline.ended > 0 ? 'done' : 'idle', onOpen: open({ page: 'execution', query: { filter: 'ended' } }) },
  ]
}
/** The dashboard: the live banner and the flow of work, as the Overview page leads with it. */
export function LiveDashboard({ data }: { data: PmsView }) {
  const { t, navigate } = usePanel()
  return <>
    <LiveBanner data={data} />
    <div className="dt-pipe-card">
      <div className="dt-pipe-head">
        <h2 className="dt-pipe-title">{t('pmsFlowTitle')}<InfoTip text={t('pmsFlowHint')} /></h2>
        <span className="dt-pipe-legend" aria-hidden="true">
          <span className="dt-pipe-key" data-tone="active">{t('pmsLightActive')}</span>
          <span className="dt-pipe-key" data-tone="waiting">{t('pmsLightWaiting')}</span>
          <span className="dt-pipe-key" data-tone="done">{t('pmsLightDone')}</span>
        </span>
        <span className="dt-pipe-updated">{t('pmsUpdated', { when: when(data.updatedAt, t('lang')) })}</span>
      </div>
      <PipelineChart stations={stationsOf(t, data, navigate)} flowing={liveState(data) === 'running'} />
    </div>
  </>
}
