import { z } from "zod";
import { pool, get, decodeEntity, events } from "./store.mjs";
import { maintenanceId } from "./maintenance-domain.mjs";
import { saveMaintenance } from "./maintenance-store.mjs";
import {
  maintenanceQuerySchema,
  queryMaintenance,
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
  recordPurpose: z
    .enum(["inspection", "presentation", "verification"])
    .optional(),
};
const createSchema = z
  .object({
    planId: uuid.nullable(),
    pointId: uuid,
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
    res.json(
      await get(
        "maintenance",
        maintenanceId(q.planId === "unassigned" ? null : q.planId, q.pointId),
      ),
    );
  });
  app.get("/api/maintenance/:id/history", async (req, res) =>
    res.json(await events(uuid.parse(req.params.id))),
  );
  app.get("/api/maintenance/:id", async (req, res) => {
    const item = await get("maintenance", uuid.parse(req.params.id));
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
        ...input,
      }),
    );
  });
}
