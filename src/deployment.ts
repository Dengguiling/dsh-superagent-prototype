/** Plugin configuration and startup verification for repository access and agent CLI identities. */
import { LIMITS } from './limits.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { Volatile } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runAsWorker, sameDirectory, withoutDirectory, workerBin } from './infra/environment.ts'
import { SetupError } from './setup.ts'

const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
/** Plugin configuration of the dsh-superagent entry. Volatile fields apply without a restart because dsh-superagent reads them on each use; changing `stateDir` remounts the plugin. */
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(LIMITS.admissionContextMaxPages.min).max(LIMITS.admissionContextMaxPages.max).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(LIMITS.admissionContextTimeoutMs.min).max(LIMITS.admissionContextTimeoutMs.max).step(1)
    .default(15000).description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
export interface Machine {
  stateDir: string
  promptMaxChars: Volatile<number>
  admissionContextMaxPages: Volatile<number>
  admissionContextTimeoutMs: Volatile<number>
}
const MOVED: Record<string, string> = {
  branchPrefix: 'in the prepare command of the Execution settings',
  feishu: 'on the Feishu Source', author: 'prompt text', repositoryPath: 'in the prepare command of the Execution settings',
  worktreeRoot: 'the ticket directory of the Execution settings', blockedCommands: 'in the Execution settings',
  redmine: 'on the Redmine Source', gerrit: 'on the Gerrit Source',
}

/** Read machine settings and reject unknown configuration keys (naming where deprecated keys moved). */
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}

export const FeishuBotSchema = z.object({ cli: z.string().trim().default('') })
/**
 * Redmine account fields: the task system's base URL, the API key of the agent's account, the project it reads, and the
 * login the agent posts as. The API key is a credential and never reaches a worker's environment.
 */
export const RedmineAccountsSchema = z.object({
  baseUrl: z.string().trim().default(''),
  apiKey: z.string().trim().default(''),
  project: z.string().trim().default(''),
  login: z.string().trim().default(''),
})
/**
 * Gerrit account fields: the HTTP base URL of the review server, the SSH URL the agent pushes patches to, an optional
 * single-repository override, the account's user name, its HTTP password, the private key used for SSH, and the branch
 * patches target.
 */
export const GerritAccountsSchema = z.object({
  httpUrl: z.string().trim().default(''),
  sshUrl: z.string().trim().default(''),
  /** Empty tracks the issue-referencing patches of every repository; a name is the legacy single-repository override. */
  project: z.string().trim().default(''),
  user: z.string().trim().default(''),
  password: z.string().trim().default(''),
  keyPath: z.string().trim().default(''),
  email: z.string().trim().default(''),
  branch: z.string().trim().default('main'),
})
/** Source configuration keys that affect deployment setup and trigger a restart when changed. */
export const SETUP_FIELDS: Readonly<Record<string, readonly string[]>> = {
  feishu: Object.keys(FeishuBotSchema.shape),
  redmine: Object.keys(RedmineAccountsSchema.shape), gerrit: Object.keys(GerritAccountsSchema.shape),
}

export interface Deployment extends Machine {
  feishu?: FeishuBot
  /** The agent's Redmine account; undefined when the Redmine Source is not configured. */
  redmine?: RedmineAccount
  /** The agent's Gerrit account; undefined when the Gerrit Source is not configured. */
  gerrit?: GerritAccount
}
export interface FeishuBot { cli: string; appId: string; brand: 'feishu' | 'lark'; botId: string; name: string }
/** The resolved Redmine account: where the task system is, and which account the agent acts as. */
export interface RedmineAccount { baseUrl: string; apiKey: string; id: number; login: string; name: string; mail: string; project: string }
/** The resolved Gerrit account: where the review server is over HTTP and SSH, and which account the agent acts as. */
export interface GerritAccount { httpUrl: string; sshUrl: string; /** Empty tracks every repository; a name is the legacy single-repository override. */ project: string; user: string; password: string; keyPath: string; branch: string; email: string }

/** Resolve a command name or absolute path to an executable file, ignoring the worker shim directory. */
export function executable(name: string, path: string, exclude?: string): string {
  if (name.includes('/') && !isAbsolute(name)) throw new Error(`${name} must be a command name or an absolute path`)
  const candidates = isAbsolute(name) ? [name] : path.split(delimiter).filter(dir => isAbsolute(dir) && !(exclude && sameDirectory(dir, exclude))).map(dir => join(dir, name))
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) { accessSync(candidate, constants.X_OK); return candidate } }
    catch { /* Not an executable file here; try the next PATH directory. */ }
  }
  throw new Error(`${name} is not an executable file${isAbsolute(name) ? '' : ' on PATH'}`)
}

