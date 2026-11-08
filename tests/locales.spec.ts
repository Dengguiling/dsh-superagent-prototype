import { expect, it } from 'vitest'
import type { EffectKind } from '../src/app/effects.ts'
import { en, zh, type DshSuperagentKey } from '../src/client/locales.ts'
import { reasonLabel, type T } from '../src/client/text.ts'
import { REASONS, USER_ERRORS } from '../src/core/index.ts'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

it('names the same placeholders in both languages', () => {
  const keys = Object.keys(zh) as DshSuperagentKey[]
  expect(keys.filter(key => placeholders(zh[key]).join() !== placeholders(en[key]).join())).toEqual([])
  expect(keys.filter(key => !zh[key] || !en[key])).toEqual([])
})

it('holds no replacement character in either language, which would read as garbled text', () => {
  expect(Object.values(zh).filter(text => text.includes('\uFFFD'))).toEqual([])
  expect(Object.values(en).filter(text => text.includes('\uFFFD'))).toEqual([])
})

it('leaves no key the panel never reads', () => {
  // The panel reads a key when a component quotes it (`t('offline')`), when a template literal covers its prefix
  // (`t(`reason.${code}`)`), or when `valueLabel` composes it from a group and a record (`valueLabel(t, 'mode', mode)`
  // covers every `mode.*` key, a literal pair names `promptRole.orchestrator`). A group read through a variable
  // (`valueLabel(t, item.name, item.value)`) counts as a whole once the group's own name is quoted. The glossary lists
  // keys of its own below the dictionary; a key's own definition inside the dictionary is not a use.
  const dir = join(process.cwd(), 'src/client')
  const code = readdirSync(dir).filter(name => /\.tsx?$/.test(name) && name !== 'locales.ts')
    .map(name => readFileSync(join(dir, name), 'utf8')).join('\n')
  const source = code + (readFileSync(join(dir, 'locales.ts'), 'utf8').split('\n} as const satisfies')[1] ?? '')
  const quoted = (name: string) => source.includes(`'${name}'`)
  const prefixes = [...[...code.matchAll(/`([\w.]+)\$\{/g)].map(match => `${match[1]!.replace(/\.$/, '')}.`),
    ...[...code.matchAll(/valueLabel\([^,]+,\s*'([\w.]+)',\s*[^']/g)].map(match => `${match[1]!}.`)]
  const composed = [...code.matchAll(/valueLabel\([^,]+,\s*'([\w.]+)',\s*'([\w.]+)'\)/g)]
    .map(match => `${match[1]!}.${match[2]!}`)
  const used = (key: string) => quoted(key) || composed.includes(key) || prefixes.some(prefix => key.startsWith(prefix))
    || (key.includes('.') && quoted(key.split('.')[0]!))
  expect((Object.keys(zh) as DshSuperagentKey[]).filter(key => !used(key))).toEqual([])
})

it('names no removed product in either language', () => {
  // GitHub left the product; the panel speaks of Redmine, Gerrit and Feishu.
  expect(Object.entries(zh).filter(([, text]) => /github/i.test(text)).map(([key]) => key)).toEqual([])
  expect(Object.entries(en).filter(([, text]) => /github/i.test(text)).map(([key]) => key)).toEqual([])
})

it('words a reason by its code with its values, each of a batch, and words a person or an assessor wrote as written', () => {
  const t = ((key: DshSuperagentKey, values: Record<string, string> = {}) => (zh[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => values[name] ?? '')) as T
  expect(reasonLabel(t, 'retried')).toBe(zh['reason.retried'])
  expect(reasonLabel(t, [{ code: 'routed', values: { ticket: 't1' } }])).toBe('已转给工单 t1')
  expect(reasonLabel(t, [{ code: 'not_a_member', triggerId: '1' }, { code: 'no_mention', triggerId: '2' }]))
    .toBe(`${zh['reason.not_a_member']}${zh.reasonSeparator}${zh['reason.no_mention']}`)
  expect(reasonLabel(t, [{ code: 'said', values: { text: 'The button is already blue' } }])).toBe('The button is already blue')
  // A code the panel has no words for reads as the host words it.
  expect(reasonLabel(t, { code: 'some_new_filter' })).toBe('some_new_filter')
  expect(reasonLabel(t, 'The button is already blue')).toBe('The button is already blue')
})

it('names every health entry of dsh-superagent itself, which the overview shows when it fails', () => {
  // Each entry by its writer: dsh-superagent, the model budget retries, every kind of the effect queue, Channel messages, the
  // Executor, the unavailable Evals of the last hour, and the workers' command shims.
  const entries = { runtime: 0, models: 0, reply: 0, worker: 0, assessment: 0, launch: 0, delivery: 0, relay: 0,
    notice: 0, evals: 0, shims: 0 } satisfies Record<EffectKind | 'runtime' | 'models' | 'reply' | 'worker' | 'evals', 0>
  expect(Object.keys(entries).filter(name => !(`health.${name}` in zh))).toEqual([])
})

it('words every refusal the host words by code, in both languages', () => {
  expect(Object.keys(USER_ERRORS).filter(code => !zh[`userError.${code}` as DshSuperagentKey]
    || !en[`userError.${code}` as DshSuperagentKey])).toEqual([])
})

it('has words for every reason code the core records', () => {
  expect(Object.keys(REASONS).filter(code => code !== 'said' && !(`reason.${code}` in zh))).toEqual([])
})

it('words the reasons agents read in the glossary\'s words: a sender on the list, a Thread', () => {
  expect(Object.values(REASONS).filter(text => /\b(member|members|topic)\b/i.test(text))).toEqual([])
})
