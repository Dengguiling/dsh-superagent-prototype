/** Shared panel React contexts, state polling, restart detection, and action runner hook. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { caller, usePoll, type ApiMessages, type Call, type OverviewView, type PmsView, type SetupView, type StateView } from './api.ts'
import type { Route } from './route.ts'
import STYLES from './client.css?raw'
import { errorText, setupText, valueLabel, type T } from './text.ts'

export interface PanelContext {
  t: T
  call: Call
  navigate: (route: Route, replace?: boolean) => void
  back: () => void
  backLabel: string
  openSession: (sessionId: string) => Promise<void>
  notify: (text: string, severity?: 'info' | 'error') => void
  restart: () => void
  /** The settings drafts that are unsaved, by their key, so the navigation can say that something is waiting to be saved. */
  drafts: Record<string, boolean>
  /** Reports a settings draft as unsaved or saved again. */
  markDraft: (key: string | undefined, dirty: boolean) => void
}
export interface PanelData {
  state: StateView | undefined
  error: Error | undefined
  reload: () => Promise<void>
  setup: SetupView | undefined
  /**
   * One snapshot of the system's state: the work that needs a person, the problems and the Executor's load. The rail and
   * the Overview read the same snapshot, so the two never disagree.
   */
  overview: OverviewView | undefined
  /** The error of the last read of that snapshot, which leaves the last good one in place. */
  overviewError: Error | undefined
  /** Reads that snapshot again, which an action on the page calls so the rail and the page follow it at once. */
  reloadOverview: () => Promise<void>
  /**
   * The operator's task inbox: the tasks assigned to the bound account, with the state each one stands in. The rail
   * counts the tasks that wait for a person from it, and the workbench shows the same list.
   */
  tasks: PmsView | undefined
  /** The error of the last read of the task inbox, which leaves the last good one in place. */
  tasksError: Error | undefined
  /** Reads the task inbox again, which an action on the page calls. */
  reloadTasks: () => Promise<void>
  /** Executor Sessions in an active turn, which a restart of `dsh-superagent` interrupts. */
  running: number
  /** Incremented each time dsh-superagent recovers from a restart so dependent views refetch. */
  restarts: number
}
const Panel = createContext<PanelContext | undefined>(undefined)
const PanelState = createContext<PanelData | undefined>(undefined)
export function usePanel(): PanelContext {
  const value = useContext(Panel)
  if (!value) throw new Error('dsh-superagent page rendered outside its panel')
  return value
}
export function usePanelData(): PanelData {
  const value = useContext(PanelState)
  if (!value) throw new Error('dsh-superagent page rendered outside its panel')
  return value
}
/** Wrap an async action with re-entrancy protection, busy state, optional reload, and error toast reporting. */
export function useAction<A extends unknown[]>(action: (...args: A) => Promise<unknown>,
  { reload }: { reload?: () => Promise<unknown> } = {}) {
  const { notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = async (...args: A): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    try { await action(...args); await reload?.(); return true }
    catch (failure) { notify(errorText(failure), 'error'); return false }
    finally { running.current = false; setBusy(false) }
  }
  return { run, busy }
}

