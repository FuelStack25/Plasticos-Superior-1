import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import QRCode from "qrcode";
import { z } from "zod";
import { Prisma } from "../generated/prisma/client";
import type { ProductionOrderStatus } from "../generated/prisma/client";
import { prisma } from "../prisma";
import { requireAuth, requireRole, ROLES, OPERARIO_STATIONS } from "../middleware/auth";
import { applyMovement, TxClient, InsufficientStockError } from "../services/stockService";
import { applyRawMaterialMovement } from "../services/rawMaterialStockService";
import { withSequentialNumberRetry } from "../services/sequentialNumber";
import { notifyRoles } from "../services/notify";
import { buildOpPdf } from "../services/opPdf";
import {
  DERIVATIONS,
  FINAL_STATIONS,
  OP_TEMPLATES,
  OpStation,
  STATION_LABELS,
  ROLL_CODE_PREFIX,
  inheritSpecs,
  normalizeSpecOptions,
  specOptionIssuesMessage,
} from "../services/opTemplates";
import {
  Allocation,
  InsufficientSourceRollError,
  SourceRollExhaustedError,
  allocateFromSourceRolls,
  allocateWholeSourceRolls,
  remainingSourceKg,
} from "../services/rollBalance";
import { generatePossessionToken, hashPossessionToken, verifyPossessionToken } from "../services/rollPossessionToken";
import { checkRateLimit } from "../services/rateLimiter";
import { LEGACY_ROLL_CODE_RE, PREFIX_TO_STATION, ROLL_CODE_RE, rollWhereFromCode } from "../services/rollCode";
import { localDayBoundary } from "../services/dateRange";
import { getRollLocation, rollLocationBlock } from "../services/rollLocation";

/** 50 verificaciones de token por minuto y por usuario -- ver
 * rateLimiter.ts: es un freno de rendimiento para un cliente en loop, no un
 * control de seguridad, así que el número es holgado a propósito. */
function checkPossessionTokenRateLimit(userId: number): boolean {
  return checkRateLimit(`roll-token:${userId}`, 50, 60_000);
}

const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads", "produccion");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export const productionOrdersRouter = Router();
productionOrdersRouter.use(requireAuth);

/**
 * El número consecutivo se calculaba como `count()+1`, lo cual asume que
 * TODAS las filas son "OP-00001..OP-000N" sin huecos. Eso se rompe apenas
 * hay filas con orderNumber no numérico (los OP-SEED-*) o se borra alguna OP
 * (limpieza de datos de prueba) — count() baja pero el máximo número ya
 * emitido no, así que el próximo intento vuelve a chocar con un número que
 * ya existe, para siempre (withSequentialNumberRetry no ayuda porque no hay
 * otra request concurrente que cambie el count() entre reintentos). Se
 * calcula en base al máximo sufijo numérico realmente usado en vez del total
 * de filas.
 */
