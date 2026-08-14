import { readFile, writeFile } from "node:fs/promises";

const SNIRH = "https://snirh.apambiente.pt";
const NETWORK_ID = "920123705";
const OUTPUT = new URL("../public/data/reservoir-status.json", import.meta.url);
const RESERVOIRS = new URL("../public/data/reservoirs.geojson", import.meta.url);
const decoder = new TextDecoder("windows-1252");
const today = new Date();
const start = new Date(Date.UTC(today.getUTCFullYear() - 2, today.getUTCMonth(), 1));
const checkAccess = process.argv.includes("--check-access");
const refreshCatalog = process.argv.includes("--refresh-catalog");
const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const REQUEST_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pt-PT,pt;q=0.9,en;q=0.7",
  "cache-control": "no-cache",
};
let nextRequestAt = 0;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForRequestSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + 175;
  if (wait) await delay(wait);
}

function cookiesFrom(response) {
  const values = response.headers.getSetCookie?.()
    ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")] : []);
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function dateParam(date) {
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

function textFrom(buffer) {
  return decoder.decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchBytes(url, options = {}) {
  let lastResponse;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await waitForRequestSlot();
    const response = await fetch(url, {
      ...options,
      headers: { ...REQUEST_HEADERS, ...options.headers },
      signal: AbortSignal.timeout(45_000),
    });
    lastResponse = response;
    if (response.ok) return { response, bytes: new Uint8Array(await response.arrayBuffer()) };
    await response.arrayBuffer().catch(() => {});
    if (!RETRYABLE_STATUS.has(response.status) || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after"));
    await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1_000 * (2 ** attempt));
  }
  throw new Error(`${lastResponse.status} ${lastResponse.statusText} · ${url}`);
}

async function fetchStationCatalog() {
  const catalogUrl = `${SNIRH}/index.php?idMain=2&idItem=3`;
  const landing = await fetchBytes(catalogUrl, {
    headers: { referer: `${SNIRH}/` },
  });
  const cookie = cookiesFrom(landing.response);
  const body = new URLSearchParams({
    accao: "go",
    tipo_entrada: "0",
    form_estacao: "",
    "form_rede[1]": NETWORK_ID,
    f_divisao_administrativa: "",
    f_curso_agua: "",
  });
  const { bytes } = await fetchBytes(catalogUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: SNIRH,
      referer: catalogUrl,
      ...(cookie ? { cookie } : {}),
    },
    body,
  });
  const html = textFrom(bytes);
  const stations = new Map();
  const rows = html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const [, row] of rows) {
    const url = row.match(/FILTRA_BACIA=(\d+)&amp;FILTRA_COVER=\d+&amp;FILTRA_SITE=(\d+)/i)
      ?? row.match(/FILTRA_BACIA=(\d+)&FILTRA_COVER=\d+&FILTRA_SITE=(\d+)/i);
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => stripHtml(match[1]));
    if (!url || cells.length < 4) continue;
    const code = cells.find((cell) => /^\d{2}[A-Z]\/\d{2}[A-Z]+$/i.test(cell));
    if (!code) continue;
    stations.set(code.toUpperCase(), {
      basinId: url[1],
      siteId: url[2],
      code: code.toUpperCase(),
      name: cells[cells.indexOf(code) + 1] ?? code,
    });
  }
  return stations;
}

function parseBiffLabels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cells = new Map();
  for (let offset = 0; offset + 4 <= bytes.length;) {
    const record = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const end = offset + 4 + length;
    if (end > bytes.length) break;
    if (record === 0x0204 && length >= 8) {
      const row = view.getUint16(offset + 4, true);
      const column = view.getUint16(offset + 6, true);
      const textLength = view.getUint16(offset + 10, true);
      const startText = offset + 12;
      if (startText + textLength <= end) cells.set(`${row}:${column}`, textFrom(bytes.subarray(startText, startText + textLength)).trim());
    }
    offset = end;
  }
  return cells;
}

