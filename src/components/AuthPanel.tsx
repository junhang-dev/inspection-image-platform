"use client";

import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { LogOut, UserRound, X } from "lucide-react";
import { requestJson } from "@/lib/api";
import {
  roleLabel,
  type AuthRole,
  type AuthSession,
  type AuthUser,
} from "@/lib/auth";
import { useAuth } from "./AuthProvider";
import styles from "./AuthPanel.module.css";

const usernamePattern = "[A-Za-z0-9][A-Za-z0-9._-]{2,39}";
const roles: AuthRole[] = ["viewer", "editor", "admin"];
const roleDescriptions: Record<AuthRole, string> = {
  viewer: "사진과 업무 기록을 조회할 수 있습니다.",
  editor: "사진을 추가하고 업무 기록을 작성·수정할 수 있습니다.",
  admin: "업무 기록과 계정을 관리할 수 있습니다.",
};
const errorMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : "요청을 처리하지 못했습니다.";
const passwordError = (password: string) =>
  password.length < 12 || password.length > 128
    ? "비밀번호는 12~128자로 입력하세요."
    : "";

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <main className={styles.gate}>
      <section className={styles.card} aria-label="로그인">
        <p className={styles.brand}>Drone Inspection Platform</p>
        {children}
      </section>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading, error, refreshSession } = useAuth();
  if (loading)
    return (
      <AuthCard>
        <p className={styles.muted} role="status">
          로그인 상태를 확인하고 있습니다.
        </p>
      </AuthCard>
    );
  if (error || !session)
    return (
      <AuthCard>
        <h1>로그인 상태 확인 필요</h1>
        <p className={styles.error} role="alert">
          {error || "로그인 상태를 확인하지 못했습니다."}
        </p>
        <button
          type="button"
          className={styles.primary}
          onClick={() => void refreshSession()}
        >
          다시 확인
        </button>
      </AuthCard>
    );
  if (!session.enabled || (session.authenticated && session.user?.active))
    return <Fragment key={session.user?.id ?? "disabled"}>{children}</Fragment>;
  return <LoginForm bootstrap={session.bootstrapRequired} />;
}

