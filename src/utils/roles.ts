export const isElevatedRole = (role: string | null | undefined) =>
  role === "admin" || role === "manager";

export const canAccessAllLeads = (role: string | null | undefined) =>
  isElevatedRole(role);

export const canAccessAllProposals = (role: string | null | undefined) =>
  isElevatedRole(role);