function numberFrom(value) {
  if (!value) return null;
  const parsed = Number(String(value).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function metadataValue(cells, label) {
  const normalizedLabel = label
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-PT")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [key, value] of cells) {
    const normalizedValue = value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLocaleLowerCase("pt-PT")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (normalizedValue !== normalizedLabel) continue;
    const [row] = key.split(":");
    return cells.get(`${row}:1`) ?? null;
  }
  return null;
}

async function fetchMetadata(station) {
  const metadataUrl = `${SNIRH}/index.php?idRef=MTE3Nw==&simbolo_redehidro=${encodeURIComponent(station.code)}`;
  const { response: page } = await fetchBytes(metadataUrl, {
    headers: { referer: `${SNIRH}/index.php?idItem=7&idMain=1` },
  });
  const cookie = cookiesFrom(page);
  const { bytes } = await fetchBytes(`${SNIRH}/snirh/_dadossintese/albufeirasinv/export.php`, {
    headers: {
      referer: metadataUrl,
      ...(cookie ? { cookie } : {}),
    },
  });
  const cells = parseBiffLabels(bytes);
  return {
    capacityDam3: numberFrom(metadataValue(cells, "Capacidade total (dam3):")),
    usefulCapacityDam3: numberFrom(metadataValue(cells, "Capacidade útil (dam3):")),
    npaM: numberFrom(metadataValue(cells, "Cota do nível de pleno armazenamento - NPA (m):")),
    nmcM: numberFrom(metadataValue(cells, "Cota do nível de máxima cheia - NMC (m):")),
    minimumOperatingLevelM: numberFrom(metadataValue(cells, "Cota do nível mínimo de exploração - NmE (m):")),
    owner: metadataValue(cells, "Dono da obra:"),
    operator: metadataValue(cells, "Entidade exploradora:"),
    useTypes: metadataValue(cells, "Tipos de aproveitamento:"),
  };
}

function parseSeries(text) {
  const points = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}),(-?\d+(?:[.,]\d+)?)/);
    if (!match) continue;
    const value = Number(match[6].replace(",", "."));
    if (!Number.isFinite(value)) continue;
    points.push({
      date: `${match[3]}-${match[2]}-${match[1]}T${match[4]}:${match[5]}:00`,
      value,
    });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchSeries(siteId, parameterId) {
  const query = new URLSearchParams({
    sites: siteId,
    pars: String(parameterId),
    tmin: dateParam(start),
    tmax: dateParam(today),
    formato: "csv",
  });
  const { bytes } = await fetchBytes(`${SNIRH}/snirh/_dadosbase/site/paraCSV/dados_csv.php?${query}`);
  return parseSeries(textFrom(bytes));
}

function closestOlder(points, target) {
  const targetTime = target.getTime();
  return [...points].reverse().find((point) => new Date(`${point.date}Z`).getTime() <= targetTime) ?? null;
}

function monthlyHistory(points, capacityDam3) {
  const byMonth = new Map();
  points.forEach((point) => byMonth.set(point.date.slice(0, 7), point));
  return [...byMonth.values()].slice(-24).map((point) => ({
    date: point.date.slice(0, 10),
    volumeDam3: point.value,
    storagePercent: capacityDam3 ? Math.min(100, point.value / capacityDam3 * 100) : null,
  }));
}

