import { NextResponse } from "next/server";

import { deleteItem, listItems, saveItem, type ClosetItem } from "@/lib/closet";
import { validateItemEdit } from "@/lib/itemEdit";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing item id." }, { status: 400 });
    await deleteItem(id);
    return NextResponse.json({ deleted: id });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not delete the item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Edit tags (nickname, type, color, fit axes, warmth, formality). Axes
 * re-validate against the merged type; updatedAt busts the outfit and
 * render caches for looks containing this item.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "Missing item id." }, { status: 400 });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Send JSON: fields to change." }, { status: 400 });
    }
    const items = await listItems();
    const item = items.find((entry) => entry.id === id);
    if (!item) return NextResponse.json({ error: "Unknown item." }, { status: 404 });
    const { tags, error } = validateItemEdit(body, item.tags);
    if (!tags) return NextResponse.json({ error }, { status: 400 });
    if (body.laundry !== undefined && typeof body.laundry !== "boolean") {
      return NextResponse.json({ error: "laundry must be true or false." }, { status: 400 });
    }
    const updated: ClosetItem = {
      ...item,
      tags: { ...item.tags, ...tags },
      updatedAt: new Date().toISOString(),
    };
    if (typeof body.laundry === "boolean") updated.laundry = body.laundry;
    await saveItem(updated, { allowOverwrite: true });
    return NextResponse.json({ item: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save the item.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
