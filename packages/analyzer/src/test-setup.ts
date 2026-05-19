import '@testing-library/jest-dom';
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// jsdom layout shims
// ---------------------------------------------------------------------------
//
// jsdom does not implement CSS layout, so getBoundingClientRect returns a
// 0×0 rect for every element and ResizeObserver does not exist. Libraries
// that rely on real measurements (e.g. @tanstack/react-virtual, Radix
// positioning, scroll virtualization) need at least a non-zero parent rect
// to produce useful output in tests.
//
// We provide minimal, predictable defaults:
//   - ResizeObserver is a noop stub.
//   - getBoundingClientRect returns an 800×600 rect anchored at (0, 0).
//   - clientWidth/clientHeight report 800/600.
//
// This is fine for our component tests; tests that actually depend on
// measured layout can still override these on a per-element basis.

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  (globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;

Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: VIEWPORT_WIDTH,
    bottom: VIEWPORT_HEIGHT,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    toJSON() {
      return this;
    },
  } as DOMRect;
};

for (const prop of ['clientWidth', 'offsetWidth', 'scrollWidth'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return VIEWPORT_WIDTH;
    },
  });
}
for (const prop of ['clientHeight', 'offsetHeight', 'scrollHeight'] as const) {
  Object.defineProperty(HTMLElement.prototype, prop, {
    configurable: true,
    get() {
      return VIEWPORT_HEIGHT;
    },
  });
}
