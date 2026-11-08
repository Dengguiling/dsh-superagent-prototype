/** Typed panel routes, route parser, and sessionStorage location history. */
import { THREAD_FILTERS, TICKET_FILTERS, type ThreadFilter, type TicketFilter } from '../app/api.ts'
import type { SetupPlace } from '../setup.ts'
import { DECISION_FILTERS, type DecisionFilter } from './api.ts'
import type { T } from './text.ts'

/**
 * The three destinations of the panel: what needs a person, the flow of the work, and the settings. Each holds the
 * pages that belong to it, so the operator chooses a task first and a page second.
 */
export const GROUPS = ['inbox', 'pipeline', 'settings'] as const
export type Group = typeof GROUPS[number]
export type Page = 'pms' | 'pipeline' | 'source' | 'trigger' | 'eval' | 'execution' | 'settings'
/** The pages each group holds, in the order they appear. The first one opens the group. */
export const GROUP_PAGES: Record<Group, readonly Page[]> = {
  // One page: the operator's task inbox already says what waits for them, so a second list beside it would repeat itself.
  inbox: ['pms'],
  // One page: the chart is the map, and the section it points at appears below it. A row of tabs would only repeat it.
  pipeline: ['pipeline'],
  settings: ['settings'],
}
/** The sections the flow page shows below its chart, in the order the work passes them. */
export const FLOW_SECTIONS = ['source', 'trigger', 'eval', 'execution'] as const
export type FlowSection = typeof FLOW_SECTIONS[number]
/** The group a page belongs to, which the tab bar shows as the current destination. */
export const groupOf = (page: Page): Group => page === 'settings' ? 'settings' : page === 'pms' ? 'inbox' : 'pipeline'
export const SETTINGS_GROUPS = ['source', 'eval', 'execution', 'prompts', 'deployment'] as const
export type SettingsGroup = typeof SETTINGS_GROUPS[number]
export const PMS_FILTERS = ['waiting', 'active', 'declined', 'archived'] as const
export type PmsFilter = typeof PMS_FILTERS[number]
export type Route = { page: 'pipeline' | 'source'; id?: undefined; query?: undefined }
  | { page: 'pms'; id?: string; query?: { filter?: PmsFilter } }
  | { page: 'trigger'; id?: undefined; query?: { filter?: ThreadFilter } }
  | { page: 'trigger'; id: string; query?: { trigger?: string } }
  | { page: 'eval'; id?: undefined; query?: { filter?: DecisionFilter; window?: '24h' } }
  | { page: 'execution'; id?: undefined; query?: { filter?: TicketFilter; window?: '24h' } }
  | { page: 'execution'; id: string; query?: undefined }
  | { page: 'settings'; id?: undefined; query: { group: SettingsGroup; source?: string; version?: string } }
export const HOME: Route = { page: 'pms' }
/** The route that opens a page with no record of its own. */
export const pageRoute = (page: Page): Route => {
  if (page === 'settings') return settingsRoute('source')
  if (page === 'pms') return { page: 'pms' }
  if (page === 'trigger') return { page: 'trigger', query: {} }
  if (page === 'eval') return { page: 'eval', query: {} }
  if (page === 'execution') return { page: 'execution', query: {} }
  return { page }
}
export const settingsRoute = (group: SettingsGroup, query: { source?: string; version?: string } = {}): Route =>
  ({ page: 'settings', query: { group, ...query } })
export const setupPage = (place: SetupPlace): Route =>
  place === 'deployment' ? settingsRoute('deployment') : settingsRoute('source', { source: place })
export const routeLabel = (t: T, route: Route): string => route.id
  ? t(route.page === 'pms' ? 'pmsBackToList' : route.page === 'trigger' ? 'term.thread' : 'term.ticket')
  : t(`tab.${route.page}`)

const pick = <V extends string>(values: readonly V[], value: unknown): V | undefined => values.find(item => item === value)
function compact<Q extends object>(query: Q): Q | undefined {
  const set = Object.entries(query).filter(([, value]) => value !== undefined)
  return set.length ? Object.fromEntries(set) as Q : undefined
}
/** Validate and normalize a stored route, dropping unrecognized query filters or removed pages (such as the legacy `policy` tab). */
export function parseRoute(value: unknown): Route | undefined {
  const { page, id, query } = (value ?? {}) as { page?: unknown; id?: unknown; query?: Record<string, unknown> }
  const text = (name: string) => typeof query?.[name] === 'string' ? query[name] as string : undefined
  const record = typeof id === 'string' && id ? id : undefined
  switch (page) {
    case 'pipeline': case 'source': return { page }
    case 'pms': {
      const filter = pick(PMS_FILTERS, query?.filter)
      return { page, ...record ? { id: record } : {}, ...filter ? { query: { filter } } : {} }
    }
    case 'trigger': return record ? { page, id: record, query: compact({ trigger: text('trigger') }) }
      : { page, query: compact({ filter: pick(THREAD_FILTERS, query?.filter) }) }
    case 'eval': return { page, query: compact({ filter: pick(DECISION_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'execution': return record ? { page, id: record } : { page, query: compact({ filter: pick(TICKET_FILTERS, query?.filter),
      window: query?.window === '24h' ? '24h' as const : undefined }) }
    case 'settings': return { page, query: { group: pick(SETTINGS_GROUPS, query?.group) ?? 'source',
      ...compact({ source: text('source'), version: text('version') }) } }
    default: return undefined
  }
}

const ROUTE_KEY = 'dsh-superagent/route'
export interface Location { route: Route; stack: Route[]; group?: SettingsGroup | undefined }
export const lastSettingsGroup = ({ route, group }: Location): SettingsGroup => route.page === 'settings' ? route.query.group
  : group ?? 'source'
export function initialLocation(): Location {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') as { route?: unknown; stack?: unknown; group?: unknown } | null
    const route = parseRoute(stored?.route)
    const stack = Array.isArray(stored?.stack) ? stored.stack as unknown[] : []
    if (route) return { route, stack: stack.flatMap(item => parseRoute(item) ?? []), group: pick(SETTINGS_GROUPS, stored?.group) }
  } catch (error) {
    // Route memory is a convenience; an unreadable value falls back to HOME.
    void error
  }
  return { route: HOME, stack: [] }
}
export function remember(location: Location): void {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch (failure) { void failure /* Route memory is a convenience. */ }
}
