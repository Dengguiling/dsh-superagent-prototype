import { describe, expect, it, vi } from 'vitest'
import { CliError, Commands, commandError } from '../src/infra/commands.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { feishuChannel } from '../src/sources/feishu-trigger.ts'
import { gerritKind } from '../src/sources/gerrit.ts'
import { gerritChannel } from '../src/sources/gerrit-trigger.ts'
import { redmineKind } from '../src/sources/redmine.ts'
import { redmineChannel } from '../src/sources/redmine-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import { key, type OutboundMessage } from '../src/core/index.ts'
import { testDeployment, testGerrit, testRedmine } from './fixtures/deployment.ts'
const sources = new SourceRegistry(() => SettingsSchema.parse({}))
sources.register(feishuKind); sources.register(redmineKind); sources.register(gerritKind)
const send = (commands: Commands, message: OutboundMessage) => sources.send(message, commands)
const deployment = testDeployment({ redmine: testRedmine, gerrit: testGerrit })
const reply = { id: 'stable-operation', channel: redmineChannel(8), text: 'Done', kind: 'reply' as const }
/** The Redmine issue of a fixture, as the API returns it. */
const issue = (fields: Record<string, unknown> = {}) => ({
  id: 8, subject: 'Fix the login', description: 'The login button does nothing.', status: { id: 1, name: 'New' },
  author: { id: 1, name: 'Alice' }, journals: [], ...fields,
})
/** The Gerrit change of a fixture, as the API returns it. */
const change = (fields: Record<string, unknown> = {}) => ({
  _number: 8, id: 'demo~master~I1', project: 'demo', branch: 'main', subject: 'Fix the login', status: 'NEW',
  owner: { username: 'agent' }, current_revision: 'rev1', revisions: { rev1: { ref: 'refs/changes/08/8/1', commit: { message: 'Fix the login' } } },
  messages: [], ...fields,
})
describe('account-isolated operations', () => {
  it('runs a command with its arguments untouched, so shell metacharacters in them mean nothing', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const output = await commands.run('echo', ['body=`whoami` $(touch x)'])
    expect(output.trim()).toBe('body=`whoami` $(touch x)')
  })
  it('runs every command with its environment over the process environment, where undefined removes a variable', async () => {
    process.env.OPERATOR_MARKER = 'personal'
    try {
      const output = await new Commands(() => deployment, { OPERATOR_MARKER: undefined, DSH_SUPERAGENT_PROBE: 'agent' }, new AbortController().signal).run('env', [])
      expect(output).toContain('DSH_SUPERAGENT_PROBE=agent')
      expect(output).not.toContain('OPERATOR_MARKER=')
    } finally { delete process.env.OPERATOR_MARKER }
  })
  it('refuses Feishu commands when the deployment has no Feishu bot', async () => {
    await expect(new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal).lark(['im', '+chat-list'])).rejects.toThrow('The Feishu Source has no working bot CLI')
  })
  it('refuses the Redmine and Gerrit accounts of a deployment that has none', () => {
    const commands = new Commands(() => testDeployment({ feishu: undefined }), {}, new AbortController().signal)
    expect(() => commands.redmine).toThrow('This installation has no Redmine account')
    expect(() => commands.gerrit).toThrow('This installation has no Gerrit account')
  })
  it('reconciles an uncertain Redmine send with its stable marker', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const http = vi.spyOn(commands, 'http').mockResolvedValue({ status: 200, body: JSON.stringify({ issue: issue({ journals: [{ id: 3, notes: '<!-- dsh-superagent:stable-operation -->' }] }) }) })
    expect(await send(commands, reply)).toBe('sent')
    // The note is already on the issue, so nothing is written again.
    expect(http.mock.calls.filter(call => (call[1] as { method?: string }).method === 'PUT')).toHaveLength(0)
  })
  it('adds the reply as a journal on the issue, with the marker that keeps a retry from writing twice', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const http = vi.spyOn(commands, 'http').mockResolvedValue({ status: 200, body: JSON.stringify({ issue: issue() }) })
    expect(await send(commands, reply)).toBe('sent')
    const note = http.mock.calls.at(-1)!
    expect(note[0]).toBe('http://redmine.test/issues/8.json')
    expect((note[1] as { method?: string }).method).toBe('PUT')
    expect(JSON.parse((note[1] as { body: string }).body)).toEqual({ issue: { notes: expect.stringContaining('Done'), private_notes: false } })
    expect((note[1] as { body: string }).body).toContain('dsh-superagent:stable-operation')
  })
  it('uses Feishu bot identity and one idempotency key on retries', async () => {
    const commands = new Commands(() => deployment, {}, new AbortController().signal); const run = vi.spyOn(commands,'run').mockResolvedValue('{"ok":true,"data":{}}')
    await send(commands, { ...reply, channel: feishuChannel('oc_1', 'om_1') })
    expect(run.mock.calls[0]![1]).toEqual(expect.arrayContaining(['--as','bot','--idempotency-key','stable-operation','--message-id','om_1']))
  })
})

