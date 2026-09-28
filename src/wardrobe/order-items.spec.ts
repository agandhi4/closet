import { describe, expect, it } from 'vitest';
import { ORDER_ITEM_STATES, orderItemTransition } from './order-items';

describe('orderItemTransition', () => {
  it('moves a pending item once: added or dismissed', () => {
    expect(orderItemTransition('pending', 'add')).toBe('added');
    expect(orderItemTransition('pending', 'dismiss')).toBe('dismissed');
  });

  it('never moves a decided item', () => {
    for (const from of ORDER_ITEM_STATES.filter((s) => s !== 'pending')) {
      expect(orderItemTransition(from, 'add')).toBeUndefined();
      expect(orderItemTransition(from, 'dismiss')).toBeUndefined();
    }
  });
});