async function nextOrderNumber(tx: TxClient): Promise<string> {
  const orders = await tx.productionOrder.findMany({
    where: { orderNumber: { startsWith: "OP-" } },
    select: { orderNumber: true },
  });
  let max = 0;
  for (const { orderNumber } of orders) {
    const match = /^OP-(\d{5})$/.exec(orderNumber);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `OP-${String(max + 1).padStart(5, "0")}`;
}

const requireProduccionGestion = requireRole(...ROLES.PRODUCCION_GESTION);
const requireOperarios = requireRole(...ROLES.OPERARIOS);
const requireCalidad = requireRole(...ROLES.CALIDAD);
/** Roles de operario puro (sin gestión) — a estos se les oculta toda OP en
 * "borrador": Gestión todavía la está armando (materia prima, medidas,
 * cliente, referencia) y no debe aparecer en la cola de planta hasta que la
 * libere explícitamente con POST /:id/release. */
const OPERARIO_ONLY_ROLES = ["operario_extrusion", "operario_impresion", "operario_sellado", "operario_precorte"];
// Calidad necesita GET / (para ver la cola ?status=pendiente_calidad) y
// GET /:id (para revisar los rollos al decidir); Auditoría necesita GET /:id
// (Trazabilidad) — por eso ambos se admiten acá a nivel de router, además de
// en sus endpoints propios de mutación.
productionOrdersRouter.use(requireRole(...ROLES.OPERARIOS, ...ROLES.CALIDAD, ...ROLES.AUDITORIA));

const STATIONS = ["extrusion", "impresion", "sellado", "precorte"] as const;

/** Estados desde los que la OP sigue "abierta" (acepta rollos y cierre). */
const OPEN_STATUSES: ProductionOrderStatus[] = ["pendiente", "en_proceso"];

/**
 * Kg reales que aportó un rollo a la meta/producción de la OP. En Precorte
 * cada fila carga 2 rollos de insumo (ver opTemplates.ts, rollColumns) — el
 * peso base va en `weightKg` y el segundo en `details.pesoR2`; ese segundo
 * peso es material real que entró a la OP y tiene que contar igual que el
 * primero en la meta (quantityPlanned), en el total que se manda a
 * inventario al aprobar en Calidad, y en cualquier total de kg producidos.
 * La etiqueta del segundo rollo (`details.etiquetaR2`) sigue siendo solo de
 * referencia — no hay una segunda relación `sourceRollId` para trazabilidad.
 */
interface SourceRollInfo {
  station: OpStation;
  stationSequence: number;
}

/** Cómo se identifica un rollo madre en el papel: el código de su QR
 * (EXT-12, IMP-30...), numerado dentro de SU estación. */
function sourceRollCode(info: SourceRollInfo | undefined): string {
  if (!info) return "";
  return `${ROLL_CODE_PREFIX[info.station]}-${info.stationSequence}`;
}

/** Próximo número dentro de la numeración PROPIA de esta estación (EXT-1,
 * EXT-2... PRE-1, PRE-2... cada una arrancando en 1 y sin mezclarse con las
 * demás) — se calcula del máximo ya usado, no de un `count()`, por si algún
 * rollo de prueba no numérico entrara a la tabla (mismo criterio que
 * nextBultoLabelCode en bultoLabels.ts). */
async function nextStationSequence(tx: TxClient, station: OpStation): Promise<number> {
  const max = await tx.productionRoll.aggregate({ where: { station }, _max: { stationSequence: true } });
  return (max._max.stationSequence ?? 0) + 1;
}

function rollProducedKg(station: OpStation | null, roll: { weightKg: unknown; details?: unknown }): number {
  const base = Number(roll.weightKg);
  if (station !== "precorte") return base;
  const details = roll.details && typeof roll.details === "object" ? (roll.details as Record<string, unknown>) : {};
  const r2 = Number(details.pesoR2);
  return base + (Number.isFinite(r2) ? r2 : 0);
}

productionOrdersRouter.get("/", async (req, res) => {
  const status = req.query.status as string | undefined;
  const station = req.query.station as string | undefined;
  // Un operario puro nunca ve una OP en "borrador" (Gestión todavía la está
  // armando) — si además pidió explícitamente ?status=borrador, directamente
  // no hay nada que mostrarle.
  const hideDraft = OPERARIO_ONLY_ROLES.includes(req.user!.role);
  if (hideDraft && status === "borrador") return res.json([]);
  const statusFilter = hideDraft && !status ? { not: "borrador" } : status;
  const orders = await prisma.productionOrder.findMany({
    where: { status: statusFilter as any, station: station as any },
    include: {
      product: true,
      client: { select: { id: true, name: true } },
      rolls: { select: { weightKg: true, wasteKg: true, details: true } },
      parent: { select: { id: true, orderNumber: true, station: true } },
      // orderBy explícito: sin esto Prisma no garantiza que vengan en el
      // orden real en que Gestión las fue derivando (ej. "Deriva en" podía
      // mostrar Sellado antes que Precorte aunque Precorte se haya
      // derivado primero) — el id sube en el mismo orden en que se crean.
      derivedOrders: { select: { id: true, orderNumber: true, station: true, status: true }, orderBy: { id: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(orders);
});

/**
 * Cola de Planeación: items de pedidos aprobados/en producción que todavía
 * no tienen una OP generada. No es una tabla propia — se deriva comparando
 * los items de la versión vigente de cada Pedido contra `ProductionOrder.
 * pedidoVersionItemId` (ver PedidoVersionItem.productionOrder).
 */
productionOrdersRouter.get("/pending-planning", requireProduccionGestion, async (_req, res) => {
  const pedidos = await prisma.pedido.findMany({
    where: { status: { in: ["aprobado", "en_produccion"] } },
    include: {
      client: true,
      versions: {
        include: { items: { include: { product: true, productionOrder: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const pending = pedidos.flatMap((pedido) => {
    const currentVersion = pedido.versions.find((v) => v.versionNumber === pedido.currentVersion);
    if (!currentVersion) return [];
    return currentVersion.items
      .filter((item) => !item.productionOrder)
      .map((item) => ({
        pedidoVersionItemId: item.id,
        pedidoId: pedido.id,
        pedidoOrderNumber: pedido.orderNumber,
        clientName: pedido.client.name,
        productId: item.productId,
        productName: item.product.name,
        productSku: item.product.sku,
        quantity: item.quantity,
        measure: item.measure ?? item.product.measure,
      }));
  });

  res.json(pending);
});

/**
 * Reporte pedido por Gestión (ver audio de la reunión con el cliente): hoy
 * cuadran a mano cuánto usó cada operario en el día (kg de rollos que sacó
 * vs. kg producidos + desperdicio). Ese cuadre ya es posible sin que nadie
 * tipee nada nuevo — cada rollo cargado (por escaneo o a mano) ya queda con
 * `operatorName` (el usuario logueado), `date`, `weightKg` y `wasteKg`; acá
 * solo se agrupan. Filtros opcionales `from`/`to` (YYYY-MM-DD, por defecto
 * últimos 7 días) y `station`.
 */
productionOrdersRouter.get("/reports/por-operario", requireProduccionGestion, async (req, res) => {
  const fromParam = req.query.from as string | undefined;
  const toParam = req.query.to as string | undefined;
  const stationParam = req.query.station as string | undefined;

  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 7);
  defaultFrom.setHours(0, 0, 0, 0);

  const from = fromParam ? localDayBoundary(fromParam, false) : defaultFrom;
  const to = toParam ? localDayBoundary(toParam, true) : new Date();

  const rolls = await prisma.productionRoll.findMany({
    where: {
      date: { gte: from, lte: to },
      productionOrder: stationParam ? { station: stationParam as any } : undefined,
    },
    select: {
      date: true,
      operatorName: true,
      weightKg: true,
      wasteKg: true,
      details: true,
      productionOrder: { select: { station: true, orderNumber: true } },
    },
  });

  type Row = { operatorName: string; day: string; station: string | null; rollCount: number; weightKg: number; wasteKg: number };
  const groups = new Map<string, Row>();
  for (const roll of rolls) {
    // YYYY-MM-DD en huso local del server, para agrupar por día calendario
    // real (no por el corte UTC).
    const day = roll.date.toLocaleDateString("en-CA");
    const station = roll.productionOrder.station;
    const key = `${roll.operatorName}|${day}|${station}`;
    const g = groups.get(key) ?? { operatorName: roll.operatorName, day, station, rollCount: 0, weightKg: 0, wasteKg: 0 };
    g.rollCount += 1;
    g.weightKg += rollProducedKg(station as OpStation, roll);
    g.wasteKg += Number(roll.wasteKg);
    groups.set(key, g);
  }

  const result = [...groups.values()].sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.operatorName.localeCompare(b.operatorName)));
  res.json(result);
});

/**
 * Resuelve un rollo por el código de su etiqueta QR (`<prefijo>-<n>`). La usa
 * el escáner al cargar un rollo en la OP derivada: quien escanea confirma qué
 * rollo físico tomó como insumo.
 */
productionOrdersRouter.get("/rolls/by-code/:code", async (req, res) => {
  const match = ROLL_CODE_RE.exec(req.params.code);
  const legacyMatch = LEGACY_ROLL_CODE_RE.exec(req.params.code);
  if (!match && !legacyMatch) return res.status(400).json({ error: "Código de rollo inválido" });
  // Un QR mal leído por el escáner puede traer un número absurdamente
  // grande — sin este chequeo llega tal cual a Postgres como `id` o
  // `stationSequence` (columnas `integer`) y explota como 500 en vez de un
  // 400 prolijo ("value out of range for type integer").
  const codeNumber = Number(match ? match[2] : legacyMatch![1]);
  if (!Number.isSafeInteger(codeNumber) || codeNumber > 2147483647) {
    return res.status(400).json({ error: "Código de rollo inválido" });
  }

  const rollWhere: Prisma.ProductionRollWhereUniqueInput = match
    ? { station_stationSequence: { station: PREFIX_TO_STATION[match[1]], stationSequence: codeNumber } }
    : { id: codeNumber };
  const roll = await prisma.productionRoll.findUnique({
    where: rollWhere,
    include: {
      createdBy: { select: { name: true } },
      productionOrder: { select: { id: true, orderNumber: true, station: true, product: { select: { name: true, sku: true } } } },
    },
  });
  if (!roll) return res.status(404).json({ error: "Rollo no encontrado" });

  // Verificación de posesión física: si el escaneo trae un token, se valida
  // acá para dar feedback inmediato -- el chequeo que de verdad importa es
  // el de POST /:id/rolls al consumirlo, este es solo para no hacer esperar
  // al operario hasta el final del formulario para enterarse de un QR
  // trucho. Sin token en la query no se exige nada (permite seguir usando
  // este mismo endpoint para simples consultas de información, ej.
  // Trazabilidad).
  const tokenVisible = typeof req.query.token === "string" ? req.query.token : undefined;
  if (tokenVisible) {
    if (!checkPossessionTokenRateLimit(req.user!.userId)) {
      return res.status(429).json({ error: "Demasiados escaneos seguidos — esperá un momento y volvé a intentar" });
    }
    if (!verifyPossessionToken(match ? `${match[1]}-${match[2]}` : req.params.code, tokenVisible, roll.possessionTokenHash)) {
      return res.status(403).json({ error: "El token de posesión del QR no es válido" });
    }
  }

  // Saldo que le queda al rollo: es lo que el operario necesita ver al
  // escanearlo para saber cuánto más puede sacarle antes de tener que montar
  // el siguiente (antes esa cuenta la llevaban a mano en el papel).
  const remainingKg = await remainingSourceKg(prisma, roll.id);
  // Dónde está físicamente (ver services/rollLocation.ts). Con
  // `?forStation=` (la estación de la OP que lo quiere consumir) se avisa ya
  // al escanear si no está en esa bodega, en vez de dejar llenar toda la fila
  // y rechazarla recién al guardar — el chequeo que manda sigue siendo el de
  // POST /:id/rolls.
  const location = await getRollLocation(prisma, roll);
  const forStation = typeof req.query.forStation === "string" ? req.query.forStation : undefined;
  if (forStation && (STATIONS as readonly string[]).includes(forStation)) {
    const block = rollLocationBlock(sourceRollCode(roll), location, forStation as OpStation);
    if (block) return res.status(400).json({ error: block });
  }
  // El hash nunca sale del servidor (se pidió arriba solo para verificar).
  const { possessionTokenHash, ...rollWithoutHash } = roll;
  res.json({ ...rollWithoutHash, remainingKg, location });
});

/**
 * Trazabilidad desde un código físico: el QR de un rollo (`EXT-9`, o el
 * viejo `RL-12`), una etiqueta de bulto (`EXT-00007`) o el número de OP
 * (`OP-00012`). Devuelve a qué OP (y rollo) pertenece, para abrir su
 * trazabilidad. El QR con token de posesión (`EXT-9-XXXX`) llega ya separado
 * desde la pantalla — acá solo se busca, no se exige posesión.
 */
productionOrdersRouter.get("/trace/by-code/:code", async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  // Misma regla de visibilidad que GET /:id: un operario puro no ve una OP
  // en borrador (ni confirma que ese número existe).
  const hideDraft = OPERARIO_ONLY_ROLES.includes(req.user!.role);
  const visible = async (orderId: number) => {
    if (!hideDraft) return true;
    const o = await prisma.productionOrder.findUnique({ where: { id: orderId }, select: { status: true } });
    return !!o && o.status !== "borrador";
  };

  // Etiqueta de bulto primero: tiene la forma inconfundible EXT- + 5 cifras
  // (ver handleScanAny en la hoja de OP), que también matchearía como rollo.
  if (/^EXT-\d{5}$/.test(code)) {
    const label = await prisma.bultoLabel.findUnique({
      where: { code },
      select: { usedByRoll: { select: { id: true, productionOrderId: true } } },
    });
    if (label) {
      if (!label.usedByRoll) return res.status(404).json({ error: `La etiqueta de bulto ${code} todavía no se usó en ningún rollo` });
      if (!(await visible(label.usedByRoll.productionOrderId))) return res.status(404).json({ error: `No existe el rollo ${code}` });
      return res.json({ kind: "bulto", orderId: label.usedByRoll.productionOrderId, rollId: label.usedByRoll.id });
    }
  }

  const opMatch = /^OP-\d+$/.test(code);
  if (opMatch) {
    // La cadena comparte el número: se abre la etapa raíz (la que no tiene padre).
    const order = await prisma.productionOrder.findFirst({
      where: { orderNumber: code },
      orderBy: [{ parentOrderId: { sort: "asc", nulls: "first" } }, { id: "asc" }],
      select: { id: true },
    });
    if (!order || !(await visible(order.id))) return res.status(404).json({ error: `No existe la OP ${code}` });
    return res.json({ kind: "op", orderId: order.id, rollId: null });
  }

  const where = rollWhereFromCode(code);
  if (!where) return res.status(400).json({ error: "Código no reconocido — escaneá el QR de un rollo, una etiqueta de bulto o escribí el número de OP" });
  const roll = await prisma.productionRoll.findUnique({ where, select: { id: true, productionOrderId: true } });
  if (!roll || !(await visible(roll.productionOrderId))) return res.status(404).json({ error: `No existe el rollo ${code}` });
  res.json({ kind: "rollo", orderId: roll.productionOrderId, rollId: roll.id });
});

/**
 * Sugerencias para armar una OP de un cliente+producto puntual — mismo
 * criterio de "sugerido a mano + sugerido por frecuencia" que ya existe para
 * productos de un cliente (ver ClientManualProduct/top-products en
 * clients.ts), aplicado acá a los campos propios de la OP: medida y cantidad
 * planeada (station="root", antes de elegir estación) o las specs de la
 * plantilla de una estación puntual (station="extrusion"/"impresion"/...).
 * Nunca se mezclan los dos orígenes: la manual se devuelve aparte y gana
 * campo por campo si el frontend decide aplicar ambas (ver POST /presets
 * abajo para cargar/actualizar la manual).
 */
const PRESET_STATIONS = ["root", ...STATIONS] as const;
type PresetStation = (typeof PRESET_STATIONS)[number];

/** Valor más frecuente de una lista (ignora null/undefined/""). Empate: gana
 * el primero que alcanzó el conteo más alto (orden estable de Map). */
function mostFrequent<T extends string | number>(values: (T | null | undefined)[]): T | null {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v === null || v === undefined || v === ("" as unknown as T)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [v, count] of counts) {
    if (count > bestCount) {
      best = v;
      bestCount = count;
    }
  }
  return best;
}

productionOrdersRouter.get("/suggestions", requireProduccionGestion, async (req, res) => {
  const clientId = Number(req.query.clientId);
  const productId = Number(req.query.productId);
  const station = (req.query.station as string) || "root";
  if (!Number.isInteger(clientId) || !Number.isInteger(productId)) {
    return res.status(400).json({ error: "clientId y productId son obligatorios" });
  }
  if (!PRESET_STATIONS.includes(station as PresetStation)) {
    return res.status(400).json({ error: `station inválida: ${PRESET_STATIONS.join(", ")}` });
  }

  const manual = await prisma.productionOrderPreset.findUnique({
    where: { clientId_productId_station: { clientId, productId, station } },
  });

  if (station === "root") {
    // parentOrderId null = la fila raíz de cada cadena de derivación (ver
    // comentario en POST /:id/derive): ahí quedó la medida/cantidad que
    // Gestión tipeó al crear la OP, sin importar a qué estación haya
    // avanzado después.
    const roots = await prisma.productionOrder.findMany({
      where: { clientId, productId, parentOrderId: null },
      select: { measure: true, quantityPlanned: true },
    });
    const frequent = {
      sampleSize: roots.length,
      measure: mostFrequent(roots.map((r) => r.measure)),
      quantityPlanned: mostFrequent(roots.map((r) => (r.quantityPlanned != null ? Number(r.quantityPlanned) : null))),
    };
    return res.json({ manual, frequent });
  }

  const stationOrders = await prisma.productionOrder.findMany({
    where: { clientId, productId, station: station as OpStation },
    select: { specs: true },
  });
  const specsByKey = new Map<string, (string | number)[]>();
  // Materia Prima es una lista de filas ({ref, pct, lote}), no un valor
  // simple -- se agrega aparte, por ref, y solo el % (lote es de un lote
  // físico puntual, no algo reutilizable como sugerencia).
  const materiaPrimaByRef = new Map<string, (string | number)[]>();
  for (const order of stationOrders) {
    const specs = order.specs as Record<string, unknown> | null;
    if (!specs || typeof specs !== "object") continue;
    for (const [key, value] of Object.entries(specs)) {
      if (key === "materiaPrima") {
        if (!Array.isArray(value)) continue;
        for (const row of value) {
          if (!row || typeof row !== "object") continue;
          const { ref, pct } = row as { ref?: unknown; pct?: unknown };
          if (typeof ref !== "string" || (typeof pct !== "string" && typeof pct !== "number")) continue;
          if (!materiaPrimaByRef.has(ref)) materiaPrimaByRef.set(ref, []);
          materiaPrimaByRef.get(ref)!.push(pct);
        }
        continue;
      }
      if (typeof value !== "string" && typeof value !== "number") continue;
      if (!specsByKey.has(key)) specsByKey.set(key, []);
      specsByKey.get(key)!.push(value);
    }
  }
  const frequentSpecs: Record<string, unknown> = {};
  for (const [key, values] of specsByKey) {
    const value = mostFrequent(values);
    if (value !== null) frequentSpecs[key] = value;
  }
  const frequentMateriaPrima: { ref: string; pct: string | number }[] = [];
  for (const [ref, values] of materiaPrimaByRef) {
    const pct = mostFrequent(values);
    if (pct !== null) frequentMateriaPrima.push({ ref, pct });
  }
  if (frequentMateriaPrima.length) frequentSpecs.materiaPrima = frequentMateriaPrima;
  res.json({ manual, frequent: { sampleSize: stationOrders.length, specs: frequentSpecs } });
});

/**
 * Detalle completo de una OP: sus rollos, adjuntos, cadena de derivación
 * (padre e hijas), el resultado de Calidad (si ya se registró) y el
 * pedido/cliente de origen (si vino de Planeación).
 */
productionOrdersRouter.get("/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: {
      product: true,
      client: { select: { id: true, name: true } },
      rolls: {
        orderBy: [{ date: "asc" }, { id: "asc" }],
        include: {
          createdBy: { select: { name: true } },
          sourceRoll: { select: { id: true, label: true, station: true, stationSequence: true, weightKg: true, createdBy: { select: { name: true } } } },
          // Trazabilidad: TODOS los rollos madre de los que salió (con los kg
          // de cada uno), no solo el principal de `sourceRoll`; por dónde se
          // movió el rollo entre bodegas; y la etiqueta de bulto si tiene.
          consumptions: {
            orderBy: { id: "asc" },
            select: { quantityKg: true, sourceRoll: { select: { id: true, label: true, station: true, stationSequence: true } } },
          },
          transfers: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              fromStation: true,
              toStation: true,
              status: true,
              mode: true,
              carrierName: true,
              createdAt: true,
              receivedAt: true,
              dispatchedKg: true,
              receivedKg: true,
              registeredBy: { select: { name: true } },
              receivedBy: { select: { name: true } },
            },
          },
          bultoLabel: { select: { code: true } },
          // Correcciones de saldo (peso al recibir / conteo físico).
          adjustments: {
            orderBy: { id: "asc" },
            select: { id: true, reason: true, previousKg: true, newKg: true, deltaKg: true, notes: true, createdAt: true, createdBy: { select: { name: true } } },
          },
        },
      },
      attachments: { orderBy: { createdAt: "asc" } },
      // El despacho a cliente que generó ESTA OP al aprobarse (no los del
      // producto en general, ver recentDispatchItems más abajo).
      dispatches: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          status: true,
          dispatchedDate: true,
          client: { select: { name: true } },
          items: { select: { quantityRequested: true, quantityDispatched: true } },
        },
      },
      // rolls acá es solo para que Sellado/Precorte puedan mostrar los
      // totales reales de "Orden de Extrusión/Impresión" (kilos y rollos
      // que produjo la OP padre) sin que nadie los tipee a mano.
      parent: {
        select: { id: true, orderNumber: true, station: true, status: true, rolls: { select: { weightKg: true } } },
      },
      // orderBy explícito: sin esto Prisma no garantiza que vengan en el
      // orden real en que Gestión las fue derivando (ej. "Deriva en" podía
      // mostrar Sellado antes que Precorte aunque Precorte se haya
      // derivado primero) — el id sube en el mismo orden en que se crean.
      derivedOrders: { select: { id: true, orderNumber: true, station: true, status: true }, orderBy: { id: "asc" } },
      qualityCheck: { include: { createdBy: { select: { name: true } } } },
      pedidoVersionItem: {
        include: { pedidoVersion: { include: { pedido: { include: { client: true } } } } },
      },
      createdBy: { select: { name: true } },
    },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (order.status === "borrador" && OPERARIO_ONLY_ROLES.includes(req.user!.role)) {
    return res.status(404).json({ error: "OP no encontrada" });
  }

  // Cadena completa de derivación: todas las etapas comparten el mismo
  // orderNumber (ver POST /:id/derive) — para Trazabilidad es más útil ver
  // la cadena entera de una sola vez que ir clickeando padre por padre.
  const chain = await prisma.productionOrder.findMany({
    where: { orderNumber: order.orderNumber },
    select: {
      id: true,
      station: true,
      status: true,
      parentOrderId: true,
      quantityPlanned: true,
      // Trazabilidad muestra los lotes de materia prima de Extrusión
      // (specs.materiaPrima) de toda la cadena.
      specs: true,
      rolls: { select: { weightKg: true, details: true } },
    },
    orderBy: { id: "asc" },
  });

  // El stock deja de estar atado a esta OP en particular apenas Calidad lo
  // suma al inventario (es fungible por producto, no por lote) — así que
  // esto es la foto ACTUAL del producto en el almacén y sus despachos
  // recientes, no específicamente "dónde quedaron estos kilos" de esta OP.
  // Igual es la info más cercana que existe sin agregar trazabilidad por
  // lote, que sería un cambio de modelo mucho más grande.
  const [warehouseLocations, recentDispatchItems] = await Promise.all([
    prisma.stockLocation.findMany({
      where: { productId: order.productId, quantity: { gt: 0 } },
      select: { quantity: true, location: { select: { code: true, label: true } } },
      orderBy: { location: { code: "asc" } },
    }),
    prisma.dispatchItem.findMany({
      where: { productId: order.productId },
      select: {
        id: true,
        quantityRequested: true,
        quantityDispatched: true,
        dispatch: { select: { id: true, status: true, dispatchedDate: true, client: { select: { name: true } } } },
      },
      orderBy: { id: "desc" },
      take: 5,
    }),
  ]);

  // possessionTokenHash nunca sale del servidor (mismo criterio que
  // passwordHash) -- `include` trae la fila completa de cada rollo, así
  // que se saca acá antes de responder.
  const rollsWithoutHash = order.rolls.map(({ possessionTokenHash, ...r }) => r);
  const availableSourceRolls = await availableParentRolls(order);
  res.json({ ...order, rolls: rollsWithoutHash, chain, warehouseLocations, recentDispatchItems, availableSourceRolls });
});

/**
 * OP derivada abierta: qué rollos de la OP padre puede usar YA (están en la
 * bodega de esta estación con saldo) y cuáles vienen en camino hacia acá —
 * para que el operario sepa qué rollo buscar sin tener que ir a Inventario
 * de bodegas. Es solo informativo: igual tiene que escanear el rollo.
 */
async function availableParentRolls(order: {
  station: string | null;
  status: string;
  parent: { id: number } | null;
}) {
  if (!order.parent || !order.station || !["pendiente", "en_proceso"].includes(order.status)) return [];
  const station = order.station as OpStation;
  // Pocas consultas fijas, no una por rollo (una OP padre puede tener
  // cientos): misma lógica que getRollLocation y remainingSourceKg, pero en
  // lote — igual que GET /roll-transfers/inventory.
  const parentRolls = await prisma.productionRoll.findMany({
    where: { productionOrderId: order.parent.id },
    select: {
      id: true,
      station: true,
      stationSequence: true,
      label: true,
      weightKg: true,
      transfers: { orderBy: { id: "desc" }, take: 1, select: { status: true, toStation: true, carrierName: true } },
    },
    orderBy: { id: "asc" },
  });
  const candidates = parentRolls
    .map((r) => {
      const last = r.transfers[0];
      const status =
        last?.status === "en_transito"
          ? last.toStation === station
            ? ("en_transito" as const)
            : null
          : (last?.status === "recibido" ? last.toStation : r.station) === station
            ? ("en_bodega" as const)
            : null;
      return { r, last, status };
    })
    .filter((c) => c.status !== null);
  if (!candidates.length) return [];
  const ids = candidates.map((c) => c.r.id);
  const [consumed, adjusted] = await Promise.all([
    prisma.rollConsumption.groupBy({ by: ["sourceRollId"], where: { sourceRollId: { in: ids } }, _sum: { quantityKg: true } }),
    prisma.rollAdjustment.groupBy({ by: ["rollId"], where: { rollId: { in: ids } }, _sum: { deltaKg: true } }),
  ]);
  const consumedBy = new Map(consumed.map((c) => [c.sourceRollId, Number(c._sum.quantityKg ?? 0)]));
  const adjustedBy = new Map(adjusted.map((a) => [a.rollId, Number(a._sum.deltaKg ?? 0)]));
  return candidates
    .map(({ r, last, status }) => ({
      id: r.id,
      code: `${ROLL_CODE_PREFIX[r.station as OpStation]}-${r.stationSequence}`,
      label: r.label,
      weightKg: Number(r.weightKg),
      remainingKg: Math.round((Number(r.weightKg) - (consumedBy.get(r.id) ?? 0) + (adjustedBy.get(r.id) ?? 0)) * 100) / 100,
      status: status!,
      carrierName: status === "en_transito" ? last!.carrierName : null,
    }))
    .filter((r) => r.remainingKg > 0);
}

const createOrderSchema = z.object({
  // Sin default: la OP nace sin proceso asignado (ver comentario en el
  // schema) y se deriva a Extrusión como primer paso, no se elige acá.
  station: z.enum(STATIONS).optional(),
  productId: z.number().int(),
  clientId: z.number().int().optional(),
  quantityPlanned: z.number().positive(),
  measure: z.string().optional(),
  specs: z.record(z.string(), z.any()).optional(),
  notes: z.string().optional(),
});

/** Crea una OP con numeración consecutiva (OP-00001, OP-00002, ...). */
productionOrdersRouter.post("/", requireProduccionGestion, async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const product = await prisma.product.findUnique({ where: { id: parsed.data.productId } });
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  if (parsed.data.clientId) {
    const client = await prisma.client.findUnique({ where: { id: parsed.data.clientId } });
    if (!client) return res.status(404).json({ error: "Cliente no encontrado" });
  }

  // Sin proceso asignado todavía no hay plantilla contra la cual validar las
  // listas — se validan recién al derivar a Extrusión (ver POST /:id/derive).
  let specs = parsed.data.specs;
  if (specs && parsed.data.station) {
    const normalized = normalizeSpecOptions(parsed.data.station, specs);
    if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage(parsed.data.station, normalized.issues) });
    specs = normalized.specs;
  }

  const order = await withSequentialNumberRetry(() =>
    prisma.$transaction(async (tx) => {
      const orderNumber = await nextOrderNumber(tx);

      return tx.productionOrder.create({
        data: {
          orderNumber,
          // Sin proceso todavía (a menos que se lo pasen explícito, ej.
          // pruebas de API) — Gestión la deriva a Extrusión como primer
          // paso (ver POST /:id/derive).
          station: parsed.data.station ?? null,
          // Nace en "borrador": Gestión todavía tiene que terminar de cargar
          // materia prima/medidas/cliente/referencia antes de que la vea
          // planta — recién queda visible/operable para los operarios al
          // liberarla con POST /:id/release.
          status: "borrador",
          productId: parsed.data.productId,
          clientId: parsed.data.clientId,
          quantityPlanned: parsed.data.quantityPlanned,
          measure: parsed.data.measure ?? product.measure,
          specs: specs as Prisma.InputJsonValue | undefined,
          notes: parsed.data.notes,
          createdById: req.user!.userId,
        },
      });
    })
  );

  res.status(201).json(order);
});

