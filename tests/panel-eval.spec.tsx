// @vitest-environment jsdom
// The Eval status and settings.
import { act } from 'react'
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, settle, all, find, tab, click, type, text, field, openPage } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
it('opens the Decisions under Policy from the flow line with their reasons, Decisions that start work first, filterable by kind',
  async () => {
  await mount()
  await openPage(zh, 'eval')
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.eval'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen')).toBe(true)
  expect(text()).toContain(zh['reason.explicitRouted'])
  // The window of the log is the operator's choice: the last day, or every Decision kept.
  await click(zh.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=accept,reopen&window=24h')).toBe(true)
  await click(zh.stop)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=stop&window=24h')).toBe(true)
  expect(text()).toContain('@bot 修一下')
  await click(zh['decision.ignore'])
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore&window=24h')).toBe(true)
  expect(text()).toContain(zh.none)
  await click(zh.lastDayOnly)
  expect(server.requests.some(request => request.path === 'decisions?limit=30&kind=ignore')).toBe(true)
})

it('keeps a Policy draft across remounts, and merges another save into it sender by sender and rule by rule', async () => {
  const addUser = async () => {
    await click(all('.dt-part button').find(button => button.textContent === '添加')!)
    const row = all('.dt-part .dt-rows-item').at(-1)!
    await type(row.querySelector<HTMLInputElement>('input[aria-label="open_id"]')!,
      'ou_newperson'); await type(row.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '新人')
  }
  await mount()
  await openPage(zh, 'eval')
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect(all('.dt-subtab').map(tab => tab.textContent)).toEqual(['飞书', 'Redmine', 'Gerrit'])
  await addUser()
  expect(text()).toContain(zh.draftKept)
  await remount()
  expect(text()).toContain(zh.draftRestored)
  expect(all('.dt-part .dt-rows-item')).toHaveLength(2)
  // Someone else renames a rule and allows another sender meanwhile: the draft keeps its own sender and takes both of theirs.
  const { policy } = server.settings
  server.settings = { ...server.settings, policy: { ...policy, rules: [{ ...policy.rules[0]!, name: '文案' }],
    sources: { ...policy.sources, feishu: { ...policy.sources.feishu!, allowed: [...policy.sources.feishu!.allowed, { id: 'ou_bob',
      name: 'Bob' }] } } } }
  server.revisions.policy = 4
  await click(zh.save)
  expect(text()).toContain(zh.saveMerged)
  await type(all('.dt-part input[aria-label="名字"]').at(-2) as HTMLInputElement, '新同事')
  expect(text()).not.toContain(zh.saveMerged)
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.allowed).toEqual([{ id: 'ou_alice', name: 'Alice' }, { id: 'ou_newperson', name: '新同事' },
    { id: 'ou_bob', name: 'Bob' }])
  expect(server.settings.policy.rules.map(rule => rule.name)).toEqual(['文案'])
  expect(sessionStorage.getItem('dsh-superagent/draft/master/policy')).toBeNull()
})

it('keeps the Policy to its rules and each Source\'s part, in that Source\'s own identities', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  // Auto-merge and its threshold are prompt text, and no Source's settings sit in the Policy core.
  for (const gone of ['自动合并', '行数阈值', '成员', '计入策略版本']) expect(text()).not.toContain(gone)
  expect(all('.dt-lv').map(item => item.textContent)[0]).toBe('策略版本 abcdef12')
  expect(text()).toContain('名单内的人 @ 机器人或私聊机器人，总是明确的请求')
  await click(find(zh['source.redmine'], '.dt-subtab'))
  // Redmine admits by relation: it keeps no sender list, only the explicit-request description and its admission table.
  expect(text()).toContain('任何 Redmine 账号把事务指派给智能体，或在事务或讨论里 @ 它的账号；不设名单，谁发起都可以。')
  expect(all('.dt-part .dt-rows-item')).toHaveLength(0)
})

it('opens the rule list for an invalid field inside it only', async () => {
  await mount()
  await openPage(zh, 'eval')
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  const openRows = () => all('.dt-disclosure[data-open]').length
  await act(async () => { field(zh.evalTimeout).dispatchEvent(new Event('invalid', { bubbles: false })) })
  expect(openRows()).toBe(0)
  await click(all('.dt-rule [data-disclosure-row]')[0]!)
  await act(async () => { all('.dt-rule input')[0]!.dispatchEvent(new Event('invalid')) })
  expect(openRows()).toBe(all('.dt-rule').length)
})

