import { readFile } from "node:fs/promises";

const snapshotUrl = new URL("../public/data/reservoir-status.json", import.meta.url);
const snapshot = JSON.parse(await readFile(snapshotUrl, "utf8"));
const reservoirs = Array.isArray(snapshot.reservoirs) ? snapshot.reservoirs : [];
const unavailable = Array.isArray(snapshot.unavailable) ? snapshot.unavailable : [];
const generatedAt = new Date(snapshot.generatedAt);
const ageHours = (Date.now() - generatedAt.getTime()) / 3_600_000;

const failures = [];
if (snapshot.source !== "APA / SNIRH") failures.push("fonte inesperada");
if (!Number.isFinite(generatedAt.getTime()) || ageHours < -1 || ageHours > 6) failures.push("generatedAt inválido ou desatualizado");
if (reservoirs.length < 60) failures.push(`apenas ${reservoirs.length} albufeiras com leitura`);
if (new Set(reservoirs.map((item) => item.code)).size !== reservoirs.length) failures.push("códigos de albufeira duplicados");
if (snapshot.coverage?.currentReadings !== reservoirs.length) failures.push("cobertura incoerente com as leituras publicadas");

for (const item of reservoirs) {
  if (!item.code || !item.siteId || !item.name) failures.push("registo sem identidade completa");
  if (!item.current?.date || (item.current.volumeDam3 == null && item.current.cotaM == null)) {
    failures.push(`${item.code || "?"}: leitura atual ausente`);
  }
}

if (failures.length) {
  throw new Error(`Snapshot SNIRH rejeitado: ${[...new Set(failures)].join("; ")}.`);
}

console.log(JSON.stringify({
  status: "valid",
  generatedAt: snapshot.generatedAt,
  reservoirs: reservoirs.length,
  unavailable: unavailable.length,
}, null, 2));