/**
 * Genera la OP correspondiente a un item de pedido pendiente de planeación.
 * Nace sin proceso asignado, con el cliente del pedido, en "borrador" —
 * Planeación/Gestión todavía tiene que cargarle materia prima y medidas, y
 * derivarla a Extrusión (el proceso base) antes de liberarla a planta
 * (POST /:id/release). Los procesos siguientes se derivan desde ella.
 */
class ItemAlreadyHasOrderError extends Error {}

productionOrdersRouter.post("/from-pedido-item/:pedidoVersionItemId", requireProduccionGestion, async (req, res) => {
  const pedidoVersionItemId = Number(req.params.pedidoVersionItemId);
  if (!Number.isInteger(pedidoVersionItemId)) return res.status(400).json({ error: "Id inválido" });

  const item = await prisma.pedidoVersionItem.findUnique({
    where: { id: pedidoVersionItemId },
    include: { product: true, productionOrder: true, pedidoVersion: { include: { pedido: true } } },
  });
  if (!item) return res.status(404).json({ error: "Item de pedido no encontrado" });
  if (item.productionOrder) return res.status(400).json({ error: "Este item ya tiene una OP generada" });

  // El item puede venir de una versión que ya no es la vigente (el pedido se
  // volvió a editar y PATCH /pedidos/:id creó una versión nueva) — generar
  // una OP desde ahí dejaría una orden real colgada de un pedido que el
  // cliente ya no ve. También exige que el pedido esté en un estado desde el
  // que tiene sentido planear producción (mismo filtro que GET
  // /pending-planning).
  const pedido = item.pedidoVersion.pedido;
  if (item.pedidoVersion.versionNumber !== pedido.currentVersion) {
    return res.status(400).json({ error: "Esta versión del pedido ya fue reemplazada por una más reciente, recargá la pantalla" });
  }
  if (!["aprobado", "en_produccion"].includes(pedido.status)) {
    return res.status(400).json({ error: "El pedido no está en un estado desde el que se pueda generar producción" });
  }

  let order;
  try {
    order = await withSequentialNumberRetry(() =>
      prisma.$transaction(async (tx) => {
        // Re-chequea DENTRO de la transacción, no solo antes: dos clicks
        // casi simultáneos pasan los dos el chequeo de arriba (leído fuera
        // de cualquier transacción) y sin esto los dos intentarían crear una
        // OP para el mismo item — el segundo choca contra el unique de
        // pedidoVersionItemId y, como withSequentialNumberRetry reintenta
        // cualquier P2002, terminaba reintentando ciegamente hasta agotar
        // los intentos y devolver un 500 crudo en vez de un 400 claro.
        const existing = await tx.productionOrder.findUnique({
          where: { pedidoVersionItemId: item.id },
          select: { id: true },
        });
        if (existing) throw new ItemAlreadyHasOrderError();

        const orderNumber = await nextOrderNumber(tx);

        return tx.productionOrder.create({
          data: {
            orderNumber,
            // Igual que POST /: sin proceso hasta que Gestión la derive a
            // Extrusión explícitamente.
            station: null,
            status: "borrador",
            productId: item.productId,
            clientId: pedido.clientId,
            quantityPlanned: item.quantity,
            measure: item.measure ?? item.product.measure,
            pedidoVersionItemId: item.id,
            createdById: req.user!.userId,
          },
        });
      })
    );
  } catch (err) {
    if (err instanceof ItemAlreadyHasOrderError) {
      return res.status(400).json({ error: "Este item ya tiene una OP generada" });
    }
    throw err;
  }

  res.status(201).json(order);
});

/**
 * Libera una OP en "borrador" a planta: Gestión ya terminó de cargar materia
 * prima/medidas/cliente/referencia, y de acá en más queda visible y operable
 * para los operarios de esa estación (cola de EstacionProduccion.tsx, carga
 * de rollos). No hay vuelta atrás por acá — para corregir algo después de
 * liberada se usa /:id/reopen una vez que ya se cerró.
 */
productionOrdersRouter.post("/:id/release", requireProduccionGestion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const order = await prisma.productionOrder.findUnique({ where: { id } });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (order.status !== "borrador") return res.status(400).json({ error: "Esta OP ya fue liberada a planta" });
  if (order.station === null) {
    return res.status(400).json({ error: "Primero derivá la OP a Extrusión antes de liberarla a planta" });
  }
  if (order.station === "extrusion") {
    const falta = materiaPrimaIncompleta(order.specs);
    if (falta) return res.status(400).json({ error: `No se puede liberar: ${falta}` });
  }

  const updated = await prisma.productionOrder.update({ where: { id }, data: { status: "pendiente" } });
  res.json(updated);
});

const deriveSchema = z.object({
  station: z.enum(STATIONS),
  quantityPlanned: z.number().positive().optional(),
  measure: z.string().optional(),
  specs: z.record(z.string(), z.any()).optional(),
  notes: z.string().optional(),
});

/**
 * Deriva una OP hacia el siguiente proceso (Extrusión → Impresión/Sellado/
 * Precorte; Impresión → Sellado/Precorte). Hereda producto, cliente, medida
 * y cantidad del padre salvo que el body los pise. La OP hija nace directo
 * en "pendiente" (no "borrador").
 *
 * Solo Gestión/Planeación puede derivar — NINGÚN operario, de ninguna
 * estación (antes un operario podía mandar su propia OP al siguiente
 * proceso; el cliente pidió que esa decisión quede siempre en manos de
 * Gestión, para no perder el control de cuándo pasa cada OP a la siguiente
 * planta).
 *
 * Caso especial: si la OP todavía no tiene proceso asignado (recién creada,
 * `station` null), este mismo endpoint es el que se lo asigna — pero NO crea
 * una fila hija nueva, actualiza la fila existente en el lugar, porque
 * todavía no hubo ningún trabajo real hecho en "estado sin proceso". El
 * cliente pidió explícitamente que la OP se cree en blanco y recién se
 * "derive a Extrusión" como primer paso, en vez de nacer ya asignada.
 */
