// @vitest-environment jsdom
// The Workbench: the assigned Redmine tasks, their conversation with the superagent, and the local list actions.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, settle, all, click, tab, text, type } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
const openTab = async (dictionary = zh) => { await mount(dictionary); await click(dictionary['tab.pms']) }
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
  expect(all('[role="tab"]').map(item => item.textContent)).toEqual(['概览', '工作台', '来源', '触发', '评估', '执行', '设置'])
  expect(all('.dt-inbox-filters .dt-pill').map(item => item.textContent)).toEqual([`${zh.pmsFilterActive}2`, `${zh.pmsFilterArchived}1`])
  expect(all('.dt-task-open').map(item => item.textContent)).toEqual([
    expect.stringContaining('SDK pagination skips the first page'), expect.stringContaining('CLI --timeout is ignored')])
  expect(all('.dt-task-ticket').map(item => item.textContent)).toEqual([zh.pmsTicket.replace('{title}', 'Fix SDK pagination')])
  // The archived filter shows the archived task only, and the active filter brings the inbox back.
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh.pmsFilterArchived))!)
  expect(all('.dt-task-open').map(item => item.textContent)).toEqual([expect.stringContaining('Old demo issue')])
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh.pmsFilterActive))!)
  expect(all('.dt-task-open')).toHaveLength(2)
  expect(text()).toContain(zh.pmsSelectTask)
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
  expect(all('.dt-chat-link').map(link => link.getAttribute('href'))).toContain('http://redmine.test/issues/12#change-41')
  // The ticket that works the task, its change and its session.
  expect(document.querySelector('.dt-taskview-ticket')?.textContent).toContain('Fix SDK pagination')
  expect(document.querySelector('.dt-taskview-ticket')?.textContent).toContain(zh.pmsChange.replace('{number}', '1003'))
  await click([...document.querySelectorAll<HTMLButtonElement>('.dt-taskview-ticket button')].find(item => item.textContent === zh.openSession)!)
  expect(server.opened).toEqual(['worker-ticket-1'])
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
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh.pmsFilterArchived))!)
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
  expect(server.pms.tasks.map(task => task.id)).toEqual([13])
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
  await click(all('.dt-pill').find(item => item.textContent?.startsWith(zh.pmsFilterArchived))!)
  await openTask('Old demo issue')
  expect(document.querySelector('.dt-taskview-subject')?.textContent).toBe('Old demo issue')
  await click(zh.pmsBackToList)
  expect(all('.dt-pill').find(item => item.textContent?.startsWith(zh.pmsFilterArchived))?.getAttribute('aria-pressed')).toBe('true')
  expect(all('.dt-task-open')).toHaveLength(1)
})

it('words the inbox in English when the panel speaks English', async () => {
  await openTab(en)
  expect(document.querySelector('.dt-page-title h2')?.textContent).toBe(en.pmsTitle)
  expect(all('.dt-inbox-filters .dt-pill').map(item => item.textContent)).toEqual([`${en.pmsFilterActive}2`, `${en.pmsFilterArchived}1`])
  await openTask('SDK pagination skips the first page')
  expect(all('.dt-chat-author').slice(0, 3).map(item => item.textContent)).toEqual(['Team Leader', en.pmsAgent, en.pmsYou])
  expect(composer()?.getAttribute('placeholder')).toBe(en.pmsReplyPlaceholder)
  expect(tab(en['tab.overview']).getAttribute('aria-selected')).toBe('false')
})