it('syncs a Source\'s list from where the Source keeps it, but not while a Policy draft is unsaved', async () => {
  await mount()
  await openPage(zh, 'eval')
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  expect([...all('.dt-part select')[0]!.querySelectorAll('option')].map(option => option.textContent)).toEqual(['不同步', '另一个群', '团队群'])
  await click(find('立即同步', '.dt-part button'))
  expect(server.requests.some(request => request.path === 'policy-sync/feishu' && request.method === 'POST')).toBe(true)
  await type(all('.dt-part select')[0] as HTMLSelectElement, 'oc_other')
  const before = server.requests.length
  await click(find('立即同步', '.dt-part button'))
  expect(document.querySelector('.dt-toast')?.textContent).toBe(zh.syncNeedsSave)
  expect(server.requests.slice(before).some(request => request.path.startsWith('policy-sync'))).toBe(false)
})

it('adds, copies, renames, disables and deletes rules in Policy without touching Eval', async () => {
  await mount()
  await openPage(zh, 'eval')
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await click(zh.addRule)
  await type(field<HTMLInputElement>(zh.ruleName), '文档')
  await type(field<HTMLTextAreaElement>(zh.ruleInstruction), '修复失效链接')
  await click(zh.duplicate)
  expect(all('.dt-rule').map(rule => rule.querySelector('[data-disclosure-row]')!.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('文档 副本')]))
  await click('启用规则：文案修改')
  const removeButtons = all('button').filter(button => button.textContent === '删除')
  await click(removeButtons.at(-1)!)
  await click(zh.save)
  expect(server.settings.policy.rules.map(rule => [rule.name, rule.enabled])).toEqual([['文案修改', false], ['文档', true]])
  expect(server.requests.filter(request => request.method === 'PUT').map(request => request.path)).toEqual(['settings/policy'])
})

it('shows the current Policy version once, explains what makes it up, and opens a Mandate\'s version in the Policy history', async () => {
  await mount()
  await openPage(zh, 'eval')
  await click(find(zh['tab.settings'], '.dt-status-head button'))
  await settle()
  expect(all('.dt-lv')[0]!.textContent).toBe('策略版本 abcdef12')
  expect(all('.dt-info').map(tip => tip.getAttribute('aria-label')).join('\n')).toContain('策略版本由接单规则、各来源上的策略和评估的接单模式决定')
  expect(all('.dt-tag').filter(tag => tag.textContent === '计入策略版本')).toHaveLength(0)
  await openPage(zh, 'execution')
  await click('修复回归')
  await click('abcdef12')
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
  await settle()
  // The history opens at the save that made the version, and lists versions that Source saves made too.
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('生成策略版本 abcdef12')
  expect(text()).toContain('生成策略版本 98765432')
})

it('sets the Feishu admission table per receiving scope, offering only the cells a scope can receive, and warns when anyone may originate work', async () => {
  server.settings = { ...server.settings, sources: { ...server.settings.sources, feishu: { enabled: true, config: { cli: 'lark-bot',
    chats: [{ chatId: 'oc_team', listen: 'all' }, { chatId: 'oc_other', listen: 'mentions' }], directMessages: true,
      otherChats: 'none' } } } }
  await mount()
  await click(tab(zh['tab.settings']))
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  // Chats receiving every message have all three cells; @-only chats only the mention cell; other chats nothing while not received.
  expect(rows).toEqual([['团队群', 3], ['另一个群', 1], ['其他群', 0], ['私聊', 1]])
  const cell = field<HTMLSelectElement>('团队群 · 名单外 · 点名智能体')
  expect(cell.value).toBe('ignore')
  await type(cell, 'explicit')
  // The warning is an icon in a slot every cell reserves, with the text on hover, so the table does not move.
  expect(document.querySelector('.dt-admission .dt-info-warn')?.getAttribute('aria-label')).toBe(zh.admissionAnyoneWarning)
  expect(all('.dt-admission-slot')).toHaveLength(5)
  // A message not addressed to the bot cannot be an explicit request.
  expect([...field<HTMLSelectElement>('团队群 · 名单外 · 未 @').options].map(option => option.value)).toEqual(['inferred', 'ignore'])
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.admission).toEqual({ oc_team: { unlistedAddressed: 'explicit' } })
})

