import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import sharp from "sharp";
import { digest } from "../../server/dataset-contract.mjs";

// Synthetic pixels only; production originals and labels are never accessed.
export async function createPrivateFixture(directory) {
  const root = resolve(directory);
  await mkdir(join(root, "source"), { recursive: true, mode: 0o700 });
  const save = async (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const path = join(root, name);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { path, sha256: digest(bytes) };
  };
  const originals = [];
  const bytes = new Map();
  for (let n = 1; n <= 300; n++) {
    const canonical = n === 300 ? 226 : n;
    const id = `FIX-${String(n).padStart(3, "0")}`;
    const input =
      n === 300
        ? bytes.get(226)
        : await sharp({
            create: {
              width: 16,
              height: 16,
              channels: 3,
              background: { r: n % 256, g: Math.floor(n / 256), b: 83 },
            },
          })
            .png()
            .toBuffer();
    bytes.set(n, input);
    const relative_path = `${id}.png`;
    await writeFile(join(root, "source", relative_path), input, {
      flag: "wx",
      mode: 0o600,
    });
    originals.push({
      id,
      relative_path,
      sha256: digest(input),
      size_bytes: input.length,
      split:
        canonical <= 231 ? "train" : canonical <= 289 ? "validation" : "test",
      included: n !== 300,
      duplicate_of: n === 300 ? "FIX-226" : null,
    });
  }
  const manifest = await save("manifest.local.json", { entries: originals });
  const frozen = {
    manifest_sha256: manifest.sha256,
    model_version: "synthetic-model-v1",
    preprocessing_version: "synthetic-preprocessing-v1",
    checkpoint_sha256: "c".repeat(64),
  };
  const freeze = await save("freeze.local.json", frozen);
  const reports = {};
  for (const split of ["train", "test"]) {
    reports[split] = await save(`${split}.local.json`, {
      ...frozen,
      split,
      results: originals
        .filter(
          (e) =>
            e.included &&
            e.split === split &&
            !["FIX-001", "FIX-290"].includes(e.id),
        )
        .map((e) => ({
          id: e.id,
          actual: 5,
          grade: 3,
          confidence: 0.9,
          model_version: frozen.model_version,
          preprocessing_version: frozen.preprocessing_version,
        })),
    });
  }
  const plan = await save("plan.local.json", {
    algorithm: "virtual-four-team-placement-v1",
    publicExposureAllowed: false,
    source_root_reference: join(root, "source"),
    evidence: { manifest, freeze, evaluation: reports.test },
    demo_aliases: originals
      .slice(0, 5)
      .map((e) => ({
        demo_name: `${e.id}.png`,
        sourceId: e.id,
        sha256: e.sha256,
      })),
    entries: originals.map((e, index) => ({
      sourceId: e.id,
      sha256: e.sha256,
      relative_path: e.relative_path,
      size_bytes: e.size_bytes,
      canonicalSourceId: e.duplicate_of || e.id,
      originalSplit: e.split,
      canonicalSplit: e.split,
      included: e.included,
      duplicateOf: e.duplicate_of,
      team: `virtual-team-0${Math.floor(index / 75) + 1}`,
      inferenceAllowed: false,
      locationVerified: false,
      virtualAssignment: true,
    })),
  });
  return { plan, train: reports.train, root };
}
