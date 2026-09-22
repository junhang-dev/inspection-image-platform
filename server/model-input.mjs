import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

export async function predictStream(modelUrl, source, photo, { signal } = {}) {
  // The source can disconnect before fetch begins consuming the multipart body.
  source.on("error", () => {});
  const boundary = `inspection-${randomUUID()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="inspection-image"\r\nContent-Type: ${photo.mime}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from(
    (async function* () {
      yield header;
      for await (const bytes of source) yield bytes;
      yield footer;
    })(),
  );
  try {
    signal?.throwIfAborted();
    const response = await fetch(`${modelUrl}/predict`, {
      method: "POST",
      body,
      duplex: "half",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(header.length + photo.size + footer.length),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error(`모델 응답 오류 (${response.status})`);
    return await response.json();
  } finally {
    source.destroy();
    body.destroy();
  }
}
