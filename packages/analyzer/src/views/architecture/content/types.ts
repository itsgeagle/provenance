/** A deep link out of a node detail panel — source file, PRD section, or doc. */
export type ArchLink = { label: string; href: string };

/** Detail shown when a diagram node is selected. */
export type ArchNode = {
  /** Heading for the panel. Usually the node's label, spelled out. */
  title: string;
  /** Prose explanation. Plain text; rendered as paragraphs split on blank lines. */
  body: string;
  /** The load-bearing rule, if this node encodes one. Rendered as a callout. */
  invariant?: string;
  links?: ArchLink[];
};

/** Nodes are addressed as "<diagramId>:<dot node name>". */
export function nodeKey(diagram: string, name: string): string {
  return `${diagram}:${name}`;
}
