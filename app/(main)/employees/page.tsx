"use client";

import { useEffect, useState, FormEvent } from "react";
import { Plus, Search, Edit2, Trash2, X, Mail, Phone, RefreshCw, Users, Loader, AlertTriangle, Trash } from "lucide-react";
import ConfirmModal from "@/components/ConfirmModal";
import { BASE_PATH } from "@/lib/utils";

interface Department {
  id: string;
  name: string;
  code: string;
}

interface Assignment {
  id: string;
  asset: {
    assetTag: string;
    name: string;
    category: { name: string };
  };
}

interface Employee {
  id: string;
  name: string;
  email: string;
  jobTitle: string;
  phone: string | null;
  staffId: string | null;
  department: Department;
  assignments: Assignment[];
}

interface ModalProps {
  employee: Employee | null;
  departments: Department[];
  onClose: () => void;
  onSaved: () => void;
}

function EmployeeModal({ employee, departments, onClose, onSaved }: ModalProps) {
  const isEdit = !!employee;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: employee?.name ?? "",
    email: employee?.email ?? "",
    jobTitle: employee?.jobTitle ?? "",
    phone: employee?.phone ?? "",
    staffId: employee?.staffId ?? "",
    departmentId: employee?.department.id ?? (departments[0]?.id ?? ""),
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) {
    setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const url = isEdit ? `${BASE_PATH}/api/employees/${employee.id}` : `${BASE_PATH}/api/employees`;
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to save");
        return;
      }
      onSaved();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-shell" style={{ maxWidth: 480 }}>
        <div className="modal-pinned-header">
          <h2 className="modal-title">{isEdit ? "Edit Employee" : "Add Employee"}</h2>
          <button className="p-1 rounded hover:bg-slate-100" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col" style={{ flex: 1, minHeight: 0 }}>
          <div className="modal-scroll-body">
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
              {error}
            </div>
          )}
          <div className="space-y-4">
            <div>
              <label className="form-label">Full Name *</label>
              <input name="name" value={form.name} onChange={handleChange} className="form-input" required />
            </div>
            <div>
              <label className="form-label">Email *</label>
              <input name="email" type="email" value={form.email} onChange={handleChange} className="form-input" required />
            </div>
            <div>
              <label className="form-label">Job Title *</label>
              <input name="jobTitle" value={form.jobTitle} onChange={handleChange} className="form-input" required />
            </div>
            <div>
              <label className="form-label">Phone</label>
              <input name="phone" value={form.phone} onChange={handleChange} className="form-input" placeholder="+971 50 000 0000" />
            </div>
            <div>
              <label className="form-label">Staff ID</label>
              <input name="staffId" value={form.staffId} onChange={handleChange} className="form-input" placeholder="e.g. S12345" />
            </div>
            <div>
              <label className="form-label">Department *</label>
              <select name="departmentId" value={form.departmentId} onChange={handleChange} className="form-input">
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>
          </div>
          </div>
          <div className="modal-pinned-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "Saving..." : isEdit ? "Save Changes" : "Add Employee"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface ADUser {
  dn: string;
  sAMAccountName: string;
  displayName: string;
  email: string;
  jobTitle: string;
  department: string;
  phone: string;
  alreadyImported: boolean;
  hasChanges: boolean;
  description: string;
}

interface ADSyncModalProps {
  departments: Department[];
  onClose: () => void;
  onImported: () => void;
}

const PAGE_SIZE = 50;
const SYNC_POLL_INTERVAL_MS = 1500;
// Safety net only — the server fails the request itself if the agent doesn't respond.
const SYNC_CLIENT_TIMEOUT_MS = 180_000;