it('reports Feishu failures with their code and without command arguments', () => {
  const membership = commandError({stderr:'[page 1] fetching...\n'+JSON.stringify({error:{code:232011,message:'operator is not in the chat'}})})
  expect(membership).toMatchObject({ message: 'operator is not in the chat (232011)', code: 232011 })
  expect(commandError({stderr:JSON.stringify({error:{code:999,message:'scope missing'}})}).message).toBe('scope missing (999)')
})
describe('Channels', () => {
  const commands = () => new Commands(() => deployment, {}, new AbortController().signal)
  const feishu = { ...reply, channel: feishuChannel('oc_1', 'om_1') }
  const lark = (code: number, message: string) => commandError({ stderr: JSON.stringify({ error: { code, message } }), code: 1 })
  it('drop a Feishu reply to a recalled message or one Feishu no longer finds, and say how to add the bot to a chat', async () => {
    const value = commands()
    const run = vi.spyOn(value, 'run')
    for (const [code, message] of [[230011, 'The message is recalled'], [230001, 'message not found'], [231003,
      'The message is withdrawn']] as const) {
      run.mockRejectedValueOnce(lark(code, message))
      expect(await send(value, feishu)).toBe('gone')
    }
    run.mockRejectedValueOnce(lark(232011, 'operator is not in the chat'))
    const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
    await expect(send(value, feishu)).rejects.toThrow(hint)
    run.mockRejectedValueOnce(lark(99991400, 'rate limited'))
    await expect(send(value, feishu)).rejects.toThrow('rate limited (99991400)')
  })
  it('keep a Feishu reply whose command timed out for a retry, whatever its text says', async () => {
    const value = commands()
    const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '', message: 'Command failed: lark-bot --markdown withdrawn' }
    vi.spyOn(value, 'run').mockRejectedValueOnce(commandError(timedOut, 'lark-bot'))
    await expect(send(value, { ...feishu, text: 'The change was withdrawn' })).rejects.toThrow('lark-bot timed out after 90 s')
  })
  it('drop a Redmine reply to an issue that is gone or locked, and keep the others for a retry', async () => {
    const value = commands()
    const http = vi.spyOn(value, 'http')
    for (const status of [404, 410, 422]) {
      http.mockResolvedValueOnce({ status, body: '{"errors":["Not found"]}' })
      expect(await send(value, reply)).toBe('gone')
    }
    // Redmine refuses a wrong API key (401, 403) for a while, and a server error may pass; both are retried.
    for (const status of [401, 500]) {
      http.mockResolvedValueOnce({ status, body: '{}' })
      await expect(send(value, reply)).rejects.toThrow()
    }
  })
  it('drop a Gerrit reply to a change that is gone or already merged, and keep the others for a retry', async () => {
    const value = commands()
    const http = vi.spyOn(value, 'http')
    for (const status of [404, 410, 409]) {
      http.mockResolvedValueOnce({ status, body: '{}' })
      expect(await send(value, { ...reply, channel: gerritChannel(8, 'demo') })).toBe('gone')
    }
    // Gerrit refuses the credentials (401, 403) for a while, and a server error may pass; both are retried.
    for (const status of [401, 500]) {
      http.mockResolvedValueOnce({ status, body: '{}' })
      await expect(send(value, { ...reply, channel: gerritChannel(8, 'demo') })).rejects.toThrow()
    }
  })
  it('review the current revision of a change, and keep the marker that keeps a retry from writing twice', async () => {
    const value = commands()
    const http = vi.spyOn(value, 'http').mockResolvedValue({ status: 200, body: JSON.stringify(change()) })
    expect(await send(value, { ...reply, channel: gerritChannel(8, 'demo') })).toBe('sent')
    const review = http.mock.calls.at(-1)!
    expect(review[0]).toBe('http://gerrit.test:8080/a/changes/8/revisions/rev1/review')
    expect((review[1] as { method?: string }).method).toBe('POST')
    expect((review[1] as { body: string }).body).toContain('dsh-superagent:stable-operation')
  })
  it('link each address to its page with its label', () => {
    const links = { redmine: deployment.redmine!.baseUrl, gerrit: deployment.gerrit!.httpUrl, feishu: deployment.feishu! }
    expect(redmineKind.channel!.link(redmineChannel(8).address, links)).toEqual({ url: 'http://redmine.test/issues/8',
      label: { zh: 'Redmine 事务 #8', en: 'Redmine issue #8' } })
    expect(gerritKind.channel!.link(gerritChannel(8, 'demo').address, links))
      .toEqual({ url: 'http://gerrit.test:8080/#/c/demo/+/8', label: { zh: 'Gerrit 变更 8', en: 'Gerrit change 8' } })
    expect(redmineKind.channel!.link(redmineChannel(8).address, {}).url).toBe('')
    const message = feishuChannel('oc_1', 'om_1').address
    expect(feishuKind.channel!.link(message, links)).toEqual({ url: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_1',
      label: { zh: '飞书消息', en: 'Feishu message' }, triggerId: key('feishu', 'om_1') })
  })
})
it('says how to add the bot to a chat when Feishu answers that it is not a member, and keeps the code', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const membership = JSON.stringify({ error: { code: 232011, message: 'operator is not in the chat' } })
  const run = vi.spyOn(commands, 'run').mockRejectedValueOnce(commandError({ stderr: membership, code: 1 }))
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011, exitCode: 1 })
  run.mockResolvedValueOnce(JSON.stringify({ ok: false, error: { code: 232011, message: 'operator is not in the chat' } }))
  await expect(commands.lark(['im', '+chat-members-list'])).rejects.toMatchObject({ message: hint, code: 232011 })
})
it('names only the program and how it ended when a command prints no diagnostics, never its arguments', async () => {
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const secret = 'secret reply text'
  await expect(commands.run('sh', ['-c', 'exit 3', secret])).rejects.toMatchObject({ message: 'sh exited with code 3', exitCode: 3 })
  await expect(commands.run('sh', ['-c', 'kill -9 $$', secret])).rejects.toMatchObject({ message: 'sh was stopped by SIGKILL' })
  await expect(commands.run('/no/such/program', ['secret reply text'])).rejects.toMatchObject({ message: 'program could not run: ENOENT' })
  // Timeouts kill the child with SIGTERM; Node's default error message would echo every argument.
  const timedOut = { killed: true, signal: 'SIGTERM', code: null, stderr: '',
    message: 'Command failed: /path/lark-bot im +messages-reply --markdown withdrawn' }
  expect(commandError(timedOut, '/path/lark-bot')).toMatchObject({ message: 'lark-bot timed out after 90 s' })
  expect(String(commandError(timedOut, '/path/lark-bot'))).not.toContain('withdrawn')
})
it('reports failures as CliError with the code the CLI names and the exit status', async () => {
  const notFound = commandError({ stderr: 'redmine-cli: Not Found (HTTP 404)\n', code: 1 })
  expect(notFound).toBeInstanceOf(CliError)
  expect(notFound).toMatchObject({ message: 'redmine-cli: Not Found (HTTP 404)', code: 404, exitCode: 1 })
  expect(commandError({ stderr: JSON.stringify({ error: { code: 230011, message: 'The message is recalled' } }),
    code: 1 })).toMatchObject({ message: 'The message is recalled (230011)', code: 230011 })
  // A cancelled command stays an AbortError so callers can distinguish cancellation from failure.
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError', stderr: '' })
  expect(commandError(aborted)).toBe(aborted)
  const controller = new AbortController()
  const running = new Commands(() => deployment, {}, controller.signal).run('sleep', ['5'])
  controller.abort()
  await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  vi.spyOn(commands, 'run').mockResolvedValue(JSON.stringify({ ok: false, error: { code: 231003, message: 'message not found' } }))
  await expect(commands.lark(['im', '+messages-reply'])).rejects.toMatchObject({ message: 'message not found (231003)', code: 231003 })
})

it('stops a running command when the signal of its work aborts, or the lifetime, and leaves the other work running', async () => {
  const lifetime = new AbortController(), work = new AbortController()
  const commands = new Commands(() => deployment, {}, lifetime.signal)
  const started = Date.now()
  const running = commands.withSignal(work.signal).run('sleep', ['5'])
  work.abort()
  await expect(running).rejects.toThrow()
  // Only commands bound to the aborted work signal stop.
  expect(await commands.run('echo', ['still'])).toBe('still\n')
  const other = commands.withSignal(new AbortController().signal).run('sleep', ['5'])
  lifetime.abort()
  await expect(other).rejects.toThrow()
  expect(Date.now() - started).toBeLessThan(4000)
})
