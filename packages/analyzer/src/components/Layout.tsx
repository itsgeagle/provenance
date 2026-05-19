/**
 * Layout — top-bar (Header) + content slot.
 *
 * Used by overview and timeline views. The Header hides itself when no
 * bundle is loaded, so Layout can be used on /load too if needed (it renders
 * just the children in that case).
 */

import type { ReactNode } from 'react';
import { Header } from './Header.js';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Header />
      <main className="flex-1">{children}</main>
    </div>
  );
}
