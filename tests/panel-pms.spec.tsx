// @vitest-environment jsdom
// The Workbench: the assigned Redmine tasks, their conversation with the superagent, and the local list actions.
import { act } from 'react'
import { expect, it, onTestFinished, vi } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, click, tab, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
// The task inbox is the only page of the Inbox group, so the group tab opens it.
const openTab = async (dictionary = zh) => { await mount(dictionary); await click(dictionary['tab.group.inbox']) }
const openTask = async (subject: string) => {
  const row = all('.dt-task-open').find(item => item.textContent?.includes(subject))
  expect(row, subject).toBeTruthy()
  await click(row!)
  await settle()
}
const composer = () => document.querySelector<HTMLTextAreaElement>('.dt-chat-input')
const send = () => [...document.querySelectorAll<HTMLButtonElement>('.dt-chat-actions button')].find(button => button.textContent === zh.pmsReplySend)!

it('lists the tasks assigned to the bound account with their tickets, and keeps archived tasks in their own filter', async () => {
  await openTab()
  // The tab order starts with Overview; the Workbench lists the inbox.
  expect(all('.dt-grouptabs [role="tab"]').map(item => item.textContent)).toEqual(['任务工作台', '流水线', '设置'])
  // The filters are the states a task stands in, and never overlap.
  expect(all('.dt-inbox-filters .dt-pill').map(item => item.textContent)).toEqual([`${zh['pmsFilter.waiting']}1`,
    `${zh['pmsFilter.active']}2`, `${zh['pmsFilter.declined']}1`, `${zh['pmsFilter.archived']}1`])
  expect(all('.dt-task-open').map(item => item.textContent)).toEqual([
    expect.stringContaining('SDK pagination skips the first page'), expect.stringContaining('CLI --timeout is ignored')])
  expect(all('.dt-task-ticket').map(item => item.textContent)).toEqual([zh.pmsTicket.replace('{title}', 'Fix SDK pagination')])
  // The archived filter shows the archived task only, and the active filter brings the inbox back.
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))!)
  expect(all('.dt-task-open').map(item => item.textContent)).toEqual([expect.stringContaining('Old demo issue')])
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.active']))!)
  expect(all('.dt-task-open')).toHaveLength(2)
})

it('opens the first task of the view by itself, and leaves a task the operator closed closed', async () => {
  await openTab()
  await settle()
  // The page opens the first task of the filter, so coming back to it costs no click.
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('SDK pagination skips the first page')
  // Another view opens its own first task, and keeps its filter.
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))!)
  await settle()
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('Old demo issue')
  expect(all('.dt-inbox-filters .dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))?.getAttribute('aria-pressed')).toBe('true')
  // A task the operator closed stays closed, so the list can be read on its own.
  await click(document.querySelector('.dt-back')!)
  await settle()
  expect(document.querySelector('.dt-taskview')).toBeNull()
  expect(text()).toContain(zh.pmsIntro)
})

it('opens a task as its Redmine conversation, with the agent replies, the people on the issue and the ticket that works it', async () => {
  await openTab()
  await openTask('SDK pagination skips the first page')
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('SDK pagination skips the first page')
  expect(document.querySelector('.dt-taskview-meta')?.textContent).toContain('#12')
  expect(document.querySelector('.dt-taskview-meta')?.textContent).toContain('sdk')
  // The issue description, the agent's reply, the operator's reply and the reporter's note, in that order.
  expect(all('.dt-chat-msg')).toHaveLength(4)
  expect(all('.dt-chat-msg').map(item => item.getAttribute('data-role'))).toEqual(['other', 'agent', 'you', 'other'])
  expect(all('.dt-chat-author').map(item => item.textContent)).toEqual(['Team Leader', zh.pmsAgent, zh.pmsYou, 'Team Leader'])
  expect(all('.dt-chat-msg')[1]!.textContent).toContain('off-by-one')
  // The task system is one link away, in the head of the conversation; no message carries a link of its own.
  expect(all('.dt-chat-link')).toHaveLength(0)
  expect(document.querySelector('.dt-taskview-actions a')?.getAttribute('href')).toBe('http://redmine.test/issues/12')
  // The ticket that works the task, its change and its session.
  expect(document.querySelector('.dt-taskview-ticket')?.textContent).toContain('Fix SDK pagination')
  expect(document.querySelector('.dt-taskview-ticket')?.textContent).toContain(zh.pmsChange.replace('{number}', '1003'))
  await click([...document.querySelectorAll<HTMLButtonElement>('.dt-taskview-ticket button')].find(item => item.textContent === zh.openSession)!)
  expect(server.opened).toEqual(['worker-ticket-1'])
})

