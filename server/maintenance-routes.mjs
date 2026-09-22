import { z } from "zod";
import { pool, get, decodeEntity, events } from "./store.mjs";
import { maintenanceId } from "./maintenance-domain.mjs";
import { photoTarget } from "./maintenance-view.mjs";
import { saveMaintenance } from "./maintenance-store.mjs";
import {
  maintenanceQuerySchema,
  queryMaintenance,
  allMaintenanceViews,
} from "./maintenance-query.mjs";
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const expectedVersion = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const audit = {
  actor: z.string().trim().min(1, "수정자를 입력하세요.").max(60),
  reason: z.string().trim().min(1, "변경 사유를 입력하세요.").max(1000),
};
const fields = {
  photoIds: z.array(uuid).max(2000).optional(),
  repairStatus: z
    .enum(["none", "review", "planned", "progress", "done"])
    .optional(),
  repairMethod: z.enum(["undecided", "paint", "replace"]).optional(),
  inWorklist: z.boolean().optional(),
  ta: z.boolean().optional(),
  inclusionMode: z.enum(["auto", "include", "exclude"]).optional(),
  visibility: z.enum(["visible", "hidden"]).optional(),
  acknowledgedEvidence: z.record(uuid, z.string().regex(/^[a-f0-9]{64}$/)).refine((value) => Object.keys(value).length <= 2000).optional(),
  recordPurpose: z
    .enum(["inspection", "presentation", "verification"])
    .optional(),
};
const createSchema = z
  .object({
    planId: uuid.nullable(),
    pointId: uuid.nullable(),
    targetType: z.enum(["point", "photo"]).optional(),
    targetId: uuid.optional(),
    expectedVersion: z.null(),
    ...audit,
    ...fields,
  })
  .strict();
const patchSchema = z.object({ expectedVersion, ...audit, ...fields }).strict();
const fail = (status, message) => Object.assign(new Error(message), { status });
export function registerMaintenanceRoutes(app) {
  app.get("/api/maintenance/query", async (req, res) =>
    res.json(
      await queryMaintenance(
        pool,
        decodeEntity,
        maintenanceQuerySchema.parse(req.query),
      ),
    ),
  );
  app.get("/api/maintenance/pair", async (req, res) => {
    const q = z
      .object({
        planId: z.union([uuid, z.literal("unassigned")]),
        pointId: uuid,
      })
      .strict()
      .parse(req.query);
    const id = maintenanceId(q.planId === "unassigned" ? null : q.planId, q.pointId);
    res.json((await allMaintenanceViews(pool, decodeEntity)).find((item) => item.id === id) ?? null);
  });
  app.get("/api/maintenance/target", async (req, res) => {
    const photo = await get("inspection", uuid.parse(req.query.photoId));
    if (!photo) throw fail(404, "사진을 찾을 수 없습니다.");
    res.json((await allMaintenanceViews(pool, decodeEntity)).find((item) => item.id === photoTarget(photo).id) ?? null);
  });
  app.get("/api/maintenance/:id/history", async (req, res) =>
    res.json(await events(uuid.parse(req.params.id))),
  );
  app.get("/api/maintenance/:id", async (req, res) => {
    const id = uuid.parse(req.params.id);
    const item = (await allMaintenanceViews(pool, decodeEntity)).find((item) => item.id === id);
    if (!item) throw fail(404, "보수 기록을 찾을 수 없습니다.");
    res.json(item);
  });
  app.post("/api/maintenance", async (req, res) =>
    res.status(201).json(await saveMaintenance(createSchema.parse(req.body))),
  );
  app.patch("/api/maintenance/:id", async (req, res) => {
    const input = patchSchema.parse(req.body),
      current = await get("maintenance", uuid.parse(req.params.id));
    if (!current) throw fail(404, "보수 기록을 찾을 수 없습니다.");
    res.json(
      await saveMaintenance({
        planId: current.planId,
        pointId: current.pointId,
        targetType: current.targetType,
        targetId: current.targetId,
        ...input,
      }),
    );
  });
}
