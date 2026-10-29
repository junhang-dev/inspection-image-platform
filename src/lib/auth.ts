import policy from "./auth-policy.json" with { type: "json" };

export type AuthRole = "admin" | "editor" | "viewer";
export type AuthPermission =
  "read" | "work.write" | "records.manage" | "accounts.manage";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  role: AuthRole;
  active: boolean;
  createdAt: string;
};

export type AuthSession = {
  enabled: boolean;
  authenticated: boolean;
  bootstrapRequired: boolean;
  user: AuthUser | null;
  csrfToken: string | null;
  expiresAt: string | null;
};

let csrfToken: string | null = null;
let authUserId: string | null = null;

export function getCsrfToken(): string | null {
  return csrfToken;
}

export function setCsrfToken(value: string | null): void {
  csrfToken = value;
}

export function getAuthUserId(): string | null {
  return authUserId;
}

export function setAuthUserId(value: string | null): void {
  const changed = value !== authUserId;
  authUserId = value;
  if (changed && typeof window !== "undefined")
    window.dispatchEvent(new Event("inspection-auth-owner-changed"));
}

export function roleLabel(role: AuthRole): string {
  return policy.roles[role].label;
}

export function can(
  role: AuthRole | null | undefined,
  permission: AuthPermission,
): boolean {
  return Boolean(
    role && Object.hasOwn(policy.roles, role) &&
    policy.roles[role].permissions.includes(permission),
  );
}
