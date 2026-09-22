import { z } from "zod";
import { locations } from "./relations.mjs";
import { deriveMaintenance, maintenancePage } from "./maintenance-view.mjs";
const id = z.union([
  z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase()),
  z.literal("all"),
  z.literal("unassigned"),
]);
export const maintenanceQuerySchema = z
  .object({
    planId: id.default("all"),
    pointId: z
      .union([
        z
          .string()
          .uuid()
          .transform((value) => value.toLowerCase()),
        z.literal("all"),
      ])
      .default("all"),
    recordPurpose: z
      .enum(["inspection", "presentation", "verification", "all"])
      .default("inspection"),
    visibility: z.enum(["visible", "hidden", "all"]).default("visible"),
    inWorklist: z.enum(["true", "all"]).default("true"),
    ta: z.enum(["all", "true", "false"]).default("all"),
    repairStatus: z
      .enum(["all", "none", "review", "planned", "progress", "done"])
      .default("all"),
    repairMethod: z
      .enum(["all", "undecided", "paint", "replace"])
      .default("all"),
    teamId: z
      .enum(["all", ...locations.teams.map((team) => team.id)])
      .default("all"),
    rackId: z
      .enum(["all", ...locations.racks.map((rack) => rack.id)])
      .default("all"),
    search: z.string().trim().max(200).default(""),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (q) =>
      q.teamId === "all" ||
      q.rackId === "all" ||
      locations.racks.some((r) => r.id === q.rackId && r.teamId === q.teamId),
    "선택한 팀에 속한 랙을 선택하세요.",
  );
export async function readMaintenanceSnapshot(connection, decodeEntity) {
  const [rows] = await connection.execute("SELECT kind, data FROM entities WHERE kind IN ('inspection', 'maintenance', 'point', 'plan')");
  const data = { photos: [], saved: [], points: [], plans: [], history: [] };
  const names = { inspection: "photos", maintenance: "saved", point: "points", plan: "plans" };
  for (const row of rows) data[names[row.kind]].push(decodeEntity(row.data, row.kind));
  const legacy = data.saved.filter((item) => !item.inclusionMode && !item.inWorklist).map((item) => item.id);
  if (legacy.length) {
    const [events] = await connection.execute(`SELECT data FROM history WHERE entity_id IN (${legacy.map(() => "?").join(",")})`, legacy);
    data.history = events.map((row) => typeof row.data === "string" ? JSON.parse(row.data) : row.data);
  }
  return data;
}
export async function allMaintenanceViews(pool, decodeEntity) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    const items = deriveMaintenance(await readMaintenanceSnapshot(connection, decodeEntity));
    await connection.commit();
    return items;
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally { connection.release(); }
}
export async function queryMaintenance(pool, decodeEntity, query) {
  return maintenancePage(await allMaintenanceViews(pool, decodeEntity), query);
}
