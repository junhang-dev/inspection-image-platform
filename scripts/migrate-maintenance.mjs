import "dotenv/config";
import { pool } from "../server/store.mjs";
import { migratePointMaintenance } from "../server/maintenance-store.mjs";
// Run during the API cutover before allowing new maintenance writes. This is
// deliberately not an automatic startup migration. Default invocation is read-only.
const apply = process.argv.includes("--apply");
try {
  const [points] = await pool.query(
    "SELECT id FROM entities WHERE kind = 'point' ORDER BY id",
  );
  const results = [];
  for (const point of points)
    results.push(await migratePointMaintenance(point.id, { apply }));
  console.log(
    JSON.stringify({
      apply,
      points: results.length,
      created: results.filter((row) => row.created).length,
      marked: results.filter((row) => row.marked).length,
    }),
  );
} finally {
  await pool.end();
}
