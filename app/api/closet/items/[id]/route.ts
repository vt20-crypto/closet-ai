import { NextResponse } from "next/server";

import { deleteItem } from "@/lib/closet";

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
