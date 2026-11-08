/**
 * The command palette: the destinations of the panel and the actions an operator reaches for, in one list that
 * ⌘K opens from anywhere. It reuses the host's dialog, its tokens and the calls the rail makes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Icon, Input, Modal } from './controls.tsx'
import { usePanel, usePanelData } from './provider.tsx'
import { FLOW_SECTIONS, GROUPS, GROUP_PAGES, type Group, type Page } from './route.ts'
import { errorText } from './text.ts'
import PALETTE from './palette.css?raw'

/** How many commands the palette shows at once; the ones it holds back are counted, never hidden silently. */
const SHOWN = 8
/** The name of the list, so the input can point at the options it controls. */
const LIST_ID = 'dt-palette-list'

/** One entry of the palette: a destination of the panel, or an action an operator reaches for. */
interface Command {
  id: string
  label: string
  /** The kind of the entry, or the group it belongs to; empty when it would only repeat the label. */
  hint: string
  /** The number the panel's own snapshot holds, when the entry counts something. */
  count?: string
  run: () => void
}

/** How the palette is opened, and who gets the focus back when it closes. */
interface PaletteControl {
  /** Opens the palette; the element that had the focus gets it back when the palette closes. */
  open: (from?: HTMLElement) => void
}
const Palette = createContext<PaletteControl | undefined>(undefined)
/** Opens the command palette from anywhere in the panel. */
export function usePalette(): PaletteControl {
  const value = useContext(Palette)
  if (!value) throw new Error('the command palette rendered outside the panel')
  return value
}

/** The shortcut the palette opens with, in the words of the platform it runs on. */
export const shortcut = (): string => {
  const platform = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K'
}
const optionId = (id: string) => `dt-palette-option-${id.replace(/[^a-z0-9]+/gi, '-')}`

/** The header's button that opens the palette, with the shortcut it opens with. */
export function PaletteButton() {
  const { t } = usePanel()
  const { open } = usePalette()
  return <Button variant="ghost" size="sm" className="dt-palette-trigger" data-palette-trigger
    aria-label={t('paletteOpen')} title={t('paletteOpen')} aria-haspopup="dialog"
    onClick={event => open(event.currentTarget)}><kbd className="dt-palette-key">{shortcut()}</kbd></Button>
}

/**
 * The palette: a search field and the list of what it holds. Every destination of the panel is in the list, and so
 * are the actions the operator reaches for most; running one closes the palette and does it.
 */
