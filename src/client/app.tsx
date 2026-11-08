/** Root panel shell: header with global search and glossary, top-level navigation tabs, and active route view. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { SearchView } from './api.ts'
import { Button, Dot, Icon, Input, Modal, SegmentedTabs } from './controls.tsx'
import type { DeploymentForm } from './deployment.tsx'
import { EvalStatus } from './eval.tsx'
import { ExecutionStatus } from './execution.tsx'
import { ticketMark } from './marks.ts'
import { GLOSSARY, GLOSSARY_VALUES, en, zh, type DshSuperagentKey } from './locales.ts'
import { CommandPalette, PaletteButton } from './palette.tsx'
import { PipelinePage } from './pipeline-page.tsx'
import { SignalRail } from './rail.tsx'
import { PmsPage } from './pms.tsx'
import { PanelProvider, usePanel, usePanelData } from './provider.tsx'
import { GROUPS, GROUP_PAGES, HOME, groupOf, initialLocation, lastSettingsGroup, pageRoute, remember, routeLabel,
  settingsRoute, type Group, type Location, type Page, type Route } from './route.ts'
import { SettingsPage } from './settings.tsx'
import { SourceStatus } from './source.tsx'
import { actorName, errorText, reasonLabel, valueLabel, type T, readableMarkers } from './text.ts'
import { ThreadPage } from './thread.tsx'
import { TicketPage } from './ticket.tsx'
import { TriggerStatus } from './trigger.tsx'
import { When } from './widgets.tsx'

export interface AppProps {
  t: T; openSession: (sessionId: string) => Promise<void>
  deploymentForm: DeploymentForm
}

function Glossary({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = usePanel()
  // The language is read from the dictionary by comparing one known key: the panel carries exactly two dictionaries,
  // zh and en, and the translator offers no language of its own to ask.
  const chinese = t('tab.group.inbox') === zh['tab.group.inbox']
  const [own, other] = chinese ? [zh, en] : [en, zh]
  const heading = (group: keyof typeof GLOSSARY) => t(group === 'roles' ? 'glossaryGroup.roles' : `tab.${group}`)
  return <Modal className="dt-glossary-modal" open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')}
    description={t('glossaryIntro')} footer={<Button variant="primary" onClick={onClose}>{t('close')}</Button>}>
    <div className="dt-glossary-body">
      <table className="dt-glossary">
        <thead><tr>
          <th>{t(chinese ? 'glossaryChinese' : 'glossaryEnglish')}</th><th>{t(chinese ? 'glossaryEnglish' : 'glossaryChinese')}</th>
          <th>{t('glossaryMeaning')}</th>
        </tr></thead>
        {Object.entries(GLOSSARY).map(([group, keys]) => <tbody key={group}>
          <tr><th colSpan={3} scope="rowgroup" className="dt-glossary-group">{heading(group as keyof typeof GLOSSARY)}</th></tr>
          {keys.map(key => <tr key={key}><td>{own[`term.${key}`]}</td><td>{other[`term.${key}`]}</td><td>{own[`meaning.${key}`]}</td></tr>)}
        </tbody>)}
      </table>
      <p className="dt-legend-title">{t('legendTitle')}</p>
      <ul className="dt-legend">{(['done', 'ongoing', 'warning', 'error', 'idle'] as const).map(state => <li key={state}>
        <Dot state={state} /><span>{t(`legend.${state}`)}</span>
      </li>)}</ul>
      <dl className="dt-values">{Object.entries(GLOSSARY_VALUES).map(([group, values]) => <div key={group} style={{ display: 'contents' }}>
        <dt>{own[`term.${group}` as DshSuperagentKey]}</dt>
        <dd>{values.map(key => `${own[key]} ${other[key]}`).join(' · ')}</dd>
      </div>)}</dl>
    </div>
  </Modal>
}

function Highlight({ text, query }: { text: string; query: string }) {
  const index = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (index < 0) return <>{text}</>
  return <>{text.slice(0, index)}<mark className="dt-mark">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>
}
function Result({ name, open, children }: { name: ReactNode; open: (() => void) | undefined; children: ReactNode }) {
  return <li className="dt-row dt-link"><div className="dt-row-main">
    <div className="dt-row-title">{open ? <button type="button" className="dt-open" onClick={open}>{name}</button> : name}</div>
    <div className="dt-row-meta">{children}</div>
  </div></li>
}
function SearchResults({ result, query, onClose }: { result: SearchView; query: string; onClose: () => void }) {
  const { t, navigate } = usePanel()
  const empty = !result.items.length && !result.threads.length && !result.tickets.length
  const counts = { tickets: result.tickets.length, threads: result.threads.length, items: result.items.length }
  const go = (route: Route) => () => { onClose(); navigate(route) }
  return <div className="dt-search-results" role="region" aria-label={t('searchLabel')}>
    <div className="dt-search-head">
      <span className="dt-hint">{empty ? t('searchNone')
        : t(result.items.length >= 20 ? 'searchFoundCapped' : 'searchFound', counts)}</span>
      <Button variant="ghost" size="sm" icon={<Icon name="close" size={14} />} aria-label={t('close')} onClick={onClose} />
    </div>
    {!empty && <ul className="dt-list">
      {result.tickets.map(ticket => <Result key={ticket.id} name={<Highlight text={ticket.title} query={query} />}
        open={go({ page: 'execution', id: ticket.id })}>
        <span>{t('term.ticket')}</span><span>{ticket.stage === 'ended' ? t('ticket.ended') : ticketMark(t, ticket).label}</span>
      </Result>)}
      {result.threads.map(thread => <Result key={thread.key} name={readableMarkers(t, thread.title)} open={go({ page: 'trigger',
        id: thread.key })}>
        <span>{t('term.thread')}</span>
      </Result>)}
      {/* Filtered triggers have no Thread and display their filter reason instead of a link. */}
      {result.items.map(item => <Result key={item.id} name={<Highlight text={readableMarkers(t, item.preview) || t('empty')}
        query={query} />}
        open={item.filtered === undefined ? go({ page: 'trigger', id: item.threads[0]!, query: { trigger: item.id } }) : undefined}>
        <span>{valueLabel(t, 'source', item.source)}</span><span>{actorName(t, item.actor)}</span><When at={item.at} />
        {item.threadTitle && <span className="dt-ellipsis">{t('inThread', { thread: readableMarkers(t, item.threadTitle) })}</span>}
        {item.filtered !== undefined && <span>{t('searchFiltered', { reason: reasonLabel(t, item.filtered) })}</span>}
      </Result>)}
    </ul>}
  </div>
}

