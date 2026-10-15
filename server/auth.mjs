import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createAuthStore, authError } from "./auth-store.mjs";
import { hasPermission, requiredPermission } from "./auth-policy.mjs";
import { withPrincipal } from "./auth-context.mjs";

const username = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/,
    "아이디는 영문·숫자·._- 조합으로 3~40자여야 합니다.",
  )
  .transform((value) => value.toLowerCase());
const displayName = z.string().trim().min(1).max(40);
const password = z
  .string()
  .min(12, "비밀번호는 12자 이상이어야 합니다.")
  .max(128);
const role = z.enum(["admin", "editor", "viewer"]);
const setupSchema = z.object({ username, displayName, password }).strict();
const loginSchema = z
  .object({ username, password: z.string().min(1).max(128) })
  .strict();
const createSchema = setupSchema.extend({ role: role.default("viewer") });
const patchSchema = z
  .object({
    displayName: displayName.optional(),
    role: role.optional(),
    active: z.boolean().optional(),
    password: password.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "변경할 항목을 입력하세요.",
  );
const passwordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: password,
  })
  .strict();
const blankSession = (enabled, bootstrapRequired = false) => ({
  enabled,
  authenticated: false,
  bootstrapRequired,
  user: null,
  csrfToken: null,
  expiresAt: null,
});
const signedSession = (session) => ({
  enabled: true,
  authenticated: true,
  bootstrapRequired: false,
  user: session.user,
  csrfToken: session.csrfToken,
  expiresAt: session.expiresAt,
});

export function registerAuth(
  app,
  { pool, profile, origins, mode = process.env.AUTH_MODE ?? "disabled" },
) {
  if (!["disabled", "local"].includes(mode))
    throw new Error("AUTH_MODE는 disabled 또는 local이어야 합니다.");
  const enabled = mode === "local";
  // First version is explicitly limited to the approved development storage.
  if (enabled && profile.scope !== "local-private")
    throw new Error("자체 계정은 전용 개발 환경에서만 활성화할 수 있습니다.");
  const store = createAuthStore(pool);
  const cookieName = `inspection_private_session_${profile.webPort}`;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/",
  };

  const readToken = (req) => {
    const value = req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));
    return value?.slice(cookieName.length + 1) ?? null;
  };
  const requireOrigin = (req) => {
    if (
      !origins.includes(req.headers.origin) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw authError(403, "허용된 개발 화면에서 다시 시도하세요.");
  };
  const requireJson = (req) => {
    requireOrigin(req);
    if (!req.is("application/json"))
      throw authError(415, "JSON 요청이 필요합니다.");
  };
  const requireCsrf = (req, session) => {
    requireOrigin(req);
    const token = req.get("X-CSRF-Token");
    const bytes = Buffer.from(token ?? "");
    if (
      bytes.length !== 43 ||
      !session?.csrfToken ||
      !timingSafeEqual(bytes, Buffer.from(session.csrfToken))
    )
      throw authError(403, "로그인 상태를 새로 확인한 후 다시 시도하세요.");
  };
  const setCookie = (res, session) =>
    res.cookie(cookieName, session.token, {
      ...cookieOptions,
      expires: new Date(session.expiresAt),
    });
  const clearCookie = (res) => res.clearCookie(cookieName, cookieOptions);
  const protectedRoute = (permission, handler) => async (req, res) => {
    if (!enabled)
      throw authError(404, "개발용 로그인이 활성화되지 않았습니다.");
    const session = await store.readSession(readToken(req));
    if (!session) throw authError(401, "로그인이 필요합니다.");
    if (permission && !hasPermission(session.user.role, permission))
      throw authError(403, "이 작업을 할 권한이 없습니다.");
    if (!["GET", "HEAD"].includes(req.method)) {
      requireJson(req);
      requireCsrf(req, session);
    }
    return withPrincipal(session.user, () => handler(req, res, session));
  };

  app.get("/api/auth/session", async (req, res) => {
    if (!enabled) return res.json(blankSession(false));
    const session = await store.readSession(readToken(req));
    res.json(
      session
        ? signedSession(session)
        : blankSession(true, await store.bootstrapRequired()),
    );
  });
  app.post("/api/auth/bootstrap", async (req, res) => {
    if (!enabled)
      throw authError(404, "개발용 로그인이 활성화되지 않았습니다.");
    requireJson(req);
    const session = await store.bootstrap(setupSchema.parse(req.body));
    setCookie(res, session);
    res.status(201).json(signedSession(session));
  });
  app.post("/api/auth/login", async (req, res) => {
    if (!enabled)
      throw authError(404, "개발용 로그인이 활성화되지 않았습니다.");
    requireJson(req);
    const session = await store.login(loginSchema.parse(req.body));
    await store.logout(readToken(req));
    setCookie(res, session);
    res.json(signedSession(session));
  });
  app.post(
    "/api/auth/logout",
    protectedRoute(null, async (req, res) => {
      await store.logout(readToken(req));
      clearCookie(res);
      res.json(blankSession(true));
    }),
  );
  app.get(
    "/api/auth/users",
    protectedRoute("accounts.manage", async (_req, res) =>
      res.json({ items: await store.listUsers() }),
    ),
  );
  app.post(
    "/api/auth/users",
    protectedRoute("accounts.manage", async (req, res, session) => {
      res
        .status(201)
        .json(
          await store.createUser(createSchema.parse(req.body), session.user),
        );
    }),
  );
  app.patch(
    "/api/auth/users/:id",
    protectedRoute("accounts.manage", async (req, res, session) => {
      res.json(
        await store.patchUser(
          z.string().uuid().parse(req.params.id),
          patchSchema.parse(req.body),
          session.user,
        ),
      );
    }),
  );
  app.post(
    "/api/auth/password",
    protectedRoute(null, async (req, res, current) => {
      const session = await store.changePassword(
        passwordSchema.parse(req.body),
        current.user,
      );
      setCookie(res, session);
      res.json(signedSession(session));
    }),
  );

  app.use(async (req, res, next) => {
    if (!enabled || !/^\/api(?:\/|$)/i.test(req.path)) return next();
    const session = await store.readSession(readToken(req));
    if (
      ["GET", "HEAD"].includes(req.method) &&
      /^\/api\/health\/?$/.test(req.path)
    ) {
      req.auth = session;
      return next();
    }
    if (!session) throw authError(401, "로그인이 필요합니다.");
    const permission = requiredPermission(req.method, req.path, req.body);
    if (!permission || !hasPermission(session.user.role, permission))
      throw authError(403, "이 작업을 할 권한이 없습니다.");
    if (!["GET", "HEAD"].includes(req.method)) requireCsrf(req, session);
    req.auth = session;
    // Existing strict create schemas have no actor field. Never insert one.
    if (req.body && Object.hasOwn(req.body, "actor"))
      req.body.actor = session.user.displayName;
    return withPrincipal(session.user, next);
  });
  return {
    enabled,
    initialize: () => (enabled ? store.initialize() : Promise.resolve()),
  };
}
