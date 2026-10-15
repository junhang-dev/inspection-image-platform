import { readFile } from "node:fs/promises";

export const authPolicy = JSON.parse(
  await readFile(
    new URL("../src/lib/auth-policy.json", import.meta.url),
    "utf8",
  ),
);
export const hasPermission = (role, permission) =>
  Object.hasOwn(authPolicy.roles, role) &&
  authPolicy.roles[role].permissions.includes(permission);

const uuid =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const route = (pattern) => new RegExp(`^/api/${pattern}/?$`);
const routes = {
  GET: [
    [
      "read",
      route(
        "(?:health|locations|points|plans|inspections|inspections/query|maintenance/query|maintenance/pair|maintenance/target|maintenance/bundles)",
      ),
    ],
    ["read", route("demo/[^/]+")],
    [
      "read",
      route(
        `(?:plans|inspections|maintenance|upload-sessions|analysis-jobs)/${uuid}`,
      ),
    ],
    [
      "read",
      route(
        `(?:points|plans|inspections|maintenance|rois|analysis-jobs)/${uuid}/history`,
      ),
    ],
    [
      "read",
      route(`inspections/${uuid}/(?:thumbnail|image|rois|analysis-jobs)`),
    ],
  ],
  POST: [
    [
      "work.write",
      route(
        "(?:points|plans|demo-inspections|inspections|upload-sessions|maintenance|maintenance/bundles|analysis-jobs)",
      ),
    ],
    ["work.write", route(`upload-sessions/${uuid}/(?:complete|restart)`)],
    ["work.write", route(`inspections/${uuid}/(?:retry|rois)`)],
    ["work.write", route(`analysis-jobs/${uuid}/cancel`)],
  ],
  PATCH: [
    [
      "work.write",
      route(`(?:points|plans|inspections|maintenance|rois)/${uuid}`),
    ],
    ["records.manage", route(`inspections/${uuid}/visibility`)],
    ["records.manage", route(`(?:inspections|points|plans)/${uuid}/purpose`)],
  ],
  PUT: [["work.write", route(`upload-sessions/${uuid}/chunks`)]],
};

// Match methods and full paths. A newly added API is denied until classified.
export function requiredPermission(method, path, body) {
  const routeMethod = method === "HEAD" ? "GET" : method;
  if (!Object.hasOwn(routes, routeMethod)) return null;
  const permission = routes[routeMethod].find(
    ([, pattern]) => pattern.test(path),
  )?.[0];
  if (!permission) return null;
  const value =
    body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (
    method === "PATCH" &&
    route(`(?:plans|maintenance|rois)/${uuid}`).test(path) &&
    (Object.hasOwn(value, "visibility") ||
      Object.hasOwn(value, "recordPurpose"))
  )
    return "records.manage";
  if (
    method === "POST" &&
    route("(?:points|maintenance|upload-sessions)").test(path) &&
    ((Object.hasOwn(value, "recordPurpose") &&
      value.recordPurpose !== "inspection") ||
      (Object.hasOwn(value, "visibility") && value.visibility !== "visible"))
  )
    return "records.manage";
  return permission;
}
