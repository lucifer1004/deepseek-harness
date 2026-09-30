export class OrderStore {
  readonly #orders = new Set<string>()

  put(id: string): void {
    this.#orders.add(id)
  }
}
