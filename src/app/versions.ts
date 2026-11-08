/** Versioned record storage backed by numbered snapshots and a current-revision pointer in the Store KV table. */
import type { Family, Key } from '../kv.ts'
import type { Store } from './store.ts'

/**
 * Manages numbered snapshots of a versioned record in the `Store` key-value table with a pointer key tracking the active revision.
 * Each save writes a new snapshot and advances the pointer atomically, keeping full history without duplicating the active record.
 * Used by `Store` for settings history and by `Prompts` for versioned prompt configuration.
 */
export class Versions<V extends { revision: number }> {
  constructor(private readonly store: Pick<Store, 'get' | 'set' | 'keys' | 'atomic'>, private readonly pointer: Key<number>,
    private readonly family: Family<V, [revision: number]>) {}
  /** Current revision number, or `0` before the first save. */
  revision(): number { return this.store.get(this.pointer) ?? 0 }
  /** Current snapshot, or `undefined` before the first save. */
  current(): V | undefined {
    const revision = this.store.get(this.pointer)
    return revision === undefined ? undefined : this.get(revision)
  }
  get(revision: number): V | undefined { return this.store.get(this.family(revision)) }
  save(make: (revision: number) => V): V {
    return this.store.atomic(() => {
      const version = make(this.revision() + 1)
      this.store.set(this.family(version.revision), version)
      this.store.set(this.pointer, version.revision)
      return version
    })
  }
  /** Stores a snapshot without advancing the current revision pointer (e.g., to record an initial built-in baseline). */
  keep(version: V): void { this.store.set(this.family(version.revision), version) }
  /**
   * The newest `limit` snapshots, newest first. The key names carry the revision number, so it selects the newest keys
   * first and parses only the values it returns, instead of parsing the family's whole history to sort it.
   */
  list(limit = Infinity): V[] {
    const prefix = this.family.prefix
    const keys = this.store.keys(prefix)
      .map(name => ({ name: name as Key<V>, revision: Number(name.slice(prefix.length)) }))
      .filter(key => Number.isFinite(key.revision))
      .sort((a, b) => b.revision - a.revision)
      .slice(0, limit)
    return keys.flatMap(key => { const value = this.store.get(key.name); return value ? [value] : [] })
  }
}