productionOrdersRouter.post("/:id/derive", requireProduccionGestion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });
  const parsed = deriveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const parent = await prisma.productionOrder.findUnique({
    where: { id },
    include: { rolls: { select: { weightKg: true, details: true } } },
  });
  if (!parent) return res.status(404).json({ error: "OP no encontrada" });
  if (parent.status === "cancelada") return res.status(400).json({ error: "No se puede derivar de una OP cancelada" });

  if (parent.station === null) {
    if (parsed.data.station !== "extrusion") {
      return res.status(400).json({ error: "El primer proceso de una OP siempre es Extrusión" });
    }
    // Lo que manda el body se valida estricto (400 si trae un valor fuera de
    // la lista); lo que ya estaba guardado de antes solo se normaliza, sin
    // trabar la derivación por un dato viejo — la hoja lo va a mostrar
    // marcado como inválido para que Gestión lo corrija al guardar.
    let firstSpecs: Record<string, unknown> | undefined;
    if (parsed.data.specs) {
      const normalized = normalizeSpecOptions("extrusion", parsed.data.specs);
      if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage("extrusion", normalized.issues) });
      firstSpecs = normalized.specs;
    } else if (parent.specs && typeof parent.specs === "object") {
      firstSpecs = normalizeSpecOptions("extrusion", parent.specs as Record<string, unknown>).specs;
    }
    const updated = await prisma.productionOrder.update({
      where: { id },
      data: {
        station: "extrusion",
        quantityPlanned: parsed.data.quantityPlanned ?? parent.quantityPlanned,
        measure: parsed.data.measure ?? parent.measure,
        specs: firstSpecs as Prisma.InputJsonValue | undefined,
        notes: parsed.data.notes ?? parent.notes,
      },
    });
    return res.json(updated);
  }

  // Esta segunda derivación en adelante SÍ crea una fila hija nueva y
  // visible para planta (a diferencia de la primera, arriba, que solo
  // asigna Extrusión sobre la misma fila) -- si el padre sigue en
  // "borrador" (todavía no se liberó con POST /:id/release), la hija
  // aparecería en la cola de su estación antes de que Gestión termine de
  // armar la OP.
  if (parent.status === "borrador") {
    return res.status(400).json({ error: "Primero liberá la OP a planta (Liberar) antes de derivarla a otro proceso" });
  }

  const allowed = DERIVATIONS[parent.station as OpStation];
  if (!allowed.includes(parsed.data.station)) {
    return res.status(400).json({
      error: allowed.length
        ? `Desde ${parent.station} solo se puede derivar a: ${allowed.join(", ")}`
        : `Una OP de ${parent.station} es un proceso final, no deriva a otro`,
    });
  }

  // Una OP solo puede derivar UNA vez a cada estación destino — si no, cada
  // clic en "Derivar a Sellado" crea una fila hija más, todas con el mismo
  // número (ver comentario arriba), y en el listado se ve como si la OP se
  // hubiera "duplicado" infinitas veces hacia el mismo proceso.
  const existingDerivation = await prisma.productionOrder.findFirst({
    where: { parentOrderId: parent.id, station: parsed.data.station },
  });
  if (existingDerivation) {
    return res.status(400).json({
      error: `Esta OP ya fue derivada a ${STATION_LABELS[parsed.data.station]} (OP #${existingDerivation.id})`,
    });
  }

  // El número de OP identifica la cadena completa, no cada etapa: la hija
  // hereda el mismo orderNumber del padre (que a su vez ya viene heredado
  // desde la raíz). Solo sube el consecutivo al crear una OP nueva, no acá.
  //
  // Specs: la hija no nace en blanco — hereda del padre todo lo que
  // aplique (color, ancho, fuelles, calibre, tipo/forma de material, etc.,
  // ver inheritSpecs) para que Gestión no tenga que volver a tipear lo que
  // ya se sabe. Si además viene `specs` explícito en el body, se mergea
  // encima (lo explícito gana sobre lo heredado).
  const inherited = inheritSpecs(parent.station as OpStation, parsed.data.station, parent.specs as Record<string, unknown> | null);
  let bodySpecs: Record<string, unknown> = {};
  if (parsed.data.specs) {
    const normalized = normalizeSpecOptions(parsed.data.station, parsed.data.specs);
    if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage(parsed.data.station, normalized.issues) });
    bodySpecs = normalized.specs;
  }
  const specs = { ...inherited, ...bodySpecs };

  // La meta (quantityPlanned) de la hija tiene que ser lo que el padre
  // REALMENTE produjo (suma de sus rollos), no lo que el padre tenía como
  // meta propia -- si Extrusión planificaba 40kg pero solo salieron 37kg
  // reales (2 rollos), la hija no puede seguir esperando 40kg: no hay más
  // material físico que cargar y la hoja quedaba mostrando "Restan 1 kg"
  // para siempre, sin ningún rollo que escanear para completarlo. Cae al
  // quantityPlanned del padre solo si todavía no produjo nada (ej. derivar
  // antes de cargar el primer rollo).
  //
  // Y con varias hijas, cada una recibe solo lo que queda sin asignar entre
  // sus hermanas (ver siblingAllocation) — Gestión reparte bajando la meta de
  // una para darle a otra.
  const alloc = await siblingAllocation(prisma, parent);
  if (parsed.data.quantityPlanned == null && alloc.availableKg <= 0.005) {
    return res.status(400).json({
      error: `Ya se asignaron los ${alloc.baseKg} kg del padre entre sus derivadas (${alloc.detail}) — bajá la meta de alguna antes de derivar otra`,
    });
  }
  if (parsed.data.quantityPlanned != null && parsed.data.quantityPlanned > alloc.availableKg + 0.005) {
    return res.status(400).json({
      error: `La meta se pasa de lo disponible: el padre tiene ${alloc.baseKg} kg y ya hay ${alloc.assignedKg} kg asignados (${alloc.detail}) — quedan ${alloc.availableKg} kg`,
    });
  }
  const defaultQuantityPlanned = alloc.availableKg;

  const order = await prisma.productionOrder.create({
    data: {
      orderNumber: parent.orderNumber,
      station: parsed.data.station,
      productId: parent.productId,
      clientId: parent.clientId,
      quantityPlanned: parsed.data.quantityPlanned ?? defaultQuantityPlanned,
      measure: parsed.data.measure ?? parent.measure,
      specs: Object.keys(specs).length ? (specs as Prisma.InputJsonValue) : undefined,
      notes: parsed.data.notes ?? parent.notes,
      parentOrderId: parent.id,
      createdById: req.user!.userId,
    },
  });

  res.status(201).json(order);
});


const presetSchema = z.object({
  clientId: z.number().int(),
  productId: z.number().int(),
  station: z.enum(PRESET_STATIONS),
  measure: z.string().optional(),
  quantityPlanned: z.number().positive().optional(),
  specs: z.record(z.string(), z.any()).optional(),
  notes: z.string().optional(),
});

/** Cargar la misma combinación cliente+producto+estación dos veces
 * actualiza la sugerencia existente en vez de duplicarla (ver @@unique del
 * modelo). */
productionOrdersRouter.post("/presets", requireProduccionGestion, async (req, res) => {
  const parsed = presetSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { clientId, productId, station } = parsed.data;
  const [client, product] = await Promise.all([
    prisma.client.findUnique({ where: { id: clientId } }),
    prisma.product.findUnique({ where: { id: productId } }),
  ]);
  if (!client) return res.status(404).json({ error: "Cliente no encontrado" });
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  let specs = parsed.data.specs;
  if (specs && station !== "root") {
    const normalized = normalizeSpecOptions(station as OpStation, specs);
    if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage(station as OpStation, normalized.issues) });
    specs = normalized.specs;
  }

  const preset = await prisma.productionOrderPreset.upsert({
    where: { clientId_productId_station: { clientId, productId, station } },
    create: {
      clientId,
      productId,
      station,
      measure: parsed.data.measure,
      quantityPlanned: parsed.data.quantityPlanned,
      specs: specs as Prisma.InputJsonValue | undefined,
      notes: parsed.data.notes,
      createdById: req.user!.userId,
    },
    update: {
      measure: parsed.data.measure,
      quantityPlanned: parsed.data.quantityPlanned,
      specs: specs as Prisma.InputJsonValue | undefined,
      notes: parsed.data.notes,
      createdById: req.user!.userId,
    },
  });
  res.status(201).json(preset);
});

productionOrdersRouter.delete("/presets/:id", requireProduccionGestion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const preset = await prisma.productionOrderPreset.findUnique({ where: { id } });
  if (!preset) return res.status(404).json({ error: "Sugerencia no encontrada" });

  await prisma.productionOrderPreset.delete({ where: { id } });
  res.status(204).end();
});

const updateOrderSchema = z.object({
  specs: z.record(z.string(), z.any()).optional(),
  measure: z.string().nullable().optional(),
  quantityPlanned: z.number().positive().optional(),
  clientId: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  /** A cuántos kg (peso+desperdicio) avisar que la OP está por completarse
   * — configurable a mano por Gestión; null vuelve al default (90% de
   * quantityPlanned), ver POST /:id/rolls. */
  alertThresholdKg: z.number().positive().nullable().optional(),
});

/**
 * Propaga los campos heredables (ver inheritSpecs) del padre a TODAS sus
 * OPs derivadas, en cascada (hijas, nietas, ...) — no solo al momento de
 * derivar. El cliente pidió que editar Medidas/Ancho/Fuelles/etc. en una OP
 * ya derivada actualice también lo que ya se deriv, en vez de quedar
 * pegado a la foto del momento en que se derivó. Pisa lo que ya tuviera
 * cargado la hija en esos campos puntuales (así lo confirmó el cliente):
 * el padre manda sobre esos datos, el resto de los campos de la hija
 * (los que no son heredables) no se tocan.
 */
async function propagateSpecsToChildren(
  tx: TxClient,
  parentId: number,
  parentStation: OpStation,
  parentSpecs: Record<string, unknown> | null
) {
  const children = await tx.productionOrder.findMany({
    where: { parentOrderId: parentId, status: { in: [...OPEN_STATUSES, "borrador"] } },
    select: { id: true, station: true, specs: true },
  });
  for (const child of children) {
    if (!child.station) continue;
    const inherited = inheritSpecs(parentStation, child.station as OpStation, parentSpecs);
    if (Object.keys(inherited).length === 0) continue;
    const currentSpecs = child.specs && typeof child.specs === "object" ? (child.specs as Record<string, unknown>) : {};
    const newSpecs = { ...currentSpecs, ...inherited };
    await tx.productionOrder.update({ where: { id: child.id }, data: { specs: newSpecs as Prisma.InputJsonValue } });
    await propagateSpecsToChildren(tx, child.id, child.station as OpStation, newSpecs);
  }
}

/**
 * Sincroniza la meta (quantityPlanned) de los hijos DIRECTOS de `orderId` con
 * lo que esta OP realmente produjo hasta ahora — mismo cálculo que se usa al
 * derivar (ver comentario en POST /:id/derive): si un hijo todavía no cargó
 * ningún rollo propio, su meta no puede seguir apuntando a una foto vieja de
 * la producción del padre (ej. Extrusión planificaba 40kg, derivó a Sellado
 * esperando eso, pero luego un rollo cargado tarde en Extrusión sube el
 * total real a 45kg — Sellado tiene que poder cargar esos 45kg, no quedarse
 * trabado en 40). Solo toca hijos que aún no produjeron nada propio: uno que
 * ya tiene rollos cargados ya está trabajando sobre su propia meta real, no
 * sobre la foto heredada del padre.
 */
async function syncQuantityPlannedToChildren(tx: TxClient, orderId: number) {
  const order = await tx.productionOrder.findUnique({
    where: { id: orderId },
    include: { rolls: { select: { weightKg: true, details: true } } },
  });
  if (!order) return;
  // Precorte/Sellado son estaciones finales (DERIVATIONS.precorte/sellado =
  // []) así que en la práctica `order` acá nunca es una de esas dos — pero
  // se usa rollProducedKg de todos modos para que esto siga siendo correcto
  // si ese mapa de derivaciones cambia algún día.
  const producedKg = order.rolls.reduce((acc, r) => acc + rollProducedKg(order.station as OpStation, r), 0);
  if (producedKg <= 0) return;
  const newPlanned = Math.round(producedKg * 100) / 100;

  const children = await tx.productionOrder.findMany({
    where: { parentOrderId: orderId, status: { not: "cancelada" } },
    include: { rolls: { select: { id: true } } },
  });
  // Con varias hijas, lo producido se reparte entre ellas (ver
  // siblingAllocation) y el reparto lo decide Gestión: si cada una se
  // sincronizara sola al total, volverían a quedar todas con el 100%. Solo
  // una hija única sigue automáticamente a su padre.
  if (children.length !== 1) return;
  for (const child of children) {
    if (child.rolls.length > 0) continue;
    if (Number(child.quantityPlanned) === newPlanned) continue;
    await tx.productionOrder.update({ where: { id: child.id }, data: { quantityPlanned: newPlanned } });
  }
}

/** Edita el encabezado/specs de una OP mientras siga abierta. */
productionOrdersRouter.patch("/:id", requireProduccionGestion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });
  const parsed = updateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: { rolls: { select: { weightKg: true, wasteKg: true, details: true } } },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  // "borrador" también es editable — es justo el estado en el que Gestión
  // carga materia prima/medidas/cliente/referencia antes de liberarla.
  if (order.status !== "borrador" && !OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: "Solo se puede editar una OP en borrador o abierta (pendiente o en proceso)" });
  }

  // Mismo chequeo que POST / -- un clientId inexistente (cliente borrado
  // entre que se cargó el dropdown y se guardó) rompía la FK y devolvía un
  // 500 crudo en vez de un mensaje claro.
  if (parsed.data.clientId != null) {
    const client = await prisma.client.findUnique({ where: { id: parsed.data.clientId } });
    if (!client) return res.status(404).json({ error: "Cliente no encontrado" });
  }

  // No se puede bajar la meta por debajo de lo que ya hay físicamente
  // cargado (peso + desperdicio, mismo criterio que el tope de POST
  // /:id/rolls) -- si no, la hoja pasa a "Completado" con material real sin
  // registrar, y los cálculos de materia prima (que se derivan del % ×
  // cantidad planificada) quedan recalculados sobre un número menor al
  // realmente consumido al cerrar.
  if (parsed.data.quantityPlanned != null) {
    const yaCargado = order.rolls.reduce((acc, r) => acc + rollProducedKg(order.station as OpStation, r) + Number(r.wasteKg), 0);
    if (parsed.data.quantityPlanned < yaCargado) {
      return res.status(400).json({
        error: `La meta no puede ser menor a lo ya cargado (${Math.round(yaCargado * 100) / 100} kg entre peso y desperdicio)`,
      });
    }
  }

  // Una OP derivada no puede pedir más de lo que su padre produjo, contando
  // lo ya asignado a sus hermanas (ver siblingAllocation).
  // Solo si la meta SUBE: el cliente manda quantityPlanned en cada "Guardar
  // cambios", y una hija que ya tenía su meta (ej. OPs derivadas antes de
  // esta regla, con el 100% cada una) no puede quedar sin poder editar sus
  // notas o specs por un reparto que nadie tocó. Bajarla nunca empeora el
  // reparto (es justo como Gestión lo corrige), así que siempre se permite.
  if (
    parsed.data.quantityPlanned != null &&
    order.parentOrderId &&
    parsed.data.quantityPlanned > Number(order.quantityPlanned) + 0.005
  ) {
    const parent = await prisma.productionOrder.findUnique({
      where: { id: order.parentOrderId },
      include: { rolls: { select: { weightKg: true, details: true } } },
    });
    if (parent) {
      const alloc = await siblingAllocation(prisma, parent, order.id);
      if (parsed.data.quantityPlanned > alloc.availableKg + 0.005) {
        return res.status(400).json({
          error: `La meta se pasa de lo disponible: el padre tiene ${alloc.baseKg} kg y sus otras derivadas ya tienen ${alloc.assignedKg} kg (${alloc.detail || "ninguna"}) — como máximo ${alloc.availableKg} kg`,
        });
      }
    }
  }

  // Un umbral mayor a la meta nunca se cruza (el aviso compara contra
  // `quantityPlanned` en POST /:id/rolls) -- Gestión configuraba una alerta
  // que en la práctica nunca iba a saltar, sin ningún aviso de que estaba
  // mal puesta.
  if (parsed.data.alertThresholdKg != null) {
    const effectivePlanned = parsed.data.quantityPlanned ?? Number(order.quantityPlanned);
    if (parsed.data.alertThresholdKg > effectivePlanned) {
      return res.status(400).json({
        error: `El umbral de alerta no puede ser mayor a la meta (${effectivePlanned} kg) — nunca se cruzaría`,
      });
    }
  }

  // Cada campo de lista tiene que ser una de sus opciones ("alta" se guarda
  // como "ALTA"; "Natural" en Color se rechaza) — antes se guardaba
  // cualquier texto y la hoja lo mostraba en blanco, y al derivar la OP hija
  // heredaba un valor que su propio <select> tampoco podía mostrar.
  let specs = parsed.data.specs;
  if (specs && order.station) {
    const normalized = normalizeSpecOptions(order.station as OpStation, specs);
    if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage(order.station as OpStation, normalized.issues) });
    specs = normalized.specs;
  }

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.productionOrder.update({
      where: { id },
      data: {
        specs: specs as Prisma.InputJsonValue | undefined,
        measure: parsed.data.measure,
        quantityPlanned: parsed.data.quantityPlanned,
        clientId: parsed.data.clientId,
        notes: parsed.data.notes,
        alertThresholdKg: parsed.data.alertThresholdKg,
      },
    });
    if (parsed.data.specs !== undefined && result.station) {
      await propagateSpecsToChildren(tx, result.id, result.station as OpStation, result.specs as Record<string, unknown> | null);
    }
    return result;
  });
  res.json(updated);
});

