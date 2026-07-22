import type { ArchNode } from '../types.js';

/** Nodes in the `chain` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = ['edots'];
