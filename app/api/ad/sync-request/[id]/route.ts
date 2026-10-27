import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/jwt";
import { ADUser, CLAIM_TIMEOUT_MS, PROCESS_TIMEOUT_MS, compareWithEmployees } from "@/lib/ad-sync";

// Polled by the sync modal until the agent has pushed the users (or the request times out).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = req.cookies.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const request = await prisma.adSyncRequest.findUnique({ where: { id } });
  if (!request) {
    return NextResponse.json({ error: "Sync request not found." }, { status: 404 });
  }

  const now = Date.now();
  let { status, error } = request;

  if (status === "pending" && now - request.createdAt.getTime() > CLAIM_TIMEOUT_MS) {
    status = "failed";
    error = "The AD sync agent did not respond. Check that the scheduled task is running on the internal server.";
  } else if (status === "processing" && request.claimedAt && now - request.claimedAt.getTime() > PROCESS_TIMEOUT_MS) {
    status = "failed";
    error = "The AD sync agent started but did not finish. Check the agent log on the internal server.";
  }

  if (status !== request.status) {
    await prisma.adSyncRequest.updateMany({
      where: { id, status: request.status },
      data: { status, error, completedAt: new Date() },
    });
  }

  if (status === "failed") {
    return NextResponse.json({ status, error });
  }

  if (status === "completed") {
    const adUsers: ADUser[] = JSON.parse(request.payload ?? "[]");
    const users = await compareWithEmployees(adUsers);
    return NextResponse.json({ status, completedAt: request.completedAt, users });
  }

  return NextResponse.json({ status });
}
