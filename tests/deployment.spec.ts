import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, executable, machineOf, resolveFeishuBot, resolveGerrit, resolveRedmine, type Machine, type Probe } from '../src/deployment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
const program = (file: string, body = ''): string => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); return file }
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  `case "$*" in\n  "auth status") echo '${JSON.stringify(status)}' ;;\n  "config strict-mode") echo 'strict-mode: ${mode} (source: profile)' ;;\n  "api GET /open-apis/bot/v3/info --as bot --format ndjson") echo '${JSON.stringify(bot)}' ;;\nesac`
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/** Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. */
const probe: Probe = async argv => (await exec(argv[0]!, argv.slice(1), { env: { PATH: path, HOME: dir } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}/`, join(dir, 'bin'), '/usr/bin', '/bin'].join(':')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'lark-cli'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'ssh://agent@gerrit.test:29418/demo'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('requires only the state directory and reads the editable fields through references', () => {
    expect(() => Config({})).toThrow('stateDir')
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository, repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('setup', () => {
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, redmine: unknown) =>
      expect(resolveRedmine(machine(), redmine)).rejects.toEqual(setupError(place, code, values))
    // The task system needs an address and an API key; the review server needs an address and an account.
    await needs('redmine', 'redmineUrlUnset', {}, { apiKey: 'key' })
    await needs('redmine', 'redmineApiKeyUnset', {}, { baseUrl: 'http://redmine.test' })
    const gerrit = (code: string, config: Record<string, unknown>, values: Record<string, unknown> = {}) =>
      expect(resolveGerrit(machine(), config)).rejects.toEqual(setupError('gerrit', code, values))
    await gerrit('gerritUrlUnset', { sshUrl: 'ssh://agent@gerrit.test:29418' })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Redmine account with its API key, or refuses a wrong one', async () => {
    const answer = (body: unknown, status = 200) => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status })) }
    // An empty configuration means the Source is not used.
    expect(await resolveRedmine(machine(), {})).toBeUndefined()
    answer({ user: { id: 5, login: 'agent', firstname: 'Agent', lastname: 'Bot', mail: 'agent@example.com' } })
    expect(await resolveRedmine(machine(), { baseUrl: 'http://redmine.test/', apiKey: 'key', project: 'demo' }))
      .toEqual({ baseUrl: 'http://redmine.test', apiKey: 'key', id: 5, login: 'agent', name: 'Agent Bot', mail: 'agent@example.com', project: 'demo' })
    answer({}, 401)
    await expect(resolveRedmine(machine(), { baseUrl: 'http://redmine.test', apiKey: 'key' })).rejects.toEqual(setupError('redmine', 'redmineApiKeyRefused', { url: 'http://redmine.test' }))
    answer({})
    await expect(resolveRedmine(machine(), { baseUrl: 'http://redmine.test', apiKey: 'key' })).rejects.toEqual(setupError('redmine', 'redmineNoAccount', { url: 'http://redmine.test' }))
  })
  it('reads the Gerrit account from the review server, past the prefix it puts in front of its answers', async () => {
    const answer = (body: unknown, status = 200) => { vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`)]}'\n${JSON.stringify(body)}`, { status })) }
    const server = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const path = String(url)
      if (path.includes('/projects/')) return new Response(`)]}'\n${JSON.stringify({ id: 'demo', name: 'demo' })}`, { status: 200 })
      return new Response(`)]}'\n${JSON.stringify({ username: 'agent', email: 'agent@example.com' })}`, { status: 200 })
    })
    expect(await resolveGerrit(machine(), {})).toBeUndefined()
    // A named project is the legacy single-repository override, and is checked for existence.
    server()
    expect(await resolveGerrit(machine(), { httpUrl: 'http://gerrit.test:8080/', project: 'demo', user: 'agent', password: 'secret', branch: 'main' }))
      .toEqual({ httpUrl: 'http://gerrit.test:8080', sshUrl: '', project: 'demo', user: 'agent', password: 'secret', keyPath: '', branch: 'main', email: 'agent@example.com' })
    // Empty tracks every repository: the account check verifies the credentials and the address, and the project stays empty.
    const fetch = server()
    fetch.mockClear()
    expect(await resolveGerrit(machine(), { httpUrl: 'http://gerrit.test:8080', user: 'agent', password: 'secret', branch: 'main' }))
      .toEqual({ httpUrl: 'http://gerrit.test:8080', sshUrl: '', project: '', user: 'agent', password: 'secret', keyPath: '', branch: 'main', email: 'agent@example.com' })
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['http://gerrit.test:8080/a/accounts/self'])
    // A named project that does not exist is still refused, and a refused account is named where it is fixed.
    answer({})
    await expect(resolveGerrit(machine(), { httpUrl: 'http://gerrit.test:8080', project: 'missing', user: 'agent', password: 'secret' }))
      .rejects.toEqual(setupError('gerrit', 'gerritNoProject', { project: 'missing' }))
    answer({}, 403)
    await expect(resolveGerrit(machine(), { httpUrl: 'http://gerrit.test:8080', user: 'agent', password: 'wrong' }))
      .rejects.toEqual(setupError('gerrit', 'gerritCredentialsRefused', { url: 'http://gerrit.test:8080' }))
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'echo "not configured" >&2; exit 1')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