function LoginForm({ bootstrap }: { bootstrap: boolean }) {
  const { applySession, refreshSession } = useAuth();
  const prefix = useId();
  const usernameRef = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    usernameRef.current?.focus();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current) return;
    const validation = bootstrap
      ? passwordError(password) ||
        (password !== confirmation ? "새 비밀번호가 서로 다릅니다." : "") ||
        (!displayName.trim() ? "표시 이름을 입력하세요." : "")
      : "";
    if (validation) {
      setError(validation);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await requestJson<AuthSession>(
        bootstrap ? "/api/auth/bootstrap" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({
            username: username.trim(),
            password,
            ...(bootstrap ? { displayName: displayName.trim() } : {}),
          }),
        },
      );
      setPassword("");
      setConfirmation("");
      applySession(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <AuthCard>
      <h1>{bootstrap ? "첫 관리자 계정 만들기" : "로그인"}</h1>
      <p className={styles.muted}>
        {bootstrap ? "처음 한 번만 설정합니다." : "개발 계정으로 로그인하세요."}
      </p>
      <form onSubmit={submit} className={styles.form} aria-busy={busy}>
        <fieldset disabled={busy}>
          <label className={styles.field} htmlFor={`${prefix}-username`}>
            아이디
            <input
              id={`${prefix}-username`}
              ref={usernameRef}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              pattern={usernamePattern}
              title="첫 문자는 영문 또는 숫자, 전체는 영문·숫자·점·밑줄·하이픈 3~40자"
              minLength={3}
              maxLength={40}
              required
              aria-describedby={
                bootstrap ? `${prefix}-username-hint` : undefined
              }
            />
            {bootstrap && (
              <small id={`${prefix}-username-hint`}>
                영문·숫자·점·밑줄·하이픈 3~40자
              </small>
            )}
          </label>
          {bootstrap && (
            <label className={styles.field} htmlFor={`${prefix}-name`}>
              표시 이름
              <input
                id={`${prefix}-name`}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                maxLength={40}
                required
              />
            </label>
          )}
          <label className={styles.field} htmlFor={`${prefix}-password`}>
            비밀번호
            <input
              id={`${prefix}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={bootstrap ? "new-password" : "current-password"}
              minLength={bootstrap ? 12 : undefined}
              maxLength={128}
              required
              aria-describedby={
                bootstrap ? `${prefix}-password-hint` : undefined
              }
            />
            {bootstrap && (
              <small id={`${prefix}-password-hint`}>12~128자</small>
            )}
          </label>
          {bootstrap && (
            <label className={styles.field} htmlFor={`${prefix}-confirmation`}>
              비밀번호 확인
              <input
                id={`${prefix}-confirmation`}
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
              />
            </label>
          )}
        </fieldset>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="submit" className={styles.primary} disabled={busy}>
          {busy ? "처리 중…" : bootstrap ? "관리자 계정 만들기" : "로그인"}
        </button>
        {error && (
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void refreshSession()}
          >
            로그인 상태 다시 확인
          </button>
        )}
      </form>
    </AuthCard>
  );
}

export function AuthAccountButton() {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const user = session?.authenticated ? session.user : null;
  useEffect(() => {
    setOpen(false);
  }, [user?.id]);
  if (!session?.enabled || !user) return null;
  return (
    <>
      <button
        type="button"
        className={styles.accountButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <UserRound size={17} aria-hidden="true" />
        <span className={styles.accountName}>{user.displayName}</span>
        <small>{roleLabel(user.role)}</small>
      </button>
      {open && <AccountDialog user={user} onClose={() => setOpen(false)} />}
    </>
  );
}

type UserPatch = {
  displayName?: string;
  role?: AuthRole;
  active?: boolean;
  password?: string;
};

function AccountDialog({
  user,
  onClose,
}: {
  user: AuthUser;
  onClose: () => void;
}) {
  const { session, applySession, can } = useAuth();
  const prefix = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const lock = useRef(false);
  const [section, setSection] = useState<"personal" | "users">("personal");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState("");
  const [revision, setRevision] = useState(0);
  const manageAccounts = can("accounts.manage");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    if (section !== "users" || !manageAccounts) return;
    let current = true;
    const controller = new AbortController();
    setUsersLoading(true);
    setUsersError("");
    void requestJson<{ items: AuthUser[] }>("/api/auth/users", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then((result) => {
        if (current) setUsers(result.items);
      })
      .catch((cause) => {
        if (current) setUsersError(errorMessage(cause));
      })
      .finally(() => {
        if (current) setUsersLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [section, manageAccounts, revision]);

  function begin(action: string): boolean {
    if (lock.current) return false;
    lock.current = true;
    setBusy(action);
    setError("");
    setMessage("");
    return true;
  }

  function finish() {
    lock.current = false;
    setBusy("");
  }

  async function logout() {
    if (!begin("logout")) return;
    try {
      const next = await requestJson<AuthSession>("/api/auth/logout", {
        method: "POST",
        body: "{}",
      });
      applySession(next);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      finish();
    }
  }

  async function changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<string | null> {
    if (!begin("password")) return "다른 변경을 처리 중입니다.";
    try {
      const next = await requestJson<AuthSession>("/api/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      applySession(next);
      setMessage("비밀번호를 변경했습니다.");
      return null;
    } catch (cause) {
      return errorMessage(cause);
    } finally {
      finish();
    }
  }

  async function addUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: AuthRole;
  }): Promise<string | null> {
    if (!begin("create")) return "다른 변경을 처리 중입니다.";
    try {
      const created = await requestJson<AuthUser>("/api/auth/users", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setUsers((previous) => [
        ...previous.filter((item) => item.id !== created.id),
        created,
      ]);
      setMessage(`${created.displayName} 계정을 추가했습니다.`);
      return null;
    } catch (cause) {
      return errorMessage(cause);
    } finally {
      finish();
    }
  }

  async function saveUser(
    id: string,
    patch: UserPatch,
  ): Promise<string | null> {
    if (!begin(`user:${id}`)) return "다른 변경을 처리 중입니다.";
    try {
      const updated = await requestJson<AuthUser>(
        `/api/auth/users/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(patch),
        },
      );
      setUsers((previous) =>
        previous.map((item) => (item.id === id ? updated : item)),
      );
      if (session && updated.id === session.user?.id)
        applySession({ ...session, user: updated });
      setMessage(`${updated.displayName} 계정을 변경했습니다.`);
      return null;
    } catch (cause) {
      return errorMessage(cause);
    } finally {
      finish();
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={`${prefix}-title`}
      onClose={onClose}
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <header className={styles.dialogHeader}>
        <div>
          <h2 id={`${prefix}-title`}>내 계정</h2>
          <p className={styles.muted}>
            {user.displayName} · {roleLabel(user.role)}
          </p>
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="계정 창 닫기"
          disabled={Boolean(busy)}
          onClick={() => dialogRef.current?.close()}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </header>
      {manageAccounts && (
        <nav className={styles.sectionNav} aria-label="계정 메뉴">
          <button
            type="button"
            aria-pressed={section === "personal"}
            disabled={Boolean(busy)}
            onClick={() => {
              setSection("personal");
              setError("");
              setMessage("");
            }}
          >
            내 계정
          </button>
          <button
            type="button"
            aria-pressed={section === "users"}
            disabled={Boolean(busy)}
            onClick={() => {
              setSection("users");
              setError("");
              setMessage("");
            }}
          >
            계정 관리
          </button>
        </nav>
      )}
      <div className={styles.dialogBody} aria-busy={Boolean(busy)}>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className={styles.success} role="status">
            {message}
          </p>
        )}
        {section === "personal" || !manageAccounts ? (
          <>
            <dl className={styles.accountSummary}>
              <div>
                <dt>아이디</dt>
                <dd>{user.username}</dd>
              </div>
              <div>
                <dt>역할</dt>
                <dd>{roleLabel(user.role)}</dd>
              </div>
            </dl>
            <p className={styles.muted}>{roleDescriptions[user.role]}</p>
            <PasswordForm
              busy={Boolean(busy)}
              submitting={busy === "password"}
              onSubmit={changePassword}
            />
          </>
        ) : (
          <>
            <section className={styles.userSection} aria-label="계정 목록">
              <header className={styles.listHeader}>
                <h3>계정 목록</h3>
                <button
                  type="button"
                  className={styles.secondary}
                  disabled={Boolean(busy) || usersLoading}
                  onClick={() => setRevision((value) => value + 1)}
                >
                  다시 조회
                </button>
              </header>
              {usersLoading && (
                <p className={styles.muted} role="status">
                  계정을 불러오는 중입니다.
                </p>
              )}
              {usersError && (
                <p className={styles.error} role="alert">
                  {usersError}
                </p>
              )}
              {!usersLoading && !usersError && !users.length && (
                <p className={styles.muted}>등록된 계정이 없습니다.</p>
              )}
              {users.map((item) => (
                <UserEditor
                  key={item.id}
                  user={item}
                  self={item.id === user.id}
                  busy={Boolean(busy) || usersLoading || Boolean(usersError)}
                  submitting={busy === `user:${item.id}`}
                  onSave={saveUser}
                />
              ))}
            </section>
            <AddUserForm
              busy={Boolean(busy) || usersLoading || Boolean(usersError)}
              submitting={busy === "create"}
              onSubmit={addUser}
            />
          </>
        )}
      </div>
      <footer className={styles.dialogFooter}>
        <button
          type="button"
          className={styles.secondary}
          disabled={Boolean(busy)}
          onClick={() => void logout()}
        >
          <LogOut size={16} aria-hidden="true" />
          {busy === "logout" ? "로그아웃 중…" : "로그아웃"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          disabled={Boolean(busy)}
          onClick={() => dialogRef.current?.close()}
        >
          닫기
        </button>
      </footer>
    </dialog>
  );
}

