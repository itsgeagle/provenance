import { describe, it, expect } from 'vitest';
import { Throttler } from './throttle.js';

describe('Throttler', () => {
  it('admits first, suppresses within window, re-admits after window with suppressed count', () => {
    let t = 1000;
    const th = new Throttler({ windowMs: 300_000, now: () => t });
    expect(th.admit('k')).toEqual({ send: true, suppressed: 0 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 1 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 2 });
    t += 300_001;
    expect(th.admit('k')).toEqual({ send: true, suppressed: 2 });
    expect(th.admit('k')).toEqual({ send: false, suppressed: 1 });
  });

  it('keys are independent', () => {
    const th = new Throttler({ windowMs: 1000, now: () => 0 });
    expect(th.admit('a').send).toBe(true);
    expect(th.admit('b').send).toBe(true);
  });

  it('evicts oldest beyond maxKeys', () => {
    let t = 0;
    const th = new Throttler({ windowMs: 1000, now: () => t, maxKeys: 2 });
    th.admit('a');
    t++;
    th.admit('b');
    t++;
    th.admit('c'); // 'a' evicted
    expect(th.admit('a')).toEqual({ send: true, suppressed: 0 }); // treated as fresh
  });
});
