import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyToken } from "@/lib/jwt";
import { AGENT_KEY_CONFIG, AGENT_LAST_SEEN_CONFIG, generateAgentKey } from "@/lib/ad-sync";

async function requireAdmin(req: NextRequest) {
  const token = req.cookies.get("token")?.value;
  const user = token ? await verifyToken(token) : null;
  if (!user || user.role !== "admin") return null;
  return user;
}

// Agent status for the Settings page: whether a key exists and when the agent last checked in.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: [AGENT_KEY_CONFIG, AGENT_LAST_SEEN_CONFIG] } },
  });
  const keyRow = rows.find((r) => r.key === AGENT_KEY_CONFIG);
  const seenRow = rows.find((r) => r.key === AGENT_LAST_SEEN_CONFIG);

  return NextResponse.json({
    configured: !!keyRow,
    keyCreatedAt: keyRow?.updatedAt ?? null,
    lastSeen: seenRow?.value ?? null,
  });
}

// Generates a new agent key. The plain key is returned once; only its hash is stored.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key, hash } = generateAgentKey();
  await prisma.systemConfig.upsert({
    where: { key: AGENT_KEY_CONFIG },
    update: { value: hash },
    create: { key: AGENT_KEY_CONFIG, value: hash },
  });

  return NextResponse.json({ key });
}
