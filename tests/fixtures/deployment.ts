/** Default deployment and machine fixtures for tests. */
import type { Volatile } from '@deepseek-ai/cordis'
import type { Deployment, Machine } from '../../src/deployment.ts'

/** Mutable Volatile reference for simulating live configuration updates. */
export const reference = <T>(value: T): Volatile<T> & { set(next: T): void } => {
  let current = value
  return { get: () => current as never, set: next => { current = next } }
}
export const testMachine = (overrides: Partial<Machine> = {}): Machine => ({
  stateDir: '/tmp/dsh-superagent-test', promptMaxChars: reference(100000), admissionContextMaxPages: reference(10),
  admissionContextTimeoutMs: reference(15000), ...overrides,
})
/** The Redmine account of a fixture: a task system at `http://redmine.test` with the API key `key`. */
export const testRedmine = { baseUrl: 'http://redmine.test', apiKey: 'key', id: 5, login: 'agent', name: 'Agent Bot', mail: 'agent@example.com', project: 'demo' }
/** The Gerrit account of a fixture: a review server at `http://gerrit.test:8080` reached over SSH as `agent`. */
export const testGerrit = { httpUrl: 'http://gerrit.test:8080', sshUrl: 'ssh://agent@gerrit.test:29418', project: 'demo', user: 'agent',
  password: 'secret', keyPath: '/keys/agent', branch: 'main', email: 'agent@example.com' }
/** The deployment of a fixture: the task system, the review server, and an optional bot. */
export const testDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  ...testMachine(), feishu: { cli: '/bin/false', botId: 'ou_bot', appId: 'cli_bot', brand: 'feishu', name: 'Widgets Bot' }, ...overrides,
})
