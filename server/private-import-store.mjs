import { randomUUID } from "node:crypto";
import { insertEntity, append } from "./store.mjs";
import { pointLocation } from "./relations.mjs";
import { planPrivatePlacement } from "./private-placement.mjs";

const decode = (data) => (typeof data === "string" ? JSON.parse(data) : data);
const conflict = (message) =>
  Object.assign(new Error(message), { code: "import_conflict" });

export async function commitPrivateInference(
  db,
  dataset,
  photo,
  ai,
  predictedAt,
) {
  if (
    !Number.isInteger(ai.grade) ||
    ai.grade < 1 ||
    ai.grade > 5 ||
    !Number.isFinite(ai.confidence) ||
    ai.confidence < 0 ||
    ai.confidence > 1 ||
    ai.model_version !== dataset.freeze.model_version ||
    ai.preprocessing_version !== dataset.freeze.preprocessing_version
  )
    throw conflict("동결 모델 결과 형식이 다릅니다.");
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT data FROM entities WHERE kind='inspection' AND id=? FOR UPDATE",
      [photo.id],
    );
    const before = rows[0] && decode(rows[0].data);
    if (
      !before ||
      before.sourceId !== photo.sourceId ||
      before.sha256 !== photo.sha256 ||
      before.objectKey !== photo.objectKey ||
      !dataset.policy.explicitImportInference(before, photo.sha256).allowed
    )
      throw conflict("판독 대상이 변경됐습니다. 기존 결과를 보존했습니다.");
    const after = {
      ...before,
      ai,
      status: "done",
      error: null,
      updatedAt: predictedAt,
      aiProvenance: {
        kind: "live_frozen_inference",
        sourceId: before.sourceId,
        sourceSha256: before.sha256,
        manifestSha256: dataset.manifestSha256,
        modelVersion: dataset.freeze.model_version,
        preprocessingVersion: dataset.freeze.preprocessing_version,
        checkpointSha256: dataset.freeze.checkpoint_sha256,
        predictedAt,
      },
    };
    await connection.execute(
      "UPDATE entities SET data=? WHERE kind='inspection' AND id=?",
      [JSON.stringify(after), photo.id],
    );
    await append(
      connection,
      photo.id,
      "수정",
      before,
      after,
      "AI 서비스",
      "로컬 미판독 원본의 동결 모델 판독",
    );
    await connection.commit();
    return after;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