export type Probe = (argv: string[]) => Promise<string>
/** Run startup checks through DSH's worker subprocess service with worker shims removed from PATH so a wrapper script reaches the real binary. */
export function workerProbe(subprocess: SubprocessRuntime, stateDir: string, cwd: string, signal: AbortSignal): Probe {
  const path = withoutDirectory(process.env.PATH ?? '', workerBin(stateDir))
  return argv => runAsWorker(subprocess, ['env', `PATH=${path}`, ...argv], cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

/** Parses the JSON of a command or a response and keeps it when it has the expected shape. */
function parsed<T>(schema: z.ZodType<T>, text: string): T | undefined {
  let value: unknown
  try { value = JSON.parse(text) } catch { return undefined /* Non-JSON output; the caller surfaces the setup failure. */ }
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}
/**
 * Performs an HTTP request with optional headers and returns its status and body. Credentials travel in the `Authorization`
 * header, never in the URL or the process arguments.
 */
/**
 * The time a request may take before it is abandoned: a task system that stops answering must not hold a poll, a panel
 * page or a worker for ever.
 */
const REQUEST_TIMEOUT_MS = 30_000

export async function http(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { method: init.method ?? 'GET', headers: init.headers, body: init.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    return { status: response.status, body: await response.text() }
  } catch (error) { throw new Error(`HTTP ${url} failed: ${reason(error)}`) }
}
/** Builds the HTTP Basic authorization header for `user` and `password`. */
export const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
/** Strips trailing slashes from a base URL so paths can be appended to it. */
export const base = (url: string): string => url.trim().replace(/\/+$/, '')
/**
 * Gerrit puts an anti-hijacking prefix in front of every JSON response; it must be removed before the body is parsed.
 */
export const strip = (body: string): string => body.replace(/^\)\]\}'\r?\n?/, '')

const RedmineUser = z.object({ id: z.number().int(), login: z.string(), mail: z.string().nullish(), firstname: z.string().nullish(), lastname: z.string().nullish() })
/** The display name Redmine shows for a user, as its API formats it. */
const displayName = (user: { firstname?: string | null; lastname?: string | null }): string =>
  [user.firstname, user.lastname].filter(Boolean).join(' ')
/**
 * Verify the agent's Redmine account with its API key and read the account it acts as. An empty configuration means the
 * Redmine Source is not used.
 */
export async function resolveRedmine(machine: Machine, redmine: unknown): Promise<RedmineAccount | undefined> {
  const accounts = RedmineAccountsSchema.parse(redmine ?? {})
  if (!accounts.baseUrl && !accounts.apiKey) return undefined
  if (!accounts.baseUrl) throw new SetupError('redmineUrlUnset')
  if (!accounts.apiKey) throw new SetupError('redmineApiKeyUnset')
  const root = base(accounts.baseUrl)
  // Redmine 4.2 reads the API key as the user name of the Basic credentials, and accepts it in its own header as well.
  const headers = { Authorization: basic(accounts.apiKey, ''), 'X-Redmine-API-Key': accounts.apiKey, 'Content-Type': 'application/json' }
  const response = await http(`${root}/users/current.json`, { headers }).catch((error: unknown) => {
    throw new SetupError('redmineUnreadable', { url: root, output: reason(error) })
  })
  if (response.status === 401 || response.status === 403) throw new SetupError('redmineApiKeyRefused', { url: root })
  if (response.status !== 200) throw new SetupError('redmineUnreadable', { url: root, output: `HTTP ${response.status}: ${response.body.slice(0, 200)}` })
  // The account is under the `user` key of the answer.
  const user = parsed(z.object({ user: RedmineUser }), response.body)?.user
  if (!user) throw new SetupError('redmineNoAccount', { url: root })
  return { baseUrl: root, apiKey: accounts.apiKey, id: user.id, login: user.login, name: displayName(user),
    mail: user.mail ?? '', project: accounts.project }
}

const GerritProject = z.object({ id: z.string(), name: z.string() })
const GerritAccountInfo = z.object({ username: z.string().optional(), email: z.string().nullish(), name: z.string().nullish() })
/**
 * Verify the agent's Gerrit account against the review server's REST API. An empty configuration means the Gerrit Source
 * is not used. The project is optional: empty tracks the issue-referencing patches of every repository, so only the
 * account is checked; a named project is the legacy single-repository override and is checked for existence too.
 */
