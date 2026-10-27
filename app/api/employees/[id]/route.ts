import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActingUser, logAudit } from "@/lib/audit";
import { employeeConflictMessage } from "@/lib/api-errors";

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Kept outside the try so the catch can explain unique-field clashes
  let submitted: { email?: string; staffId?: string | null } = {};
  try {
    const { id } = await params;
    const body = await req.json();
    submitted = body;
    const before = await prisma.employee.findUnique({ where: { id } });
    const employee = await prisma.employee.update({
      where: { id },
      data: {
        name: body.name,
        email: body.email,
        jobTitle: body.jobTitle,
        phone: body.phone || null,
        staffId: body.staffId || null,
        departmentId: body.departmentId,
      },
      include: { department: true },
    });

    const user = await getActingUser(req);
    await logAudit({
      entityType: "Employee",
      entityId: employee.id,
      entityLabel: employee.name,
      action: "UPDATE",
      user,
      before,
      after: employee,
    });

    return NextResponse.json(employee);
  } catch (error) {
    const conflict = await employeeConflictMessage(error, submitted);
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
    console.error(error);
    return NextResponse.json({ error: "Failed to update employee" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const before = await prisma.employee.findUnique({ where: { id } });
    await prisma.employee.delete({ where: { id } });

    const user = await getActingUser(req);
    await logAudit({
      entityType: "Employee",
      entityId: id,
      entityLabel: before?.name,
      action: "DELETE",
      user,
      before,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to delete employee" }, { status: 500 });
  }
}