export async function initializePrivateRegistry(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS private_import_registry (
    dataset_sha256 CHAR(64) NOT NULL, source_id VARCHAR(80) NOT NULL,
    data JSON NOT NULL, PRIMARY KEY(dataset_sha256,source_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS private_import_parents (
    dataset_sha256 CHAR(64) NOT NULL, parent_key VARCHAR(80) NOT NULL,
    data JSON NOT NULL, PRIMARY KEY(dataset_sha256,parent_key)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS private_import_aliases (
    dataset_sha256 CHAR(64) NOT NULL, alias_key VARCHAR(120) NOT NULL,
    data JSON NOT NULL, PRIMARY KEY(dataset_sha256,alias_key)
  )`);
}

export async function reservePrivateImport(pool, dataset) {
  const placement = planPrivatePlacement(dataset.plan.entries);
  const manifest = dataset.manifestSha256;
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [locks] = await connection.execute(
      "SELECT GET_LOCK(?,0) AS acquired",
      [`private-import:${manifest.slice(0, 40)}`],
    );
    locked = locks[0].acquired === 1;
    if (!locked) throw conflict("다른 가져오기 작업이 진행 중입니다.");
    await connection.beginTransaction();
    const [storedParents] = await connection.execute(
      "SELECT data FROM private_import_parents WHERE dataset_sha256=? FOR UPDATE",
      [manifest],
    );
    const parents = new Map(
      storedParents.map((row) => {
        const data = decode(row.data);
        return [data.key, data];
      }),
    );
    for (const row of placement) {
      for (const [kind, key] of [
        ["point", row.pointKey],
        ["plan", row.planKey],
      ]) {
        const fullKey = `${kind}:${key}`;
        if (parents.has(fullKey)) continue;
        const data = {
          key: fullKey,
          kind,
          id: randomUUID(),
          teamId: row.teamId,
          ...(kind === "point" ? { rackId: row.rackId } : {}),
        };
        await connection.execute(
          "INSERT INTO private_import_parents VALUES (?,?,?)",
          [manifest, fullKey, JSON.stringify(data)],
        );
        parents.set(fullKey, data);
      }
    }
    const [stored] = await connection.execute(
      "SELECT data FROM private_import_registry WHERE dataset_sha256=? FOR UPDATE",
      [manifest],
    );
    const existing = new Map(
      stored.map((row) => {
        const data = decode(row.data);
        return [data.sourceId, data];
      }),
    );
    if (
      [...existing.keys()].some(
        (id) => !placement.some((row) => row.sourceId === id),
      )
    )
      throw conflict("기존 registry에 계획 밖 원본이 있습니다.");
    for (const row of placement) {
      const identity = {
        ...row,
        manifestSha256: manifest,
        pointId: parents.get(`point:${row.pointKey}`).id,
        planId: parents.get(`plan:${row.planKey}`).id,
        objectKey: `originals/${manifest}/${row.sha256}`,
      };
      const current = existing.get(row.sourceId);
      if (current) {
        if (
          Object.entries(identity).some(
            ([key, value]) => current[key] !== value,
          )
        )
          throw conflict(
            "기존 자료 ID·해시·배치 예약이 다릅니다. 덮어쓰지 않습니다.",
          );
        continue;
      }
      const data = {
        ...identity,
        inspectionId: randomUUID(),
        state: "reserved",
        reservedAt: new Date().toISOString(),
      };
      await connection.execute(
        "INSERT INTO private_import_registry VALUES (?,?,?)",
        [manifest, row.sourceId, JSON.stringify(data)],
      );
      existing.set(row.sourceId, data);
    }
    for (const alias of dataset.plan.demo_aliases) {
      const canonical = existing.get(alias.sourceId);
      if (!canonical || canonical.sha256 !== alias.sha256)
        throw conflict("시연 alias의 원본 예약이 다릅니다.");
      const data = {
        ...alias,
        inspectionId: canonical.inspectionId,
        objectKey: canonical.objectKey,
      };
      const [rows] = await connection.execute(
        "SELECT data FROM private_import_aliases WHERE dataset_sha256=? AND alias_key=? FOR UPDATE",
        [manifest, alias.demo_name],
      );
      if (rows.length) {
        if (
          JSON.stringify(decode(rows[0].data), Object.keys(data).sort()) !==
          JSON.stringify(data, Object.keys(data).sort())
        )
          throw conflict("기존 시연 alias 연결이 다릅니다.");
      } else
        await connection.execute(
          "INSERT INTO private_import_aliases VALUES (?,?,?)",
          [manifest, alias.demo_name, JSON.stringify(data)],
        );
    }
    await connection.commit();
    return await readPrivateRegistry(pool, manifest);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    if (locked)
      await connection
        .execute("SELECT RELEASE_LOCK(?)", [
          `private-import:${manifest.slice(0, 40)}`,
        ])
        .catch(() => {});
    connection.release();
  }
}
export async function readPrivateRegistry(pool, manifest) {
  const [rows] = await pool.execute(
    "SELECT data FROM private_import_registry WHERE dataset_sha256=? ORDER BY source_id",
    [manifest],
  );
  return rows.map((row) => decode(row.data));
}

export async function ensurePrivateParents(pool, dataset) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT data FROM private_import_parents WHERE dataset_sha256=? ORDER BY parent_key FOR UPDATE",
      [dataset.manifestSha256],
    );
    const parents = rows.map((row) => decode(row.data));
    for (const parent of parents) {
      const [existing] = await connection.execute(
        "SELECT data FROM entities WHERE kind=? AND id=? FOR UPDATE",
        [parent.kind, parent.id],
      );
      if (existing.length) {
        if (
          decode(existing[0].data).datasetManifestSha256 !==
          dataset.manifestSha256
        )
          throw conflict("예약된 부모 ID가 다른 자료를 가리킵니다.");
        continue;
      }
      const base = {
        id: parent.id,
        editVersion: 0,
        createdAt: new Date().toISOString(),
        recordPurpose: "inspection",
        datasetManifestSha256: dataset.manifestSha256,
      };
      const data =
        parent.kind === "point"
          ? {
              ...base,
              ...pointLocation(parent.rackId, parent.id, ""),
              equipment: "설비 미확인",
              name: "가상 사진 묶음 · 실제 위치 미확인",
              maintenanceSchemaVersion: 1,
              locationVerified: false,
            }
          : {
              ...base,
              title: `정유${parent.teamId.slice(-1)}팀 사진 검토`,
              date: "",
              note: "기존 사진의 가상 배치이며 실제 설비 위치와 검사일은 미확인입니다.",
              status: "planned",
              pointIds: parents
                .filter(
                  (item) =>
                    item.kind === "point" && item.teamId === parent.teamId,
                )
                .map((item) => item.id)
                .sort(),
            };
      await insertEntity(
        connection,
        parent.kind,
        data,
        "로컬 자료 연결",
        "가상 배치와 기존 원본 연결",
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

export async function commitPrivatePhoto(
  pool,
  dataset,
  reservation,
  entry,
  { mime, failBeforeCommit = false } = {},
) {
  const connection = await pool.getConnection();
  let commitAttempted = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT data FROM private_import_registry WHERE dataset_sha256=? AND source_id=? FOR UPDATE",
      [dataset.manifestSha256, entry.sourceId],
    );
    if (!rows.length) throw conflict("원본 ID 예약이 없습니다.");
    const current = decode(rows[0].data);
    if (
      current.inspectionId !== reservation.inspectionId ||
      current.sha256 !== entry.sha256
    )
      throw conflict("원본 ID 예약이 변경됐습니다.");
    const [photos] = await connection.execute(
      "SELECT data FROM entities WHERE kind='inspection' AND id=? FOR UPDATE",
      [current.inspectionId],
    );
    if (current.state === "complete") {
      const photo = photos[0] && decode(photos[0].data);
      if (
        !photo ||
        photo.sourceId !== entry.sourceId ||
        photo.sha256 !== entry.sha256 ||
        photo.objectKey !== current.objectKey ||
        photo.datasetManifestSha256 !== dataset.manifestSha256
      )
        throw conflict("완료된 원본 기록과 예약이 다릅니다.");
      await connection.commit();
      return { created: false, id: photo.id };
    }
    if (photos.length)
      throw conflict("완료 표식 없는 사진 ID가 이미 있습니다.");
    for (const [kind, id] of [
      ["point", current.pointId],
      ["plan", current.planId],
    ]) {
      const [parents] = await connection.execute(
        "SELECT data FROM entities WHERE kind=? AND id=? FOR UPDATE",
        [kind, id],
      );
      const parent = parents[0] && decode(parents[0].data);
      if (
        !parent ||
        (kind === "plan" && !parent.pointIds?.includes(current.pointId))
      )
        throw conflict(
          "예약된 계획·포인트 연결이 바뀌었습니다. 기존 자료를 보존했습니다.",
        );
    }
    const cached = dataset.caches.get(entry.canonicalSourceId);
    const now = new Date().toISOString();
    const photo = {
      id: current.inspectionId,
      name: `검사 사진 ${entry.sourceId.replace(/[^0-9]/g, "")}.${mime === "image/png" ? "png" : "jpg"}`,
      sourceId: entry.sourceId,
      canonicalSourceId: entry.canonicalSourceId,
      datasetManifestSha256: dataset.manifestSha256,
      objectKey: current.objectKey,
      sha256: entry.sha256,
      size: entry.size_bytes,
      mime,
      pointId: current.pointId,
      planId: current.planId,
      recordPurpose: "inspection",
      visibility: "visible",
      status: cached ? "done" : "unread",
      ai: cached ? structuredClone(cached.ai) : null,
      aiProvenance: cached
        ? {
            ...cached.provenance,
            sourceId: entry.sourceId,
            cacheSourceId: entry.canonicalSourceId,
            importedAt: now,
          }
        : null,
      inferencePolicy: {
        allowed: false,
        reason: entry.canonicalSplit === "test" ? "fixed_test" : "import_hold",
      },
      protectedEvaluation: entry.canonicalSplit === "test",
      assetAlias: entry.duplicateOf !== null,
      humanGrade: null,
      retake: false,
      retakeReason: "",
      labeling: false,
      error: null,
      editVersion: 0,
      createdAt: now,
    };
    await insertEntity(
      connection,
      "inspection",
      photo,
      "로컬 자료 연결",
      "기존 원본 및 보존된 판독 출처 등록",
    );
    await connection.execute(
      "UPDATE private_import_registry SET data=? WHERE dataset_sha256=? AND source_id=?",
      [
        JSON.stringify({ ...current, state: "complete", completedAt: now }),
        dataset.manifestSha256,
        entry.sourceId,
      ],
    );
    if (failBeforeCommit) throw new Error("synthetic failure before commit");
    commitAttempted = true;
    await connection.commit();
    return { created: true, id: photo.id };
  } catch (error) {
    await connection.rollback().catch(() => {});
    error.commitUncertain = commitAttempted;
    throw error;
  } finally {
    connection.release();
  }
}
