/**
 * Thin wrapper around the `canonicalize` npm package.
 * Produces RFC 8785 (JCS) canonical JSON — deterministic key ordering,
 * no extra whitespace, consistent number representation.
 * Used for hashing in the hash chain (PRD §5.2).
 */

import jcsSerialize from 'canonicalize';

/**
 * Serialize a value to its RFC 8785 canonical JSON representation.
 * Throws on NaN, Infinity, or circular references (propagated from the library).
 */
export function canonicalize(value: unknown): string {
  const result = jcsSerialize(value);
  if (result === undefined) {
    // The library returns undefined for `undefined` inputs; treat as an error
    // since `undefined` is not valid JSON and should never appear in an envelope.
    throw new TypeError('canonicalize: value serialized to undefined (likely `undefined` input)');
  }
  return result;
}
