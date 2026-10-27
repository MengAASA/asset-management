import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { markAgentSeen, sanitizeADUsers, verifyAgentKey } from "@/lib/ad-sync";

// Called by the on-prem agent with the AD users for a claimed request,
// or with { requestId, error } if the AD query failed.
export async function POST(req: NextRequest) {
  if (!(await verifyAgentKey(req))) {
    return NextResponse.json({ error: "Invalid agent key" }, { status: 401 });
  }

  await markAgentSeen();

  let body: { requestId?: string; users?: unknown; error?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.requestId) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

  const request = await prisma.adSyncRequest.findUnique({ where: { id: body.requestId } });
  if (!request || request.status !== "processing") {
    return NextResponse.json({ error: "Request is not awaiting results" }, { status: 409 });
  }

  if (body.error) {
    await prisma.adSyncRequest.update({
      where: { id: request.id },
      data: { status: "failed", error: String(body.error).slice(0, 2000), completedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  }

  if (!Array.isArray(body.users)) {
    return NextResponse.json({ error: "users must be an array" }, { status: 400 });
  }

  const users = sanitizeADUsers(body.users);
  await prisma.adSyncRequest.update({
    where: { id: request.id },
    data: { status: "completed", payload: JSON.stringify(users), completedAt: new Date() },
  });

  return NextResponse.json({ ok: true, received: users.length });
}
