import { z } from "zod";
import { locations } from "./relations.mjs";

const id = z.union([
  z.string().uuid(),
  z.literal("all"),
  z.literal("unassigned"),
]);
export const photoQuerySchema = z
  .object({
    planId: id.default("all"),
    pointId: id.default("all"),
    recordPurpose: z
      .enum(["inspection", "presentation", "verification", "all"])
      .default("inspection"),
    visibility: z.enum(["visible", "hidden", "all"]).default("visible"),
    teamId: z
      .enum(["all", ...locations.teams.map((team) => team.id)])
      .default("all"),
    rackId: z
      .enum(["all", ...locations.racks.map((rack) => rack.id)])
      .default("all"),
    search: z.string().trim().max(200).default(""),
    classification: z
      .enum(["all", "repair", "pending", "retake", "done", "error"])
      .default("all"),
    labeling: z.enum(["all", "true"]).default("all"),
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .refine(
    (query) =>
      query.teamId === "all" ||
      query.rackId === "all" ||
      locations.racks.some(
        (rack) => rack.id === query.rackId && rack.teamId === query.teamId,
      ),
    "선택한 팀에 속한 파이프랙을 선택하세요.",
  );

const text = (alias, field) =>
  `NULLIF(JSON_UNQUOTE(JSON_EXTRACT(${alias}.data, '$.${field}')), 'null')`;
export const photoConditions = {
  repair: `COALESCE(${text("i", "humanGrade")}, ${text("i", "ai.grade")}, 0) + 0 >= 3`,
  pending: `${text("i", "status")} IN ('pending', 'processing')`,
  retake: `${text("i", "retake")} = 'true'`,
  done: `${text("i", "status")} = 'done'`,
  error: `${text("i", "status")} = 'error'`,
  labeling: `${text("i", "labeling")} = 'true'`,
};
const literalLike = (value) =>
  `%${value.replace(/[=%_]/g, (part) => `=${part}`)}%`;

// All counts and rows use these predicates before applying any page limit.
export function photoWhere(query, { classification = true } = {}) {
  const clauses = ["i.kind = 'inspection'"];
  const values = [];
  for (const key of ["planId", "pointId"]) {
    if (query[key] !== "all") {
      clauses.push(`COALESCE(${text("i", key)}, '') = ?`);
      values.push(query[key] === "unassigned" ? "" : query[key]);
    }
  }
  for (const [key, fallback] of [
    ["recordPurpose", "inspection"],
    ["visibility", "visible"],
  ]) {
    if (query[key] !== "all") {
      clauses.push(`COALESCE(${text("i", key)}, '${fallback}') = ?`);
      values.push(query[key]);
    }
  }
  if (query.rackId !== "all") {
    clauses.push(`${text("p", "rackId")} = ?`);
    values.push(query.rackId);
  } else if (query.teamId !== "all") {
    const racks = locations.racks.filter(
      (rack) => rack.teamId === query.teamId,
    );
    clauses.push(
      `${text("p", "rackId")} IN (${racks.map(() => "?").join(",")})`,
    );
    values.push(...racks.map((rack) => rack.id));
  }
  if (query.search) {
    clauses.push(
      `CONCAT_WS(' ', ${[text("i", "name"), text("p", "equipment"), text("p", "rack"), text("p", "name")].join(", ")}) LIKE ? ESCAPE '='`,
    );
    values.push(literalLike(query.search));
  }
  if (query.labeling === "true") clauses.push(photoConditions.labeling);
  if (classification && query.classification !== "all")
    clauses.push(photoConditions[query.classification]);
  return { sql: clauses.map((clause) => `(${clause})`).join(" AND "), values };
}

export async function queryPhotos(pool, decodeEntity, query) {
  const connection = await pool.getConnection();
  const base = photoWhere(query, { classification: false });
  const filtered = photoWhere(query);
  const from = `FROM entities i LEFT JOIN entities p ON p.kind = 'point' AND p.id = ${text("i", "pointId")}`;
  try {
    // A consistent read keeps page, COUNT and map totals on one database snapshot.
    await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.beginTransaction();
    const [summaries] = await connection.execute(
      `SELECT COUNT(*) AS total, ${Object.entries(photoConditions)
        .map(([key, condition]) => `COALESCE(SUM(${condition}), 0) AS ${key}`)
        .join(", ")} ${from} WHERE ${base.sql}`,
      base.values,
    );
    const [totals] = await connection.execute(
      `SELECT COUNT(*) AS total ${from} WHERE ${filtered.sql}`,
      filtered.values,
    );
    const total = Number(totals[0].total);
    const pages = Math.max(1, Math.ceil(total / query.pageSize));
    const page = Math.min(query.page, pages);
    const [rows] = await connection.execute(
      `SELECT i.data ${from} WHERE ${filtered.sql} ORDER BY i.created_at DESC, i.id DESC LIMIT ${query.pageSize} OFFSET ${(page - 1) * query.pageSize}`,
      filtered.values,
    );
    const [counts] = await connection.execute(
      `SELECT ${text("i", "pointId")} AS pointId, COUNT(*) AS total ${from} WHERE ${filtered.sql} GROUP BY ${text("i", "pointId")}`,
      filtered.values,
    );
    await connection.commit();
    return {
      items: rows.map((row) => decodeEntity(row.data, "inspection")),
      total,
      page,
      pageSize: query.pageSize,
      pages,
      summary: Object.fromEntries(
        Object.entries(summaries[0]).map(([key, value]) => [
          key,
          Number(value),
        ]),
      ),
      pointCounts: Object.fromEntries(
        counts
          .filter((row) => row.pointId)
          .map((row) => [row.pointId, Number(row.total)]),
      ),
      scope: query,
    };
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}
