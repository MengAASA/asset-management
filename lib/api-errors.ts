import { prisma } from "@/lib/prisma";

// Turns a caught error from a Prisma write into a short, user-readable message —
// never leaks Prisma's raw invocation dump/stack trace to the browser.
export function friendlyImportRowError(err: unknown, duplicateDescription?: string): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002" && duplicateDescription) return `${duplicateDescription} already exists.`;
    if (code === "P2000") return "One of the values is too long for its field.";
  }
  return "Could not import this row — please check the data format and try again.";
}

// Explains a unique-constraint clash on an employee write (email / staff ID), naming
// the employee who already holds the value. Returns null for any other error.
export async function employeeConflictMessage(
  err: unknown,
  data: { email?: string; staffId?: string | null }
): Promise<string | null> {
  if (typeof err !== "object" || err === null || (err as { code?: string }).code !== "P2002") return null;
  const target = String((err as { meta?: { target?: unknown } }).meta?.target ?? "");

  if (target.includes("staffId") && data.staffId) {
    const owner = await prisma.employee.findUnique({ where: { staffId: data.staffId } });
    return owner
      ? `Staff ID "${data.staffId}" already belongs to ${owner.name} (${owner.email}).`
      : `Staff ID "${data.staffId}" is already in use.`;
  }
  if (target.includes("email") && data.email) {
    const owner = await prisma.employee.findUnique({ where: { email: data.email } });
    return owner
      ? `Email ${data.email} already belongs to ${owner.name}.`
      : `Email ${data.email} is already in use.`;
  }
  return "A unique field (email or staff ID) is already in use.";
}