function ADSyncModal({ departments, onClose, onImported }: ADSyncModalProps) {
  const [adUsers, setAdUsers] = useState<ADUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncStage, setSyncStage] = useState<"pending" | "processing">("pending");
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; updated: number; skipped: number } | null>(null);
  const [page, setPage] = useState(1);

  // Ask the on-prem agent for fresh AD data, then poll until it has pushed the users back
  useEffect(() => {
    let cancelled = false;

    async function runSync() {
      try {
        const res = await fetch(`${BASE_PATH}/api/ad/sync-request`, { method: "POST" });
        const d = await res.json();
        if (!res.ok) { setError(d.error ?? "Failed to start AD sync."); return; }

        const started = Date.now();
        while (!cancelled) {
          await new Promise((r) => setTimeout(r, SYNC_POLL_INTERVAL_MS));
          if (cancelled) return;

          const sRes = await fetch(`${BASE_PATH}/api/ad/sync-request/${d.id}`);
          const s = await sRes.json();
          if (!sRes.ok || s.status === "failed") { setError(s.error ?? "AD sync failed."); return; }
          if (s.status === "completed") {
            setAdUsers(s.users);
            setSyncedAt(s.completedAt);
            return;
          }
          setSyncStage(s.status);
          if (Date.now() - started > SYNC_CLIENT_TIMEOUT_MS) { setError("Timed out waiting for the AD server."); return; }
        }
      } catch {
        if (!cancelled) setError("Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    runSync();
    return () => { cancelled = true; };
  }, []);

  const totalPages = Math.max(1, Math.ceil(adUsers.length / PAGE_SIZE));
  const pageUsers = adUsers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelected(new Set(adUsers.filter((u) => !u.alreadyImported || u.hasChanges).map((u) => u.email)));
    } else {
      setSelected(new Set());
    }
  }

  function togglePage(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      pageUsers.filter((u) => !u.alreadyImported || u.hasChanges).forEach((u) =>
        checked ? next.add(u.email) : next.delete(u.email)
      );
      return next;
    });
  }

  function toggle(email: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(email) ? next.delete(email) : next.add(email);
      return next;
    });
  }

  const pageImportable = pageUsers.filter((u) => !u.alreadyImported || u.hasChanges);
  const allPageSelected = pageImportable.length > 0 && pageImportable.every((u) => selected.has(u.email));

  function generateDeptCode(name: string): string {
    const words = name.trim().split(/\s+/);
    const code = words.length === 1
      ? name.substring(0, 5).toUpperCase()
      : words.map((w) => w[0]).join("").toUpperCase();
    return code.substring(0, 20);
  }

  async function handleImport() {
    setImporting(true);
    const toImport = adUsers.filter((u) => selected.has(u.email));
    let imported = 0;
    let updated = 0;
    let skipped = 0;

    // Build dept map from existing departments (case-insensitive)
    const deptMap = new Map(departments.map((d) => [d.name.toLowerCase(), d.id]));

    // Auto-create any AD departments not yet in the system
    const uniqueADDepts = [...new Set(toImport.map((u) => u.department).filter(Boolean))];
    for (const deptName of uniqueADDepts) {
      if (!deptMap.has(deptName.toLowerCase())) {
        const res = await fetch(`${BASE_PATH}/api/departments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: deptName, code: generateDeptCode(deptName) }),
        });
        if (res.ok) {
          const created = await res.json();
          deptMap.set(deptName.toLowerCase(), created.id);
        }
      }
    }

    for (const u of toImport) {
      const deptId = deptMap.get(u.department.toLowerCase());
      if (!deptId) { skipped++; continue; }

      const payload = {
        name: u.displayName,
        email: u.email,
        jobTitle: u.jobTitle || "Staff",
        phone: u.phone || null,
        staffId: u.description || null,
        departmentId: deptId,
      };

      if (u.alreadyImported) {
        // Update existing employee — look up by email first
        const empRes = await fetch(`${BASE_PATH}/api/employees?search=${encodeURIComponent(u.email)}`);
        if (!empRes.ok) { skipped++; continue; }
        const empList = await empRes.json();
        const existing = empList.find((e: { email: string }) => e.email.toLowerCase() === u.email.toLowerCase());
        if (!existing) { skipped++; continue; }
        const putRes = await fetch(`${BASE_PATH}/api/employees/${existing.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        putRes.ok ? updated++ : skipped++;
      } else {
        const res = await fetch(`${BASE_PATH}/api/employees`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        res.ok ? imported++ : skipped++;
      }
    }

    setImporting(false);
    setImportResult({ imported, updated, skipped });
    setTimeout(() => onImported(), 1500);
  }


  const showResults = !loading && !error && !importResult && adUsers.length > 0;

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-shell" style={{ maxWidth: 700, maxHeight: "80vh" }}>
        <div className="modal-pinned-header">
          <h2 className="modal-title flex items-center gap-2">
            <Users size={18} /> Sync from Active Directory
          </h2>
          <button className="p-1 rounded hover:bg-slate-100" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="flex flex-col" style={{ flex: 1, minHeight: 0, padding: "1.25rem 1.5rem", overflow: "hidden" }}>
        {loading && (
          <div className="flex items-center justify-center gap-3 py-12 text-slate-500">
            <Loader size={20} className="animate-spin" />
            {syncStage === "pending" ? "Waiting for the AD server..." : "Reading users from Active Directory..."}
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 p-4 rounded-lg bg-amber-50 text-amber-800 text-sm" style={{ border: "1px solid #fde68a" }}>
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <div className="font-medium mb-1">Unable to sync</div>
              <div>{error}</div>
              {error.includes("agent") && (
                <a href={`${BASE_PATH}/settings`} className="text-blue-600 underline mt-1 block">
                  Go to Settings → AD Sync Agent
                </a>
              )}
            </div>
          </div>
        )}

        {importResult && (
          <div className="p-4 rounded-lg bg-green-50 text-green-800 text-sm text-center" style={{ border: "1px solid #bbf7d0" }}>
            <div className="font-semibold mb-1">Sync complete</div>
            {importResult.imported > 0 && <span>{importResult.imported} imported</span>}
            {importResult.imported > 0 && importResult.updated > 0 && <span> · </span>}
            {importResult.updated > 0 && <span>{importResult.updated} updated</span>}
            {importResult.skipped > 0 && <span> · {importResult.skipped} skipped</span>}
          </div>
        )}

        {showResults && (
          <>
            {/* Stats + select controls */}
            <div className="flex items-center justify-between mb-3 px-1 flex-wrap gap-2">
              <div className="text-sm text-slate-500">
                {adUsers.length} users · {adUsers.filter((u) => !u.alreadyImported).length} new · {adUsers.filter((u) => u.alreadyImported && u.hasChanges).length} changed · {selected.size} selected
                {syncedAt && (
                  <span className="text-xs text-slate-400"> · fetched {new Date(syncedAt).toLocaleTimeString()}</span>
                )}
              </div>
              <div className="flex items-center gap-4 text-sm text-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={allPageSelected} onChange={(e) => togglePage(e.target.checked)} />
                  This page
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={adUsers.filter((u) => !u.alreadyImported || u.hasChanges).length > 0 && adUsers.filter((u) => !u.alreadyImported || u.hasChanges).every((u) => selected.has(u.email))}
                    onChange={(e) => toggleAll(e.target.checked)}
                  />
                  All pages
                </label>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-auto flex-1 rounded-lg scroll-light" style={{ border: "1px solid #e2e8f0" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Staff Id</th>
                    <th>Job Title</th>
                    <th>Department</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pageUsers.map((u) => {
                    const upToDate = u.alreadyImported && !u.hasChanges;
                    return (
                      <tr key={u.dn} style={{ opacity: upToDate ? 0.45 : 1 }}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(u.email)}
                            disabled={upToDate}
                            onChange={() => toggle(u.email)}
                          />
                        </td>
                        <td className="font-medium text-sm">{u.displayName}</td>
                        <td className="text-sm text-slate-500">{u.email}</td>
                        <td className="text-sm text-slate-500">{u.description}</td>
                        <td className="text-sm">{u.jobTitle || "—"}</td>
                        <td className="text-sm">{u.department || "—"}</td>
                        <td>
                          {u.alreadyImported && u.hasChanges ? (
                            <span className="badge bg-amber-100 text-amber-700">Has Changes</span>
                          ) : u.alreadyImported ? (
                            <span className="badge bg-green-100 text-green-700">Up to date</span>
                          ) : (
                            <span className="badge bg-slate-100 text-slate-600">New</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 px-1">
                <div className="text-xs text-slate-400">
                  Page {page} of {totalPages} · showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, adUsers.length)} of {adUsers.length}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    className="btn btn-secondary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setPage(1)}
                    disabled={page === 1}
                  >
                    «
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setPage((p) => p - 1)}
                    disabled={page === 1}
                  >
                    ‹ Prev
                  </button>

                  {/* Page number buttons — show up to 5 around current page */}
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                    .reduce<(number | "...")[]>((acc, p, i, arr) => {
                      if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("...");
                      acc.push(p);
                      return acc;
                    }, [])
                    .map((p, i) =>
                      p === "..." ? (
                        <span key={`ellipsis-${i}`} className="px-1 text-slate-400 text-xs">…</span>
                      ) : (
                        <button
                          key={p}
                          className="btn"
                          style={{
                            padding: "4px 10px",
                            fontSize: 12,
                            background: p === page ? "#3b82f6" : undefined,
                            color: p === page ? "white" : undefined,
                            border: p === page ? "none" : undefined,
                          }}
                          onClick={() => setPage(p as number)}
                        >
                          {p}
                        </button>
                      )
                    )}

                  <button
                    className="btn btn-secondary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page === totalPages}
                  >
                    Next ›
                  </button>
                  <button
                    className="btn btn-secondary"
                    style={{ padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setPage(totalPages)}
                    disabled={page === totalPages}
                  >
                    »
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {!loading && !error && !importResult && adUsers.length === 0 && (
          <div className="text-center py-10 text-slate-400">No users found in Active Directory.</div>
        )}
        </div>

        {showResults && (
          <div className="modal-pinned-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
            >
              {importing ? (
                <><Loader size={14} className="animate-spin" /> Importing...</>
              ) : (
                <><Users size={14} /> Import {selected.size} Employee{selected.size !== 1 ? "s" : ""}</>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function EmployeesPage() {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showModal, setShowModal] = useState(false);
  const [editEmployee, setEditEmployee] = useState<Employee | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showADModal, setShowADModal] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);

  async function fetchAll() {
    const params = search ? `?search=${encodeURIComponent(search)}` : "";
    const [empRes, deptRes] = await Promise.all([
      fetch(`${BASE_PATH}/api/employees${params}`),
      fetch(`${BASE_PATH}/api/departments`),
    ]);
    if (empRes.ok) setEmployees(await empRes.json());
    if (deptRes.ok) setDepartments(await deptRes.json());
    setLoading(false);
  }

  useEffect(() => { setPage(1); fetchAll(); }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDelete() {
    if (!deleteId) return;
    const res = await fetch(`${BASE_PATH}/api/employees/${deleteId}`, { method: "DELETE" });
    setDeleteId(null);
    if (res.ok) fetchAll();
  }

  async function handleBulkDelete() {
    await Promise.all([...selected].map((id) => fetch(`${BASE_PATH}/api/employees/${id}`, { method: "DELETE" })));
    setSelected(new Set());
    setShowBulkConfirm(false);
    fetchAll();
  }

  function toggleSelect(id: string) {
    setSelected((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function toggleSelectAll(checked: boolean) {
    setSelected(checked ? new Set(employees.map((e) => e.id)) : new Set());
  }

  return (
    <div className="flex flex-col h-full">
      <div className="page-header">
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-subtitle">{employees.length} IT department members</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-secondary" onClick={() => setShowADModal(true)}>
            <RefreshCw size={15} /> Sync from AD
          </button>
          <button className="btn btn-primary" onClick={() => { setEditEmployee(null); setShowModal(true); }}>
            <Plus size={16} /> Add Employee
          </button>
        </div>
      </div>

      <div className="filter-bar">
        <div className="search-input" style={{ flex: 1, maxWidth: 340 }}>
          <Search size={15} color="#9ca3af" />
          <input
            type="text"
            placeholder="Search by name, email, title, staff ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {(() => {
        const totalPages = Math.max(1, Math.ceil(employees.length / PAGE_SIZE));
        const pageEmployees = employees.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        console.log("page employees: ", pageEmployees);
        return (
          <>
      {selected.size > 0 && (
        <div className="flex items-center justify-between px-4 py-2 mb-2 rounded-lg bg-red-50 text-red-700 text-sm" style={{ border: "1px solid #fecaca" }}>
          <span>{selected.size} item{selected.size !== 1 ? "s" : ""} selected</span>
          <button className="btn btn-danger flex items-center gap-1" onClick={() => setShowBulkConfirm(true)}>
            <Trash size={14} /> Delete Selected
          </button>
        </div>
      )}
      <div className="card scroll-light" style={{ padding: 0, overflowX: "scroll", overflowY: "auto", flex: 1, minHeight: 0 }}>
        {loading ? (
          <div className="empty-state text-slate-400">Loading employees...</div>
        ) : employees.length === 0 ? (
          <div className="empty-state">No employees found.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={employees.length > 0 && selected.size === employees.length} onChange={(e) => toggleSelectAll(e.target.checked)} />
                </th>
                <th>Name</th>
                <th>Email</th>
                <th>Staff Id</th>
                <th>Job Title</th>
                <th>Department</th>
                <th>Phone</th>
                <th>Assets</th>
                <th style={{ width: 80 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageEmployees.map((emp) => (
                <tr key={emp.id}>
                  <td>
                    <input type="checkbox" checked={selected.has(emp.id)} onChange={() => toggleSelect(emp.id)} />
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div
                        className="flex items-center justify-center rounded-full text-white text-xs font-semibold"
                        style={{
                          width: 32, height: 32, flexShrink: 0,
                          background: "#3b82f6",
                        }}
                      >
                        {emp.name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase()}
                      </div>
                      <span className="font-medium text-sm">{emp.name}</span>
                    </div>
                  </td>
                  <td>
                    <a href={`mailto:${emp.email}`} className="text-sm text-blue-600 flex items-center gap-1">
                      <Mail size={12} /> {emp.email}
                    </a>
                  </td>
                  <td className="text-sm">{emp.staffId ?? "—"}</td>

                  <td className="text-sm">{emp.jobTitle}</td>
                  <td>
                    <span className="badge bg-blue-50 text-blue-700">{emp.department.code}</span>
                  </td>
                  <td className="text-sm text-slate-600">
                    {emp.phone ? (
                      <span className="flex items-center gap-1"><Phone size={12} /> {emp.phone}</span>
                    ) : "—"}
                  </td>
                  <td>
                    <span className="font-medium text-sm">{emp.assignments.length}</span>
                    {emp.assignments.length > 0 && (
                      <div className="text-xs text-slate-400">
                        {emp.assignments.slice(0, 2).map(a => a.asset.category.name).join(", ")}
                        {emp.assignments.length > 2 ? "..." : ""}
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <button
                        className="p-1.5 rounded hover:bg-slate-100 text-slate-500 hover:text-blue-600"
                        onClick={() => { setEditEmployee(emp); setShowModal(true); }}
                      >
                        <Edit2 size={14} />
                      </button>
                      <button
                        className="p-1.5 rounded hover:bg-red-50 text-slate-500 hover:text-red-600"
                        onClick={() => setDeleteId(emp.id)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <div className="text-sm text-slate-500">
            Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, employees.length)} of {employees.length} employees
          </div>
          <div className="flex items-center gap-1">
            <button className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPage(1)} disabled={page === 1}>«</button>
            <button className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPage((p) => p - 1)} disabled={page === 1}>‹ Prev</button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
              .reduce<(number | "...")[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("...");
                acc.push(p);
                return acc;
              }, [])
              .map((p, i) =>
                p === "..." ? (
                  <span key={`e-${i}`} className="px-1 text-slate-400 text-sm">…</span>
                ) : (
                  <button
                    key={p}
                    className="btn"
                    style={{ padding: "4px 10px", fontSize: 12, background: p === page ? "#3b82f6" : undefined, color: p === page ? "white" : undefined, border: p === page ? "none" : undefined }}
                    onClick={() => setPage(p as number)}
                  >
                    {p}
                  </button>
                )
              )}
            <button className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPage((p) => p + 1)} disabled={page === totalPages}>Next ›</button>
            <button className="btn btn-secondary" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</button>
          </div>
        </div>
      )}
          </>
        );
      })()}

      {deleteId && (
        <ConfirmModal
          title="Delete Employee"
          message="Are you sure you want to delete this employee? This action cannot be undone."
          confirmLabel="Delete"
          variant="danger"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {showBulkConfirm && (
        <ConfirmModal
          title="Delete Selected Employees"
          message={`Are you sure you want to delete ${selected.size} employee${selected.size !== 1 ? "s" : ""}? This action cannot be undone.`}
          confirmLabel={`Delete ${selected.size}`}
          variant="danger"
          onConfirm={handleBulkDelete}
          onCancel={() => setShowBulkConfirm(false)}
        />
      )}

      {showModal && (
        <EmployeeModal
          employee={editEmployee}
          departments={departments}
          onClose={() => setShowModal(false)}
          onSaved={() => { setShowModal(false); fetchAll(); }}
        />
      )}

      {showADModal && (
        <ADSyncModal
          departments={departments}
          onClose={() => setShowADModal(false)}
          onImported={() => { setShowADModal(false); fetchAll(); }}
        />
      )}
    </div>
  );
}
