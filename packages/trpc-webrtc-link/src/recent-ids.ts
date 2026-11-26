/**
 * Remembers a bounded number of recently retired operation IDs so frames that
 * were already in flight when an operation ended can be recognized as benign
 * races instead of protocol violations.
 */
export class RecentIdSet {
  readonly #limit: number;
  readonly #ids = new Set<string>();

  public constructor(limit = 1024) {
    this.#limit = limit;
  }

  public add(id: string): void {
    this.#ids.delete(id);
    this.#ids.add(id);
    if (this.#ids.size > this.#limit) {
      const oldest = this.#ids.values().next();
      if (!oldest.done) {
        this.#ids.delete(oldest.value);
      }
    }
  }

  public has(id: string): boolean {
    return this.#ids.has(id);
  }

  public delete(id: string): void {
    this.#ids.delete(id);
  }

  public clear(): void {
    this.#ids.clear();
  }
}
