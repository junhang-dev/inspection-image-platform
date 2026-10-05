import { z } from "zod";
import {
  createMaintenanceBundle,
  readMaintenanceBundles,
} from "./maintenance-bundle-store.mjs";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const createMaintenanceBundleSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    maintenanceIds: z.array(uuid).min(2).max(2000),
    expectedVersions: z.record(
      uuid,
      z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER - 1),
    ),
    actor: z.string().trim().min(1).max(60),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

export function registerMaintenanceBundleRoutes(app) {
  app.get("/api/maintenance/bundles", async (_req, res) => {
    res.json({ items: await readMaintenanceBundles() });
  });
  app.post("/api/maintenance/bundles", async (req, res) => {
    res
      .status(201)
      .json(
        await createMaintenanceBundle(
          createMaintenanceBundleSchema.parse(req.body),
        ),
      );
  });
}