const materialParaSchema = z.object({ materialPara: z.string().nullable() });

/**
 * "Material para" (specs.materialPara) es el ÚNICO campo del encabezado que
 * también puede tocar el operario, no solo Gestión: es literalmente a qué
 * estación va a derivar esta OP (IMPRESION/SELLADO/PRECORTE), y el operario
 * de Extrusión es quien decide eso al terminar su parte — el resto del PATCH
 * general (materia prima, medidas, cliente...) sigue siendo exclusivo de
 * Gestión. Endpoint aparte (en vez de abrir todo el PATCH /:id) para no
 * poder tocar ningún otro campo desde acá.
 */
productionOrdersRouter.patch("/:id/material-para", requireOperarios, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });
  const parsed = materialParaSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.productionOrder.findUnique({ where: { id } });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (order.status !== "borrador" && !OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: "Solo se puede editar una OP en borrador o abierta (pendiente o en proceso)" });
  }

  const allowedStations = OPERARIO_STATIONS[req.user!.role];
  if (allowedStations && !allowedStations.includes(order.station as OpStation)) {
    return res.status(403).json({ error: `Tu rol solo puede editar OPs de: ${allowedStations.join(", ")}` });
  }

  // Misma regla de listas que el PATCH general: solo una de las opciones de
  // la plantilla (IMPRESION/SELLADO/PRECORTE), en su forma exacta.
  let materialPara = parsed.data.materialPara;
  if (materialPara && order.station) {
    const normalized = normalizeSpecOptions(order.station as OpStation, { materialPara });
    if (normalized.issues.length) return res.status(400).json({ error: specOptionIssuesMessage(order.station as OpStation, normalized.issues) });
    materialPara = normalized.specs.materialPara as string;
  }

  const currentSpecs = order.specs && typeof order.specs === "object" ? (order.specs as object) : {};
  const updated = await prisma.productionOrder.update({
    where: { id },
    data: { specs: { ...currentSpecs, materialPara } as Prisma.InputJsonValue },
  });
  res.json(updated);
});

/**
 * Cierra una OP. Extrusión (siempre intermedia) queda "finalizada" directo,
 * su material pasa a la OP derivada sin mover stock. Impresión/Sellado/
 * Precorte (FINAL_STATIONS) pasan a "pendiente_calidad" — recién cuando
 * Calidad aprueba se genera la entrada de inventario con la suma de kg de
 * los rollos. Impresión puede cerrarse así AUNQUE también tenga OPs
 * derivadas (a Sellado/Precorte): cerrar y derivar son decisiones
 * independientes, no una excluye a la otra.
 */
productionOrdersRouter.post("/:id/close", requireRole(...ROLES.CIERRE_OP), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: { rolls: { select: { id: true, weightKg: true, wasteKg: true, details: true } } },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (!OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: "Esta OP ya no está abierta" });
  }
  const allowedStations = OPERARIO_STATIONS[req.user!.role];
  if (allowedStations && !allowedStations.includes(order.station as OpStation)) {
    return res.status(403).json({ error: `Tu rol solo puede operar OPs de: ${allowedStations.join(", ")}` });
  }

  if (order.rolls.length === 0) {
    return res.status(400).json({ error: "No se puede cerrar una OP sin rollos registrados" });
  }

  if (order.station === "extrusion") {
    const falta = materiaPrimaIncompleta(order.specs);
    // El que cierra es el operario, que no puede editar la fórmula: el
    // mensaje le dice a quién pedírsela.
    if (falta) return res.status(400).json({ error: `No se puede cerrar: ${falta}. Pedile a Gestión que complete la fórmula en la hoja de la OP.` });
  }

  const isFinal = FINAL_STATIONS.includes(order.station as OpStation);
  const newStatus = isFinal ? "pendiente_calidad" : "finalizada";

  // Al cerrar una OP de Extrusión se descuenta del stock de materia prima
  // el % de cada insumo de la tabla (specs.materiaPrima) sobre lo producido
  // real (peso + desperdicio de sus rollos), ver más abajo. Si un `ref` no
  // matchea ningún código del catálogo (materia prima borrada, error de
  // tipeo), se avisa en la respuesta pero NO bloquea el cierre — la OP ya
  // tiene rollos reales cargados, no tiene sentido trabarla por esto.
  const skippedRefs: string[] = [];
  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // Mismo patrón que /reopen: reintenta el gate de estado DENTRO de la
      // transacción con un update condicional — si dos cierres casi
      // simultáneos del mismo botón pasan el chequeo de arriba, acá solo
      // uno logra el update (el otro ve count=0 y aborta sin descontar
      // materia prima dos veces ni pisar el status del otro).
      const claimed = await tx.productionOrder.updateMany({
        where: { id, status: { in: OPEN_STATUSES } },
        data: { status: newStatus },
      });
      if (claimed.count === 0) throw new StatusRaceError();

      if (order.station === "extrusion") {
        // Lo que de verdad pasó por la extrusora: peso de los rollos más su
        // desperdicio. Cada insumo se descuenta con su % sobre ese total —
        // antes se descontaba el kg de la tabla, calculado sobre la meta
        // PLANIFICADA al momento de guardar (si después cambiaba la meta, o
        // se producía más o menos, el inventario de materia prima quedaba
        // descuadrado contra la producción real).
        const procesadoKg = order.rolls.reduce((acc, r) => acc + rollProducedKg("extrusion", r) + Number(r.wasteKg), 0);
        for (const row of materiaPrimaRows(order.specs)) {
          const kg = Math.round(((row.pct / 100) * procesadoKg) * 100) / 100;
          if (kg <= 0) continue;
          const material = await tx.rawMaterial.findUnique({ where: { code: row.ref } });
          if (!material) {
            skippedRefs.push(row.ref);
            continue;
          }
          await applyRawMaterialMovement(tx, {
            rawMaterialId: material.id,
            quantity: -kg,
            movementType: "consumo_produccion",
            referenceType: "production_order",
            referenceId: order.id,
            createdById: req.user!.userId,
          });
        }
      }

      return tx.productionOrder.findUniqueOrThrow({ where: { id } });
    });
  } catch (err) {
    if (err instanceof StatusRaceError) {
      return res.status(400).json({ error: "Esta OP ya no está abierta" });
    }
    if (err instanceof InsufficientStockError) {
      // No hay suficiente materia prima cargada en el sistema para lo que
      // esta OP declara haber consumido -- antes esto se descontaba igual y
      // dejaba el insumo en negativo sin ningún aviso; ahora se bloquea el
      // cierre para que Planeación cargue el faltante (o corrija specs)
      // antes de seguir.
      return res.status(400).json({ error: `No se puede cerrar: ${err.message}` });
    }
    throw err;
  }

  if (isFinal) {
    await notifyRoles(ROLES.CALIDAD, {
      type: "op_pendiente_calidad",
      message: `OP #${order.orderNumber} lista para revisión de calidad`,
      link: "/calidad",
    });
  }

  res.json({ ...updated, skippedRawMaterialRefs: skippedRefs });
});

/** Estados desde los que se puede reabrir una OP para corregir un error. */
const REOPENABLE_STATUSES: ProductionOrderStatus[] = ["finalizada", "pendiente_calidad", "detenida"];

/**
 * Reabre una OP cerrada por error, dejándola "en_proceso" otra vez (se
 * puede volver a editar specs/cantidad y cargar o borrar rollos). Revierte
 * TODO efecto de inventario que se haya aplicado al cerrarla o aprobarla,
 * en vez de solo cambiar el status, para que los kilos nunca queden
 * "fantasma" en el stock:
 *  - si tenía un control de calidad "aprobado", revierte la entrada de
 *    producto terminado (misma cantidad de kg que se sumó) y borra el
 *    control (al volver a cerrar se vuelve a pasar por Calidad);
 *  - si tenía un control "rechazado", solo borra el control (nunca movió
 *    stock);
 *  - si es una OP de Extrusión, revierte la materia prima descontada al
 *    cerrarla, leyendo los movimientos reales que quedaron logueados con
 *    `referenceType: "production_order"` (no se recalcula desde specs, que
 *    pudo haber cambiado desde entonces).
 */
class StatusRaceError extends Error {}
class BultoLabelUnavailableError extends Error {}
class RollAlreadyConsumedError extends Error {}
/** El rollo madre escaneado no está en la bodega de esta estación (ver services/rollLocation.ts). */
class RollNotHereError extends Error {}
/** En una estación que consume el insumo entero (Impresión), lo que sale
 * (peso + desperdicio) no cuadra con lo que entró. */
class MassBalanceError extends Error {}

/** Tolerancia del cuadre entrada/salida en estaciones que consumen el insumo
 * entero (Impresión): la tinta suma algo de peso y la balanza tiene su error,
 * así que se acepta hasta 2% del insumo o 0,5 kg, lo que sea mayor. */
function massBalanceToleranceKg(entradaKg: number): number {
  return Math.max(0.5, entradaKg * 0.02);
}

/**
 * Cuánto material de una OP padre queda sin asignar entre sus OPs derivadas.
 * La base es lo que el padre produjo de verdad (o su meta, si todavía no
 * produjo nada), y la suma de las metas de TODAS sus hijas no puede pasarla:
 * antes cada hija recibía el 100% de lo producido, y con dos hijas el
 * sistema dejaba cargar el doble del material que existía.
 */
async function siblingAllocation(
  db: TxClient | typeof prisma,
  parent: { id: number; station: string | null; quantityPlanned: unknown; rolls: { weightKg: unknown; details?: unknown }[] },
  excludeChildId?: number
) {
  const producedKg = parent.rolls.reduce((acc, r) => acc + rollProducedKg(parent.station as OpStation, r), 0);
  const baseKg = producedKg > 0 ? Math.round(producedKg * 100) / 100 : Number(parent.quantityPlanned);
  const siblings = await db.productionOrder.findMany({
    where: { parentOrderId: parent.id, status: { not: "cancelada" }, ...(excludeChildId ? { id: { not: excludeChildId } } : {}) },
    select: { station: true, quantityPlanned: true },
  });
  const assignedKg = Math.round(siblings.reduce((acc, s) => acc + Number(s.quantityPlanned), 0) * 100) / 100;
  const detail = siblings.map((s) => `${STATION_LABELS[s.station as OpStation] ?? s.station} ${Number(s.quantityPlanned)} kg`).join(", ");
  return { baseKg, assignedKg, availableKg: Math.round((baseKg - assignedKg) * 100) / 100, detail };
}

/** Filas de materia prima de Extrusión (specs.materiaPrima) con su % — el
 * kg que se descuenta ya no sale de la tabla (que se calculaba sobre la meta
 * planificada), sino del % sobre lo producido real al cerrar. */
function materiaPrimaRows(specs: unknown): { ref: string; pct: number }[] {
  const rows = (specs as any)?.materiaPrima;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r: any) => ({ ref: typeof r?.ref === "string" ? r.ref : "", pct: Number(r?.pct) }))
    .filter((r) => r.ref && Number.isFinite(r.pct) && r.pct > 0);
}

/** null si la fórmula de materia prima está completa (suma 100%), o el
 * mensaje para Gestión. Extrusión no puede salir a planta ni cerrarse sin
 * fórmula: al cerrar no se descontaría nada del inventario de materia prima. */
function materiaPrimaIncompleta(specs: unknown): string | null {
  const total = Math.round(materiaPrimaRows(specs).reduce((acc, r) => acc + r.pct, 0) * 100) / 100;
  if (Math.abs(total - 100) <= 0.01) return null;
  return total === 0
    ? "Cargá la fórmula de materia prima (los % de cada insumo) antes de seguir: sin eso no se descuenta nada del inventario"
    : `La materia prima suma ${total}% — tiene que sumar 100% antes de seguir`;
}

