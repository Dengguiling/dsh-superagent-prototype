/**
 * Live check of the deployment checks: the Redmine and Gerrit accounts must be read from the running servers, and a
 * wrong key or password must be refused.
 */
import { resolveGerrit, resolveRedmine, type Machine } from '../../src/deployment.ts'
import { reference } from '../../tests/fixtures/deployment.ts'

const machine: Machine = {
  stateDir: '/tmp/dsh-superagent-live', promptMaxChars: reference(100000),
  admissionContextMaxPages: reference(10), admissionContextTimeoutMs: reference(15000),
}

console.log('== the Redmine account ==')
const redmine = await resolveRedmine(machine, {
  baseUrl: process.env.REDMINE_URL ?? 'http://127.0.0.1:3010', apiKey: process.env.REDMINE_KEY ?? '',
  project: process.env.REDMINE_PROJECT ?? 'demo', login: process.env.REDMINE_LOGIN ?? 'agent',
})
console.log('  resolved:', redmine && { baseUrl: redmine.baseUrl, id: redmine.id, login: redmine.login, name: redmine.name, project: redmine.project })

console.log('== a wrong Redmine key is refused ==')
await resolveRedmine(machine, { baseUrl: process.env.REDMINE_URL ?? 'http://127.0.0.1:3010', apiKey: 'wrong-key' })
  .then(() => console.log('  UNEXPECTED: the wrong key was accepted'))
  .catch((error: unknown) => console.log('  refused:', error instanceof Error ? error.message : error))

console.log('== the Gerrit account ==')
const gerrit = await resolveGerrit(machine, {
  httpUrl: process.env.GERRIT_URL ?? 'http://127.0.0.1:8081', sshUrl: 'ssh://agent@127.0.0.1:29419',
  project: process.env.GERRIT_PROJECT ?? 'demo', user: process.env.GERRIT_USER ?? 'agent',
  password: process.env.GERRIT_PASS ?? '', branch: process.env.GERRIT_BRANCH ?? 'master',
})
console.log('  resolved:', gerrit && { httpUrl: gerrit.httpUrl, project: gerrit.project, user: gerrit.user, branch: gerrit.branch, email: gerrit.email })

console.log('== a wrong Gerrit password is refused ==')
await resolveGerrit(machine, {
  httpUrl: process.env.GERRIT_URL ?? 'http://127.0.0.1:8081', project: process.env.GERRIT_PROJECT ?? 'demo',
  user: process.env.GERRIT_USER ?? 'agent', password: 'wrong',
})
  .then(() => console.log('  UNEXPECTED: the wrong password was accepted'))
  .catch((error: unknown) => console.log('  refused:', error instanceof Error ? error.message : error))
