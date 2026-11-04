import { NextResponse } from "next/server";

import { getBlobStore } from "@/lib/cache";
import { avatarWeeklyLimit, checkAvatarAllowance } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** Redos left this rolling week (the confirm sheet shows the count). */
export async function GET() {
  const allowance = await checkAvatarAllowance(getBlobStore(), Date.now());
  return NextResponse.json({
    remaining: allowance.remaining,
    total: avatarWeeklyLimit(),
    resetAt: allowance.resetAt,
  });
}
