/**
 * Minimal NDJSON framing helper (no I/O): feed streamed text chunks, get
 * back complete parsed objects. Split lines and invalid JSON are skipped.
 */

export function createNDJSONParser(onEvent: (event: unknown) => void): {
  feed: (chunk: string) => void;
} {
  let buffer = "";
  return {
    feed(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          try {
            onEvent(JSON.parse(line) as unknown);
          } catch {
            // Skip malformed lines; the stream stays usable.
          }
        }
        newline = buffer.indexOf("\n");
      }
    },
  };
}
