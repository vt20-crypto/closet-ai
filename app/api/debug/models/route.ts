import { NextResponse } from "next/server";

import { getMetaClient } from "@/lib/meta/client";

export const dynamic = "force-dynamic";

// TODO: delete after the hackathon. Temporary diagnostic for the Meta ticket:
// lists which model ids are visible from the deployed region. Never returns
// or logs the key, and touches no user data.
export async function GET() {
  try {
    const client = getMetaClient();
    const list = await client.models.list();
    const ids = list.data.map((model) => model.id);
    return NextResponse.json({
      region: process.env.VERCEL_REGION ?? "local",
      count: ids.length,
      hasImage: ids.includes("muse-image-1.0"),
      hasSpark13: ids.includes("muse-spark-1.3"),
      ids,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Models list failed.";
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 500 });
  }
}
