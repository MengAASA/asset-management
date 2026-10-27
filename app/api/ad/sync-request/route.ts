import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/jwt";
import { CLAIM_TIMEOUT_MS, PROCESS_TIMEOUT_MS } from "@/lib/ad-sync";

// Called by the "Sync from AD" button. Creates a request for the on-prem agent to pick up.
export async function POST(req: NextRequest) {
  const token = req.cookies.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Housekeeping: payloads can be large, keep only the last day of requests
  await prisma.adSyncRequest.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
  });

  // If someone else just clicked Sync, share their request instead of queueing another
  const inFlight = await prisma.adSyncRequest.findFirst({
    where: {
      OR: [
        { status: "pending", createdAt: { gte: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
        { status: "processing", claimedAt: { gte: new Date(Date.now() - PROCESS_TIMEOUT_MS) } },
      ],
    },
    orderBy: { createdAt: "desc" },
  });
  if (inFlight) return NextResponse.json({ id: inFlight.id });

  const request = await prisma.adSyncRequest.create({
    data: { requestedBy: user.name || user.email },
  });

  return NextResponse.json({ id: request.id }, { status: 201 });
}
