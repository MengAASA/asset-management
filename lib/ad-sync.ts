import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const AGENT_KEY_CONFIG = "ad_agent_key_hash";
export const AGENT_LAST_SEEN_CONFIG = "ad_agent_last_seen";

// A request the agent hasn't picked up within this window is treated as failed.
export const CLAIM_TIMEOUT_MS = 30_000;
// Once claimed, the agent has this long to push the users back.
export const PROCESS_TIMEOUT_MS = 120_000;

export interface ADUser {
  dn: string;
  sAMAccountName: string;
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  phone: string;
  manager: string;
  office: string;
  description: string;
  assignedDevices: string[]; // computer names from AD managedBy
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateAgentKey(): { key: string; hash: string } {
  const key = randomBytes(32).toString("base64url");
  return { key, hash: hashKey(key) };
}

/** Checks the X-Agent-Key header against the stored key hash. */
export async function verifyAgentKey(req: NextRequest): Promise<boolean> {
  const key = req.headers.get("x-agent-key");
  if (!key) return false;

  const row = await prisma.systemConfig.findUnique({ where: { key: AGENT_KEY_CONFIG } });
  if (!row) return false;

  const expected = Buffer.from(row.value, "hex");
  const actual = Buffer.from(hashKey(key), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function markAgentSeen() {
  const value = new Date().toISOString();
  await prisma.systemConfig.upsert({
    where: { key: AGENT_LAST_SEEN_CONFIG },
    update: { value },
    create: { key: AGENT_LAST_SEEN_CONFIG, value },
  });
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

/** Normalises the agent's JSON into ADUser[], dropping rows without name/email and duplicate emails. */
export function sanitizeADUsers(raw: unknown[]): ADUser[] {
  const seenEmails = new Set<string>();
  const users: ADUser[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const u = item as Record<string, unknown>;
    const devices = Array.isArray(u.assignedDevices) ? u.assignedDevices : u.assignedDevices ? [u.assignedDevices] : [];

    const user: ADUser = {
      dn: str(u.dn),
      sAMAccountName: str(u.sAMAccountName),
      displayName: str(u.displayName),
      email: str(u.email),
      jobTitle: str(u.jobTitle),
      department: str(u.department),
      phone: str(u.phone),
      manager: str(u.manager),
      office: str(u.office),
      description: str(u.description),
      assignedDevices: devices.map(str).filter(Boolean),
    };

    if (!user.displayName || !user.email) continue;
    const key = user.email.toLowerCase();
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    users.push(user);
  }

  return users;
}

/** Flags each AD user as new / already imported / changed compared to the employee table. */
export async function compareWithEmployees(adUsers: ADUser[]) {
  const existingEmployees = await prisma.employee.findMany({
    include: { department: true },
  });
  const existingMap = new Map(existingEmployees.map((e) => [e.email.toLowerCase(), e]));

  return adUsers
    .filter((u) => u.department && u.department.trim() !== "")
    .map((u) => {
      const existing = existingMap.get(u.email.toLowerCase());
      if (!existing) return { ...u, alreadyImported: false, hasChanges: false };

      const hasChanges =
        (u.displayName || "") !== (existing.name || "") ||
        (u.jobTitle || "") !== (existing.jobTitle || "") ||
        (u.phone || "") !== (existing.phone || "") ||
        (u.description || "") !== (existing.staffId || "") ||
        (u.department || "") !== (existing.department?.name || "");

      return { ...u, alreadyImported: true, hasChanges };
    });
}
