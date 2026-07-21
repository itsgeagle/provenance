/**
 * SkipIdleToggle.test.tsx
 *
 * Tests:
 *  1. Reports its state via role=switch / aria-checked.
 *  2. Clicking emits the INVERTED value (it is a toggle, not a setter).
 *  3. Disabled blocks the callback.
 *  4. The title explains that the timeline still shows real time — the whole
 *     reason this default is safe for an integrity tool.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkipIdleToggle } from './SkipIdleToggle.js';

describe('SkipIdleToggle', () => {
  it('exposes its state as a switch', () => {
    render(<SkipIdleToggle skipIdle onSkipIdleChange={vi.fn()} />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('reports the off state', () => {
    render(<SkipIdleToggle skipIdle={false} onSkipIdleChange={vi.fn()} />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  });

  it('emits false when toggled off', () => {
    const onSkipIdleChange = vi.fn();
    render(<SkipIdleToggle skipIdle onSkipIdleChange={onSkipIdleChange} />);
    fireEvent.click(screen.getByTestId('skip-idle-toggle'));
    expect(onSkipIdleChange).toHaveBeenCalledWith(false);
  });

  it('emits true when toggled on', () => {
    const onSkipIdleChange = vi.fn();
    render(<SkipIdleToggle skipIdle={false} onSkipIdleChange={onSkipIdleChange} />);
    fireEvent.click(screen.getByTestId('skip-idle-toggle'));
    expect(onSkipIdleChange).toHaveBeenCalledWith(true);
  });

  it('does not fire when disabled', () => {
    const onSkipIdleChange = vi.fn();
    render(<SkipIdleToggle skipIdle onSkipIdleChange={onSkipIdleChange} disabled />);
    fireEvent.click(screen.getByTestId('skip-idle-toggle'));
    expect(onSkipIdleChange).not.toHaveBeenCalled();
  });

  it('tells the reviewer the timeline still shows real time', () => {
    render(<SkipIdleToggle skipIdle onSkipIdleChange={vi.fn()} />);
    expect(screen.getByTestId('skip-idle-toggle').getAttribute('title')).toContain('real time');
  });
});
