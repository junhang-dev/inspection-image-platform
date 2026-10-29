import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  authPolicy,
  hasPermission,
  requiredPermission,
} from "../server/auth-policy.mjs";

// Import only the classifier. The API entry point would connect to the DB.
const id = "12345678-abcd-4abc-8def-123456789abc";
const businessRoutes = [
  ["GET", "/api/health", "read"],
  ["GET", "/api/demo/:name", "read"],
  ["GET", "/api/locations", "read"],
  ["GET", "/api/points", "read"],
  ["GET", "/api/points/:id/history", "read"],
  ["GET", "/api/plans", "read"],
  ["GET", "/api/plans/:id", "read"],
  ["GET", "/api/plans/:id/history", "read"],
  ["GET", "/api/inspections/query", "read"],
  ["GET", "/api/inspections", "read"],
  ["GET", "/api/inspections/:id", "read"],
  ["GET", "/api/inspections/:id/thumbnail", "read"],
  ["GET", "/api/inspections/:id/image", "read"],
  ["GET", "/api/inspections/:id/history", "read"],
  ["GET", "/api/upload-sessions/:id", "read"],
  ["GET", "/api/maintenance/query", "read"],
  ["GET", "/api/maintenance/pair", "read"],
  ["GET", "/api/maintenance/target", "read"],
  ["GET", "/api/maintenance/:id", "read"],
  ["GET", "/api/maintenance/:id/history", "read"],
  ["GET", "/api/maintenance/bundles", "read"],
  ["GET", "/api/inspections/:id/rois", "read"],
  ["GET", "/api/rois/:id/history", "read"],
  ["GET", "/api/inspections/:id/analysis-jobs", "read"],
  ["GET", "/api/analysis-jobs/:id", "read"],
  ["GET", "/api/analysis-jobs/:id/history", "read"],
  ["POST", "/api/points", "work.write"],
  ["POST", "/api/plans", "work.write"],
  ["POST", "/api/demo-inspections", "work.write"],
  ["POST", "/api/inspections", "work.write"],
  ["POST", "/api/upload-sessions", "work.write"],
  ["POST", "/api/upload-sessions/:id/complete", "work.write"],
  ["POST", "/api/upload-sessions/:id/restart", "work.write"],
  ["POST", "/api/inspections/:id/retry", "work.write"],
  ["POST", "/api/maintenance", "work.write"],
  ["POST", "/api/maintenance/bundles", "work.write"],
  ["POST", "/api/inspections/:id/rois", "work.write"],
  ["POST", "/api/analysis-jobs", "work.write"],
  ["POST", "/api/analysis-jobs/:id/cancel", "work.write"],
  ["PATCH", "/api/points/:id", "work.write"],
  ["PATCH", "/api/plans/:id", "work.write"],
  ["PATCH", "/api/inspections/:id", "work.write"],
  ["PATCH", "/api/maintenance/:id", "work.write"],
  ["PATCH", "/api/rois/:id", "work.write"],
  ["PATCH", "/api/inspections/:id/visibility", "records.manage"],
  ["PATCH", "/api/inspections/:id/purpose", "records.manage"],
  ["PATCH", "/api/points/:id/purpose", "records.manage"],
  ["PATCH", "/api/plans/:id/purpose", "records.manage"],
  ["PUT", "/api/upload-sessions/:id/chunks", "work.write"],
];
const actualPath = (pattern) =>
  pattern.replaceAll(":id", id).replace(":name", "demo-01.jpg");
const expectedPermissions = {
  viewer: ["read"],
  editor: ["read", "work.write"],
  admin: ["read", "work.write", "records.manage", "accounts.manage"],
};

test("승인한 세 역할의 권한만 제공한다", () => {
  assert.deepEqual(Object.keys(authPolicy.roles).sort(), [
    "admin",
    "editor",
    "viewer",
  ]);
  for (const [role, permissions] of Object.entries(expectedPermissions)) {
    assert.deepEqual(authPolicy.roles[role].permissions, permissions);
    for (const permission of expectedPermissions.admin) {
      assert.equal(
        hasPermission(role, permission),
        permissions.includes(permission),
      );
    }
    assert.equal(hasPermission(role, "unknown.permission"), false);
  }
});

