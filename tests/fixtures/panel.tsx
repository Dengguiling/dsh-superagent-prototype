/** DOM rendering and interaction helpers for panel tests. */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect, vi } from 'vitest'
import { App } from '../../src/client/app.tsx'
import { usePageForm } from '../../src/client/deployment.tsx'
import { zh } from '../../src/client/locales.ts'
import type { T } from '../../src/client/text.ts'
import { server, usePanelServer } from './panel-server.ts'

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean }
globalThis.IS_REACT_ACT_ENVIRONMENT = true

export const translator = (dictionary: Record<string, string>): T => ((key: string, params?: Record<string, unknown>) => {
  const template = dictionary[key] ?? key
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template
}) as T
function Panel({ t }: { t: T }) {
  return <App t={t} openSession={async id => { server.opened.push(id) }} deploymentForm={usePageForm(server.form)} />
}
let root: Root | undefined
let container: HTMLElement | undefined
function unmount() {
  act(() => { root?.unmount() })
  root = undefined
  container?.remove()
}
export const usePanel = () => usePanelServer(unmount)

/** Flush pending fake-server responses and React state updates. */
export async function settle() {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(server.pending).toBe(0)
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
export async function mount(dictionary: Record<string, string> = zh) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(<Panel t={translator(dictionary)} />) })
  await settle()
}
export async function remount(dictionary: Record<string, string> = zh) { unmount(); await mount(dictionary) }

export const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
const CONTROLS = 'button, [role="button"], [role="tab"], [role="switch"], a'
export function find(name: string, selector = CONTROLS): HTMLElement {
  const match = all(selector).find(element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name)
  if (!match) throw new Error(`No ${selector} named ${name}`)
  return match
}
export const tab = (name: string) => find(name, '[role="tab"]')
/**
 * Opens a page of the panel: the group it belongs to first. The flow group has one page, so its sections are reached
 * the way an operator reaches them: through the command palette, which lists every one of them.
 */
export async function openPage(dictionary: Record<string, string>, page: string) {
  const group = page === 'settings' ? 'settings' : page === 'inbox' || page === 'pms' ? 'inbox' : 'pipeline'
  const groupTab = tab(dictionary[`tab.group.${group}`]!)
  if (groupTab.getAttribute('aria-selected') !== 'true') await click(groupTab)
  if (page === 'pipeline' || page === 'pms' || page === 'settings') return
  // The route already names this page: opening it again would drop what the page shows, such as the record it holds.
  const current = JSON.parse(sessionStorage.getItem('dsh-superagent/route') ?? '{}') as { route?: { page?: string } }
  if (current.route?.page === page) return
  // The sections of the flow page are reached the way an operator reaches them: through the command palette.
  await press('k', { metaKey: true })
  await type(document.querySelector<HTMLInputElement>('.dt-palette input')!, dictionary[`tab.${page}`]!)
  await press('Enter')
}
/** Presses a key on whatever holds the focus, the way the operator does. */
export async function press(key: string, options: KeyboardEventInit = {}) {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...options }))
  })
  await settle()
}
export async function click(target: string | HTMLElement) {
  const element = typeof target === 'string' ? find(target) : target
  await act(async () => { element.click() })
  await settle()
}
export async function type(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  await settle()
}
/** The page's text without its stylesheet. */
export const text = () => [...document.body.querySelectorAll('style')].reduce((all, style) => all.replace(style.textContent ?? '', ''),
  document.body.textContent ?? '')
export function field<E extends HTMLElement>(label: string): E {
  const labelled = (element: HTMLElement) => !!element.id && all('label').some(item => (item as HTMLLabelElement).htmlFor === element.id
    && item.textContent === label)
  const match = all('input, textarea, select').find(element => element.getAttribute('aria-label') === label || labelled(element))
  if (!match) throw new Error(`No field ${label}`)
  return match as unknown as E
}
export const at = (route: object) => sessionStorage.setItem('dsh-superagent/route', JSON.stringify({ route, stack: [] }))
