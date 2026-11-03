// Tape-label text for a garment. Prefers the Spark nickname (at most two
// playful words); falls back to "<primary_color> <type>" when missing.

export interface TapeLabelLike {
  nickname?: string | null;
  primary_color: string;
  type: string;
}

export function tapeLabel(item: TapeLabelLike): string {
  const nick = (item.nickname ?? "").trim();
  if (nick) return nick;
  return `${item.primary_color} ${item.type}`.trim();
}