const messages = (t: T): ApiMessages => ({
  offline: t('offline'), notRunning: t('hostNotRunning'), serverError: status => t('serverError', { status }),
    requestFailed: status => t('requestFailed', { status }),
  setup: problem => problem.values.output ? `${setupText(t, problem)}\n${problem.values.output}` : setupText(t, problem),
  // A refusal names a prompt part by its label.
  user: ({ code, values }) => t(`userError.${code}`, values.part ? { ...values, part: valueLabel(t, 'promptPart', values.part) } : values),
})
/** The panel's toast: a notice held above the page for a moment; a failing action reads as an alert. */
function Toast({ text, severity = 'info', onDone, holdMs = 3000 }: { text: string; severity?: 'info' | 'error'; onDone: () => void; holdMs?: number }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => { const timer = setTimeout(() => done.current(), holdMs + 1000); return () => clearTimeout(timer) }, [holdMs])
  return createPortal(<div className="dt-toast" role={severity === 'error' ? 'alert' : 'status'}
    style={{ ['--dt-toast-hold' as string]: `${holdMs}ms` }}>{text}</div>, document.body)
}
const stay = () => {}
const noSession = async () => {}
export function PanelProvider({ t, interval = 5000, openSession = noSession, navigate = stay, back = stay, backLabel = '',
  readTasks = true, children }: {
  t: T; interval?: number; openSession?: (sessionId: string) => Promise<void>; navigate?: PanelContext['navigate']; back?: () => void
  backLabel?: string
  /** Whether to read the operator's task inbox; the Plugin Manager's page has no use for it. */
  readTasks?: boolean
  children: ReactNode
}) {
  // Read the current translator via ref so locale changes do not recreate `call` and restart polling.
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(() => messages(copy.current)), [])
  const [toast, setToast] = useState<{ text: string; severity: 'info' | 'error'; id: number }>()
  const notify = useCallback((text: string, severity: 'info' | 'error' = 'info') => setToast({ text, severity, id: Date.now() }), [])
  // The unsaved settings drafts, so the navigation can mark where something waits to be saved.
  const [drafts, setDrafts] = useState<Record<string, boolean>>({})
  const markDraft = useCallback((key: string | undefined, dirty: boolean) => {
    if (!key) return
    setDrafts(current => {
      if (!!current[key] === dirty) return current
      const next = { ...current }
      if (dirty) next[key] = true
      else delete next[key]
      return next
    })
  }, [])
  // Poll at 1s during a restart until the server goes down and answers again, or time out after 30s if the restart completed between polls.
  const [restarting, setRestarting] = useState<{ down: boolean }>()
  const [restarts, setRestarts] = useState(0)
  const restart = useCallback(() => setRestarting({ down: false }), [])
  const { data: state, error, reload } = usePoll(() => call('GET state'), [call], restarting ? 1000 : interval)
  // One snapshot of the system serves the rail and the Overview, so the two never show different numbers.
  const { data: overview, error: overviewError, reload: reloadOverview } = usePoll(() => call('GET overview'), [call], restarting ? 1000 : interval)
  // The task inbox, read once for the whole panel: the rail counts the tasks waiting for a person from it, and the
  // workbench shows the same list, so the two can never disagree.
  const { data: tasks, error: tasksError, reload: reloadTasks } = usePoll(() => readTasks ? call('GET pms') : Promise.resolve(undefined),
    [call, readTasks], readTasks ? (restarting ? 1000 : interval) : 1_000_000)
  if (restarting && !!error !== restarting.down) {
    setRestarting(error ? { down: true } : undefined)
    if (!error) setRestarts(restarts + 1)
  }
  useEffect(() => {
    if (!restarting) return
    const timer = setTimeout(() => setRestarting(undefined), 30_000)
    return () => clearTimeout(timer)
  }, [restarting])
  const context = useMemo(() => ({ t, call, navigate, back, backLabel, openSession, notify, restart, drafts, markDraft }), [t, call, navigate,
    back, backLabel, openSession, notify, restart, drafts, markDraft])
  const data = useMemo(() => ({ state, error, reload, setup: state?.setup, overview, overviewError, reloadOverview,
    tasks, tasksError, reloadTasks, running: state?.load.running ?? 0, restarts }), [state, error, reload, overview, overviewError,
    reloadOverview, tasks, tasksError, reloadTasks, restarts])
  return <Panel.Provider value={context}><PanelState.Provider value={data}>
    <style>{STYLES}</style>
    {children}
    {toast && <Toast key={toast.id} text={toast.text} severity={toast.severity} onDone={() => setToast(undefined)} />}
  </PanelState.Provider></Panel.Provider>
}