productionOrdersRouter.post("/:id/reopen", requireProduccionGestion, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: { qualityCheck: true, rolls: { select: { weightKg: true, details: true } } },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (!REOPENABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: "Esta OP no se puede reabrir desde su estado actual" });
  }

  // Si Calidad ya la aprobó con cliente asignado, se generó un Despacho para
  // ese cliente (ver POST /:id/quality-check) — reabrir revertiría el
  // inventario mientras ese despacho sigue vivo, y si Almacén ya lo
  // completa (o si se vuelve a aprobar y se genera un segundo despacho) el
  // stock queda descontado dos veces. Más simple y seguro: no se puede
  // reabrir mientras exista ESE despacho vivo, resuélvanlo (cancélenlo,
  // ver POST /dispatches/:id/cancel) primero — uno ya cancelado no cuenta,
  // porque cancelar ya revirtió su stock.
  const existingDispatch = await prisma.dispatch.findFirst({ where: { productionOrderId: id, status: { not: "cancelada" } } });
  if (existingDispatch) {
    return res.status(400).json({
      error: `Esta OP ya generó el Despacho #${existingDispatch.id} para su cliente — resolvé o cancelá ese despacho antes de reabrir la OP`,
    });
  }

  let reversedProductKg = 0;
  let reversedRawMaterials: { code: string; kg: number }[] = [];

  try {
    await prisma.$transaction(async (tx) => {
      // Reintenta el gate de estado DENTRO de la transacción con un update
      // condicional: si dos reaperturas casi simultáneas pasan el chequeo
      // de arriba (hecho con el `order` leído antes de abrir la tx), acá
      // solo una de las dos logra el update — la otra ve count=0 y aborta
      // sin haber revertido nada (si no, ambas reversarían la misma OP).
      const claimed = await tx.productionOrder.updateMany({
        where: { id, status: { in: REOPENABLE_STATUSES } },
        data: {
          status: "en_proceso",
          notes: order.notes
            ? `${order.notes}\n[Reabierta el ${new Date().toLocaleString("es-CO")} por ${req.user!.name}]`
            : `[Reabierta el ${new Date().toLocaleString("es-CO")} por ${req.user!.name}]`,
        },
      });
      if (claimed.count === 0) throw new StatusRaceError();

      if (order.qualityCheck) {
        if (order.qualityCheck.result === "aprobado") {
          reversedProductKg = order.rolls.reduce((acc, r) => acc + rollProducedKg(order.station, r), 0);
          if (reversedProductKg > 0) {
            // Se referencia la OP (order.id), no el qualityCheck -- ese
            // registro se borra dos líneas más abajo, así que apuntar a su
            // id dejaba el movimiento señalando a un registro inexistente,
            // imposible de reconstruir después desde Auditoría/Trazabilidad.
            await applyMovement(tx, {
              productId: order.productId,
              quantity: -reversedProductKg,
              movementType: "ajuste",
              referenceType: "production_order",
              referenceId: order.id,
              createdById: req.user!.userId,
            });
          }
        }
        await tx.qualityCheck.delete({ where: { id: order.qualityCheck.id } });
      }

      if (order.station === "extrusion") {
        // Se sobre-el NETO por insumo (suma de todo lo que quedó logueado
        // contra esta OP), no "cada movimiento negativo" — si esta ya es la
        // segunda vez que se cierra y reabre esta OP, el historial trae la
        // consumición original Y la reversión de la primera vuelta con el
        // mismo referenceId; sumar todo y revertir solo lo que sigue
        // pendiente (neto < 0) evita devolver dos veces el mismo kg.
        const movimientos = await tx.rawMaterialMovement.findMany({
          where: { referenceType: "production_order", referenceId: order.id },
          include: { rawMaterial: { select: { code: true } } },
        });
        const porMaterial = new Map<number, { code: string; net: number }>();
        for (const mov of movimientos) {
          const acc = porMaterial.get(mov.rawMaterialId) ?? { code: mov.rawMaterial.code, net: 0 };
          acc.net += Number(mov.quantity);
          porMaterial.set(mov.rawMaterialId, acc);
        }
        for (const [rawMaterialId, { code, net }] of porMaterial) {
          if (net >= 0) continue; // ya saldado por una reversión anterior
          const kg = -net;
          await applyRawMaterialMovement(tx, {
            rawMaterialId,
            quantity: kg,
            movementType: "ajuste",
            referenceType: "production_order",
            referenceId: order.id,
            notes: `Reversión por reapertura de ${order.orderNumber}`,
            createdById: req.user!.userId,
          });
          reversedRawMaterials.push({ code, kg });
        }
      }
    });
  } catch (err) {
    if (err instanceof StatusRaceError) {
      return res.status(400).json({ error: "Esta OP no se puede reabrir desde su estado actual" });
    }
    if (err instanceof InsufficientStockError) {
      // El producto que esta OP sumó al aprobarse ya no está completo en
      // stock (ej. se despachó a mano, sin pasar por el Despacho automático
      // que el chequeo de arriba sabe detectar) -- revertir dejaría el
      // stock en negativo, así que se bloquea en vez de "arreglarlo" a
      // costa de un número roto.
      // Dos causas distintas con la misma clase de error: el stock ya se
      // ubicó en un estante (hay que liberarlo en Almacén) o ya no está
      // completo en el total (se despachó por otro lado). El mensaje de
      // applyMovement ya dice cuál es; la pista extra solo aplica al segundo.
      const yaUbicado = err.message.includes("stock ubicado en estantes");
      return res.status(400).json({
        error: yaUbicado
          ? `No se puede reabrir: ${err.message}. Primero sacá ese producto del estante en Almacén.`
          : `No se puede reabrir: ${err.message} (probablemente parte de lo que produjo esta OP ya se despachó por otro lado)`,
      });
    }
    throw err;
  }

  const updated = await prisma.productionOrder.findUnique({ where: { id } });
  res.json({ ...updated, reversedProductKg, reversedRawMaterials });
});

/** Solo hay dos turnos reales en planta — se calcula solo de la hora del
 * servidor al guardar (mismo criterio que `date`, que también se deja en
 * blanco para que el default de Prisma la ponga), no se tipea ni se
 * confía en lo que mande el cliente. 6:00–17:59 es "Día", el resto "Noche". */
