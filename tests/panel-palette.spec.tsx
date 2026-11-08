// @vitest-environment jsdom
// The command palette: the destinations and the actions of the panel, opened with ⌘K from anywhere.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, click, text, type, tab, press } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()

const palette = () => document.querySelector<HTMLElement>('.dt-palette')
const options = () => all('.dt-palette-option')
const labels = () => all('.dt-palette-label').map(item => item.textContent)
const search = () => document.querySelector<HTMLInputElement>('.dt-palette input')!
const option = (name: string) => options().find(item => item.querySelector('.dt-palette-label')?.textContent === name)!

it('opens the palette with the keyboard, names the dialog, and closes it with Escape', async () => {
  await mount()
  expect(palette()).toBeNull()
  await press('k', { metaKey: true })
  expect(palette()).not.toBeNull()
  // The dialog has a name, and the search field holds the focus, so the keyboard alone drives it.
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(zh.paletteTitle)
  expect(document.activeElement).toBe(search())
  expect(search().getAttribute('role')).toBe('combobox')
  await press('Escape')
  expect(palette()).toBeNull()
})

it('closes on a click outside the palette', async () => {
  await mount()
  await press('k', { metaKey: true })
  await click(document.querySelector<HTMLElement>('.dt-modal-mask')!)
  expect(palette()).toBeNull()
})

it('offers every group and every page of the panel, each under its own name', async () => {
  await mount()
  await press('k', { metaKey: true })
  // The actions come first, then the groups with the pages they hold, in the order the panel shows them.
  expect(labels()).toEqual([zh.pauseProcessing, zh.openMaster, zh['tab.group.inbox'], zh['tab.pms'],
    zh['tab.group.pipeline'], zh['tab.pipeline'], zh['tab.source'], zh['tab.trigger']])
  // Every page and every group of the panel is in the list, though it shows only the first few.
  for (const label of [zh['tab.group.inbox'], zh['tab.pms'], zh['tab.group.pipeline'], zh['tab.pipeline'],
    zh['tab.source'], zh['tab.trigger'], zh['tab.eval'], zh['tab.execution'], zh['tab.group.settings'], zh['tab.settings']]) {
    await type(search(), label)
    expect(labels()).toContain(label)
  }
  // The results are a list of options, and the field names the one it holds.
  expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
  expect(search().getAttribute('aria-activedescendant')).toBe(options()[0]?.id)
})

it('filters the commands as the operator types, and keeps what is left', async () => {
  await mount()
  await press('k', { metaKey: true })
  await type(search(), '触发')
  expect(labels()).toEqual([zh['tab.trigger']])
  await type(search(), 'TRIGGER')
  expect(labels()).toEqual([])
})

it('runs the command it names, and closes the palette', async () => {
  await mount()
  await press('k', { metaKey: true })
  await type(search(), '触发')
  await press('Enter')
  expect(palette()).toBeNull()
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.trigger'])
})

it('opens the group a command names', async () => {
  await mount()
  await press('k', { metaKey: true })
  await type(search(), zh['tab.group.pipeline'])
  await press('Enter')
  expect(palette()).toBeNull()
  expect(tab(zh['tab.group.pipeline']).getAttribute('aria-selected')).toBe('true')
})

it('moves the selection with the arrow keys, and runs the one it holds', async () => {
  await mount()
  await press('k', { metaKey: true })
  expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
  await press('ArrowDown')
  expect(options()[0]?.getAttribute('aria-selected')).toBe('false')
  expect(options()[1]?.getAttribute('aria-selected')).toBe('true')
  expect(search().getAttribute('aria-activedescendant')).toBe(options()[1]?.id)
  await press('ArrowUp')
  expect(options()[0]?.getAttribute('aria-selected')).toBe('true')
  // The fourth command is the task inbox of the Inbox group.
  await press('ArrowDown')
  await press('ArrowDown')
  await press('ArrowDown')
  await press('Enter')
  expect(palette()).toBeNull()
  expect(tab(zh['tab.group.inbox']).getAttribute('aria-selected')).toBe('true')
})

it('says plainly that nothing matches, and shows no command of the ones before', async () => {
  await mount()
  await press('k', { metaKey: true })
  expect(options().length).toBeGreaterThan(0)
  await type(search(), '没有这样的命令')
  expect(options()).toHaveLength(0)
  expect(text()).toContain(zh.paletteNone)
})

it('keeps the list short and says how many commands it holds back', async () => {
  await mount()
  await press('k', { metaKey: true })
  expect(options()).toHaveLength(8)
  expect(document.querySelector('.dt-palette-total')?.textContent)
    .toBe(zh.listTotal.replace('{shown}', '8').replace('{total}', '12'))
})

it('pauses the processing with the same call the rail makes', async () => {
  await mount()
  await press('k', { metaKey: true })
  await click(option(zh.pauseProcessing))
  expect(palette()).toBeNull()
  expect(server.requests.find(request => request.path === 'executor/pause'))
    .toMatchObject({ method: 'POST', body: { paused: true } })
})

it('offers to resume the processing while it is paused', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  await press('k', { metaKey: true })
  expect(labels()).toContain(zh.resumeProcessing)
  await click(option(zh.resumeProcessing))
  expect(server.requests.find(request => request.path === 'executor/pause'))
    .toMatchObject({ method: 'POST', body: { paused: false } })
})

it('opens the master Session with the same call the rail makes', async () => {
  await mount()
  await press('k', { metaKey: true })
  await click(option(zh.openMaster))
  expect(server.opened).toEqual(['master'])
})

it('counts the work that waits for a person as the rail counts it', async () => {
  await mount()
  await press('k', { metaKey: true })
  expect(all('.dt-palette-count').map(item => item.textContent)).toEqual([`1 ${zh.railWaiting}`])
})

it('opens the palette from the header, and gives the focus back to the button', async () => {
  await mount()
  const trigger = document.querySelector<HTMLElement>('[data-palette-trigger]')!
  expect(trigger.getAttribute('aria-label')).toBe(zh.paletteOpen)
  await click(trigger)
  expect(palette()).not.toBeNull()
  expect(document.activeElement).toBe(search())
  await press('Escape')
  expect(palette()).toBeNull()
  await settle()
  expect(document.activeElement).toBe(trigger)
})

it('shows the palette in English', async () => {
  await mount(en)
  await press('k', { ctrlKey: true })
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(en.paletteTitle)
  expect(labels().slice(0, 2)).toEqual([en.pauseProcessing, en.openMaster])
  await type(search(), 'eval')
  expect(labels()).toEqual([en['tab.eval']])
})