it('lists each Source\'s bots next to its people, and keeps Redmine to its admission table without a list', async () => {
  await mount()
  await click(tab(zh['tab.settings']))
  // The Redmine Source receives only what is addressed to the agent until a switch opens a scope of the project.
  const redmine = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'Redmine')!
  expect([...redmine.querySelectorAll('.dt-switch-row')].map(row => row.textContent)).toEqual(['接收没有 @ 智能体的新事务', '接收没有 @ 智能体的讨论'])
  expect([...redmine.querySelectorAll('[role="switch"]')].slice(1).map(item => item.getAttribute('aria-checked'))).toEqual(['false', 'false'])
  await click(find(zh['term.eval'], '.dt-settings-link'))
  const lists = () => all('.dt-part > .dt-field .dt-subhead .dt-field-head').map(head => head.firstChild?.textContent)
  const list = (label: string) => all('.dt-part > .dt-field').find(item => item.textContent?.startsWith(label))!
  const add = async (label: string) => {
    await click([...list(label).querySelectorAll('button')].find(button => button.textContent === zh.addRow)!)
    return [...list(label).querySelectorAll('.dt-rows-item')].at(-1)!
  }
  expect(lists()).toEqual(['能发起工作的飞书用户', '消息可以成为候选的机器人'])
  const bot = await add('消息可以成为候选的机器人')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="App ID 或 open_id"]')!, 'cli_reviewer')
  await type(bot.querySelector<HTMLInputElement>('input[aria-label="名字"]')!, '评审机器人')
  await click(find(zh['source.redmine'], '.dt-subtab'))
  // A relation Source keeps no list: every row has a spoke-to cell that is always explicit, and a cell per observed scope.
  expect(lists()).toEqual([])
  const rows = () => all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelector('.dt-admission-scope small')?.textContent, row.querySelectorAll('select').length])
  expect(rows()).toEqual([['新事务', '仅指派或 @', 0], ['事务下的讨论', '仅指派或 @', 0]])
  expect(all('.dt-admission tbody td').map(cell => cell.textContent)).toContain('总是明确的请求')
  await click(zh.save)
  expect(server.settings.policy.sources.feishu!.bots).toEqual([{ id: 'cli_reviewer', name: '评审机器人' }])
  // The retired Redmine list is dropped by the save instead of being kept.
  expect(server.settings.policy.sources.redmine).toEqual({ admission: {} })
})

it('shows the Redmine Source\'s switches for what it receives across the project, and the admission rows they open, in English', async () => {
  server.settings.sources.redmine = { ...server.settings.sources.redmine!, config: { ...server.settings.sources.redmine!.config,
    observeIssues: true } }
  await mount(en)
  await click(tab(en['tab.settings']))
  const redmine = all('.dt-card').find(card => card.querySelector('.dt-card-title')?.textContent === 'Redmine')!
  expect([...redmine.querySelectorAll('.dt-switch-row')].map(row => [row.textContent, row.querySelector('[role="switch"]')
    ?.getAttribute('aria-checked')])).toEqual([['Receive new issues that do not mention the agent', 'true'],
    ['Receive discussion that does not mention the agent', 'false']])
  await click(find('Receive discussion that does not mention the agent', '[role="switch"]'))
  await act(async () => { redmine.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(server.settings.sources.redmine!.config).toMatchObject({ observeIssues: true, observeJournals: true })
  await click(find(en['term.eval'], '.dt-settings-link'))
  await click(find(en['source.redmine'], '.dt-subtab'))
  const rows = all('.dt-admission tbody tr').map(row => [row.querySelector('.dt-admission-scope')!.firstChild?.textContent,
    row.querySelectorAll('select').length])
  expect(rows).toEqual([['New issues', 1], ['Issue discussion', 1]])
  // A received scope offers the cell of a message that does not speak to the agent.
  expect(field('New issues · Not on the list · no mention')).toBeTruthy()
  expect(all('.dt-admission thead th').map(cell => cell.textContent)).toEqual([en.admissionScope, en.admissionRelationAddressed,
    en.admissionRelationUnaddressed])
})
