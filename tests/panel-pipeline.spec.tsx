// @vitest-environment jsdom
// The pipeline of the work: the stations, and the system problems below the chart.
import { expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { usePanel, mount, remount, all, find, tab, click, text, openPage } from './fixtures/panel.tsx'
import { server, droppedReply, threadSummary, ticketSummary } from './fixtures/panel-server.ts'

usePanel()
it('shows the pipeline of the work on its own page, every station counting the work it holds', async () => {
  await mount()
  // Three destinations; each group holds one page, so there is no second row of tabs anywhere.
  expect(all('.dt-grouptabs [role="tab"]').map(tab => tab.textContent)).toEqual(['任务工作台', '流水线', '设置'])
  expect(document.querySelector('.dt-pagetabs')).toBeNull()
  // The rail stands above every page: the live state, the work that needs a person, the load and the switch that stops it.
  expect(document.querySelector('.dt-rail')?.getAttribute('data-state')).toBe('attention')
  expect(document.querySelector('.dt-rail-state')?.textContent).toBe(zh.pmsAttention)
  expect(document.querySelector('.dt-rail-waiting')?.textContent).toBe(`1${zh.railWaiting}`)
  expect(all('.dt-rail-metric').map(item => item.textContent)).toEqual([`0${zh.queuedLabel}`, `2/3${zh.railWorkerSlots}`])
  const readsWhenOpening = server.requests.filter(request => request.path === 'pms' && request.method === 'GET').length
  await click(tab(zh['tab.group.pipeline']))
  // The flow group has one page too: the chart is the map, and the section it points at appears below it.
  expect(document.querySelector('.dt-pagetabs')).toBeNull()
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.source'])
  // The panel reads the task inbox once for the whole panel (see the provider): opening the flow page reads it again
  // no more than the poll already does, so the chart and the rail draw from one source.
  const readInbox = () => server.requests.filter(request => request.path === 'pms' && request.method === 'GET').length
  expect(readInbox()).toBe(readsWhenOpening)
  // Every stage of the flow, with what it counts and the window it covers.
  expect(all('.dt-station-label').map(item => item.textContent)).toEqual(['来源', '触发', '评估中', '工单', '执行中', '等人', '完成'])
  expect(all('.dt-station-count').map(item => item.textContent)).toEqual(['2', '2', '1', '3', '1', '1', '2'])
  // Each station says what it counts and the window it covers, so two stations are never read as the same thing.
  expect(all('.dt-station-unit').map(item => item.textContent)).toEqual(['来源', '会话', '会话', '工单', '工单', '工单', '工单'])
  expect(all('.dt-station-window').map(item => item.textContent)).toEqual(['现在', '全部', '此刻', '未结束', '代理在做', '需要你处理', '过去 24 小时'])
  // Every station opens the section that holds the work it counts, below the chart.
  expect(all('.dt-station-open')).toHaveLength(7)
  await click(all('.dt-station-open').at(-3)!)
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.execution'])
  // The chart stays where it is: the section appears below it, not on another page.
  expect(all('.dt-station-label')).toHaveLength(7)
})
it('opens the section every station names, below the chart, and counts the same kind of item the list holds', async () => {
  await mount()
  await click(tab(zh['tab.group.pipeline']))
  const section = () => document.querySelector('.dt-status-title')?.textContent
  // 来源 → the Sources, the section the station is named after.
  await click(all('.dt-station-open')[0]!)
  expect(section()).toBe(zh['tab.source'])
  await click(tab(zh['tab.group.pipeline']))
  // 触发 → the Threads, the section the station is named after.
  await click(all('.dt-station-open')[1]!)
  expect(section()).toBe(zh['tab.trigger'])
  expect(all('.dt-station-label')).toHaveLength(7)
  await click(tab(zh['tab.group.pipeline']))
  // 评估中 → the Threads under evaluation, not the Decision log of the Eval section.
  await click(all('.dt-station-open')[2]!)
  expect(section()).toBe(zh['tab.trigger'])
  expect(find(zh['threadFilter.evaluating'], '.dt-pill').getAttribute('aria-pressed')).toBe('true')
  await click(tab(zh['tab.group.pipeline']))
  // 执行中 → the Tickets the Executor works on, not the workers it runs.
  await click(all('.dt-station-open')[4]!)
  expect(section()).toBe(zh['tab.execution'])
  expect(find(zh['ticketFilter.working'], '.dt-pill').getAttribute('aria-pressed')).toBe('true')
  await click(tab(zh['tab.group.pipeline']))
  // 完成 → the Tickets ended in the last day, the ones the station counts.
  server.tickets.ended = [ticketSummary({ id: 't-recent', title: '昨天结束的工单', state: 'ended', updatedAt: new Date().toISOString() },
    { stage: 'ended' }), ticketSummary({ id: 't-old', title: '上个月结束的工单', state: 'ended', updatedAt: '2026-09-01T00:00:00Z' },
    { stage: 'ended' })]
  await click(all('.dt-station-open')[6]!)
  expect(section()).toBe(zh['tab.execution'])
  expect(find(zh['ticketFilter.ended'], '.dt-pill').getAttribute('aria-pressed')).toBe('true')
  expect(find(zh.endedLastDayOnly, '.dt-pill').getAttribute('aria-pressed')).toBe('true')
  expect(all('.dt-row-title').map(row => row.textContent)).toEqual(['昨天结束的工单'])
})
it('re-evaluates or dismisses an unjudged Eval from the problem list', async () => {
  await mount()
  await openPage(zh, 'pipeline')
  await click(zh.requeue)
  expect(server.requests.some(request => request.path === 'triggers/e3/requeue' && request.method === 'POST')).toBe(true)
  await click(zh.dismiss)
  expect(server.requests.some(request => request.path === 'decisions/u1/dismiss' && request.method === 'POST')).toBe(true)
  expect(server.requests.filter(request => request.path === 'overview').length).toBeGreaterThan(2)
})
it('opens the Thread of an unjudged Eval at its Trigger from the problem list', async () => {
  await mount()
  await openPage(zh, 'pipeline')
  await click('评估未完成：这个文案好奇怪')
  expect(server.requests.some(request => request.path.startsWith('threads/feishu:oc_1:om_root'))).toBe(true)
  expect(document.querySelector('.dt-highlight')?.textContent).toContain('message e3')
})
it('counts the Triggers of the last day on the Source page, and the filtered ones with them', async () => {
  await mount()
  await click(tab(zh['tab.group.pipeline']))
  // The chart counts the Sources it lists, so the number on it and the rows below it agree.
  expect(all('.dt-station-count')[0]?.textContent).toBe('2')
  // The filtered ones have no Thread, so the Source page is where they are listed.
  await openPage(zh, 'source')
  expect(text()).toContain('24 小时到达 12')
  await click(zh.sourceFilteredTitle)
  expect(text()).toContain('looks wrong')
  expect(text()).toContain(zh['reason.source_disabled'])
})
it('shows paused processing as a system problem with its resume action, and says so on the Policy records', async () => {
  server.settings = { ...server.settings, paused: true }
  await mount()
  await openPage(zh, 'pipeline')
  expect(text()).toContain(zh.problemPaused)
  await click(tab(zh['tab.group.pipeline']))
  await openPage(zh, 'eval')
  expect(text()).toContain(zh.evalRecordsPaused)
  await click(zh.resumeWhere)
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(zh['tab.execution'])
  await openPage(zh, 'pipeline')
  await click(find(zh.resumeProcessing, '.dt-att button'))
  await click(zh.confirm)
  expect(server.requests.find(request => request.path === 'executor/pause')).toMatchObject({ method: 'POST', body: { paused: false } })
})
it('offers the step that fixes a settings problem as a button on the pipeline page', async () => {
  // Nothing can originate work only when no relation Source is enabled and every list is empty as well.
  const off = (id: 'feishu' | 'redmine' | 'gerrit') => ({ ...server.settings.sources[id]!, enabled: false })
  server.settings = { ...server.settings, policy: { ...server.settings.policy, sources: { feishu: { allowed: [], admission: {} },
    redmine: { allowed: [], admission: {} }, gerrit: { allowed: [], admission: {} } } },
    sources: { feishu: off('feishu'), redmine: off('redmine'), gerrit: off('gerrit') } }
  await mount()
  await openPage(zh, 'pipeline')
  expect(text()).toContain(zh.problemNoAllowed)
  await click(zh.actionAddAllowed)
  expect(tab(zh['tab.settings']).getAttribute('aria-selected')).toBe('true')
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['term.eval'])
})
it('counts the messages not sent in the last day on the Source page, and shows none when there are none', async () => {
  await mount()
  await click(tab(zh['tab.group.pipeline']))
  await openPage(zh, 'source')
  expect(text()).not.toContain(zh.sourceDroppedTitle)
  server.dropped = [droppedReply('m2', 1, 'feishu', 'channelGone'), droppedReply('m1', 2, 'redmine', 'channelIgnored'), droppedReply('m0',
    30, 'feishu', 'channelGone')]
  await remount()
  await click(tab(zh['tab.group.pipeline']))
  await openPage(zh, 'source')
  // One message per Source fell out of the last day: the one sent 30 hours ago.
  expect(all('.dt-row .dt-count').map(item => item.textContent)).toEqual(['1', '1'])
  const disclosure = all('[data-disclosure-row]').find(item => item.textContent?.includes(zh.sourceDroppedTitle))!
  await click(disclosure)
  expect(all('.dt-row-title').map(item => item.textContent).length).toBeGreaterThan(0)
})
it('names a failing part of dsh-superagent itself by its label', async () => {
  server.health = { launch: { state: 'error', detail: 'spawn failed' }, relay: { state: 'ready', detail: 'Nothing waiting' } }
  await mount()
  await openPage(zh, 'pipeline')
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toContain(zh.problemRuntime.replace('{name}', zh['health.launch']))
  expect(text()).toContain('spawn failed')
})
it('shows the pipeline in English', async () => {
  await mount(en)
  expect(all('.dt-grouptabs [role="tab"]').map(tab => tab.textContent)).toEqual(['Task workbench', 'Pipeline', 'Settings'])
  expect(document.querySelector('.dt-rail-state')?.textContent).toBe(en.pmsAttention)
  await click(tab(en['tab.group.pipeline']))
  expect(document.querySelector('.dt-pagetabs')).toBeNull()
  expect(document.querySelector('.dt-status-title')?.textContent).toBe(en['tab.source'])
  expect(all('.dt-station-label').map(item => item.textContent)).toEqual(['Sources', 'Triggers', 'Evaluating', 'Tickets', 'Working', 'Waiting', 'Done'])
  // The system problems are listed below the chart, each with the way to it.
  expect(all('.dt-section-title').map(title => title.textContent)).toEqual([`${en.problems}2`])
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['Feishu Source failing', 'Eval unavailable: 这个文案好奇怪'])
})
it('lists the unavailable Evals one by one, without the health entry that counts them as a failure of dsh-superagent', async () => {
  server.health.evals = { state: 'error', detail: '1 Eval(s) unavailable in the last hour without a later judgement' }
  await mount()
  await openPage(zh, 'pipeline')
  expect(all('.dt-cards .dt-att-what').map(item => item.textContent)).toEqual(['飞书 来源异常', '评估未完成：这个文案好奇怪'])
  expect(text()).not.toContain(zh['health.evals'])
})
it('says when no Source is on, an Eval is past its deadline or a message keeps failing, each with the way to it', async () => {
  for (const kind of ['feishu', 'redmine', 'gerrit']) server.settings.sources[kind] = { ...server.settings.sources[kind]!, enabled: false }
  server.threads = [threadSummary({ key: 'redmine:9', title: '#9 迟迟未决', stage: 'evaluating',
    evaluating: { id: 'v9', triggers: 1, strength: 'inferred', startedAt: '2026-08-31T23:58:00Z', deadline: '2026-09-01T00:00:00Z' } })]
  server.failing = [{ id: 'm1', channel: { source: 'redmine', thread: 'redmine:42', address: { issue: '42' } },
    text: '已修复', attempts: 4,
    error: 'HTTP 502 from Redmine' }]
  await mount()
  await openPage(zh, 'pipeline')
  const titles = () => all('.dt-cards .dt-att-what').map(item => item.textContent)
  // The Feishu Source is off, so its error is no problem any more.
  expect(titles()).toEqual([zh.problemNoSource, '评估超时未决定：#9 迟迟未决', '评估未完成：这个文案好奇怪', 'Redmine 回复发送失败（已重试 4 次）'])
  expect(text()).toContain('HTTP 502 from Redmine')
  await click(zh.actionOpenSources)
  expect(document.querySelector('.dt-settings-link[aria-current="page"]')?.textContent).toBe(zh['settingsGroup.source'])
  await openPage(zh, 'pipeline')
  await click('评估超时未决定：#9 迟迟未决')
  expect(server.requests.some(request => request.path.startsWith('threads/redmine:9'))).toBe(true)
})
