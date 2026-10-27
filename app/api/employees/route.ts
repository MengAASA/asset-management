import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getActingUser, logAudit } from "@/lib/audit";
import { employeeConflictMessage } from "@/lib/api-errors";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search");

    const where = search
      ? {
          OR: [
            { name: { contains: search } },
            { email: { contains: search } },
            { jobTitle: { contains: search } },
            { staffId: { contains: search } },
          ],
        }
      : {};

    const employees = await prisma.employee.findMany({
      where,
      include: {
        department: true,
        assignments: {
          where: { returnedDate: null },
          include: { asset: { include: { category: true } } },
        },
      },
      orderBy: { name: "asc" },
    });

    return NextResponse.json(employees);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Failed to fetch employees" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Kept outside the try so the catch can explain unique-field clashes
  let submitted: { email?: string; staffId?: string | null } = {};
  try {
    const body = await req.json();
    submitted = body;
    const employee = await prisma.employee.create({
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
      action: "CREATE",
      user,
      after: employee,
    });

    return NextResponse.json(employee, { status: 201 });
  } catch (error) {
    const conflict = await employeeConflictMessage(error, submitted);
    if (conflict) return NextResponse.json({ error: conflict }, { status: 409 });
    console.error(error);
    return NextResponse.json({ error: "Failed to create employee" }, { status: 500 });
  }
}
