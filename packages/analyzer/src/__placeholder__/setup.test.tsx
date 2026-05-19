import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App.js';

describe('App placeholder routes', () => {
  it('renders the load placeholder at /load', () => {
    render(
      <MemoryRouter initialEntries={['/load']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('load-placeholder')).toBeInTheDocument();
  });

  it('renders the overview placeholder at /overview', () => {
    render(
      <MemoryRouter initialEntries={['/overview']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('overview-placeholder')).toBeInTheDocument();
  });

  it('renders the timeline placeholder at /timeline', () => {
    render(
      <MemoryRouter initialEntries={['/timeline']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('timeline-placeholder')).toBeInTheDocument();
  });

  it('redirects / to /load', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('load-placeholder')).toBeInTheDocument();
  });
});
