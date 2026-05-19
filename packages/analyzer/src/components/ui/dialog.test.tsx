import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DrawerContent,
  DialogTitle,
  DialogDescription,
} from './dialog.js';

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

  it('renders DrawerContent with title and description', () => {
    render(
      <Dialog defaultOpen>
        <DrawerContent>
          <DialogTitle>Test drawer</DialogTitle>
          <DialogDescription>Some description</DialogDescription>
        </DrawerContent>
      </Dialog>,
    );
    expect(screen.getByText('Test drawer')).toBeInTheDocument();
    expect(screen.getByText('Some description')).toBeInTheDocument();
  });
});
