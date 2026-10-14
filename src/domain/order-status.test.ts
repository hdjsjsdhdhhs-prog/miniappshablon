import { describe, expect, it } from 'vitest';
import { canTransition, isActiveStatus, isOrderStatus, ORDER_STATUSES, ORDER_TRANSITIONS } from './order-status';

describe('order status', () => {
  it('allows only the documented forward transitions', () => {
    expect(canTransition('new', 'confirmed')).toBe(true);
    expect(canTransition('confirmed', 'ready')).toBe(true);
    expect(canTransition('ready', 'completed')).toBe(true);
    expect(canTransition('new', 'completed')).toBe(false);
    expect(canTransition('completed', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'new')).toBe(false);
  });

  it('every non-terminal status can be cancelled; terminal ones have no transitions', () => {
    for (const s of ORDER_STATUSES) {
      if (s === 'completed' || s === 'cancelled') expect(ORDER_TRANSITIONS[s]).toEqual([]);
      else expect(canTransition(s, 'cancelled')).toBe(true);
    }
  });

  it('type guards and active statuses', () => {
    expect(isOrderStatus('ready')).toBe(true);
    expect(isOrderStatus('paid')).toBe(false);
    expect(isActiveStatus('confirmed')).toBe(true);
    expect(isActiveStatus('completed')).toBe(false);
  });
});
