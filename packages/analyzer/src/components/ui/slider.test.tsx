import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Slider } from './slider.js';

describe('Slider', () => {
  it('forwards aria-label to the thumb as the accessible name', () => {
    render(<Slider aria-label="Scrub position" defaultValue={[3]} max={10} />);
    expect(screen.getByRole('slider', { name: /scrub position/i })).toBeInTheDocument();
  });

  it('forwards aria-valuetext to the thumb', () => {
    render(
      <Slider
        aria-label="Scrub position"
        aria-valuetext="event 3 of 10"
        defaultValue={[3]}
        max={10}
      />,
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', 'event 3 of 10');
  });
});
