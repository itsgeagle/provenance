import '@testing-library/jest-dom';
import { vi, beforeAll, afterEach, afterAll } from 'vitest';
import { setupServer } from 'msw/node';
import { handlers } from './test/msw-handlers.js';

// ---------------------------------------------------------------------------
// MSW server — intercepts fetch calls in test environment
// ---------------------------------------------------------------------------
//
// The server is started once for all tests (beforeAll), handlers are reset
// after each test to prevent state leakage (afterEach), and the server is
// closed after all tests complete (afterAll).
//
// Individual tests can override handlers with server.use() for the duration
// of that test.

export const mswServer = setupServer(...handlers);

beforeAll(() => mswServer.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

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

// jsdom also has no IntersectionObserver. The cohort tables use it to drive
// infinite-scroll loading; tests never need it to fire, so a noop stub is
// enough to keep React effects from throwing on construction.
class IntersectionObserverStub {
  root = null;
  rootMargin = '';
  thresholds: ReadonlyArray<number> = [];
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}
if (typeof globalThis.IntersectionObserver === 'undefined') {
  (globalThis as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
    IntersectionObserverStub as unknown as typeof IntersectionObserver;
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
