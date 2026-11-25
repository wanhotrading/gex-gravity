import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createPrivateStore, encode64 } from "../lib/secure-store.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const [source, manifest] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
JSON.parse(manifest);

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

const records = new Map();
const env = {
  BUCKET: {
    async get(key) {
      return records.has(key) ? { text: async () => records.get(key) } : null;
    },
    async put(key, body) {
      records.set(key, String(body));
    },
  },
  GAMMA_SITE_ORIGIN: "https://gamma.test",
  FUTU_TOKEN_ENCRYPTION_KEY: encode64(new Uint8Array(32)),
};
const store = createPrivateStore(env);
const underlyingCode = "US.NQ2612";
await store.put("watch/state", { markets: { NQ: { market: "NQ", underlyingCode, contracts: [] } } });
await store.put("watch/menthorq-context", {
  NQ: {
    source: "MenthorQ", mode: "Intraday", underlyingCode, sourceDate: "2026-11-17",
    capturedAt: "2026-11-17T14:50:00Z", levels: [{ strike: 28000, labels: ["Put Support"] }],
  },
});
for (const query of ["", "?view=summary"]) {
  const response = await workerModule.default.fetch(new Request(env.GAMMA_SITE_ORIGIN + "/api/market-state" + query), env);
  assert.equal(response.status, 200, "The bundled worker must serve a saved MenthorQ map");
  assert.equal((await response.json()).markets.NQ.watchContext.levels[0].strike, 28000);
}
console.log("Artifact serves saved Levels through both market-state endpoints.");