function PasswordForm({
  busy,
  submitting,
  onSubmit,
}: {
  busy: boolean;
  submitting: boolean;
  onSubmit: (
    currentPassword: string,
    newPassword: string,
  ) => Promise<string | null>;
}) {
  const prefix = useId();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const validation =
      passwordError(newPassword) ||
      (newPassword !== confirmation ? "새 비밀번호가 서로 다릅니다." : "");
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    const failure = await onSubmit(currentPassword, newPassword);
    if (failure) {
      setError(failure);
      return;
    }
    setCurrentPassword("");
    setNewPassword("");
    setConfirmation("");
  }

  return (
    <form className={styles.formSection} onSubmit={submit}>
      <h3>비밀번호 변경</h3>
      <fieldset disabled={busy}>
        <label className={styles.field} htmlFor={`${prefix}-current`}>
          현재 비밀번호
          <input
            id={`${prefix}-current`}
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            maxLength={128}
            required
          />
        </label>
        <label className={styles.field} htmlFor={`${prefix}-new`}>
          새 비밀번호
          <input
            id={`${prefix}-new`}
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
            aria-describedby={`${prefix}-hint`}
          />
          <small id={`${prefix}-hint`}>12~128자</small>
        </label>
        <label className={styles.field} htmlFor={`${prefix}-confirmation`}>
          새 비밀번호 확인
          <input
            id={`${prefix}-confirmation`}
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button type="submit" className={styles.primary}>
          {submitting ? "변경 중…" : "비밀번호 변경"}
        </button>
      </fieldset>
    </form>
  );
}