function autoShift(): string {
  // Hora de Colombia explícita (America/Bogota, UTC-5 fijo, sin horario de
  // verano) — no la del sistema operativo del server, que en el VPS puede
  // estar en otro huso. Node a veces devuelve "24" para la medianoche con
  // hour12:false, de ahí el % 24.
  const hourStr = new Intl.DateTimeFormat("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false }).format(new Date());
  const hour = Number(hourStr) % 24;
  return hour >= 6 && hour < 18 ? "Día" : "Noche";
}

const createRollSchema = z.object({
  date: z.string().optional(),
  machine: z.string().optional(),
  label: z.string().optional(),
  weightKg: z.number().positive(),
  wasteKg: z.number().min(0).optional().default(0),
  details: z.record(z.string(), z.any()).optional(),
  notes: z.string().optional(),
  /** Rollo físico tomado como insumo, resuelto al escanear su QR
   * (GET /rolls/by-code/:code). Queda registrado quién lo tomó porque
   * `createdById` es siempre el usuario logueado que hizo el POST. */
  sourceRollId: z.number().int().optional(),
  /** Rollos madre escaneados, EN EL ORDEN en que se escanearon (Sellado/
   * Precorte). Los kilos de esta fila se reparten agotando el primero antes
   * de tocar el siguiente: si quedaban 10 kg del madre A y se cargan 15,
   * salen 10 de A y 5 de B. `sourceRollId` de arriba es el caso viejo de un
   * solo rollo consumido entero (Impresión) y se sigue aceptando. */
  sourceRollIds: z.array(z.number().int()).min(1).optional(),
  /** Token de posesión de cada rollo madre escaneado (ver
   * services/rollPossessionToken.ts), uno por id de `sourceRollIds`/
   * `sourceRollId` -- obligatorio para poder consumir ese rollo, todo rollo
   * tiene un `possessionTokenHash` desde que se creó. */
  sourceRollTokens: z.record(z.string(), z.string()).optional(),
  /** Código de la etiqueta física de bulto escaneada (Sellado/Precorte) —
   * ver GET /bulto-labels/by-code/:code. Reemplaza tipear "E. BULTO" a
   * mano: se valida que exista y siga disponible, y queda consumida
   * (atómico con la creación de este rollo). */
  bultoLabelCode: z.string().optional(),
});

/**
 * Agrega una fila al registro acumulativo de rollos de la OP (la tabla
 * inferior del formato en papel). Un operario solo puede cargar rollos en
 * OPs de SU estación (gerente_produccion y planeacion cargan cualquiera).
 */
productionOrdersRouter.post("/:id/rolls", requireOperarios, async (req, res) => {
  const productionOrderId = Number(req.params.id);
  if (!Number.isInteger(productionOrderId)) return res.status(400).json({ error: "Id inválido" });
  const parsed = createRollSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (!order.station) return res.status(400).json({ error: "Esta OP todavía no tiene proceso asignado" });
  if (!OPEN_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: "Esta OP ya no está abierta" });
  }

  const allowedStations = OPERARIO_STATIONS[req.user!.role];
  if (allowedStations && !allowedStations.includes(order.station as OpStation)) {
    return res.status(403).json({ error: `Tu rol solo puede registrar rollos en OPs de: ${allowedStations.join(", ")}` });
  }

  // Los rollos madre escaneados, en orden. `sourceRollIds` (varios, Sellado/
  // Precorte) y `sourceRollId` (uno solo, el caso de siempre) se unifican acá
  // para que el resto del handler no tenga que distinguirlos.
  const sourceRollIds = parsed.data.sourceRollIds ?? (parsed.data.sourceRollId ? [parsed.data.sourceRollId] : []);
  if (new Set(sourceRollIds).size !== sourceRollIds.length) {
    return res.status(400).json({ error: "Se escaneó el mismo rollo madre dos veces en la misma fila" });
  }
  const template = OP_TEMPLATES[order.station as OpStation];
  // Una OP derivada (Impresión/Sellado/Precorte) transforma material de su
  // OP padre: cada fila tiene que decir de qué rollo salió, escaneando su QR.
  // Sin eso no hay nada contra qué cuadrar los kilos — en Impresión, además,
  // el rollo de Extrusión nunca quedaba consumido y seguía figurando
  // disponible. (Antes Impresión dejaba cargar la fila sin escanear.)
  if (order.parentOrderId && sourceRollIds.length === 0) {
    return res.status(400).json({ error: "Escaneá el QR del rollo que estás tomando como insumo antes de registrar la fila" });
  }
  const sourceRollById = new Map<number, SourceRollInfo>();
  for (const sourceRollId of sourceRollIds) {
    const source = await prisma.productionRoll.findUnique({ where: { id: sourceRollId } });
    if (!source) return res.status(404).json({ error: "El rollo de origen escaneado no existe" });
    // El insumo escaneado tiene que salir de la OP padre real (la cadena de
    // derivación), no de cualquier rollo del sistema — si no, el QR deja de
    // ser trazabilidad y pasa a ser un dato suelto sin sentido.
    if (source.productionOrderId !== order.parentOrderId) {
      return res.status(400).json({ error: "El rollo escaneado no pertenece a la OP de la que deriva esta orden" });
    }
    // La UI mirror-ea este chequeo al escanear (GET /rolls/by-code, con el
    // mismo token), pero ESTE es el que de verdad importa: el server es la
    // autoridad, no la pantalla -- sin esto, cualquiera con sesión válida
    // podría mandar un sourceRollId adivinado sin haber escaneado nada.
    if (!checkPossessionTokenRateLimit(req.user!.userId)) {
      return res.status(429).json({ error: "Demasiados intentos seguidos — esperá un momento y volvé a intentar" });
    }
    const tokenVisible = parsed.data.sourceRollTokens?.[String(sourceRollId)];
    const code = sourceRollCode(source);
    if (!tokenVisible || !verifyPossessionToken(code, tokenVisible, source.possessionTokenHash)) {
      return res.status(403).json({ error: `Falta demostrar posesión física del rollo ${code} — escaneá su QR` });
    }
    sourceRollById.set(sourceRollId, { station: source.station as OpStation, stationSequence: source.stationSequence });
  }

  // etiquetaR2/pesoR2 (Precorte) los calcula el server solo del reparto
  // entre rollos madre (más abajo) CUANDO la fila viene de un escaneo
  // (sourceRollIds) — la UI ya no tiene ningún input que los escriba en ese
  // caso, pero un cliente con la PWA en caché vieja todavía podría mandarlos
  // tipeados a mano junto con el escaneo. Se descartan ACÁ, antes del
  // chequeo de meta de abajo (no solo dentro de la transacción) — si no, un
  // pesoR2 inventado por un cliente viejo hace que una fila que en realidad
  // entra justo se rechace como "se pasa de la cantidad planificada", con un
  // mensaje que ni siquiera tiene sentido para quien lo lee. Fuera del flujo
  // de escaneo (sin sourceRollIds) pesoR2/etiquetaR2 siguen siendo el
  // segundo rollo tipeado a mano de siempre — no hay ningún reparto que los
  // vaya a pisar, así que no se tocan.
  let sanitizedDetails = parsed.data.details as Record<string, unknown> | undefined;
  if (template.consumesSourceByWeight && sourceRollIds.length > 0 && sanitizedDetails) {
    const { etiquetaR2, pesoR2, ...rest } = sanitizedDetails;
    sanitizedDetails = rest;
  }

  // La meta de la OP (quantityPlanned) se completa con PESO + DESPERDICIO,
  // no solo peso — así lo pidió el cliente ("si son 200kg se tiene que
  // descontar el desperdicio"). Una vez alcanzada, no se puede seguir
  // cargando (chequeo acá, no solo en el frontend, para que sea real).
  const existingRolls = await prisma.productionRoll.findMany({
    where: { productionOrderId },
    select: { weightKg: true, wasteKg: true, details: true },
  });
  const existingTotal = existingRolls.reduce(
    (acc, r) => acc + rollProducedKg(order.station as OpStation, r) + Number(r.wasteKg),
    0
  );
  const planned = Number(order.quantityPlanned);
  // En Precorte, el segundo peso de la fila (details.pesoR2) es material
  // real igual que weightKg — cuenta contra la meta igual que el primero.
  const thisRollKg = rollProducedKg(order.station as OpStation, {
    weightKg: parsed.data.weightKg,
    details: sanitizedDetails,
  });
  // No alcanza con chequear "¿ya se completó antes de este rollo?" — un
  // rollo grande podía colarse entero y pasarse de largo de la meta en un
  // solo golpe (ej. OP de 40kg con 33kg cargados, entra un rollo de 44kg y
  // queda en 82kg). Se rechaza si ESTE rollo, sumado a lo que ya hay, se
  // pasaría de lo planificado — no solo si ya estaba completa de antes.
  if (planned > 0 && existingTotal + thisRollKg + parsed.data.wasteKg > planned) {
    const remaining = Math.round((planned - existingTotal) * 100) / 100;
    return res.status(400).json({
      error:
        remaining <= 0
          ? "Esta OP ya alcanzó la cantidad planificada — no se pueden cargar más rollos"
          : `Este rollo se pasa de la cantidad planificada — quedan ${remaining} kg disponibles de ${planned} kg`,
    });
  }

  let roll;
  try {
    roll = await withSequentialNumberRetry(() =>
    prisma.$transaction(async (tx) => {
      // Se reinicia en cada intento del reintento de arriba, en vez de
      // reusar la variable de afuera directamente: las mutaciones de abajo
      // (eBulto, etiquetaR2/pesoR2) van todas por spread (`{ ...details,
      // ... }`), así que nunca tocan `sanitizedDetails` en el lugar -- si un
      // intento anterior falló, el siguiente arranca de la misma base
      // limpia, no de una versión ya mutada. `sanitizedDetails` en sí ya
      // viene libre de un eventual etiquetaR2/pesoR2 tipeado a mano por un
      // cliente con la PWA en caché vieja (ver arriba, antes del chequeo de
      // meta).
      let details = sanitizedDetails;
      // Se reclama la etiqueta ANTES de crear el rollo, con un update
      // condicional atómico (no un find + create separados) — así dos
      // escaneos casi simultáneos del mismo QR no pueden consumir la misma
      // etiqueta dos veces.
      if (parsed.data.bultoLabelCode) {
        const claim = await tx.bultoLabel.updateMany({
          where: { code: parsed.data.bultoLabelCode, status: "disponible" },
          data: { status: "usada", usedById: req.user!.userId, usedAt: new Date() },
        });
        if (claim.count === 0) throw new BultoLabelUnavailableError();
        details = { ...details, eBulto: parsed.data.bultoLabelCode };
      }

      // Reparto contra los rollos madre. En Sellado/Precorte el rollo madre
      // se monta en la máquina y se le van sacando rollos chicos, así que
      // esta fila le descuenta solo sus kilos y el madre queda con saldo
      // para las siguientes; en el resto de las estaciones el insumo
      // escaneado se consume entero, como siempre.
      let allocations: Allocation[] = [];
      const wasteKg = Number(parsed.data.wasteKg ?? 0);
      if (sourceRollIds.length > 0) {
        // Del rollo madre sale el rollo chico MÁS su desperdicio: la merma
        // también es material de ese rollo. Antes solo se descontaba el
        // peso, y el saldo del madre quedaba inflado justo en lo que se fue
        // a merma.
        const toConsumeKg = Math.round((parsed.data.weightKg + wasteKg) * 100) / 100;
        allocations = template.consumesSourceByWeight
          ? await allocateFromSourceRolls(tx, sourceRollIds, toConsumeKg)
          : await allocateWholeSourceRolls(tx, sourceRollIds);

        // Un rollo solo se consume en la estación donde está físicamente
        // (ver services/rollLocation.ts): despachado y recibido en la bodega
        // de ESTA estación, o producido acá mismo. Se chequea recién acá,
        // con los rollos madre ya bloqueados por la asignación de arriba
        // (SELECT ... FOR UPDATE, el mismo lock que toma POST
        // /roll-transfers al despachar) — chequearlo antes de la transacción
        // dejaba una ventana en la que un despacho registrado en ese mismo
        // instante se colaba igual.
        for (const sourceRollId of sourceRollIds) {
          const info = sourceRollById.get(sourceRollId)!;
          const location = await getRollLocation(tx, { id: sourceRollId, station: info.station });
          const block = rollLocationBlock(sourceRollCode(info), location, order.station as OpStation);
          if (block) throw new RollNotHereError(block);
        }

        // Estaciones que consumen el insumo entero (Impresión): lo que entra
        // tiene que salir como producto o como desperdicio. Antes un rollo de
        // 40 kg podía dar 15 kg impresos sin desperdicio y los otros 25 kg
        // desaparecían sin registro.
        if (!template.consumesSourceByWeight) {
          const entradaKg = Math.round(allocations.reduce((acc, a) => acc + a.quantityKg, 0) * 100) / 100;
          const salidaKg = Math.round((parsed.data.weightKg + wasteKg) * 100) / 100;
          const diffKg = Math.round((entradaKg - salidaKg) * 100) / 100;
          if (Math.abs(diffKg) > massBalanceToleranceKg(entradaKg)) {
            const codes = allocations.map((a) => sourceRollCode(sourceRollById.get(a.sourceRollId))).join(" + ");
            throw new MassBalanceError(
              diffKg > 0
                ? `Entraron ${entradaKg} kg (${codes}) y salen ${parsed.data.weightKg} kg + ${wasteKg} kg de desperdicio = ${salidaKg} kg: faltan ${diffKg} kg. Si es merma, cargala en desperdicio.`
                : `Salen ${salidaKg} kg (peso + desperdicio) pero solo entraron ${entradaKg} kg (${codes}): sobran ${-diffKg} kg. Revisá el peso.`
            );
          }
        }
      }

      // Precorte tiene DOS pares ETIQUETA R / PESO R en el papel — son
      // justamente para el caso en que un rollo chico se pasa del saldo del
      // madre y el excedente sale del siguiente. El primer par va en los
      // campos base y el segundo en `details`, que es donde la plantilla los
      // lee (ver rollProducedKg: para Precorte el total de la fila es
      // weightKg + pesoR2, así que el reparto no cambia el total).
      //
      // El reparto de arriba incluye el desperdicio, tomado DESPUÉS del peso
      // (FIFO): el primer par lleva lo que el primer madre aportó al peso, y
      // el segundo par el resto del peso — la merma no cuenta como peso
      // producido, aunque haya salido de algún madre.
      let weightKg = parsed.data.weightKg;
      if (template.consumesSourceByWeight && order.station === "precorte" && allocations.length > 0) {
        const firstKg = Math.round(Math.min(allocations[0].quantityKg, parsed.data.weightKg) * 100) / 100;
        const spillKg = Math.round((parsed.data.weightKg - firstKg) * 100) / 100;
        weightKg = firstKg;
        if (spillKg > 0.005) {
          details = { ...details, etiquetaR2: sourceRollCode(sourceRollById.get(allocations[1].sourceRollId)), pesoR2: spillKg };
        }
      }

      const stationSequence = await nextStationSequence(tx, order.station as OpStation);

      // Token de posesión física de ESTE rollo recién creado (ver
      // services/rollPossessionToken.ts): se guarda solo el hash; el valor
      // visible (`possessionToken`) se devuelve en la respuesta y es la
      // ÚNICA vez que existe fuera de la etiqueta impresa -- no se puede
      // recuperar después, ni releyendo esta misma fila.
      const code = `${ROLL_CODE_PREFIX[order.station as OpStation]}-${stationSequence}`;
      const possessionToken = generatePossessionToken();
      const possessionTokenHash = hashPossessionToken(code, possessionToken);

      const created = await tx.productionRoll.create({
        data: {
          productionOrderId,
          station: order.station as OpStation,
          stationSequence,
          date: parsed.data.date ? new Date(parsed.data.date) : undefined,
          shift: autoShift(),
          // El operario SIEMPRE sale del JWT, nunca del body — si no, cualquiera
          // con un token válido podría firmar rollos a nombre de otra persona
          // llamando la API directo (el frontend ya manda esto, pero no hay
          // que confiar en eso del lado del cliente).
          operatorName: req.user!.name,
          machine: parsed.data.machine,
          label: parsed.data.label,
          weightKg,
          wasteKg: parsed.data.wasteKg,
          details: details as Prisma.InputJsonValue | undefined,
          notes: parsed.data.notes,
          // Rollo madre principal (el primero escaneado) — el reparto real
          // en kilos vive en roll_consumptions, esto queda como atajo para
          // mostrar "de dónde salió" sin cargar el ledger.
          sourceRollId: allocations[0]?.sourceRollId ?? parsed.data.sourceRollId,
          createdById: req.user!.userId,
          possessionTokenHash,
        },
      });

      if (allocations.length > 0) {
        await tx.rollConsumption.createMany({
          data: allocations.map((a) => ({ rollId: created.id, sourceRollId: a.sourceRollId, quantityKg: a.quantityKg })),
        });
      }

      if (parsed.data.bultoLabelCode) {
        await tx.bultoLabel.update({ where: { code: parsed.data.bultoLabelCode }, data: { usedByRollId: created.id } });
      }

      if (order.status === "pendiente") {
        await tx.productionOrder.update({ where: { id: productionOrderId }, data: { status: "en_proceso" } });
      }

      await syncQuantityPlannedToChildren(tx, productionOrderId);

      // QR listo para imprimir de una: código+token embebidos -- es la
      // ÚNICA vez que se puede armar (nada de esto queda guardado en texto
      // plano). Si acá no se imprime, la única forma de conseguir una
      // etiqueta válida después es reemitiéndola (ver
      // POST /:id/rolls/:rollId/reissue-label, invalida esta).
      const qrDataUrl = await QRCode.toDataURL(`${code}-${possessionToken}`);
      // El hash nunca sale del servidor -- lo único que se manda es el
      // token visible (arriba), que es la única vez que va a existir fuera
      // de la etiqueta impresa.
      const { possessionTokenHash: _hash, ...createdWithoutHash } = created;
      return { ...createdWithoutHash, possessionToken, qrDataUrl };
    })
    );
  } catch (err) {
    if (err instanceof BultoLabelUnavailableError) {
      return res.status(400).json({ error: "Esa etiqueta de bulto no existe o ya fue usada" });
    }
    if (err instanceof RollNotHereError || err instanceof MassBalanceError) {
      return res.status(400).json({ error: err.message });
    }
    if (err instanceof SourceRollExhaustedError) {
      return res.status(400).json({ error: "Este rollo ya fue consumido como insumo en otra fila — no se puede volver a escanear" });
    }
    if (err instanceof InsufficientSourceRollError) {
      // El caso del papel: quedaban 10 kg del rollo madre y el operario carga
      // 15. Hay que escanear el siguiente para cubrir los 5 que faltan.
      return res.status(400).json({
        error: `Faltan ${err.missingKg} kg para cubrir esta fila — escaneá el siguiente rollo madre`,
      });
    }
    throw err;
  }

  // Aviso de "está por completarse" — se dispara una sola vez, justo al
  // cruzar el umbral, no en cada rollo posterior mientras siga entre el
  // umbral y el 100%. El umbral lo configura Gestión a mano
  // (alertThresholdKg, en kg absolutos) — si no lo configuró, cae al
  // default de siempre (90% de lo planificado).
  const newTotal = existingTotal + thisRollKg + Number(roll.wasteKg);
  const threshold = order.alertThresholdKg != null ? Number(order.alertThresholdKg) : planned * 0.9;
  // Antes se exigía `newTotal < planned`, así que un rollo que cruzaba el
  // umbral Y completaba la OP en el mismo golpe (ej. pasaba de 30/40kg
  // directo a 40/40kg) no disparaba ningún aviso -- ni este, ni ningún otro
  // (no existe un aviso separado de "OP completada"). Con `<=` ese caso
  // avisa igual, con un mensaje que refleja que ya se completó.
  if (planned > 0 && existingTotal < threshold && newTotal >= threshold && newTotal <= planned) {
    const completa = newTotal >= planned;
    await notifyRoles(ROLES.PRODUCCION_GESTION, {
      type: "op_proxima_a_completarse",
      message: completa
        ? `OP #${order.orderNumber} se completó (${Math.round(newTotal * 100) / 100} / ${planned} kg)`
        : `OP #${order.orderNumber} está próxima a completarse (${Math.round(newTotal * 100) / 100} / ${planned} kg)`,
      link: `/produccion/ordenes/${productionOrderId}`,
    });
  }

  res.status(201).json(roll);
});

