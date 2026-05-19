import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from './dialog.js';

describe('Dialog', () => {
  it('renders trigger text', () => {
    render(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Test Title</DialogTitle>
          <DialogDescription>Test description</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByText('Open dialog')).toBeInTheDocument();
  });
});