export function CommandPalette({ onGroup, onPage, children }: {
  onGroup: (group: Group) => void
  onPage: (page: Page) => void
  children: ReactNode
}) {
  const { t, call, openSession, notify } = usePanel()
  // The numbers the palette shows come from the same snapshot the rail and the Overview read.
  const { state, overview, overviewError, reloadOverview, tasks, tasksError } = usePanelData()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const field = useRef<HTMLDivElement>(null)
  const restore = useRef<HTMLElement | undefined>(undefined)
  const entered = useRef(false)
  const paused = overview?.paused ?? state?.paused ?? false
  const masterId = state?.masterId
  // The count of the tasks that wait for a person, as the rail reads it; a stale snapshot shows no number at all.
  const waiting = tasks && !tasksError ? tasks.tasks.filter(task => task.state === 'waiting').length : undefined
  const togglePause = useCallback(async () => {
    try {
      await call('POST executor/pause', { body: { paused: !paused } })
      await reloadOverview()
    } catch (failure) { notify(errorText(failure), 'error') }
  }, [call, notify, paused, reloadOverview])
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = []
    // The actions an operator reaches for come first; the destinations of the panel follow.
    list.push({ id: 'action:pause', label: t(paused ? 'resumeProcessing' : 'pauseProcessing'), hint: t('paletteAction'),
      run: () => { void togglePause() } })
    if (masterId) list.push({ id: 'action:master', label: t('openMaster'), hint: t('paletteAction'),
      run: () => { openSession(masterId).catch(failure => notify(errorText(failure), 'error')) } })
    // The groups, each with the pages it holds, the way the panel shows them.
    for (const group of GROUPS) {
      const groupLabel = t(`tab.group.${group}`)
      list.push({ id: `group:${group}`, label: groupLabel, hint: t('paletteGroup'), run: () => onGroup(group) })
      for (const page of GROUP_PAGES[group]) {
        const label = t(`tab.${page}`)
        list.push({ id: `page:${page}`, label, hint: label === groupLabel ? '' : groupLabel,
          count: page === 'pms' && waiting !== undefined ? `${waiting} ${t('railWaiting')}` : undefined,
          run: () => onPage(page) })
      }
      // The flow page holds its sections below the chart; the palette is where the operator goes to one of them.
      if (group === 'pipeline') for (const section of FLOW_SECTIONS) {
        const label = t(`tab.${section}`)
        list.push({ id: `page:${section}`, label, hint: groupLabel, run: () => onPage(section) })
      }
    }
    return list
  }, [masterId, onGroup, onPage, paused, t, togglePause, waiting])
  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => commands.filter(command => !needle || command.label.toLowerCase().includes(needle)),
    [commands, needle])
  const shown = matches.slice(0, SHOWN)
  const active = shown.length ? Math.min(selected, shown.length - 1) : 0
  const close = useCallback(() => { setOpen(false) }, [])
  const openPalette = useCallback((from?: HTMLElement) => {
    const focused = document.activeElement
    // The element that had the focus gets it back when the palette closes.
    restore.current = from ?? (focused instanceof HTMLElement && focused !== document.body ? focused : undefined)
    entered.current = true
    setQuery('')
    setSelected(0)
    setOpen(true)
  }, [])
  // ⌘K opens the palette from anywhere in the panel, and closes it again.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || (!event.metaKey && !event.ctrlKey)) return
      event.preventDefault()
      if (open) close()
      else openPalette()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [close, open, openPalette])
  // The focus returns to the trigger when the dialog closes.
  useEffect(() => {
    if (open || !entered.current) return
    entered.current = false
    const target = restore.current
    restore.current = undefined
    const timer = setTimeout(() => {
      const element = target?.isConnected ? target : document.querySelector<HTMLElement>('[data-palette-trigger]')
      element?.focus()
    }, 0)
    return () => { clearTimeout(timer) }
  }, [open])
  // The search field holds the focus, so the whole palette is driven from the keyboard.
  useEffect(() => {
    if (!open) return
    field.current?.querySelector('input')?.focus()
  }, [open])
  const move = (step: number) => {
    if (!shown.length) return
    setSelected((active + step + shown.length) % shown.length)
  }
  const run = (command: Command) => { close(); command.run() }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Enter') {
      event.preventDefault()
      const command = shown[active]
      if (command) run(command)
    }
  }
  return <Palette.Provider value={{ open: openPalette }}>
    <style>{PALETTE}</style>
    {children}
    <Modal open={open} onClose={close} title={t('paletteTitle')} closeLabel={t('close')} className="dt-palette"
      footer={<div className="dt-palette-foot">
        <span className="dt-palette-total">{matches.length > shown.length
          ? t('listTotal', { shown: shown.length, total: matches.length }) : ''}</span>
        <span className="dt-palette-keys">{t('paletteKeys')}</span>
      </div>}>
      <div>
        <div className="dt-palette-search" ref={field}>
          <Input type="text" icon={<Icon name="search" />} value={query} placeholder={t('palettePlaceholder')}
            aria-label={t('paletteSearch')} role="combobox" aria-autocomplete="list" aria-expanded="true"
            aria-controls={LIST_ID} aria-activedescendant={shown.length ? optionId(shown[active]!.id) : undefined}
            autoComplete="off" spellCheck={false}
            onChange={event => { setQuery(event.target.value); setSelected(0) }} onKeyDown={onKeyDown} />
        </div>
        <ul id={LIST_ID} role="listbox" aria-label={t('paletteResults')} className="dt-palette-list">
          {shown.map((command, index) => <li key={command.id} id={optionId(command.id)} role="option"
            aria-selected={index === active} className="dt-palette-option" data-selected={index === active || undefined}
            onMouseDown={event => event.preventDefault()} onClick={() => run(command)}>
            <span className="dt-palette-label">{command.label}</span>
            {command.count && <span className="dt-palette-count">{command.count}</span>}
            {command.hint && <span className="dt-palette-hint">{command.hint}</span>}
          </li>)}
        </ul>
        {!shown.length && <p className="dt-palette-empty">{t('paletteNone')}</p>}
      </div>
    </Modal>
  </Palette.Provider>
}