async function buildStatus(feature, station, cachedStatus) {
  const metadata = cachedStatus ? {
    capacityDam3: cachedStatus.capacityDam3,
    usefulCapacityDam3: cachedStatus.usefulCapacityDam3,
    npaM: cachedStatus.npaM,
    nmcM: cachedStatus.nmcM,
    minimumOperatingLevelM: cachedStatus.minimumOperatingLevelM,
    owner: cachedStatus.owner,
    operator: cachedStatus.operator,
    useTypes: cachedStatus.useTypes,
  } : await fetchMetadata(station);
  const [volumes, levels] = await Promise.all([
    fetchSeries(station.siteId, 354_895_398),
    fetchSeries(station.siteId, 354_895_424),
  ]);
  const latestVolume = volumes.at(-1) ?? null;
  const latestLevel = levels.at(-1) ?? null;
  if (!latestVolume && !latestLevel) throw new Error(`${station.code}: sem leituras`);
  const latestDate = new Date(`${(latestVolume ?? latestLevel).date}Z`);
  const monthPoint = closestOlder(volumes, new Date(latestDate.getTime() - 28 * 86_400_000));
  const yearPoint = closestOlder(volumes, new Date(latestDate.getTime() - 350 * 86_400_000));
  const capacity = metadata.capacityDam3;
  const percentage = latestVolume && capacity ? Math.min(100, latestVolume.value / capacity * 100) : null;
  return {
    code: station.code,
    siteId: station.siteId,
    basinId: station.basinId,
    name: feature.properties.albufeira,
    river: feature.properties.lagua,
    basin: feature.properties.bacia,
    ...metadata,
    current: {
      date: (latestVolume ?? latestLevel).date,
      volumeDam3: latestVolume?.value ?? null,
      cotaM: latestLevel?.value ?? null,
      storagePercent: percentage,
    },
    changes: {
      monthPercentagePoints: percentage != null && monthPoint && capacity ? percentage - monthPoint.value / capacity * 100 : null,
      yearPercentagePoints: percentage != null && yearPoint && capacity ? percentage - yearPoint.value / capacity * 100 : null,
    },
    history: monthlyHistory(volumes, capacity),
    sourceUrl: `${SNIRH}/index.php?idRef=MTIyMw==&FILTRA_BACIA=${station.basinId}&FILTRA_COVER=${NETWORK_ID}&FILTRA_SITE=${station.siteId}`,
  };
}

async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const previousSnapshot = JSON.parse(await readFile(OUTPUT, "utf8"));
const cachedByCode = new Map((previousSnapshot.reservoirs ?? []).map((status) => [status.code, status]));
let stations = new Map((previousSnapshot.reservoirs ?? [])
  .filter((status) => status.code && status.siteId)
  .map((status) => [status.code, {
    basinId: status.basinId,
    siteId: status.siteId,
    code: status.code,
    name: status.name,
  }]));

if (refreshCatalog || stations.size === 0) {
  stations = await fetchStationCatalog();
  console.log(`Catálogo SNIRH atualizado: ${stations.size} estações.`);
} else {
  console.log(`Catálogo local validado: ${stations.size} estações SNIRH identificadas.`);
}

if (checkAccess) {
  const station = stations.values().next().value;
  if (!station) throw new Error("O catálogo local não contém estações SNIRH utilizáveis.");
  const points = await fetchSeries(station.siteId, 354_895_398);
  console.log(`Acesso aos dados SNIRH validado: ${station.code}; ${points.length} leituras recebidas.`);
} else {
  const catalog = JSON.parse(await readFile(RESERVOIRS, "utf8"));
  const candidates = catalog.features
    .map((feature) => ({ feature, code: String(feature.properties.rhidro_cod ?? "").trim().toUpperCase() }))
    .filter(({ code }) => code && stations.has(code));

  console.log(`SNIRH: ${stations.size} estações; ${candidates.length} albufeiras do atlas com correspondência.`);
  const failures = [];
  const statuses = (await mapConcurrent(candidates, 2, async ({ feature, code }, position) => {
    try {
      const status = await buildStatus(feature, stations.get(code), cachedByCode.get(code));
      console.log(`[${position + 1}/${candidates.length}] ${code} · ${status.current.storagePercent?.toFixed(1) ?? "—"}%`);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ code, name: feature.properties.albufeira, error: message });
      console.warn(`[${position + 1}/${candidates.length}] ${code} · indisponível · ${message}`);
      return null;
    }
  })).filter(Boolean);

  const output = {
    generatedAt: new Date().toISOString(),
    source: "APA / SNIRH",
    sourceUrl: SNIRH,
    coverage: {
      atlasReservoirs: catalog.features.length,
      matchedStations: candidates.length,
      currentReadings: statuses.length,
    },
    reservoirs: statuses,
    unavailable: failures,
  };

  await writeFile(OUTPUT, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Gravado ${statuses.length} leituras em ${OUTPUT.pathname}.`);
}

