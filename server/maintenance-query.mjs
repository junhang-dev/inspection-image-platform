import { z } from "zod";
import { locations } from "./relations.mjs";
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
const text = (alias, key) =>
  `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.data, '$.${key}')), 'null')`;
export async function queryMaintenance(pool, decodeEntity, query) {
  const clauses = ["m.kind = 'maintenance'"],
    values = [];
  for (const key of ["planId", "pointId"])
    if (query[key] !== "all") {
      clauses.push(`COALESCE(${text("m", key)}, '') = ?`);
      values.push(query[key] === "unassigned" ? "" : query[key]);
    }
  if (query.recordPurpose !== "all") {
    clauses.push(`COALESCE(${text("m", "recordPurpose")}, 'inspection') = ?`);
    values.push(query.recordPurpose);
  }
  if (query.inWorklist === "true")
    clauses.push(`${text("m", "inWorklist")} = 'true'`);
  for (const key of ["ta", "repairStatus", "repairMethod"])
    if (query[key] !== "all") {
      clauses.push(`${text("m", key)} = ?`);
      values.push(query[key]);
    }
  if (query.rackId !== "all") {
    clauses.push(`${text("p", "rackId")} = ?`);
    values.push(query.rackId);
  } else if (query.teamId !== "all") {
    const racks = locations.racks.filter((r) => r.teamId === query.teamId);
    clauses.push(
      `${text("p", "rackId")} IN (${racks.map(() => "?").join(",")})`,
    );
    values.push(...racks.map((r) => r.id));
  }
  if (query.search) {
    clauses.push(
      `CONCAT_WS(' ', ${["equipment", "rack", "name"].map((key) => text("p", key)).join(",")}, ${text("l", "title")}) LIKE ? ESCAPE '='`,
    );
    values.push(`%${query.search.replace(/[=%_]/g, (c) => "=" + c)}%`);
  }
  const from = `FROM entities m LEFT JOIN entities p ON p.kind = 'point' AND p.id = ${text("m", "pointId")} LEFT JOIN entities l ON l.kind = 'plan' AND l.id = ${text("m", "planId")} WHERE ${clauses.map((c) => "(" + c + ")").join(" AND ")}`;
  const connection = await pool.getConnection();
  try {
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    const [counts] = await connection.execute(
      `SELECT COUNT(*) AS total ${from}`,
      values,
    );
    const total = Number(counts[0].total),
      pages = Math.max(1, Math.ceil(total / query.pageSize)),
      page = Math.min(query.page, pages);
    const [rows] = await connection.execute(
      `SELECT m.data, ${text("l", "title")} AS planTitle, CONCAT_WS(' · ', ${["equipment", "rack", "name"].map((key) => `NULLIF(${text("p", key)}, '')`).join(",")}) AS pointLabel, JSON_LENGTH(m.data, '$.photoIds') AS photoCount ${from} ORDER BY m.created_at DESC, m.id DESC LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}`,
      values,
    );
    const [summaries] = await connection.execute(
      `SELECT ${text("m", "pointId")} AS pointId, COUNT(*) AS total, COALESCE(SUM(${text("m", "inWorklist")} = 'true'),0) AS registered, ${["none", "review", "planned", "progress", "done"].map((status) => `COALESCE(SUM(${text("m", "repairStatus")} = '${status}'),0) AS ${status}`).join(",")} ${from} GROUP BY ${text("m", "pointId")}`,
      values,
    );
    await connection.commit();
    return {
      items: rows.map((row) => ({
        ...decodeEntity(row.data, "maintenance"),
        planTitle: row.planTitle,
        pointLabel: row.pointLabel || "포인트 이름 미조회",
        photoCount: Number(row.photoCount),
      })),
      total,
      page,
      pages,
      pageSize: query.pageSize,
      scope: query,
      pointSummaries: Object.fromEntries(
        summaries.map(({ pointId, ...counts }) => [
          pointId,
          Object.fromEntries(
            Object.entries(counts).map(([key, value]) => [key, Number(value)]),
          ),
        ]),
      ),
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