function AddUserForm({
  busy,
  submitting,
  onSubmit,
}: {
  busy: boolean;
  submitting: boolean;
  onSubmit: (input: {
    username: string;
    displayName: string;
    password: string;
    role: AuthRole;
  }) => Promise<string | null>;
}) {
  const prefix = useId();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<AuthRole>("viewer");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const validation =
      passwordError(password) ||
      (!displayName.trim() ? "표시 이름을 입력하세요." : "");
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    const failure = await onSubmit({
      username: username.trim(),
      displayName: displayName.trim(),
      password,
      role,
    });
    if (failure) {
      setError(failure);
      return;
    }
    setUsername("");
    setDisplayName("");
    setPassword("");
    setRole("viewer");
  }

  return (
    <details className={styles.formSection}>
      <summary>계정 추가</summary>
      <form className={styles.form} onSubmit={submit}>
        <fieldset disabled={busy}>
          <label className={styles.field} htmlFor={`${prefix}-username`}>
            아이디
            <input
              id={`${prefix}-username`}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              pattern={usernamePattern}
              title="첫 문자는 영문 또는 숫자, 전체는 영문·숫자·점·밑줄·하이픈 3~40자"
              minLength={3}
              maxLength={40}
              required
              aria-describedby={`${prefix}-username-hint`}
            />
            <small id={`${prefix}-username-hint`}>
              영문·숫자·점·밑줄·하이픈 3~40자
            </small>
          </label>
          <label className={styles.field} htmlFor={`${prefix}-name`}>
            표시 이름
            <input
              id={`${prefix}-name`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="off"
              maxLength={40}
              required
            />
          </label>
          <label className={styles.field} htmlFor={`${prefix}-role`}>
            역할
            <select
              id={`${prefix}-role`}
              value={role}
              onChange={(event) => setRole(event.target.value as AuthRole)}
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </select>
            <small>{roleDescriptions[role]}</small>
          </label>
          <label className={styles.field} htmlFor={`${prefix}-password`}>
            초기 비밀번호
            <input
              id={`${prefix}-password`}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              required
              aria-describedby={`${prefix}-password-hint`}
            />
            <small id={`${prefix}-password-hint`}>
              12~128자 · 사용자에게 직접 전달하세요.
            </small>
          </label>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.primary}>
            {submitting ? "추가 중…" : "계정 추가"}
          </button>
        </fieldset>
      </form>
    </details>
  );
}