function Header() {
  const { t, call, notify } = usePanel()
  const [glossary, setGlossary] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<{ query: string; value: SearchView }>()
  // Ignore responses from superseded or cleared search requests.
  const latest = useRef(0)
  const show = (value?: { query: string; value: SearchView }) => { latest.current++; setResult(value) }
  const search = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!result) return
    const close = (event: PointerEvent) => { if (!search.current?.contains(event.target as Node)) show() }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [result])
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = query.trim()
    if (!text) { show(); return }
    const request = ++latest.current
    call('GET search', { query: { q: text } }).then(value => { if (request === latest.current) setResult({ query: text, value }) },
      failure => { if (request === latest.current) notify(errorText(failure), 'error') })
  }
  return <header className="dt-head">
    <div className="dt-head-title"><h1 className="dt-title">{t('title')}</h1></div>
    <div className="dt-toolbar">
      <form ref={search} className="dt-search" role="search" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') show() }}>
        <Input type="search" icon={<Icon name="search" />} value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchLabel')}
          onChange={event => { setQuery(event.target.value); if (!event.target.value) show() }} />
        {result && <SearchResults result={result.value} query={result.query} onClose={() => { show() }} />}
      </form>
      <Button variant="ghost" size="sm" icon={<Icon name="question" />} aria-label={t('glossary')} title={t('glossary')} aria-haspopup="dialog"
        onClick={() => setGlossary(true)} />
      <PaletteButton />
    </div>
    <Glossary open={glossary} onClose={() => setGlossary(false)} />
  </header>
}

