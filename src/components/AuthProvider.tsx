"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { requestJson } from "@/lib/api";
import {
  can as roleCan,
  setAuthUserId,
  setCsrfToken,
  type AuthPermission,
  type AuthSession,
} from "@/lib/auth";

type AuthContextValue = {
  session: AuthSession | null;
  loading: boolean;
  error: string;
  refreshSession: () => Promise<AuthSession | null>;
  applySession: (session: AuthSession) => void;
  can: (permission: AuthPermission) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sessionRef = useRef<AuthSession | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);

  const applySession = useCallback((next: AuthSession) => {
    if (!mounted.current) return;
    generation.current += 1;
    sessionRef.current = next;
    setCsrfToken(next.csrfToken);
    setAuthUserId(
      next.authenticated && next.user?.active ? next.user.id : null,
    );
    setSession(next);
    setError("");
    setLoading(false);
  }, []);

  const refreshSession = useCallback(async () => {
    const revision = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await requestJson<AuthSession>("/api/auth/session");
      if (!mounted.current || revision !== generation.current) return null;
      applySession(next);
      return next;
    } catch (cause) {
      if (!mounted.current || revision !== generation.current) return null;
      setError(
        cause instanceof Error
          ? cause.message
          : "로그인 상태를 확인하지 못했습니다.",
      );
      setLoading(false);
      return null;
    }
  }, [applySession]);

  useEffect(() => {
    mounted.current = true;
    void refreshSession();
    const handleExpired = () => {
      if (!sessionRef.current?.authenticated) return;
      applySession({
        enabled: true,
        authenticated: false,
        bootstrapRequired: false,
        user: null,
        csrfToken: null,
        expiresAt: null,
      });
      void refreshSession();
    };
    window.addEventListener("inspection-auth-expired", handleExpired);
    return () => {
      mounted.current = false;
      generation.current += 1;
      setCsrfToken(null);
      setAuthUserId(null);
      window.removeEventListener("inspection-auth-expired", handleExpired);
    };
  }, [applySession, refreshSession]);

  useEffect(() => {
    if (!session?.authenticated || !session.expiresAt) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (!Number.isFinite(remaining)) return;
    const timer = window.setTimeout(
      () => void refreshSession(),
      Math.max(0, Math.min(remaining + 250, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [session?.authenticated, session?.expiresAt, refreshSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading,
      error,
      refreshSession,
      applySession,
      can: (permission) =>
        Boolean(
          session &&
          (!session.enabled ||
            (session.authenticated &&
              session.user?.active &&
              roleCan(session.user.role, permission))),
        ),
    }),
    [session, loading, error, refreshSession, applySession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context)
    throw new Error("AuthProvider 안에서 로그인 상태를 사용하세요.");
  return context;
}