function UserEditor({
  user,
  self,
  busy,
  submitting,
  onSave,
}: {
  user: AuthUser;
  self: boolean;
  busy: boolean;
  submitting: boolean;
  onSave: (id: string, patch: UserPatch) => Promise<string | null>;
}) {
  const prefix = useId();
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<AuthRole>(user.role);
  const [active, setActive] = useState(user.active);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setDisplayName(user.displayName);
    setRole(user.role);
    setActive(user.active);
  }, [user.displayName, user.role, user.active]);

  const changed =
    displayName.trim() !== user.displayName ||
    (!self &&
      (role !== user.role || active !== user.active || Boolean(password)));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !changed) return;
    const validation = !displayName.trim()
      ? "표시 이름을 입력하세요."
      : password
        ? passwordError(password)
        : "";
    if (validation) {
      setError(validation);
      return;
    }
    const patch: UserPatch = {};
    if (displayName.trim() !== user.displayName)
      patch.displayName = displayName.trim();
    if (!self) {
      if (role !== user.role) patch.role = role;
      if (active !== user.active) patch.active = active;
      if (password) patch.password = password;
    }
    setError("");
    const failure = await onSave(user.id, patch);
    if (failure) {
      setError(failure);
      return;
    }
    setPassword("");
  }

  return (
    <details className={styles.userCard}>
      <summary>
        <span>
          <strong>
            {user.displayName}
            {self && " (본인)"}
          </strong>
          <small>{user.username}</small>
        </span>
        <span className={styles.userState}>
          {roleLabel(user.role)} · {user.active ? "사용 중" : "사용 중지"}
        </span>
      </summary>
      <form className={styles.form} onSubmit={submit}>
        <fieldset disabled={busy}>
          <label className={styles.field} htmlFor={`${prefix}-name`}>
            표시 이름
            <input
              id={`${prefix}-name`}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={40}
              required
            />
          </label>
          <label className={styles.field} htmlFor={`${prefix}-role`}>
            역할
            <select
              id={`${prefix}-role`}
              value={role}
              disabled={self}
              onChange={(event) => setRole(event.target.value as AuthRole)}
            >
              {roles.map((value) => (
                <option key={value} value={value}>
                  {roleLabel(value)}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.checkbox} htmlFor={`${prefix}-active`}>
            <input
              id={`${prefix}-active`}
              type="checkbox"
              checked={active}
              disabled={self}
              onChange={(event) => setActive(event.target.checked)}
            />
            계정 사용 허용
          </label>
          {self ? (
            <p className={styles.muted}>
              본인 역할과 사용 상태는 바꿀 수 없습니다. 비밀번호는 내 계정에서
              변경하세요.
            </p>
          ) : (
            <label className={styles.field} htmlFor={`${prefix}-password`}>
              비밀번호 재설정
              <input
                id={`${prefix}-password`}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                aria-describedby={`${prefix}-password-hint`}
              />
              <small id={`${prefix}-password-hint`}>
                바꿀 때만 12~128자로 입력하세요.
              </small>
            </label>
          )}
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <button type="submit" className={styles.primary} disabled={!changed}>
            {submitting ? "저장 중…" : "계정 변경 저장"}
          </button>
        </fieldset>
      </form>
    </details>
  );
}
