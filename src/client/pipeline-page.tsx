/** The pipeline page: the stages work passes through, each counting the work it holds. */
import type { DecisionFilter, PmsView } from './api.ts'
import { InfoTip } from './controls.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { PipelineChart, type PipelineStation, type StationTone } from './pipeline.tsx'
import { SourceStatus } from './source.tsx'
import { TriggerStatus } from './trigger.tsx'
import type { TicketFilter, ThreadFilter } from '../app/api.ts'
import type { Route } from './route.ts'
import { when, type T } from './text.ts'
import { SystemProblems } from './problems.tsx'
import { LoadState } from './widgets.tsx'

/** Which section of the flow page shows below the chart, with the state that section reads. */
export type FlowView =
  | { kind: 'source' }
  | { kind: 'trigger'; filter: ThreadFilter }
  | { kind: 'eval'; filter: DecisionFilter; window?: '24h'; paused: boolean }
  | { kind: 'execution'; filter: TicketFilter; window?: '24h'; state: Parameters<typeof ExecutionStatus>[0]['state']
    reload: Parameters<typeof ExecutionStatus>[0]['reload'] }

/**
 * The stations of the pipeline chart, in the order work passes them. Every station counts the same kind of item its
 * page lists, so the number on the chart is the length of the list it opens.
 */
export function stationsOf(t: T, data: PmsView, navigate: (route: Route, replace?: boolean) => void): PipelineStation[] {
  const tone = (live: boolean, tone: StationTone = 'active'): StationTone => live ? tone : 'idle'
  const open = (route: Route) => () => navigate(route, true)
  return [
    // The Sources are where the work comes from: the Triggers they received in the last day, and the Threads those
    // Triggers became.
    // The station counts what the Source section lists, so the number on the chart and the rows below it agree.
    { id: 'sources', label: t('pmsFlow.sources'), count: data.pipeline.sources, unit: t('pmsFlowUnit.sources'), window: t('pmsFlowNote.sources'),
      tone: tone(data.pipeline.sources > 0), onOpen: open({ page: 'source' }) },
    { id: 'triggers', label: t('pmsFlow.triggers'), count: data.pipeline.threads, unit: t('pmsFlowUnit.triggers'), window: t('pmsFlowNote.triggers'),
      tone: tone(data.pipeline.threads > 0), onOpen: open({ page: 'trigger' }) },
    // The Eval stage holds the Threads under evaluation; the Trigger list shows them under 评估中.
    { id: 'evaluating', label: t('pmsFlow.evaluating'), count: data.pipeline.evaluating, unit: t('pmsFlowUnit.evaluating'), window: t('pmsFlowNote.evaluating'),
      tone: tone(data.pipeline.evaluating > 0), onOpen: open({ page: 'trigger', query: { filter: 'evaluating' } }) },
    { id: 'tickets', label: t('pmsFlow.tickets'), count: data.pipeline.tickets, unit: t('pmsFlowUnit.tickets'), window: t('pmsFlowNote.tickets'), tone: 'idle',
      onOpen: open({ page: 'execution' }) },
    { id: 'running', label: t('pmsFlow.running'), count: data.pipeline.working, unit: t('pmsFlowUnit.running'), window: t('pmsFlowNote.running', { queued: data.pipeline.queued }),
      tone: tone(data.pipeline.working > 0), onOpen: open({ page: 'execution', query: { filter: 'working' } }) },
    { id: 'waiting', label: t('pmsFlow.waiting'), count: data.pipeline.waiting, unit: t('pmsFlowUnit.waiting'), window: t('pmsFlowNote.waiting'),
      tone: tone(data.pipeline.waiting > 0, 'waiting'), onOpen: open({ page: 'execution', query: { filter: 'person' } }) },
    // The done count covers the last day, so the list it opens covers the last day too.
    { id: 'ended', label: t('pmsFlow.ended'), count: data.pipeline.ended, unit: t('pmsFlowUnit.ended'), window: t('pmsFlowNote.ended'),
      tone: data.pipeline.ended > 0 ? 'done' : 'idle', onOpen: open({ page: 'execution', query: { filter: 'ended', window: '24h' } }) },
  ]
}

/**
 * The flow page: the chart of the pipeline, and the section it points at below it. The chart is the map and the
 * navigator — a station opens the section that holds the work it counts, so the names and the places agree.
 */
export function PipelinePage({ view }: { view: FlowView }) {
  const { t, navigate } = usePanel()
  // The panel reads the task inbox once for every page (see the provider), so the chart and the rail never disagree.
  const { tasks: data, tasksError: error } = usePanelData()
  if (!data) return <LoadState error={error} loading />
  return <>
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
    <PipelineChart stations={stationsOf(t, data, navigate)} flowing={!data.executor.paused} />
    <p className="dt-pipe-note">{t('pmsFlowNote')}</p>
    </div>
    {view.kind === 'source' && <SourceStatus />}
    {view.kind === 'trigger' && <TriggerStatus filter={view.filter} threads={data.pipeline.threads} />}
    {view.kind === 'eval' && <EvalStatus filter={view.filter} window={view.window} paused={view.paused} />}
    {view.kind === 'execution' && <ExecutionStatus filter={view.filter} window={view.window} state={view.state} reload={view.reload} />}
    <SystemProblems />
  </>
}
