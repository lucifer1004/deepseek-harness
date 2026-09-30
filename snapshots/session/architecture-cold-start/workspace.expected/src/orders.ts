import { OrderStore } from './store.ts'

export function placeOrder(store: OrderStore, id: string): void {
  store.put(id)
}
