/**
 * The signal rail: the agent's live state, the work that waits for a person, the Executor's load, and the switch that
 * stops it. It stands above every page, so the answer to "does anything need me, and is it healthy" is always in sight.
 */
import { Button, Icon } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { errorText } from './text.ts'
import { ConfirmButton } from './widgets.tsx'

/** How the system reads: it runs, it waits for a person to resume it, it is not set up, or something needs attention. */
export type RailState = 'running' | 'paused' | 'unconfigured' | 'attention'
/** The worker slots of the Executor: one pip per slot, lit while a worker runs in it. */
function Slots({ running, max }: { running: number; max: number }) {
  if (max > 10) return null
  return <span className="dt-rail-slots" aria-hidden="true">
    {Array.from({ length: Math.max(max, 1) }, (_, index) => <span key={index} className="dt-rail-slot"
      data-on={index < running || undefined} />)}
  </span>
}

/**
 * The rail: the live state on the left, the load in the middle, and the switch that stops the agent on the right.
 * The count of the work that needs a person opens the list that holds it.
 */
export function SignalRail({ onOpenWaiting, onOpenProblems }: { onOpenWaiting: () => void; onOpenProblems: () => void }) {
  const { t, call, openSession, notify } = usePanel()
  const { state, overview, overviewError, tasks, tasksError, reload } = usePanelData()
  const paused = overview?.paused ?? state?.paused ?? false
  const setup = state?.setup.problem
  const problems = overview?.problems.length ?? 0
  const reading: RailState = setup ? 'unconfigured' : paused ? 'paused' : problems > 0 ? 'attention' : 'running'
  const word = t(reading === 'running' ? 'pmsRunning' : reading === 'paused' ? 'pmsPaused'
    : reading === 'unconfigured' ? 'pmsNotConfigured' : 'pmsAttention')
  // The tasks that wait for a person; a task inbox that could not be read shows no number at all.
  const waiting = tasks && !tasksError ? tasks.tasks.filter(task => task.state === 'waiting').length : undefined
  const load = overview?.executor
  const pause = async () => { await call('POST executor/pause', { body: { paused: !paused } }); await reload() }
  const action = paused ? 'resumeProcessing' : 'pauseProcessing'
  return <div className="dt-rail" data-state={reading}>
    <span className={`dt-rail-dot dt-dot-${reading}`} aria-hidden="true" />
    <span className="dt-rail-state">{word}</span>
    {setup && <span className="dt-rail-detail">{t('pmsUnconfiguredDetail')}</span>}
    {reading === 'attention' && <button type="button" className="dt-rail-detail dt-rail-link" onClick={onOpenProblems}>
      {t('pmsAttentionDetail', { count: problems })}
    </button>}
    <span className="dt-rail-sep" />
    {/* The work that needs a person: the one number the operator came for. */}
    <button type="button" className="dt-rail-waiting" data-empty={waiting === 0 || undefined} disabled={waiting === undefined}
      onClick={onOpenWaiting}>
      <b>{waiting ?? '—'}</b><span>{t('railWaiting')}</span>
    </button>
    {load && <>
      <span className="dt-rail-sep" />
      <span className="dt-rail-metric"><b>{load.queued}</b><span>{t('queuedLabel')}</span></span>
      <span className="dt-rail-metric">
        <Slots running={load.running} max={load.maxWorkers} />
        <b>{load.running}</b><span>/{load.maxWorkers}</span><span>{t('railWorkerSlots')}</span>
      </span>
    </>}
    <span className="dt-rail-grow" />
    {overviewError && <span className="dt-rail-stale" title={overviewError.message}>{t('railStale')}</span>}
    <ConfirmButton variant="outline" icon={paused ? 'play' : 'pause'} label={t(action)} title={t(action)}
      message={t(paused ? 'resumeProcessingConfirm' : 'pauseProcessingConfirm')} onConfirm={pause} />
    <Button variant="ghost" size="sm" icon={<Icon name="session" size={14} />} aria-label={t('openMaster')}
      title={t('openMaster')} disabled={!state?.masterId}
      onClick={() => { if (state?.masterId) openSession(state.masterId).catch(failure => notify(errorText(failure))) }} />
  </div>
}
