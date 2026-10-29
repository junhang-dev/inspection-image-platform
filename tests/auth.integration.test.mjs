import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";
import mysql from "mysql2/promise";
import sharp from "sharp";

// Explicit opt-in; never use the operating or personal development database.
test(
  "합성 개발 환경의 로그인·권한·저장·회수 HTTP/SQL 검증",
  {
    skip: process.env.AUTH_INTEGRATION !== "1",
    timeout: 90000,
  },
  async (t) => {
    assert.equal(process.env.TEST_API_URL, "http://127.0.0.1:4300/api");
    const root = resolve("local/auth-verification");
    const env = parse(await readFile(`${root}/api.env`));
    assert.equal(env.DATA_SCOPE, "local-private");
    assert.equal(env.AUTH_MODE, "local");
    assert.equal(env.MYSQL_PORT, "13308");
    assert.equal(env.MINIO_PORT, "19002");
    assert.equal(env.DISABLE_BACKGROUND_WORKERS, "1");
    assert.ok(env.DATASET_PLAN_PATH.includes("/private-verification/fixture/"));
    const base = process.env.TEST_API_URL;
    const origin = "http://127.0.0.1:3300";
    const trace = [];
    let failures = 0;
    const check = (name, run) =>
      t.test(name, async () => {
        try {
          await run();
        } catch (error) {
          failures++;
          throw error;
        }
      });
    const db = await mysql.createConnection({
      host: "127.0.0.1",
      port: 13308,
      database: env.MYSQL_DATABASE,
      user: env.MYSQL_USER,
      password: env.MYSQL_PASSWORD,
      timezone: "Z",
    });
    t.after(() => db.end());
    const call = async (client, path, method = "GET", body, overrides = {}) => {
      const headers = {
        ...(client?.cookie ? { Cookie: client.cookie } : {}),
        ...(!["GET", "HEAD"].includes(method)
          ? {
              Origin: origin,
              "Content-Type": "application/json",
              ...(client?.csrfToken
                ? { "X-CSRF-Token": client.csrfToken }
                : {}),
            }
          : {}),
        ...overrides,
      };
      for (const key of Object.keys(headers))
        if (headers[key] === null) delete headers[key];
      const response = await fetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const result = method === "HEAD" ? null : await response.json();
      trace.push({ path, method, status: response.status });
      return {
        status: response.status,
        body: result,
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    };
    const expect = async (
      client,
      path,
      method = "GET",
      body,
      status = 200,
      headers,
    ) => {
      const result = await call(client, path, method, body, headers);
      assert.equal(
        result.status,
        status,
        `${method} ${path}: ${JSON.stringify(result.body)}`,
      );
      return result.body;
    };
    const session = (result) => ({
      cookie: result.cookie,
      csrfToken: result.body.csrfToken,
      user: result.body.user,
    });
    const login = async (account) => {
      const result = await call(null, "/auth/login", "POST", {
        username: account.username,
        password: account.password,
      });
      assert.equal(result.status, 200);
      return session(result);
    };
    const secret = () => randomBytes(24).toString("base64url");
    let adminAccount;
    const state = await expect(null, "/auth/session");
    assert.equal(state.enabled, true);
    if (state.bootstrapRequired) {
      adminAccount = {
        username: "qa_fixture_admin",
        displayName: "합성 검증 관리자",
        password: secret(),
      };
      const boot = await call(null, "/auth/bootstrap", "POST", adminAccount);
      assert.equal(boot.status, 201);
      adminAccount.id = boot.body.user.id;
      await writeFile(
        `${root}/credentials.local.json`,
        JSON.stringify({ admin: adminAccount }),
        { mode: 0o600 },
      );
    } else {
      ({ admin: adminAccount } = JSON.parse(
        await readFile(`${root}/credentials.local.json`),
      ));
      assert.equal(adminAccount.username, "qa_fixture_admin");
    }
    const admin = await login(adminAccount);
    const tag = randomBytes(4).toString("hex");
    const accounts = { admin: adminAccount };
    const create = async (label, role) => {
      const account = {
        username: `qa_${label}_${tag}`,
        displayName: `합성 검증 ${label}`,
        password: secret(),
        role,
      };
      const user = await expect(admin, "/auth/users", "POST", account, 201);
      accounts[label] = { ...account, id: user.id };
      return login(account);
    };
    const editor = await create("editor", "editor");
    const viewer = await create("viewer", "viewer");
    const other = await create("other", "editor");
    const mutable = await create("mutable", "editor");
    const audit = {
      actor: "클라이언트가 보낸 가짜 이름",
      reason: "합성 개발 권한·저장 검증",
    };
    let plan,
      photos = [],
      work = [],
      bundle;

    await check("익명·조회자·업무담당·관리자 권한과 Origin/CSRF", async () => {
      for (const path of [
        "/plans",
        "/inspections/query",
        "/maintenance/query",
        "/maintenance/bundles",
        "/auth/users",
      ])
        await expect(null, path, "GET", undefined, 401);
      for (const path of [
        "/plans",
        "/inspections/query",
        "/maintenance/query",
        "/maintenance/bundles",
      ])
        await expect(viewer, path);
      await expect(viewer, "/plans", "HEAD");
      for (const path of [
        "/plans",
        "/maintenance",
        "/maintenance/bundles",
        "/upload-sessions",
        "/auth/users",
      ])
        await expect(viewer, path, "POST", {}, 403);
      await expect(editor, "/auth/users", "GET", undefined, 403);
      await expect(editor, "/auth/users", "POST", {}, 403);
      await expect(admin, "/auth/users");
      await expect(
        admin,
        `/auth/users/${admin.user.id}`,
        "PATCH",
        { role: "viewer" },
        409,
      );
      await expect(
        admin,
        `/auth/users/${admin.user.id}`,
        "PATCH",
        { active: false },
        409,
      );
      await expect(
        null,
        "/auth/bootstrap",
        "POST",
        { username: "qa_duplicate", displayName: "중복", password: secret() },
        409,
      );
      await expect(admin, "/plans", "POST", {}, 403, { "X-CSRF-Token": null });
      await expect(admin, "/plans", "POST", {}, 403, {
        Origin: "https://unapproved.invalid",
      });
      await expect(admin, "/unknown", "GET", undefined, 403);
      const uppercase = await fetch("http://127.0.0.1:4300/API/plans", {
        headers: { Cookie: admin.cookie },
      });
      assert.equal(uppercase.status, 403);
      await expect(
        null,
        "/auth/login",
        "POST",
        { username: adminAccount.username, password: secret() },
        401,
      );
    });

    await check("업무담당 계획 저장·수정·버전 충돌과 실제 작성자", async () => {
      plan = await expect(
        editor,
        "/plans",
        "POST",
        {
          title: `합성 검증 계획 ${tag}`,
          date: "2026-10-11",
          teamId: "team-1",
          rackIds: ["team-1-rack-1"],
        },
        201,
      );
      const oldVersion = plan.editVersion;
      plan = await expect(editor, `/plans/${plan.id}`, "PATCH", {
        ...audit,
        expectedVersion: oldVersion,
        note: "합성 자료만 사용",
      });
      await expect(
        editor,
        `/plans/${plan.id}`,
        "PATCH",
        { ...audit, expectedVersion: oldVersion, note: "오래된 수정" },
        409,
      );
      await expect(
        editor,
        `/plans/${plan.id}`,
        "PATCH",
        { ...audit, expectedVersion: plan.editVersion, visibility: "hidden" },
        403,
      );
      assert.equal(
        (await expect(viewer, `/plans/${plan.id}`)).note,
        "합성 자료만 사용",
      );
      const history = await expect(viewer, `/plans/${plan.id}/history`);
      assert.ok(history.length >= 2);
      assert.ok(
        history.every(
          (row) =>
            row.actorId === editor.user.id &&
            row.actor === editor.user.displayName,
        ),
      );
    });

    await check("합성 사진 청크 전송·소유권·원본 바이트·재조회", async () => {
      for (let n = 0; n < 4; n++) {
        const bytes = await sharp({
          create: {
            width: 32,
            height: 32,
            channels: 3,
            background: { r: 60 + n, g: 170, b: 140 },
          },
        })
          .png()
          .toBuffer();
        const hash = createHash("sha256").update(bytes).digest("hex");
        const upload = await expect(editor, "/upload-sessions", "POST", {
          id: randomUUID(),
          batchId: randomUUID(),
          name: `합성-권한검증-${tag}-${n}.png`,
          size: bytes.length,
          sha256: hash,
          planId: plan.id,
          pointId: null,
          rackId: "team-1-rack-1",
        });
        for (const [path, method] of [
          [`/upload-sessions/${upload.id}`, "GET"],
          [`/upload-sessions/${upload.id}/complete`, "POST"],
          [`/upload-sessions/${upload.id}/restart`, "POST"],
        ])
          await expect(
            other,
            path,
            method,
            path.endsWith("/restart") ? { sha256: hash } : undefined,
            403,
          );
        const forbiddenChunk = await fetch(
          `${base}/upload-sessions/${upload.id}/chunks?offset=0`,
          {
            method: "PUT",
            headers: {
              Cookie: other.cookie,
              Origin: origin,
              "X-CSRF-Token": other.csrfToken,
              "Content-Type": "application/octet-stream",
              "X-Chunk-SHA256": hash,
            },
            body: bytes,
          },
        );
        assert.equal(forbiddenChunk.status, 403);
        assert.equal(
          (await expect(editor, `/upload-sessions/${upload.id}`)).offset,
          0,
        );
        await expect(admin, `/upload-sessions/${upload.id}`);
        const chunk = await fetch(
          `${base}/upload-sessions/${upload.id}/chunks?offset=0`,
          {
            method: "PUT",
            headers: {
              Cookie: editor.cookie,
              Origin: origin,
              "X-CSRF-Token": editor.csrfToken,
              "Content-Type": "application/octet-stream",
              "X-Chunk-SHA256": hash,
            },
            body: bytes,
          },
        );
        assert.equal(chunk.status, 200);
        await chunk.arrayBuffer();
        const complete = await expect(
          editor,
          `/upload-sessions/${upload.id}/complete`,
          "POST",
        );
        assert.equal(
          (
            await expect(
              editor,
              `/upload-sessions/${upload.id}/complete`,
              "POST",
            )
          ).photo.id,
          complete.photo.id,
        );
        const image = await fetch(
          `${base}/inspections/${complete.photo.id}/image`,
          { headers: { Cookie: viewer.cookie } },
        );
        assert.equal(image.status, 200);
        assert.equal(
          createHash("sha256")
            .update(Buffer.from(await image.arrayBuffer()))
            .digest("hex"),
          hash,
        );
        const photo = await expect(
          editor,
          `/inspections/${complete.photo.id}`,
          "PATCH",
          {
            ...audit,
            expectedVersion: complete.photo.editVersion,
            humanGrade: 4,
          },
        );
        assert.equal(
          photo.ai,
          null,
          "No model performance claim for synthetic pixels",
        );
        photos.push(photo);
      }
    });

    await check(
      "사진별 보수 저장·충돌·관리 필드 차단과 TA 묶음 재조회",
      async () => {
        for (const photo of photos) {
          const target = await expect(
            editor,
            `/maintenance/target?photoId=${photo.id}`,
          );
          assert.equal(target.inWorklist, true);
          const saved = await expect(
            editor,
            "/maintenance",
            "POST",
            {
              ...audit,
              expectedVersion: null,
              planId: plan.id,
              pointId: null,
              targetType: "photo",
              targetId: photo.id,
              photoIds: [photo.id],
              repairStatus: "review",
              repairMethod: "paint",
              ta: true,
              inclusionMode: "auto",
            },
            201,
          );
          work.push(saved);
          await expect(
            editor,
            "/maintenance",
            "POST",
            {
              ...audit,
              expectedVersion: null,
              planId: plan.id,
              pointId: null,
              targetType: "photo",
              targetId: photo.id,
              photoIds: [photo.id],
            },
            409,
          );
          const current = await expect(viewer, `/maintenance/${saved.id}`);
          assert.equal(current.persisted, true);
          assert.equal(current.ta, true);
          await expect(
            editor,
            `/maintenance/${saved.id}`,
            "PATCH",
            {
              ...audit,
              expectedVersion: saved.editVersion,
              repairStatus: "planned",
              visibility: "hidden",
            },
            403,
          );
          assert.equal(
            (await expect(viewer, `/maintenance/${saved.id}`)).repairStatus,
            "review",
          );
        }
        const oldVersion = work[0].editVersion;
        work[0] = await expect(editor, `/maintenance/${work[0].id}`, "PATCH", {
          ...audit,
          expectedVersion: oldVersion,
          repairStatus: "planned",
        });
        await expect(
          editor,
          `/maintenance/${work[0].id}`,
          "PATCH",
          { ...audit, expectedVersion: oldVersion, repairStatus: "done" },
          409,
        );
        const bundleInput = {
          ...audit,
          name: `합성 TA 검증 ${tag}`,
          maintenanceIds: work.slice(0, 2).map((item) => item.id),
          expectedVersions: Object.fromEntries(
            work.slice(0, 2).map((item) => [item.id, item.editVersion]),
          ),
        };
        await expect(
          editor,
          "/maintenance/bundles",
          "POST",
          {
            ...bundleInput,
            expectedVersions: {
              ...bundleInput.expectedVersions,
              [work[0].id]: oldVersion,
            },
          },
          409,
        );
        bundle = await expect(
          editor,
          "/maintenance/bundles",
          "POST",
          bundleInput,
          201,
        );
        await expect(editor, "/maintenance/bundles", "POST", bundleInput, 409);
        const bundles = await expect(viewer, "/maintenance/bundles");
        const readBundle = bundles.items.find((item) => item.id === bundle.id);
        assert.equal(readBundle.members.length, 2);
        const unbundled = await expect(
          viewer,
          `/maintenance/query?targetType=photo&planId=${plan.id}&ta=true&unbundledOnly=true`,
        );
        assert.equal(unbundled.total, 2);
        assert.ok(
          unbundled.items.every(
            (item) => !bundle.maintenanceIds.includes(item.id),
          ),
        );
        for (const item of work) {
          const history = await expect(
            viewer,
            `/maintenance/${item.id}/history`,
          );
          assert.ok(history.length >= (item.id === work[0].id ? 2 : 1));
          assert.ok(
            history.every(
              (row) =>
                row.actorId === editor.user.id &&
                row.actor === editor.user.displayName,
            ),
          );
        }
      },
    );

    await check(
      "이름 변경 유지·역할/사용 상태/비밀번호 변경 회수·로그아웃",
      async () => {
        await expect(admin, `/auth/users/${mutable.user.id}`, "PATCH", {
          displayName: "합성 이름만 변경",
        });
        assert.equal(
          (await expect(mutable, "/auth/session")).user.displayName,
          "합성 이름만 변경",
        );
        await expect(admin, `/auth/users/${mutable.user.id}`, "PATCH", {
          role: "viewer",
        });
        await expect(mutable, "/plans", "GET", undefined, 401);
        let changed = await login(accounts.mutable);
        assert.equal(changed.user.role, "viewer");
        await expect(changed, "/plans", "POST", {}, 403);
        await expect(admin, `/auth/users/${mutable.user.id}`, "PATCH", {
          active: false,
        });
        await expect(changed, "/plans", "GET", undefined, 401);
        await expect(
          null,
          "/auth/login",
          "POST",
          {
            username: accounts.mutable.username,
            password: accounts.mutable.password,
          },
          401,
        );
        await expect(admin, `/auth/users/${mutable.user.id}`, "PATCH", {
          active: true,
        });
        changed = await login(accounts.mutable);
        const resetPassword = secret();
        await expect(admin, `/auth/users/${mutable.user.id}`, "PATCH", {
          password: resetPassword,
        });
        await expect(changed, "/plans", "GET", undefined, 401);
        await expect(
          null,
          "/auth/login",
          "POST",
          {
            username: accounts.mutable.username,
            password: accounts.mutable.password,
          },
          401,
        );
        accounts.mutable.password = resetPassword;
        changed = await login(accounts.mutable);
        await expect(
          changed,
          "/auth/password",
          "POST",
          { currentPassword: secret(), newPassword: secret() },
          422,
        );
        await expect(changed, "/plans");
        const anotherSession = await login(accounts.mutable);
        const newPassword = secret();
        const changedPassword = await call(changed, "/auth/password", "POST", {
          currentPassword: resetPassword,
          newPassword,
        });
        assert.equal(changedPassword.status, 200);
        accounts.mutable.password = newPassword;
        await expect(changed, "/plans", "GET", undefined, 401);
        await expect(anotherSession, "/plans", "GET", undefined, 401);
        const refreshed = session(changedPassword);
        await expect(refreshed, "/plans");
        await expect(refreshed, "/auth/logout", "POST");
        await expect(refreshed, "/plans", "GET", undefined, 401);
      },
    );

    const [auditRows] = await db.query(
      "SELECT data FROM history WHERE entity_id = ?",
      [plan.id],
    );
    assert.ok(auditRows.length >= 2);
    const [sessionRows] = await db.query(
      "SELECT token_hash FROM auth_sessions",
    );
    assert.ok(
      sessionRows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)),
    );
    await writeFile(
      `${root}/credentials.local.json`,
      JSON.stringify(accounts),
      { mode: 0o600 },
    );
    await writeFile(
      `${root}/http-evidence.local.json`,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          passed: failures === 0,
          failures,
          syntheticOnly: true,
          modelInference: false,
          planId: plan?.id,
          photoIds: photos.map((photo) => photo.id),
          maintenanceIds: work.map((item) => item.id),
          bundleId: bundle?.id,
          trace,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  },
);
