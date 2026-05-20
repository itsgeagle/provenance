/**
 * JumpControls.test.tsx
 *
 * Tests:
 *  1. Renders all four jump buttons.
 *  2. Buttons with no next target are disabled.
 *  3. Buttons with a next target are enabled.
 *  4. Clicking an enabled button calls onSeek with the correct globalIdx.
 *  5. Disabled buttons do not call onSeek when clicked.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JumpControls } from './JumpControls.js';

// ---------------------------------------------------------------------------
// Default props (all buttons disabled)
// ---------------------------------------------------------------------------

const DEFAULT_PROPS = {
  nextPaste: null,
  nextExternalChange: null,
  nextFlag: null,
  nextFileSwitch: null,
  remainingPastes: 0,
  remainingExternalChanges: 0,
  remainingFlags: 0,
  remainingFileSwitches: 0,
  onSeek: vi.fn(),
};

describe('JumpControls', () => {
  it('renders the jump controls container', () => {
    render(<JumpControls {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('jump-controls')).toBeDefined();
  });

  it('renders all four jump buttons', () => {
    render(<JumpControls {...DEFAULT_PROPS} />);
    expect(screen.getByTestId('jump-paste')).toBeDefined();
    expect(screen.getByTestId('jump-external')).toBeDefined();
    expect(screen.getByTestId('jump-flag')).toBeDefined();
    expect(screen.getByTestId('jump-file-switch')).toBeDefined();
  });

  it('all buttons are disabled when all nextXxx are null', () => {
    render(<JumpControls {...DEFAULT_PROPS} />);
    for (const testId of ['jump-paste', 'jump-external', 'jump-flag', 'jump-file-switch']) {
      const btn = screen.getByTestId(testId);
      // disabled attribute present
      expect(btn.getAttribute('disabled')).not.toBeNull();
    }
  });

  it('paste button is enabled when nextPaste is non-null', () => {
    render(<JumpControls {...DEFAULT_PROPS} nextPaste={5} remainingPastes={2} />);
    const btn = screen.getByTestId('jump-paste');
    expect(btn.getAttribute('disabled')).toBeNull();
  });

  it('external button is enabled when nextExternalChange is non-null', () => {
    render(<JumpControls {...DEFAULT_PROPS} nextExternalChange={3} remainingExternalChanges={1} />);
    const btn = screen.getByTestId('jump-external');
    expect(btn.getAttribute('disabled')).toBeNull();
  });

  it('flag button is enabled when nextFlag is non-null', () => {
    render(<JumpControls {...DEFAULT_PROPS} nextFlag={10} remainingFlags={3} />);
    const btn = screen.getByTestId('jump-flag');
    expect(btn.getAttribute('disabled')).toBeNull();
  });

  it('file-switch button is enabled when nextFileSwitch is non-null', () => {
    render(<JumpControls {...DEFAULT_PROPS} nextFileSwitch={7} remainingFileSwitches={1} />);
    const btn = screen.getByTestId('jump-file-switch');
    expect(btn.getAttribute('disabled')).toBeNull();
  });

  it('clicking paste button calls onSeek with nextPaste', () => {
    const onSeek = vi.fn();
    render(<JumpControls {...DEFAULT_PROPS} onSeek={onSeek} nextPaste={5} remainingPastes={1} />);
    fireEvent.click(screen.getByTestId('jump-paste'));
    expect(onSeek).toHaveBeenCalledWith(5);
  });

  it('clicking external button calls onSeek with nextExternalChange', () => {
    const onSeek = vi.fn();
    render(
      <JumpControls
        {...DEFAULT_PROPS}
        onSeek={onSeek}
        nextExternalChange={8}
        remainingExternalChanges={1}
      />,
    );
    fireEvent.click(screen.getByTestId('jump-external'));
    expect(onSeek).toHaveBeenCalledWith(8);
  });

  it('clicking flag button calls onSeek with nextFlag', () => {
    const onSeek = vi.fn();
    render(<JumpControls {...DEFAULT_PROPS} onSeek={onSeek} nextFlag={12} remainingFlags={2} />);
    fireEvent.click(screen.getByTestId('jump-flag'));
    expect(onSeek).toHaveBeenCalledWith(12);
  });

  it('clicking file-switch button calls onSeek with nextFileSwitch', () => {
    const onSeek = vi.fn();
    render(
      <JumpControls
        {...DEFAULT_PROPS}
        onSeek={onSeek}
        nextFileSwitch={6}
        remainingFileSwitches={1}
      />,
    );
    fireEvent.click(screen.getByTestId('jump-file-switch'));
    expect(onSeek).toHaveBeenCalledWith(6);
  });

  it('disabled buttons do not call onSeek when clicked', () => {
    const onSeek = vi.fn();
    render(<JumpControls {...DEFAULT_PROPS} onSeek={onSeek} />);
    // All null → all disabled → clicks should not invoke onSeek.
    fireEvent.click(screen.getByTestId('jump-paste'));
    fireEvent.click(screen.getByTestId('jump-external'));
    fireEvent.click(screen.getByTestId('jump-flag'));
    fireEvent.click(screen.getByTestId('jump-file-switch'));
    expect(onSeek).not.toHaveBeenCalled();
  });
});
