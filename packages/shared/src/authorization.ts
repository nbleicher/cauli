import type { CallAccessSubject, Role, WorkspaceMember } from "./types.js";

function belongsToWorkspace(member: WorkspaceMember, call: CallAccessSubject) {
  return member.workspaceId === call.workspaceId;
}

export function canViewCall(member: WorkspaceMember, call: CallAccessSubject) {
  if (!belongsToWorkspace(member, call)) return false;
  return member.role !== "member" || member.userId === call.ownerId;
}

export function canDeleteCall(member: WorkspaceMember, call: CallAccessSubject) {
  if (!belongsToWorkspace(member, call)) return false;
  return member.role === "admin" || member.userId === call.ownerId;
}

export function canReviewCall(member: WorkspaceMember, call: CallAccessSubject) {
  return belongsToWorkspace(member, call) && (
    member.role === "manager" || member.role === "admin"
  );
}

export function canManageWorkspace(role: Role) {
  return role === "admin";
}