export async function resolveGerrit(machine: Machine, gerrit: unknown): Promise<GerritAccount | undefined> {
  const accounts = GerritAccountsSchema.parse(gerrit ?? {})
  if (!accounts.httpUrl && !accounts.sshUrl) return undefined
  if (!accounts.httpUrl) throw new SetupError('gerritUrlUnset')
  const root = base(accounts.httpUrl)
  const headers = { Authorization: basic(accounts.user, accounts.password), 'Content-Type': 'application/json' }
  /** Reads the account behind the configured credentials; its email is the commit identity Gerrit accepts. */
  const self = async () => {
    const response = await http(`${root}/a/accounts/self`, { headers }).catch((error: unknown) => {
      throw new SetupError('gerritUnreadable', { url: root, output: reason(error) })
    })
    if (response.status === 401 || response.status === 403) throw new SetupError('gerritCredentialsRefused', { url: root })
    if (response.status !== 200) throw new SetupError('gerritUnreadable', { url: root, output: `HTTP ${response.status}: ${response.body.slice(0, 200)}` })
    return parsed(GerritAccountInfo, strip(response.body))
  }
  // The account of the agent is the one the server reports, so the Source can tell the agent's own notes from a
  // reviewer's; an account the server does not name is a setup problem, because the agent would read its own notes.
  const account = (email: string, project: string, found?: z.infer<typeof GerritAccountInfo>): GerritAccount => {
    const user = found?.username || accounts.user
    if (!user) throw new SetupError('gerritUserUnset')
    return { httpUrl: root, sshUrl: accounts.sshUrl, project, user, password: accounts.password,
      keyPath: accounts.keyPath, branch: accounts.branch, email: email || found?.email || '' }
  }
  if (accounts.project) {
    const response = await http(`${root}/a/projects/${encodeURIComponent(accounts.project)}`, { headers }).catch((error: unknown) => {
      throw new SetupError('gerritUnreadable', { url: root, output: reason(error) })
    })
    if (response.status === 401 || response.status === 403) throw new SetupError('gerritCredentialsRefused', { url: root })
    if (response.status !== 200) throw new SetupError('gerritUnreadable', { url: root, output: `HTTP ${response.status}: ${response.body.slice(0, 200)}` })
    const project = parsed(GerritProject, strip(response.body))
    if (!project) throw new SetupError('gerritNoProject', { project: accounts.project })
    // The commit email is read best effort: a server that does not answer for the account still serves its projects.
    return account(accounts.email, project.name, await self().catch(() => undefined))
  }
  // No project means every repository, so the account check is what verifies the credentials and the address.
  return account(accounts.email, '', await self())
}

const AuthStatus = z.object({ appId: z.string().regex(/^cli_[A-Za-z0-9]+$/), brand: z.enum(['feishu', 'lark']).default('feishu'), identities: z.object({ bot: z.object({ status: z.string() }) }) })
const BotInfo = z.object({ bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().default('') }) })
/**
 * Verify that the configured Feishu CLI is authenticated as a bot and restricted to strict mode `bot`.
 * Workers invoke this CLI as `lark-cli`, so a CLI that also permits a user identity would let workers act as that user.
 */
export async function resolveFeishuBot(machine: Machine, feishu: unknown, probe: Probe, path = process.env.PATH ?? ''): Promise<FeishuBot | undefined> {
  const { cli: name } = FeishuBotSchema.parse(feishu ?? {})
  if (!name) return undefined
  const fail = (error: unknown): never => { throw error instanceof SetupError ? error : new SetupError('feishuCliFailed', { output: reason(error) }) }
  let cli = ''
  try { cli = executable(name, path, workerBin(machine.stateDir)) } catch (error) { fail(error) }
  const run = (...args: string[]): Promise<string> => probe(['env', 'LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1', 'LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1', cli, ...args]).catch(fail)
  const text = await run('auth', 'status')
  const status = parsed(AuthStatus, text.slice(text.indexOf('{')))
  if (!status) return fail(new SetupError('feishuNoApp'))
  if (status.identities.bot.status !== 'ready') fail(new SetupError('feishuBotNotReady', { app: status.appId, status: status.identities.bot.status }))
  const mode = /strict-mode:\s*(\w+)/.exec(await run('config', 'strict-mode'))?.[1]
  if (mode !== 'bot') fail(new SetupError('feishuUserIdentity', { mode: mode ?? 'unknown' }))
  // `--format json` unwraps only `data`, whereas this endpoint returns the payload under `bot`.
  const info = parsed(BotInfo, (await run('api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson')).split('\n')[0] ?? '')
  if (!info) return fail(new SetupError('feishuNoBot'))
  return { cli, appId: status.appId, brand: status.brand, botId: info.bot.open_id, name: info.bot.app_name }
}