function Pages({ route, openGroup, deploymentForm }: { route: Route; openGroup: (group: Group) => void; deploymentForm: DeploymentForm }) {
  const { t, navigate, drafts } = usePanel()
  const { state, error, reload } = usePanelData()
  const group = groupOf(route.page)
  // A setting that waits to be saved marks the Settings group, so the operator knows it is not written yet.
  const unsaved = Object.keys(drafts).length > 0
  // Keep the active tab scrolled into view on narrow screens when routes change via links.
  useEffect(() => { document.getElementById(`dt-tab-${group}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [group])
  const waiting = error ? <p className="dt-error" role="alert">{error.message}</p> : <p className="dt-hint">{t('loading')}</p>
  const page = (() => {
    switch (route.page) {
      case 'pms': return <PmsPage id={route.id} filter={route.query?.filter ?? 'active'} />
      // The flow page: the chart, and the section it points at below it. The route names the section.
      case 'pipeline': return <PipelinePage view={{ kind: 'source' }} />
      case 'source': return <PipelinePage view={{ kind: 'source' }} />
      case 'trigger': return route.id !== undefined ? <ThreadPage key={route.id} id={route.id} target={route.query?.trigger} />
        : <PipelinePage view={{ kind: 'trigger', filter: route.query?.filter ?? 'subscribed' }} />
      case 'eval': return <PipelinePage view={{ kind: 'eval', filter: route.query?.filter ?? 'work', window: route.query?.window,
        paused: !!state?.paused }} />
      case 'execution': return route.id !== undefined ? <TicketPage key={route.id} id={route.id} />
        : state ? <PipelinePage view={{ kind: 'execution', filter: route.query?.filter ?? 'open', window: route.query?.window,
          state, reload }} /> : waiting
      case 'settings': return state ? <SettingsPage key={state.masterId} group={route.query.group} query={route.query} state={state}
        deploymentForm={deploymentForm} /> : waiting
    }
  })()
  // The task inbox fills the page: its conversation is a box with its own scroll, not a column of the page's.
  return <div className="dt-page" data-fill={route.page === 'pms' ? 'true' : undefined}>
    <div className="dt-column" data-unsaved={unsaved ? 'settings' : undefined}>
      <Header />
      <SignalRail onOpenWaiting={() => navigate({ page: 'pms', query: { filter: 'waiting' } })}
        onOpenProblems={() => navigate({ page: 'pipeline' })} />
      {error && state && <p className="dt-error" role="status">{error.message}</p>}
      {/* The three destinations of the panel; each holds one page, which the tab itself opens. */}
      <SegmentedTabs className="dt-grouptabs" label={t('pagesLabel')} value={group} onChange={openGroup}
        items={GROUPS.map(value => ({ value, label: t(`tab.group.${value}`), id: `dt-tab-${value}`, panelId: 'dt-page' }))} />
      <main id="dt-page" role="tabpanel" aria-labelledby={`dt-tab-${group}`}
        className="dt-main">{page}</main>
    </div>
  </div>
}

/** Root panel component managing route history and shared panel state. */
export function App({ t, openSession, deploymentForm }: AppProps) {
  const [location, setLocation] = useState(initialLocation)
  useEffect(() => { remember(location) }, [location])
  // Preserve the last opened settings group across navigation so the Settings tab reopens at it.
  const move = useCallback((next: (current: Location) => Pick<Location, 'route' | 'stack'>) =>
    setLocation(current => ({ ...next(current), group: lastSettingsGroup(current) })), [])
  /** Navigates to `route`; `replace` swaps the current entry (filters, paging) instead of pushing a back step. */
  const navigate = useCallback((route: Route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  const back = useCallback(() => move(current => ({ route: current.stack.at(-1) ?? HOME, stack: current.stack.slice(0, -1) })), [move])
  /** Choosing a destination opens the first page of it; the Settings one reopens at the group last read. */
  const openGroup = useCallback((group: Group) => move(current => ({ stack: [], route: group === 'settings'
    ? settingsRoute(lastSettingsGroup(current)) : pageRoute(GROUP_PAGES[group][0]!) })), [move])
  const openPage = useCallback((page: Page) => move(current => ({ stack: [], route: pageRoute(page) })), [move])
  // The back label names where the back button goes, and there is no button when the panel opened here.
  const backLabel = location.stack.length ? routeLabel(t, location.stack.at(-1)!) : ''
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} backLabel={backLabel}>
    <CommandPalette onGroup={openGroup} onPage={openPage}>
      <Pages route={location.route} openGroup={openGroup} deploymentForm={deploymentForm} />
    </CommandPalette>
  </PanelProvider>
}