test("미등록 역할과 객체 기본 속성 이름은 권한을 받지 않는다", () => {
  for (const role of [
    undefined,
    null,
    "",
    "guest",
    "toString",
    "constructor",
    "__proto__",
  ]) {
    assert.equal(hasPermission(role, "read"), false, String(role));
  }
});

test("서버에 선언한 49개 업무 경로와 독립 권한 목록이 일치한다", async () => {
  const sources = await Promise.all(
    [
      "index.mjs",
      "plan-routes.mjs",
      "maintenance-routes.mjs",
      "maintenance-bundle-routes.mjs",
      "roi-routes.mjs",
    ].map((name) =>
      readFile(new URL(`../server/${name}`, import.meta.url), "utf8"),
    ),
  );
  const declarations = sources.flatMap((source) =>
    [
      ...source.matchAll(
        /app\.(get|post|patch|put|delete)\(\s*["']([^"']+)["']/g,
      ),
    ].map(([, method, path]) => `${method.toUpperCase()} ${path}`),
  );
  // The only computed registrations are the points/plans purpose routes.
  const purposeLoop = sources[0].match(
    /for\s*\(const\s*\[path,\s*kind\]\s*of\s*\[([\s\S]*?)\]\)\s*\{\s*app\.patch\(`\/api\/\$\{path\}\/:id\/purpose`/,
  );
  assert.ok(purposeLoop, "기록 목적 경로 등록을 확인해야 합니다.");
  for (const [, path] of purposeLoop[1].matchAll(/\["([^"]+)",\s*"[^"]+"\]/g)) {
    declarations.push(`PATCH /api/${path}/:id/purpose`);
  }
  assert.equal(businessRoutes.length, 49);
  assert.equal(declarations.length, 49);
  assert.equal(new Set(declarations).size, 49);
  assert.deepEqual(
    declarations.sort(),
    businessRoutes.map(([method, path]) => `${method} ${path}`).sort(),
  );
});

for (const [method, pattern, permission] of businessRoutes) {
  test(`${method} ${pattern}의 권한과 역할을 정확히 분류한다`, () => {
    const path = actualPath(pattern);
    assert.equal(requiredPermission(method, path, {}), permission);
    assert.equal(requiredPermission(method, `${path}/`, {}), permission);
    assert.equal(requiredPermission(method, `${path}//`, {}), null);
    for (const [role, permissions] of Object.entries(expectedPermissions)) {
      assert.equal(
        hasPermission(role, requiredPermission(method, path, {})),
        permissions.includes(permission),
        role,
      );
    }
  });
  if (method === "GET") {
    test(`HEAD ${pattern}는 GET과 같은 조회 권한을 요구한다`, () => {
      const path = actualPath(pattern);
      assert.equal(requiredPermission("HEAD", path), "read");
      assert.equal(requiredPermission("HEAD", `${path}/`), "read");
    });
  }
}

test("잘못된 메서드와 미분류 경로를 기본 거부한다", () => {
  for (const method of [
    "DELETE",
    "OPTIONS",
    "TRACE",
    "CONNECT",
    "get",
    "post",
    "UNKNOWN",
    "toString",
    "constructor",
    "__proto__",
  ]) {
    for (const [, pattern] of businessRoutes) {
      assert.equal(requiredPermission(method, actualPath(pattern)), null);
    }
  }
  for (const [method, path] of [
    ["GET", "/api/maintenance/export"],
    ["GET", "/api/plans/export"],
    ["GET", "/api/inspections/export"],
    ["GET", "/api/points/new-endpoint"],
    ["GET", `/api/plans/${id}/secret`],
    ["GET", `/api/maintenance/${id}/history/export`],
    ["GET", `/api/upload-sessions/${id}/chunks`],
    ["GET", "/api/demo/demo-01.jpg/secret"],
    ["GET", "/api/auth/users"],
    ["POST", "/api/health"],
    ["POST", `/api/plans/${id}`],
    ["PATCH", "/api/plans"],
    ["PATCH", `/api/maintenance/bundles/${id}`],
    ["HEAD", "/api/demo-inspections"],
    ["PUT", `/api/upload-sessions/${id}/complete`],
  ]) {
    assert.equal(requiredPermission(method, path), null, `${method} ${path}`);
  }
});

test("API prefix·업무 이름의 대소문자와 잘못된 UUID를 허용하지 않는다", () => {
  for (const [method, pattern] of businessRoutes) {
    const path = actualPath(pattern);
    assert.equal(
      requiredPermission(method, path.replace("/api/", "/API/")),
      null,
    );
    assert.equal(
      requiredPermission(method, path.replace("/api/", "/Api/")),
      null,
    );
    assert.equal(requiredPermission(method, path.toUpperCase()), null);
    if (pattern.includes(":id")) {
      for (const invalid of [
        "not-a-uuid",
        "1234",
        id.slice(1),
        `${id}0`,
        id.replace("a", "g"),
      ]) {
        assert.equal(
          requiredPermission(method, path.replace(id, invalid)),
          null,
        );
      }
      assert.equal(
        requiredPermission(method, path.replace(id, id.toUpperCase())),
        requiredPermission(method, path),
      );
    }
  }
});

test("일반 PATCH에 관리자 필드를 섞으면 요청 전체에 관리자 권한을 요구한다", () => {
  for (const resource of ["plans", "maintenance", "rois"]) {
    const path = `/api/${resource}/${id}`;
    assert.equal(
      requiredPermission("PATCH", path, {
        name: "업무 수정",
        expectedVersion: 0,
      }),
      "work.write",
    );
    for (const privileged of [
      { visibility: "visible" },
      { visibility: "hidden" },
      { recordPurpose: "inspection" },
      { recordPurpose: "verification" },
      { visibility: "visible", recordPurpose: "inspection" },
      { visibility: undefined },
      { recordPurpose: null },
    ]) {
      const permission = requiredPermission("PATCH", path, {
        name: "업무 수정",
        ...privileged,
      });
      assert.equal(permission, "records.manage");
      assert.equal(hasPermission("editor", permission), false);
      assert.equal(hasPermission("viewer", permission), false);
      assert.equal(hasPermission("admin", permission), true);
    }
  }
});

test("POST의 일반 등록은 업무담당, 비기본 기록 목적·숨김 등록은 관리자만 허용한다", () => {
  for (const resource of ["points", "maintenance", "upload-sessions"]) {
    const path = `/api/${resource}`;
    for (const body of [
      {},
      { recordPurpose: "inspection" },
      { visibility: "visible" },
      { recordPurpose: "inspection", visibility: "visible" },
    ]) {
      assert.equal(requiredPermission("POST", path, body), "work.write");
    }
    for (const privileged of [
      { recordPurpose: "verification" },
      { recordPurpose: "presentation" },
      { visibility: "hidden" },
      { recordPurpose: "inspection", visibility: "hidden" },
      { recordPurpose: undefined },
      { visibility: null },
    ]) {
      const permission = requiredPermission("POST", path, {
        name: "업무 등록",
        ...privileged,
      });
      assert.equal(permission, "records.manage");
      assert.equal(hasPermission("editor", permission), false);
      assert.equal(hasPermission("admin", permission), true);
    }
  }
});

test("요청 actor 문자열은 조회자의 쓰기나 업무담당의 관리자 권한을 만들지 않는다", () => {
  const path = `/api/maintenance/${id}`;
  for (const actor of ["관리자", "admin", "AI 서비스", "현업 엔지니어"]) {
    const normal = requiredPermission("PATCH", path, {
      actor,
      repairStatus: "done",
    });
    const privileged = requiredPermission("PATCH", path, {
      actor,
      repairStatus: "done",
      visibility: "hidden",
    });
    assert.equal(normal, "work.write");
    assert.equal(privileged, "records.manage");
    assert.equal(hasPermission("viewer", normal), false);
    assert.equal(hasPermission("editor", privileged), false);
  }
});

test("정책은 body를 수정하지 않고 자체 관리자 필드만 확인한다", () => {
  const path = `/api/maintenance/${id}`;
  const body = Object.freeze({ repairStatus: "planned", visibility: "hidden" });
  assert.equal(requiredPermission("PATCH", path, body), "records.manage");
  assert.deepEqual(body, { repairStatus: "planned", visibility: "hidden" });
  const inherited = Object.assign(
    Object.create({ visibility: "hidden", recordPurpose: "verification" }),
    { repairStatus: "planned" },
  );
  assert.equal(requiredPermission("PATCH", path, inherited), "work.write");
  for (const invalid of [undefined, null, false, "invalid", []]) {
    assert.equal(requiredPermission("PATCH", path, invalid), "work.write");
  }
});
