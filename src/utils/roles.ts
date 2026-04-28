export const isAdminRole = (role: string | null | undefined) =>
  role === "admin";

export const isElevatedRole = (role: string | null | undefined) =>
  isAdminRole(role) || role === "manager";

export const canAccessAllLeads = (role: string | null | undefined) =>
  isAdminRole(role);

export const canAccessAllProposals = (role: string | null | undefined) =>
  isAdminRole(role);
