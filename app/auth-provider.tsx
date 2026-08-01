"use client";

import { createContext, type FormEvent, useCallback, useContext, useEffect, useMemo, useState } from "react";

type SessionUser = { email: string; name: string; isSuperAdmin: boolean };
type AuthContextValue = SessionUser & {
  apiBaseUrl: string;
  authorizedFetch: (path: string, init?: RequestInit) => Promise<Response>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;

  useEffect(() => {
    if (!apiUrl) return;
    let active = true;
    fetch(`${apiUrl}/auth/session`, { credentials: "include", headers: { Accept: "application/json" } })
      .then(async (response) => response.ok ? response.json() as Promise<SessionUser> : null)
      .then((sessionUser) => { if (active) { setUser(sessionUser); setChecking(false); } })
      .catch(() => { if (active) { setError("Sign-in is unavailable. Try again."); setChecking(false); } });
    return () => { active = false; };
  }, [apiUrl]);

  const authorizedFetch = useCallback(async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-HZ-Media-Request", "1");
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${apiUrl}${path}`, { ...init, credentials: "include", headers });
    if (response.status === 401) setUser(null);
    return response;
  }, [apiUrl]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!apiUrl) return;
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-HZ-Media-Request": "1" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      });
      const body = await response.json().catch(() => ({})) as SessionUser & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Sign-in failed");
      setUser(body);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed");
    } finally {
      setSubmitting(false);
    }
  }

  const value = useMemo<AuthContextValue | null>(() => user ? ({
    ...user,
    apiBaseUrl: apiUrl!,
    authorizedFetch,
    logout: async () => {
      await fetch(`${apiUrl}/auth/logout`, { method: "POST", credentials: "include", headers: { "X-HZ-Media-Request": "1" } });
      setUser(null);
    },
  }) : null, [apiUrl, authorizedFetch, user]);

  if (!apiUrl) return <AuthStatus title="Configuration required" detail="Add NEXT_PUBLIC_API_URL to .env, then restart the website." />;
  if (checking) return <AuthStatus title="Loading" detail="Opening HZ Media…" loading />;
  if (!value) return <LoginScreen onSubmit={login} error={error} submitting={submitting} />;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function LoginScreen({ onSubmit, error, submitting }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string; submitting: boolean }) {
  return <main className="login-screen"><section className="login-card"><div className="login-brand"><span className="brand-mark">HZ</span><span>HZ Media</span></div><form className="login-form" onSubmit={onSubmit}><h1>Sign in</h1>{error && <div className="login-error">{error}</div>}<label>Username or email<input name="username" required autoFocus autoComplete="username" /></label><label>Password<input name="password" type="password" required autoComplete="current-password" /></label><button disabled={submitting}>{submitting ? "Signing in…" : "Sign in"}<span>→</span></button></form></section></main>;
}

function AuthStatus({ title, detail, loading = false }: { title: string; detail: string; loading?: boolean }) {
  return <main className="auth-screen"><div className="auth-card"><span className="brand-mark">HZ</span>{loading && <i className="auth-spinner" />}<p>HZ Media</p><h1>{title}</h1><small>{detail}</small></div></main>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
