/**
 * Storage outage plumbing. Vercel Blob "advanced operations" quota
 * incidents surface as HTTP 403 on every blob read; without this, read
 * paths return empty results (empty closet, null avatar) and the UI lies.
 * Lib code throws StorageUnavailableError, routes map it to a 503 with a
 * stable code, and the UI shows one friendly line — never empty state.
 */

export class StorageUnavailableError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Blob storage unavailable (HTTP ${status}) for ${path}`);
    this.name = "StorageUnavailableError";
    this.status = status;
    this.path = path;
  }
}

export function isStorageUnavailable(err: unknown): err is StorageUnavailableError {
  return err instanceof StorageUnavailableError;
}

/** 503 for storage outages; the UI shows the friendly line, never raw text. */
export function storageUnavailableResponse(message?: string): Response {
  return Response.json(
    {
      error:
        message ??
        "Can't reach your closet right now. Your pieces are safe - try again in a minute.",
      code: "storage_unavailable",
    },
    { status: 503 },
  );
}
