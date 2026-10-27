import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CLAIM_TIMEOUT_MS, markAgentSeen, verifyAgentKey } from "@/lib/ad-sync";

// Long-poll: held open until a sync request arrives or this many ms pass.
// Kept well under typical reverse-proxy read timeouts (nginx defaults to 60s).
const HOLD_MS = 25_000;
const CHECK_INTERVAL_MS = 1_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Called by the on-prem agent (scripts/ad-sync-agent.ps1). Authenticated by X-Agent-Key, not the login cookie.
export async function GET(req: NextRequest) {
  if (!(await verifyAgentKey(req))) {
    return NextResponse.json({ error: "Invalid agent key" }, { status: 401 });
  }

  await markAgentSeen();
  // ?wait=<seconds> lets the agent shorten the final poll of a scheduled run
  const waitParam = Number(req.nextUrl.searchParams.get("wait"));
  const holdMs = waitParam > 0 ? Math.min(waitParam * 1000, HOLD_MS) : HOLD_MS;
  const deadline = Date.now() + holdMs;

  while (!req.signal.aborted) {
    const pending = await prisma.adSyncRequest.findFirst({
      where: { status: "pending", createdAt: { gte: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
      orderBy: { createdAt: "asc" },
    });

    if (pending) {
      // Claim atomically so the request is only processed once
      const { count } = await prisma.adSyncRequest.updateMany({
        where: { id: pending.id, status: "pending" },
        data: { status: "processing", claimedAt: new Date() },
      });
      if (count === 1) return NextResponse.json({ requestId: pending.id });
      continue;
    }

    if (Date.now() >= deadline) break;
    await sleep(CHECK_INTERVAL_MS);
  }

  return NextResponse.json({ requestId: null });
}
