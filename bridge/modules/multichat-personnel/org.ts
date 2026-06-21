// org.ts — Organisation registry for the personnel roster.
//
// A single JSON file, bridge/employees/org.json, is the source of truth
// for the org chart: departments → teams → member employee-ids, plus
// descriptive metadata (label, description, lead, system-prompt context)
// the `recruit-team` skill / agent-tools MCP use to build and explain
// teams.
//
// Membership lives ONLY here (not mirrored into per-employee frontmatter)
// so there's a single source of truth that can't drift. The Personnel
// dropdown reads /v1/org/ alongside /v1/employees/ and groups the tiles;
// any employee not listed under a team renders in an "Unassigned" bucket.
//
// Shape:
//   { departments: [
//       { id, label, description,
//         teams: [ { id, label, description, lead, context, members: [empId] } ] }
//   ] }
'use strict';

const fs = require('fs');
const path = require('path');

const EMPLOYEES_DIR = require('../../core/paths').employeesDir;
const ORG_FILE = path.join(EMPLOYEES_DIR, 'org.json');
const logger = require('../../core/logger');
const { BridgeInputError } = require('../../core/errors');

let org: any = { departments: [] };

// ── Persistence ─────────────────────────────────────────────────────────────
function load(): void {
  try {
    if (!fs.existsSync(EMPLOYEES_DIR)) fs.mkdirSync(EMPLOYEES_DIR, { recursive: true });
    if (fs.existsSync(ORG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
      org = normalize(parsed);
    } else {
      org = { departments: [] };
    }
    logger.info('org.loaded', {
      departments: org.departments.length,
      teams: org.departments.reduce((n: number, d: any) => n + d.teams.length, 0),
    });
  } catch (e) {
    logger.error('org.load-failed', { error: e instanceof Error ? e.message : String(e) });
    org = { departments: [] };
  }
}

function save(): void {
  try {
    if (!fs.existsSync(EMPLOYEES_DIR)) fs.mkdirSync(EMPLOYEES_DIR, { recursive: true });
    fs.writeFileSync(ORG_FILE, JSON.stringify(org, null, 2) + '\n', 'utf8');
  } catch (e) {
    logger.warn('org.save-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Coerce arbitrary parsed JSON into the strict org shape so a hand-edited
// or skill-written org.json can never crash the grouping UI.
function normalize(raw: any): any {
  const departments = Array.isArray(raw?.departments) ? raw.departments : [];
  return {
    departments: departments
      .filter((d: any) => d && typeof d.id === 'string')
      .map((d: any) => ({
        id: sanitizeId(d.id),
        label: String(d.label || d.id),
        description: String(d.description || ''),
        teams: (Array.isArray(d.teams) ? d.teams : [])
          .filter((t: any) => t && typeof t.id === 'string')
          .map((t: any) => ({
            id: sanitizeId(t.id),
            label: String(t.label || t.id),
            description: String(t.description || ''),
            lead: String(t.lead || ''),
            context: String(t.context || ''),
            members: Array.isArray(t.members)
              ? [...new Set(t.members.filter((m: any) => typeof m === 'string').map((m: string) => sanitizeId(m)))]
              : [],
          })),
      })),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function sanitizeId(raw: any): string {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '')
    .slice(0, 48);
}

function slugify(s: any): string {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `x${Date.now().toString(36)}`
  );
}

function findDept(id: string): any {
  return org.departments.find((d: any) => d.id === id) || null;
}
function findTeam(dept: any, teamId: string): any {
  return dept ? dept.teams.find((t: any) => t.id === teamId) || null : null;
}

function getOrg(): any {
  // Deep clone so callers can't mutate the in-memory tree.
  return JSON.parse(JSON.stringify(org));
}

// ── Mutations ─────────────────────────────────────────────────────────────────
function replaceOrg(raw: any): any {
  org = normalize(raw);
  save();
  return getOrg();
}

function createDepartment(patch: any): any {
  const id = sanitizeId(patch.id) || slugify(patch.label);
  if (!id) throw new BridgeInputError('department id/label required');
  if (findDept(id)) throw new BridgeInputError(`Department '${id}' already exists`, { id });
  const dept = {
    id,
    label: String(patch.label || id),
    description: String(patch.description || ''),
    teams: [],
  };
  org.departments.push(dept);
  save();
  return dept;
}

function updateDepartment(id: string, patch: any): any {
  const dept = findDept(id);
  if (!dept) return null;
  if (patch.label !== undefined) dept.label = String(patch.label);
  if (patch.description !== undefined) dept.description = String(patch.description);
  save();
  return dept;
}

function deleteDepartment(id: string): boolean {
  const i = org.departments.findIndex((d: any) => d.id === id);
  if (i === -1) return false;
  org.departments.splice(i, 1);
  save();
  return true;
}

function createTeam(deptId: string, patch: any): any {
  const dept = findDept(deptId);
  if (!dept) throw new BridgeInputError(`Department '${deptId}' not found`, { deptId });
  const id = sanitizeId(patch.id) || slugify(patch.label);
  if (!id) throw new BridgeInputError('team id/label required');
  if (findTeam(dept, id)) throw new BridgeInputError(`Team '${id}' already exists in '${deptId}'`, { id });
  const team = {
    id,
    label: String(patch.label || id),
    description: String(patch.description || ''),
    lead: sanitizeId(patch.lead || ''),
    context: String(patch.context || ''),
    members: Array.isArray(patch.members)
      ? [...new Set(patch.members.filter((m: any) => typeof m === 'string').map((m: string) => sanitizeId(m)))]
      : [],
  };
  dept.teams.push(team);
  save();
  return team;
}

function updateTeam(deptId: string, teamId: string, patch: any): any {
  const dept = findDept(deptId);
  const team = findTeam(dept, teamId);
  if (!team) return null;
  if (patch.label !== undefined) team.label = String(patch.label);
  if (patch.description !== undefined) team.description = String(patch.description);
  if (patch.lead !== undefined) team.lead = sanitizeId(patch.lead);
  if (patch.context !== undefined) team.context = String(patch.context);
  if (Array.isArray(patch.members)) {
    team.members = [...new Set(patch.members.filter((m: any) => typeof m === 'string').map((m: string) => sanitizeId(m)))];
  }
  save();
  return team;
}

function deleteTeam(deptId: string, teamId: string): boolean {
  const dept = findDept(deptId);
  if (!dept) return false;
  const i = dept.teams.findIndex((t: any) => t.id === teamId);
  if (i === -1) return false;
  dept.teams.splice(i, 1);
  save();
  return true;
}

function assignMember(deptId: string, teamId: string, employeeId: string): any {
  const dept = findDept(deptId);
  const team = findTeam(dept, teamId);
  if (!team) throw new BridgeInputError(`Team '${teamId}' not found in '${deptId}'`, { deptId, teamId });
  const id = sanitizeId(employeeId);
  if (!id) throw new BridgeInputError('employeeId required');
  if (!team.members.includes(id)) {
    team.members.push(id);
    save();
  }
  return team;
}

function unassignMember(deptId: string, teamId: string, employeeId: string): any {
  const dept = findDept(deptId);
  const team = findTeam(dept, teamId);
  if (!team) throw new BridgeInputError(`Team '${teamId}' not found in '${deptId}'`, { deptId, teamId });
  const id = sanitizeId(employeeId);
  const i = team.members.indexOf(id);
  if (i !== -1) {
    team.members.splice(i, 1);
    save();
  }
  return team;
}

// Flat list of distinct member ids referenced anywhere in a given team
// (used by the bulk "invite team" path on the frontend, derived there).

// ── Express routes ─────────────────────────────────────────────────────────────
function registerOrgRoutes(app: any): void {
  app.get('/v1/org/', (_req: any, res: any) => {
    res.json({ success: true, org: getOrg() });
  });

  // Wholesale replace — the recruit-team skill / MCP writes the full tree.
  app.put('/v1/org/', (req: any, res: any) => {
    try {
      const next = replaceOrg(req.body?.org ?? req.body ?? {});
      res.json({ success: true, org: next });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.post('/v1/org/departments', (req: any, res: any) => {
    try {
      res.json({ success: true, department: createDepartment(req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.put('/v1/org/departments/:dep', (req: any, res: any) => {
    const d = updateDepartment(req.params.dep, req.body || {});
    if (!d) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, department: d });
  });

  app.delete('/v1/org/departments/:dep', (req: any, res: any) => {
    if (!deleteDepartment(req.params.dep)) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  });

  app.post('/v1/org/departments/:dep/teams', (req: any, res: any) => {
    try {
      res.json({ success: true, team: createTeam(req.params.dep, req.body || {}) });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.put('/v1/org/departments/:dep/teams/:team', (req: any, res: any) => {
    const t = updateTeam(req.params.dep, req.params.team, req.body || {});
    if (!t) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, team: t });
  });

  app.delete('/v1/org/departments/:dep/teams/:team', (req: any, res: any) => {
    if (!deleteTeam(req.params.dep, req.params.team)) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  });

  app.post('/v1/org/departments/:dep/teams/:team/members', (req: any, res: any) => {
    try {
      const t = assignMember(req.params.dep, req.params.team, String(req.body?.employeeId || ''));
      res.json({ success: true, team: t });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  app.delete('/v1/org/departments/:dep/teams/:team/members/:emp', (req: any, res: any) => {
    try {
      const t = unassignMember(req.params.dep, req.params.team, req.params.emp);
      res.json({ success: true, team: t });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message });
    }
  });
}

function init(): void {
  load();
}

module.exports = {
  init,
  registerOrgRoutes,
  getOrg,
  replaceOrg,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  createTeam,
  updateTeam,
  deleteTeam,
  assignMember,
  unassignMember,
  ORG_FILE,
};