it('renders the task system\'s Markdown as Markdown, and not as its source', async () => {
  const task = server.pmsTasks[12]!
  server.pmsTasks[12] = { ...task, messages: [{ ...task.messages[0]!,
    text: '## Symptoms\n\nThe cursor starts at `page * size` in `pagination.py`.\n\n- the first page repeats\n- the last page is lost' }] }
  await openTab()
  await openTask('SDK pagination skips the first page')
  const message = all('.dt-chat-msg')[0]!
  expect(message.querySelector('.dt-md-heading')?.textContent).toBe('Symptoms')
  expect(message.querySelector('code')?.textContent).toBe('page * size')
  expect([...message.querySelectorAll('li')].map(item => item.textContent)).toEqual(['the first page repeats', 'the last page is lost'])
  // The reader sees the note, not the marks that made it.
  expect(message.textContent).not.toContain('`')
  expect(message.textContent).not.toContain('## ')
})

it('replies in the conversation: the note is posted on the issue and shown at once', async () => {
  await openTab()
  await openTask('SDK pagination skips the first page')
  await type(composer()!, 'Also add a regression test for the last page.')
  await click(send())
  expect(server.replies).toEqual([{ issue: 12, text: 'Also add a regression test for the last page.' }])
  expect(server.requests.some(request => request.path === 'pms/12/reply' && request.method === 'POST')).toBe(true)
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.pmsReplySent)
  expect(all('.dt-chat-msg')).toHaveLength(5)
  expect(all('.dt-chat-msg').at(-1)!.textContent).toContain('Also add a regression test for the last page.')
  expect(composer()?.value).toBe('')
})

it('archives a task from the list and restores it from the archived filter', async () => {
  await openTab()
  const archiveButton = all('.dt-task-row')[0]!.querySelector<HTMLButtonElement>(`button[title="${zh.pmsArchive}"]`)!
  await click(archiveButton)
  expect(server.requests.some(request => request.path === 'pms/12/archive' && request.method === 'POST'
    && JSON.stringify(request.body) === JSON.stringify({ archived: true }))).toBe(true)
  expect(all('.dt-task-open')).toHaveLength(1)
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))!)
  expect(all('.dt-task-open')).toHaveLength(2)
  const restore = all('.dt-task-row').find(row => row.textContent?.includes('SDK pagination'))!
    .querySelector<HTMLButtonElement>(`button[title="${zh.pmsUnarchive}"]`)!
  await click(restore)
  expect(server.requests.some(request => request.path === 'pms/12/archive'
    && JSON.stringify(request.body) === JSON.stringify({ archived: false }))).toBe(true)
  expect(all('.dt-task-open')).toHaveLength(1)
})

it('removes a task from the workbench only after confirmation, and returns to the empty inbox', async () => {
  await openTab()
  await openTask('SDK pagination skips the first page')
  const remove = [...document.querySelectorAll<HTMLButtonElement>('.dt-taskview-actions button')].find(item => item.textContent === zh.pmsDelete)!
  await click(remove)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.pmsDeleteMessage)
  await click(zh.confirm)
  expect(server.requests.some(request => request.path === 'pms/12/delete' && request.method === 'POST')).toBe(true)
  expect(server.pms.tasks.map(task => task.id)).toEqual([13, 15])
  expect(document.querySelector('.dt-taskview')).toBeNull()
  expect(all('.dt-task-open')).toHaveLength(1)
})

it('says when a task cannot be replied to and hides the composer', async () => {
  const detail = server.pmsTasks[13]!
  server.pmsTasks[13] = { ...detail, canReply: false }
  await openTab()
  await openTask('CLI --timeout is ignored')
  expect(composer()).toBeNull()
  expect(text()).toContain(zh.pmsNoReply)
})

it('keeps the archived filter when it returns from an opened archived task', async () => {
  await openTab()
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))!)
  await openTask('Old demo issue')
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('Old demo issue')
  await click(zh.pmsBackToList)
  expect(all('.dt-pill').find(item => item.textContent?.startsWith(zh['pmsFilter.archived']))?.getAttribute('aria-pressed')).toBe('true')
  expect(all('.dt-task-open')).toHaveLength(1)
})

it('words the inbox in English when the panel speaks English', async () => {
  await openTab(en)
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('SDK pagination skips the first page')
  expect(all('.dt-inbox-filters .dt-pill').map(item => item.textContent)).toEqual([`${en['pmsFilter.waiting']}1`,
    `${en['pmsFilter.active']}2`, `${en['pmsFilter.declined']}1`, `${en['pmsFilter.archived']}1`])
  await openTask('SDK pagination skips the first page')
  expect(all('.dt-chat-author').slice(0, 3).map(item => item.textContent)).toEqual(['Team Leader', en.pmsAgent, en.pmsYou])
  expect(composer()?.getAttribute('placeholder')).toBe(en.pmsReplyPlaceholder)
  expect(tab(en['tab.group.inbox']).getAttribute('aria-selected')).toBe('true')
})

it('returns to the list when the opened task is deleted elsewhere, instead of keeping an error', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  onTestFinished(() => { vi.useRealTimers() })
  await openTab()
  await openTask('SDK pagination skips the first page')
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('SDK pagination skips the first page')
  // The conversation's poll then finds no such task: the host confirms it is gone (not merely unreachable).
  delete server.pmsTasks[12]
  await act(async () => { await vi.advanceTimersByTimeAsync(4500) }); await settle()
  expect(document.querySelector('.dt-taskview')).toBeNull()
  expect(text()).toContain(zh.pmsIntro)
})
