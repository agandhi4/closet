/** "From your orders" (#25): the owner's review list, under /wardrobe so the dock marks it. */
export const ORDERS_PATH = '/wardrobe/orders';

/** An order item's action: "Add to closet" or "Dismiss". */
export function orderItemUrl(id: number, action: 'add' | 'dismiss'): string {
  return `${ORDERS_PATH}/${id}/${action}`;
}