/** Borra una fila de rollo cargada por error (solo gestión, solo OP abierta). */
productionOrdersRouter.delete("/:id/rolls/:rollId", requireProduccionGestion, async (req, res) => {
  const productionOrderId = Number(req.params.id);
  const rollId = Number(req.params.rollId);
  if (!Number.isInteger(productionOrderId) || !Number.isInteger(rollId)) {
    return res.status(400).json({ error: "Id inválido" });
  }

  const roll = await prisma.productionRoll.findFirst({
    where: { id: rollId, productionOrderId },
    include: { productionOrder: true },
  });
  if (!roll) return res.status(404).json({ error: "Rollo no encontrado" });
  if (!OPEN_STATUSES.includes(roll.productionOrder.status)) {
    return res.status(400).json({ error: "La OP ya no está abierta" });
  }
  // Si a este rollo ya le sacaron material en otra estación, borrarlo
  // rompería la cadena: las filas que salieron de él quedarían apuntando a
  // un rollo que no existe. Hay que deshacer primero esas filas (la FK del
  // ledger también lo frena, pero como un 500 crudo en vez de un aviso).
  const consumido = await prisma.rollConsumption.findFirst({
    where: { sourceRollId: rollId },
    select: { roll: { select: { productionOrder: { select: { orderNumber: true, station: true } } } } },
  });
  if (consumido) {
    const destino = consumido.roll.productionOrder;
    return res.status(400).json({
      error: `No se puede borrar: de este rollo ya se sacó material en ${
        destino.station ? STATION_LABELS[destino.station as OpStation] : "otra OP"
      } (OP ${destino.orderNumber}). Borrá primero esas filas.`,
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Se re-chequea DENTRO de la transacción, no solo en el pre-check de
      // arriba: si alguien registra una fila contra este rollo justo en la
      // ventana entre ese chequeo y acá, el pre-check ya no lo ve y el
      // borrado volvería a chocar con la FK como un 500 crudo.
      const consumidoEnCarrera = await tx.rollConsumption.findFirst({ where: { sourceRollId: rollId } });
      if (consumidoEnCarrera) throw new RollAlreadyConsumedError();

      // Los consumos DE este rollo (lo que él le sacó a sus madres) se borran
      // en cascada, así que el saldo de los madres se libera solo.
      await tx.productionRoll.delete({ where: { id: rollId } });
      await syncQuantityPlannedToChildren(tx, productionOrderId);
    });
  } catch (err) {
    if (err instanceof RollAlreadyConsumedError) {
      return res.status(400).json({ error: "No se puede borrar: justo ahora se registró una fila que sacó material de este rollo. Recargá la página." });
    }
    // Ventana angosta que el re-chequeo de arriba no cubre: la otra
    // transacción todavía no había comiteado cuando se leyó, pero comitea
    // justo antes del DELETE — ahí el DELETE choca contra la FK
    // (RollConsumption.sourceRoll es Restrict) y Prisma lo reporta como
    // P2003, no como el error de arriba. Mismo mensaje amigable en vez del
    // 500 crudo que esto reemplaza.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return res.status(400).json({ error: "No se puede borrar: justo ahora se registró una fila que sacó material de este rollo. Recargá la página." });
    }
    throw err;
  }
  res.status(204).end();
});

const qualityCheckSchema = z.object({
  result: z.enum(["aprobado", "rechazado"]),
  observations: z.string().optional(),
});

/**
 * Aprueba o rechaza el lote de una OP final cerrada. Si se aprueba, recién
 * ahí se genera la entrada de inventario (con la suma de kg de los rollos
 * registrados) y la OP queda finalizada; si se rechaza, queda "detenida"
 * sin mover stock.
 */
productionOrdersRouter.post("/:id/quality-check", requireCalidad, async (req, res) => {
  const productionOrderId = Number(req.params.id);
  const parsed = qualityCheckSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const order = await prisma.productionOrder.findUnique({
    where: { id: productionOrderId },
    include: { qualityCheck: true, rolls: { select: { weightKg: true, details: true } } },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (order.status !== "pendiente_calidad") {
    return res.status(400).json({ error: "Esta OP no está pendiente de control de calidad" });
  }
  if (order.qualityCheck) {
    return res.status(400).json({ error: "Esta OP ya tiene un control de calidad registrado" });
  }

  const totalKg = order.rolls.reduce((acc, r) => acc + rollProducedKg(order.station as OpStation, r), 0);

  let check;
  try {
  check = await prisma.$transaction(async (tx) => {
    // El chequeo de "¿ya tiene control?" de arriba se hizo con una lectura
    // previa a la transacción — dos aprobaciones casi simultáneas (doble
    // click, o dos pestañas) podían pasarlo las dos y la segunda chocaba acá
    // contra el unique de production_order_id con un 500 crudo en vez de un
    // mensaje claro. El unique constraint sigue siendo la garantía real
    // (nunca se generan dos entradas de inventario/despacho para la misma
    // OP); esto solo traduce la colisión a una respuesta limpia.
    let created;
    try {
      created = await tx.qualityCheck.create({
        data: {
          productionOrderId,
          result: parsed.data.result,
          observations: parsed.data.observations,
          createdById: req.user!.userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new StatusRaceError();
      }
      throw err;
    }

    if (parsed.data.result === "aprobado") {
      if (totalKg > 0) {
        await applyMovement(tx, {
          productId: order.productId,
          quantity: totalKg,
          movementType: "entrada_produccion",
          // Apunta a la OP (no al control de calidad, que se borra si la OP
          // se reabre): así Movimientos/Trazabilidad pueden decir de qué OP
          // salió este stock. Antes quedaba como "ajuste manual".
          referenceType: "production_order",
          referenceId: order.id,
          createdById: req.user!.userId,
        });
        // Si la OP ya tiene un cliente asignado, el producto no es para
        // stock general -- además de entrar a inventario (arriba, sigue
        // igual), se prepara de una el Despacho para ese cliente, en
        // "pendiente" y con el producto/cantidad ya cargados, así Almacén
        // solo confirma la salida física en vez de armarlo desde cero.
        if (order.clientId) {
          await tx.dispatch.create({
            data: {
              clientId: order.clientId,
              productionOrderId: order.id,
              createdById: req.user!.userId,
              items: {
                create: [
                  {
                    productId: order.productId,
                    quantityRequested: totalKg,
                    notes: `Generado automáticamente al aprobar la OP #${order.orderNumber} en Calidad`,
                  },
                ],
              },
            },
          });
        }
      }
      await tx.productionOrder.update({ where: { id: productionOrderId }, data: { status: "finalizada" } });
    } else {
      await tx.productionOrder.update({ where: { id: productionOrderId }, data: { status: "detenida" } });
    }

    return created;
  });
  } catch (err) {
    if (err instanceof StatusRaceError) {
      return res.status(400).json({ error: "Esta OP ya tiene un control de calidad registrado" });
    }
    throw err;
  }

  if (parsed.data.result === "rechazado") {
    await notifyRoles(ROLES.PRODUCCION_GESTION, {
      type: "op_rechazada",
      message: `OP #${order.orderNumber} fue rechazada en calidad`,
      link: "/produccion/ordenes",
    });
  } else if (order.clientId && totalKg > 0) {
    await notifyRoles(ROLES.ALMACEN, {
      type: "despacho_generado_desde_op",
      message: `Se generó un despacho pendiente para ${order.orderNumber} (Calidad la aprobó con cliente asignado)`,
      link: "/despachos",
    });
  }

  res.status(201).json(check);
});

/**
 * Reporte consolidado de la OP en PDF con el layout del formato en papel del
 * cliente: encabezado, materia prima, specs, registro de rollos, totales,
 * operarios por turno y adjuntos.
 */
productionOrdersRouter.get("/:id/report.pdf", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Id inválido" });

  const order = await prisma.productionOrder.findUnique({
    where: { id },
    include: {
      product: true,
      client: { select: { name: true } },
      rolls: { orderBy: [{ date: "asc" }, { id: "asc" }] },
      attachments: { select: { originalName: true } },
      parent: {
        select: { orderNumber: true, station: true, rolls: { select: { weightKg: true } } },
      },
      derivedOrders: { select: { orderNumber: true }, orderBy: { id: "asc" } },
    },
  });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });
  if (order.station === null) {
    return res.status(400).json({ error: "Esta OP todavía no tiene proceso asignado — derivala a Extrusión antes de generar el reporte" });
  }

  const doc = buildOpPdf({
    orderNumber: order.orderNumber,
    station: order.station as OpStation,
    status: order.status,
    createdAt: order.createdAt,
    quantityPlanned: Number(order.quantityPlanned),
    measure: order.measure,
    notes: order.notes,
    specs: (order.specs ?? null) as Record<string, unknown> | null,
    clientName: order.client?.name ?? null,
    productName: order.product.name,
    productSku: order.product.sku,
    parentOrderNumber: order.parent?.orderNumber ?? null,
    parentStation: (order.parent?.station as OpStation) ?? null,
    parentKilosTotales: order.parent ? order.parent.rolls.reduce((acc, r) => acc + Number(r.weightKg), 0) : null,
    parentRollosCount: order.parent ? order.parent.rolls.length : null,
    derivedOrderNumbers: order.derivedOrders.map((d) => d.orderNumber),
    rolls: order.rolls,
    attachmentNames: order.attachments.map((a) => a.originalName),
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${order.orderNumber}.pdf"`);
  doc.pipe(res);
  doc.end();
});

// ---- Adjuntos (mismo patrón que los adjuntos de Pedidos) ----

productionOrdersRouter.get("/:id/attachments", async (req, res) => {
  const productionOrderId = Number(req.params.id);
  if (!Number.isInteger(productionOrderId)) return res.status(400).json({ error: "Id inválido" });
  // Mismo ocultamiento que GET /:id: un operario puro no debería poder
  // listar adjuntos de una OP en borrador que oficialmente no puede ver.
  if (OPERARIO_ONLY_ROLES.includes(req.user!.role)) {
    const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId }, select: { status: true } });
    if (order?.status === "borrador") return res.status(404).json({ error: "OP no encontrada" });
  }
  const attachments = await prisma.productionOrderAttachment.findMany({
    where: { productionOrderId },
    orderBy: { createdAt: "asc" },
  });
  res.json(attachments);
});

productionOrdersRouter.post("/:id/attachments", requireOperarios, upload.single("file"), async (req, res) => {
  const productionOrderId = Number(req.params.id);
  if (!Number.isInteger(productionOrderId)) return res.status(400).json({ error: "Id inválido" });
  if (!req.file) return res.status(400).json({ error: "Falta el archivo (campo \"file\")" });

  const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId } });
  if (!order) return res.status(404).json({ error: "OP no encontrada" });

  // A diferencia de POST /:id/rolls y /close, esto no aplicaba ningún
  // chequeo de estación ni de estado -- un operario de una estación podía
  // subir archivos a una OP de otra estación, incluso ya finalizada.
  // Gestión (allowedStations undefined) sigue sin esta restricción.
  const allowedStations = OPERARIO_STATIONS[req.user!.role];
  if (allowedStations) {
    if (!allowedStations.includes(order.station as OpStation)) {
      return res.status(403).json({ error: `Tu rol solo puede adjuntar archivos a OPs de: ${allowedStations.join(", ")}` });
    }
    if (!OPEN_STATUSES.includes(order.status)) {
      return res.status(400).json({ error: "Esta OP ya no está abierta" });
    }
  }

  const attachment = await prisma.productionOrderAttachment.create({
    data: {
      productionOrderId,
      storedName: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      uploadedById: req.user!.userId,
    },
  });

  res.status(201).json(attachment);
});

productionOrdersRouter.get("/:id/attachments/:attachmentId/download", async (req, res) => {
  const productionOrderId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(productionOrderId) || !Number.isInteger(attachmentId)) {
    return res.status(400).json({ error: "Id inválido" });
  }
  if (OPERARIO_ONLY_ROLES.includes(req.user!.role)) {
    const order = await prisma.productionOrder.findUnique({ where: { id: productionOrderId }, select: { status: true } });
    if (order?.status === "borrador") return res.status(404).json({ error: "OP no encontrada" });
  }

  const attachment = await prisma.productionOrderAttachment.findFirst({
    where: { id: attachmentId, productionOrderId },
  });
  if (!attachment) return res.status(404).json({ error: "Adjunto no encontrado" });

  res.download(path.join(UPLOADS_DIR, attachment.storedName), attachment.originalName);
});

/** Borra un adjunto subido por error — no existía ningún endpoint para esto. */
productionOrdersRouter.delete("/:id/attachments/:attachmentId", requireProduccionGestion, async (req, res) => {
  const productionOrderId = Number(req.params.id);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(productionOrderId) || !Number.isInteger(attachmentId)) {
    return res.status(400).json({ error: "Id inválido" });
  }
  const attachment = await prisma.productionOrderAttachment.findFirst({
    where: { id: attachmentId, productionOrderId },
  });
  if (!attachment) return res.status(404).json({ error: "Adjunto no encontrado" });

  await prisma.productionOrderAttachment.delete({ where: { id: attachmentId } });
  fs.unlink(path.join(UPLOADS_DIR, attachment.storedName), () => {});
  res.status(204).end();
});

/**
 * Reemite el token de posesión de un rollo ya creado: genera uno nuevo,
 * invalida el anterior (deja de matchear el hash guardado) y devuelve el QR
 * código+token listo para imprimir. Para cuando la etiqueta física original
 * nunca se imprimió, se dañó o se perdió -- es la única forma de conseguir
 * una etiqueta válida después de la creación, porque el token no se guarda
 * en texto plano en ningún lado. Restringido a Gestión/Calidad: reemitir a
 * la ligera invalida cualquier etiqueta física que ya esté pegada en
 * planta con el token viejo.
 */
productionOrdersRouter.post(
  "/:id/rolls/:rollId/reissue-label",
  requireRole(...ROLES.PRODUCCION_GESTION, ...ROLES.CALIDAD),
  async (req, res) => {
    const productionOrderId = Number(req.params.id);
    const rollId = Number(req.params.rollId);
    if (!Number.isInteger(productionOrderId) || !Number.isInteger(rollId)) {
      return res.status(400).json({ error: "Id inválido" });
    }

    const roll = await prisma.productionRoll.findFirst({
      where: { id: rollId, productionOrderId },
      include: { productionOrder: { select: { orderNumber: true, station: true, product: { select: { name: true } } } } },
    });
    if (!roll) return res.status(404).json({ error: "Rollo no encontrado" });

    const code = sourceRollCode(roll);
    const possessionToken = generatePossessionToken();
    await prisma.productionRoll.update({
      where: { id: rollId },
      data: { possessionTokenHash: hashPossessionToken(code, possessionToken) },
    });

    const qrDataUrl = await QRCode.toDataURL(`${code}-${possessionToken}`);
    res.json({
      code,
      possessionToken,
      label: roll.label,
      weightKg: roll.weightKg,
      orderNumber: roll.productionOrder.orderNumber,
      productName: roll.productionOrder.product.name,
      qrDataUrl,
    });
  }
);
