/**
 * Pure photo-pathname helpers (no I/O, no server-only import) so they stay
 * unit-testable under plain node:test.
 */

/** Only single-level pathnames inside our own photos/ prefix. */
export function isPhotoPathname(value: unknown): value is string {
  return (
    typeof value === "string" && /^photos\/[^/]+$/.test(value) && !value.includes("..")
  );
}

export function photoMetaPath(photoPathname: string): string {
  return `photos-meta/${photoPathname}.json`;
}
