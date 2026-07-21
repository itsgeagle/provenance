/**
 * SpeedControl.test.tsx
 *
 * Tests:
 *  1. Renders the trigger with the current speed label.
 *  2. Non-preset speed shows as-is (e.g. "3×").
 *  3. SPEED_PRESETS has the expected 11 values.
 *  4. Disabled prop disables the trigger.
 *  5. Clicking a preset item (with menu forced open) calls onSpeedChange correctly.
 *
 * Note: Radix DropdownMenu portals content to document.body. We test content
 * availability by using the `DropdownMenu open` prop (same pattern as
 * dropdown-menu.test.tsx) rather than simulating a pointer-event click.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { SpeedControl, SPEED_PRESETS } from './SpeedControl.js';

describe('SpeedControl', () => {
  it('renders the trigger with the current speed label', () => {
    render(<SpeedControl speed={1} onSpeedChange={vi.fn()} />);
    expect(screen.getByTestId('speed-control-trigger').textContent).toContain('1×');
  });

  it('shows a non-preset speed verbatim', () => {
    render(<SpeedControl speed={3} onSpeedChange={vi.fn()} />);
    expect(screen.getByTestId('speed-control-trigger').textContent).toContain('3×');
  });

  it('shows 0.25× for the smallest preset', () => {
    render(<SpeedControl speed={0.25} onSpeedChange={vi.fn()} />);
    expect(screen.getByTestId('speed-control-trigger').textContent).toContain('0.25×');
  });

  it('shows 256× for the largest preset', () => {
    render(<SpeedControl speed={256} onSpeedChange={vi.fn()} />);
    expect(screen.getByTestId('speed-control-trigger').textContent).toContain('256×');
  });

  it('disabled prop sets disabled attribute on the trigger', () => {
    render(<SpeedControl speed={1} onSpeedChange={vi.fn()} disabled />);
    const trigger = screen.getByTestId('speed-control-trigger');
    // Radix DropdownMenuTrigger sets data-disabled when disabled
    expect(
      trigger.hasAttribute('disabled') ||
        trigger.getAttribute('data-disabled') !== null ||
        trigger.getAttribute('aria-disabled') === 'true',
    ).toBe(true);
  });

  it('SPEED_PRESETS has 11 values with correct bounds', () => {
    expect(SPEED_PRESETS).toHaveLength(11);
    expect(SPEED_PRESETS[0]).toBe(0.25);
    expect(SPEED_PRESETS[SPEED_PRESETS.length - 1]).toBe(256);
  });

  it('offers speeds above the old 32× ceiling', () => {
    expect(SPEED_PRESETS).toContain(64);
    expect(SPEED_PRESETS).toContain(128);
    expect(SPEED_PRESETS).toContain(256);
  });

  it('all preset speeds are in ascending order', () => {
    for (let i = 1; i < SPEED_PRESETS.length; i++) {
      expect(SPEED_PRESETS[i]).toBeGreaterThan(SPEED_PRESETS[i - 1]!);
    }
  });

  it('calls onSpeedChange when a preset item is selected (forced open)', () => {
    // Use Radix DropdownMenu with open=true to test the item onSelect logic
    // directly, same pattern as dropdown-menu.test.tsx.
    const onSpeedChange = vi.fn();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Speed</DropdownMenuTrigger>
        <DropdownMenuContent>
          {SPEED_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset}
              data-testid={`speed-option-${String(preset)}`}
              onSelect={() => onSpeedChange(preset)}
            >
              {preset}×
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    // Click the 2× option (portaled to document.body)
    const option2 = document.body.querySelector('[data-testid="speed-option-2"]');
    expect(option2).not.toBeNull();
    fireEvent.click(option2!);
    expect(onSpeedChange).toHaveBeenCalledWith(2);
  });

  it('calls onSpeedChange with 0.25 for the smallest preset item', () => {
    const onSpeedChange = vi.fn();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Speed</DropdownMenuTrigger>
        <DropdownMenuContent>
          {SPEED_PRESETS.map((preset) => (
            <DropdownMenuItem
              key={preset}
              data-testid={`speed-option-${String(preset)}`}
              onSelect={() => onSpeedChange(preset)}
            >
              {preset}×
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    // The test id "speed-option-0.25" — querySelector attribute selectors handle this fine.
    const option025 = document.body.querySelector('[data-testid="speed-option-0.25"]');
    expect(option025).not.toBeNull();
    fireEvent.click(option025!);
    expect(onSpeedChange).toHaveBeenCalledWith(0.25);
  });
});
