import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "../../server/src/routes/auth";
import { clientsRouter } from "../../server/src/routes/clients";
import { inventoryRouter } from "../../server/src/routes/inventory";
import { rawMaterialsRouter } from "../../server/src/routes/rawMaterials";
import { productionRouter } from "../../server/src/routes/production";
import { productionOrdersRouter } from "../../server/src/routes/productionOrders";
import { bultoLabelsRouter } from "../../server/src/routes/bultoLabels";
import { rollTransfersRouter } from "../../server/src/routes/rollTransfers";
import { dispatchesRouter } from "../../server/src/routes/dispatches";
import { cotizacionesRouter } from "../../server/src/routes/cotizaciones";
import { pedidosRouter } from "../../server/src/routes/pedidos";
import { facturasRouter } from "../../server/src/routes/facturas";
import { auditLogRouter } from "../../server/src/routes/auditLog";
import { productsRouter } from "../../server/src/routes/products";
import { usersRouter } from "../../server/src/routes/users";
import { warehouseRouter } from "../../server/src/routes/warehouse";
import { publicLocationRouter } from "../../server/src/routes/publicLocation";
import { dashboardRouter } from "../../server/src/routes/dashboard";
import { exportRouter } from "../../server/src/routes/export";
import { notificationsRouter } from "../../server/src/routes/notifications";
import { whatsappWebhookRouter } from "../../server/src/routes/whatsappWebhook";
import { prisma } from "../../server/src/prisma";
import { redistributeScores, boostValue, isHot, nextCycle, nextVisitState, HOT_THRESHOLD } from "../../server/src/services/frequency";
import { generatePossessionToken, hashPossessionToken } from "../../server/src/services/rollPossessionToken";
import { ROLL_CODE_PREFIX, inheritSpecs } from "../../server/src/services/opTemplates";
import { applyMovement, InsufficientStockError } from "../../server/src/services/stockService";
import { applyRawMaterialMovement } from "../../server/src/services/rawMaterialStockService";

let server: Server;
let baseUrl = "";
let token = "";

// Un token por rol de la matriz, para probar tanto el "camino feliz" como
// los 403 de `requireRole` sin depender siempre de super_admin (que pasa
// todos los checks y por lo tanto no prueba nada sobre el guard en sí).
const tokens: Record<string, string> = {};

const authHeaders = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const headersFor = (role: string) => ({ Authorization: `Bearer ${tokens[role]}`, "Content-Type": "application/json" });

async function loginAs(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (res.status !== 200) {
    throw new Error(`login falló para ${email} (status ${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

/** Deja un rollo "recibido en la bodega de `station`" (despacho + recepción,
 * directo por Prisma) — un rollo solo se puede consumir en la estación donde
 * está físicamente (ver server/src/services/rollLocation.ts), así que los
 * tests que consumen un rollo madre en otra estación lo mueven primero. */
async function placeRollAt(rollId: number, station: "impresion" | "sellado" | "precorte") {
  const roll = await prisma.productionRoll.findUniqueOrThrow({ where: { id: rollId }, select: { station: true } });
  const user = await prisma.user.findUniqueOrThrow({ where: { email: "produccion@empresa.com" }, select: { id: true } });
  await prisma.rollTransfer.create({
    data: {
      rollId,
      fromStation: roll.station,
      toStation: station,
      mode: "retiro",
      carrierName: "Test",
      registeredById: user.id,
      clientTimezone: "America/Bogota",
      clientUtcOffsetMinutes: -300,
      status: "recibido",
      receivedById: user.id,
      receivedAt: new Date(),
    },
  });
}

/** Crea un rollo directo por Prisma (sin pasar por el endpoint), completando
 * `station`/`stationSequence` a mano -- son NOT NULL en el schema (numeración
 * propia por estación, ver migración roll_per_station_numbering) y el
 * endpoint real los calcula solo, pero un insert directo no. */
async function createTestRoll(
  productionOrderId: number,
  data: {
    operatorName?: string;
    weightKg: number;
    wasteKg?: number;
    label?: string;
    shift?: string;
    details?: any;
    sourceRollId?: number;
  }
) {
  const order = await prisma.productionOrder.findUniqueOrThrow({ where: { id: productionOrderId }, select: { station: true } });
  const max = await prisma.productionRoll.aggregate({ where: { station: order.station! }, _max: { stationSequence: true } });
  const stationSequence = (max._max.stationSequence ?? 0) + 1;
  // possessionTokenHash es NOT NULL (ver services/rollPossessionToken.ts) —
  // un insert directo de test también necesita el suyo, igual que el
  // endpoint real y el seed.
  const code = `${ROLL_CODE_PREFIX[order.station!]}-${stationSequence}`;
  const possessionToken = generatePossessionToken();
  const created = await prisma.productionRoll.create({
    data: {
      productionOrderId,
      station: order.station!,
      stationSequence,
      operatorName: data.operatorName ?? "Op",
      weightKg: data.weightKg,
      wasteKg: data.wasteKg,
      label: data.label,
      shift: data.shift,
      details: data.details,
      sourceRollId: data.sourceRollId,
      possessionTokenHash: hashPossessionToken(code, possessionToken),
    },
  });
  // El token visible nunca queda en la base (ver rollPossessionToken.ts) —
  // se devuelve acá para que los tests que consumen este rollo como insumo
  // puedan mandarlo en `sourceRollTokens`, igual que haría un escaneo real.
  return Object.assign(created, { possessionToken });
}

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/api/auth", authRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/inventory", inventoryRouter);
  app.use("/api/raw-materials", rawMaterialsRouter);
  app.use("/api/production", productionRouter);
  app.use("/api/production-orders", productionOrdersRouter);
  app.use("/api/bulto-labels", bultoLabelsRouter);
  app.use("/api/roll-transfers", rollTransfersRouter);
  app.use("/api/dispatches", dispatchesRouter);
  app.use("/api/cotizaciones", cotizacionesRouter);
  app.use("/api/pedidos", pedidosRouter);
  app.use("/api/facturas", facturasRouter);
  app.use("/api/audit-log", auditLogRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/warehouse", warehouseRouter);
  app.use("/api/public/locations", publicLocationRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/export", exportRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/webhook/whatsapp", whatsappWebhookRouter);
  return app;
}

before(async () => {
  const app = buildApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;

  token = await loginAs("admin@empresa.com");
  tokens.super_admin = token;
  tokens.ventas = await loginAs("ventas@empresa.com");
  tokens.almacen = await loginAs("despacho@empresa.com");
  tokens.produccion = await loginAs("produccion@empresa.com");
  tokens.planeacion = await loginAs("planeacion@empresa.com");
  tokens.calidad = await loginAs("calidad@empresa.com");
  tokens.auditor = await loginAs("auditor@empresa.com");
  tokens.operario_extrusion = await loginAs("operario.extrusion@empresa.com");
  tokens.operario_impresion = await loginAs("operario.impresion@empresa.com");
  tokens.operario_sellado = await loginAs("operario.sellado@empresa.com");
  tokens.operario_precorte = await loginAs("operario.precorte@empresa.com");

  // Despachar/consumir ya no deja el stock en negativo (ver auditoría de
  // inventario) -- si esta base de dev compartida quedó con algún saldo
  // negativo de corridas anteriores (de antes de que ese chequeo
  // existiera), cualquier test que reste sobre ese producto fallaría con
  // "stock insuficiente" aunque su propia lógica esté bien. Se normaliza
  // acá, una sola vez, a un piso seguro -- cada test ya captura su propio
  // "antes"/"después" y restaura exacto, así que esto no afecta esa
  // contabilidad relativa, solo evita arrancar en negativo.
  const demoProducts = await prisma.product.findMany({ where: { sku: { in: ["BUL-001", "ROL-F-002", "ROL-PL-001"] } }, select: { id: true } });
  for (const p of demoProducts) {
    const stock = await prisma.inventoryStock.findUnique({ where: { productId: p.id } });
    if (Number(stock?.currentQuantity ?? 0) < 1000) {
      await prisma.inventoryStock.upsert({
        where: { productId: p.id },
        create: { productId: p.id, currentQuantity: 1000 },
        update: { currentQuantity: 1000 },
      });
    }
  }
});

after(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("health", () => {
  it("responde ok sin autenticación", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });
});

describe("auth", () => {
  it("login válido devuelve token y rol super_admin", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@empresa.com", password: "password123" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { token: string; user: { role: string } };
    assert.ok(body.token);
    assert.equal(body.user.role, "super_admin");
  });

  it("password incorrecto devuelve 401", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@empresa.com", password: "incorrecta" }),
    });
    assert.equal(res.status, 401);
  });

  it("body inválido devuelve 400", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "no-es-email", password: "123" }),
    });
    assert.equal(res.status, 400);
  });

  it("usuario desactivado no puede loguearse", async () => {
    const user = await prisma.user.create({
      data: { name: "TEST-Inactive", email: `test-inactive-${Date.now()}@x.com`, passwordHash: "x", role: "calidad", active: false },
    });
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "password123" }),
    });
    assert.equal(res.status, 401);
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe("protección de rutas", () => {
  it("devuelve 401 sin token", async () => {
    const res = await fetch(`${baseUrl}/api/clients`);
    assert.equal(res.status, 401);
  });

  it("devuelve 401 con token inválido", async () => {
    const res = await fetch(`${baseUrl}/api/clients`, {
      headers: { Authorization: "Bearer token-invalido" },
    });
    assert.equal(res.status, 401);
  });
});

describe("clientes", () => {
  it("lista clientes activos con seed", async () => {
    const res = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const clients = (await res.json()) as { name: string }[];
    assert.ok(clients.some((c) => c.name === "Cliente ACME"));
  });

  it("crea un cliente", async () => {
    const res = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-Client", contactInfo: {} }),
    });
    assert.equal(res.status, 201);
    const client = (await res.json()) as { id: number };
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("GET / también es legible por Gestión de Producción (elige el destino de una OP), no solo Ventas/Almacén", async () => {
    const res = await fetch(`${baseUrl}/api/clients`, { headers: headersFor("produccion") });
    assert.equal(res.status, 200);
    const clients = (await res.json()) as { name: string }[];
    assert.ok(Array.isArray(clients));

    // El resto del CRM (mutaciones) sigue siendo exclusivo de Ventas.
    const create = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ name: "TEST-CLIENT-NO-GESTION" }),
    });
    assert.equal(create.status, 403);

    const denied = await fetch(`${baseUrl}/api/clients`, { headers: headersFor("operario_extrusion") });
    assert.equal(denied.status, 403, "un operario puro sigue sin poder ver clientes");
  });
});

describe("inventario", () => {
  it("lista productos del catálogo", async () => {
    const res = await fetch(`${baseUrl}/api/inventory/products`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const products = (await res.json()) as { sku: string }[];
    assert.ok(products.some((p) => p.sku === "BUL-001"));
  });

  it("devuelve stock por categoría", async () => {
    const res = await fetch(`${baseUrl}/api/inventory`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const stock = (await res.json()) as unknown[];
    assert.ok(Array.isArray(stock));
  });

  it("devuelve alertas de stock bajo mínimo", async () => {
    const res = await fetch(`${baseUrl}/api/inventory/alerts`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const alerts = (await res.json()) as unknown[];
    assert.ok(Array.isArray(alerts));
  });

  it("un producto desactivado con stock bajo desaparece de las alertas (antes se quedaba para siempre)", async () => {
    const created = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: `TEST-ALERTA-DESACTIVADO-${Date.now()}`, category: "tiras", unit: "kg", minStock: 100, unitPrice: 1000 }),
    });
    const product = (await created.json()) as { id: number; sku: string };

    const before = await fetch(`${baseUrl}/api/inventory/alerts`, { headers: authHeaders() });
    const alertsBefore = (await before.json()) as { sku: string }[];
    assert.ok(alertsBefore.some((a) => a.sku === product.sku), "recién creado, sin stock, con mínimo 100 -- debe salir en alertas");

    const deactivated = await fetch(`${baseUrl}/api/products/${product.id}`, { method: "DELETE", headers: headersFor("planeacion") });
    assert.equal(deactivated.status, 200);

    const after = await fetch(`${baseUrl}/api/inventory/alerts`, { headers: authHeaders() });
    const alertsAfter = (await after.json()) as { sku: string }[];
    assert.ok(!alertsAfter.some((a) => a.sku === product.sku), "desactivado, ya no debe salir en alertas aunque siga bajo mínimo");

    // El catálogo completo (Existencias) sí lo sigue mostrando -- desactivar
    // no lo borra, y ver el stock de un descontinuado sigue teniendo sentido.
    const stock = await fetch(`${baseUrl}/api/inventory`, { headers: authHeaders() });
    const stockList = (await stock.json()) as { sku: string }[];
    assert.ok(stockList.some((s) => s.sku === product.sku), "Existencias sigue mostrando el catálogo completo, incluidos los desactivados");

    await prisma.product.delete({ where: { id: product.id } });
  });

  it("un operario de planta no puede ver Existencias/alertas/catálogo (solo su rol de estación)", async () => {
    const routes = ["/api/inventory", "/api/inventory/alerts", "/api/inventory/products"];
    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`, { headers: headersFor("operario_extrusion") });
      assert.equal(res.status, 403, `${route} debería rechazar a un operario`);
    }
  });

  it("gerente de producción no ve Existencias/alertas (a pedido del cliente), pero sí puede elegir productos del catálogo", async () => {
    const denied = ["/api/inventory", "/api/inventory/alerts"];
    for (const route of denied) {
      const res = await fetch(`${baseUrl}${route}`, { headers: headersFor("produccion") });
      assert.equal(res.status, 403, `${route} debería rechazar a gerente_produccion`);
    }
    const products = await fetch(`${baseUrl}/api/inventory/products`, { headers: headersFor("produccion") });
    assert.equal(products.status, 200, "gerente_produccion sigue necesitando el catálogo para armar OPs");
  });

  it("GET /movements exige rol de almacén y devuelve paginado", async () => {
    const denied = await fetch(`${baseUrl}/api/inventory/movements`, { headers: headersFor("ventas") });
    assert.equal(denied.status, 403);

    const res = await fetch(`${baseUrl}/api/inventory/movements?pageSize=5`, { headers: headersFor("almacen") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; pageSize: number };
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length <= 5);
    assert.equal(body.page, 1);
    assert.equal(body.pageSize, 5);
  });
});

describe("materia prima", () => {
  let productId = 0;
  let materialId = 0;
  const code = `TEST-RM-${Date.now()}`;

  before(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    productId = product.id;
  });

  after(async () => {
    if (materialId) {
      await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: materialId } });
      await prisma.rawMaterialStock.deleteMany({ where: { rawMaterialId: materialId } });
      await prisma.rawMaterial.delete({ where: { id: materialId } }).catch(() => {});
    }
  });

  it("un operario no puede ver el catálogo/stock/alertas", async () => {
    const routes = ["/api/raw-materials", "/api/raw-materials/stock", "/api/raw-materials/alerts"];
    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`, { headers: headersFor("operario_extrusion") });
      assert.equal(res.status, 403, `${route} debería rechazar a un operario`);
    }
  });

  it("Gerente de Producción tampoco puede ver ni gestionar materia prima (a pedido del cliente)", async () => {
    const routes = ["/api/raw-materials", "/api/raw-materials/stock", "/api/raw-materials/alerts"];
    for (const route of routes) {
      const res = await fetch(`${baseUrl}${route}`, { headers: headersFor("produccion") });
      assert.equal(res.status, 403, `${route} debería rechazar a gerente_produccion`);
    }
  });

  it("crea una materia prima, rechaza código duplicado y ventas no puede crear", async () => {
    const denied = await fetch(`${baseUrl}/api/raw-materials`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ code }),
    });
    assert.equal(denied.status, 403);

    const res = await fetch(`${baseUrl}/api/raw-materials`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ code, name: "Test", minStock: 10 }),
    });
    assert.equal(res.status, 201);
    const material = (await res.json()) as { id: number; code: string };
    materialId = material.id;

    const dup = await fetch(`${baseUrl}/api/raw-materials`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ code }),
    });
    assert.equal(dup.status, 409);
  });

  it("crear con código en minúsculas se normaliza a mayúsculas (matchea contra specs.materiaPrima al cerrar una OP)", async () => {
    const lower = `${code}-lower`;
    const res = await fetch(`${baseUrl}/api/raw-materials`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ code: lower.toLowerCase() }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: number; code: string };
    assert.equal(created.code, lower.toUpperCase());
    await prisma.rawMaterial.delete({ where: { id: created.id } });
  });

  it("ajusta stock (compra) con nota, lo lista en /stock y la nota queda en el historial de movimientos", async () => {
    const res = await fetch(`${baseUrl}/api/raw-materials/${materialId}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: 50, type: "compra", notes: "Compra a proveedor de prueba" }),
    });
    assert.equal(res.status, 201);

    const stock = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
      belowMinimum: boolean;
    }[];
    const mine = stock.find((s) => s.id === materialId);
    assert.equal(mine?.currentStock, 50);
    assert.equal(mine?.belowMinimum, false);

    const movements = (await (
      await fetch(`${baseUrl}/api/raw-materials/movements?rawMaterialId=${materialId}`, { headers: headersFor("planeacion") })
    ).json()) as { items: { movementType: string; quantity: string; notes: string | null }[] };
    assert.equal(movements.items.length, 1);
    assert.equal(movements.items[0].notes, "Compra a proveedor de prueba");
    assert.equal(movements.items[0].movementType, "compra");
  });

  it("el tipo de movimiento del ajuste es explícito (type), no se deduce del signo — un ajuste correctivo POSITIVO no se registra como compra", async () => {
    // Sin `type`, el body es inválido.
    const missingType = await fetch(`${baseUrl}/api/raw-materials/${materialId}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: 10 }),
    });
    assert.equal(missingType.status, 400);

    // Una "compra" negativa no tiene sentido -- se rechaza.
    const negativeCompra = await fetch(`${baseUrl}/api/raw-materials/${materialId}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: -10, type: "compra" }),
    });
    assert.equal(negativeCompra.status, 400);

    // Un ajuste correctivo POSITIVO (ej. "el conteo físico dio de más") sí
    // se acepta con type: "ajuste", y queda registrado como ajuste, no
    // como una compra a proveedor que nunca existió.
    const positiveAdjust = await fetch(`${baseUrl}/api/raw-materials/${materialId}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: 7, type: "ajuste", notes: "Conteo físico dio 7kg más" }),
    });
    assert.equal(positiveAdjust.status, 201);

    const movements = (await (
      await fetch(`${baseUrl}/api/raw-materials/movements?rawMaterialId=${materialId}`, { headers: headersFor("planeacion") })
    ).json()) as { items: { movementType: string; quantity: string; notes: string | null }[] };
    const found = movements.items.find((m) => m.notes === "Conteo físico dio 7kg más");
    assert.ok(found, "debió registrarse el ajuste positivo");
    assert.equal(found!.movementType, "ajuste", "un ajuste correctivo positivo se registra como ajuste, no como compra");

    await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: materialId, notes: "Conteo físico dio 7kg más" } });
    await prisma.rawMaterialStock.update({ where: { rawMaterialId: materialId }, data: { currentQuantity: { decrement: 7 } } });
  });

  it("cerrar una OP de Extrusión descuenta el kg cargado por cada insumo y avisa (sin bloquear) las refs que no matchean", async () => {
    const order = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 10,
        // Se descuenta el % sobre lo producido real (10 kg de rollos): 80% → 8 kg.
        specs: { materiaPrima: [{ ref: code, pct: 80 }, { ref: "NO-EXISTE-REF", pct: 20 }] },
      },
    });
    await createTestRoll(order.id, { weightKg: 10 });

    // Cerrar es del operario de esa estación, no de Gestión (ver ROLES.CIERRE_OP).
    const denied = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(denied.status, 403);

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; skippedRawMaterialRefs: string[] };
    assert.equal(body.status, "finalizada");
    assert.deepEqual(body.skippedRawMaterialRefs, ["NO-EXISTE-REF"]);

    const stock = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
    }[];
    const mine = stock.find((s) => s.id === materialId);
    assert.equal(mine?.currentStock, 42, "50 - 8 = 42");

    // Reabrir la OP debe devolver exactamente el kg descontado (lee el
    // movimiento real logueado, no vuelve a leer specs.materiaPrima).
    const reopen = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(reopen.status, 200);
    const reopenBody = (await reopen.json()) as { status: string; reversedRawMaterials: { code: string; kg: number }[] };
    assert.equal(reopenBody.status, "en_proceso");
    assert.deepEqual(reopenBody.reversedRawMaterials, [{ code, kg: 8 }]);

    const stockReabierta = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
    }[];
    assert.equal(stockReabierta.find((s) => s.id === materialId)?.currentStock, 50, "42 + 8 = 50, vuelve a como estaba");

    // Segundo ciclo cerrar→reabrir sobre la MISMA OP (specs corregidas a un
    // kg distinto): el historial de raw_material_movements para este
    // referenceId ya trae la consumición original Y su reversión — hay que
    // devolver solo el neto pendiente de este segundo cierre, no volver a
    // sumar la reversión de la primera vuelta encima.
    await prisma.productionOrder.update({ where: { id: order.id }, data: { specs: { materiaPrima: [{ ref: code, pct: 60 }, { ref: "NO-EXISTE-REF", pct: 40 }] } } });

    const close2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(close2.status, 200);

    const stockTrasCierre2 = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
    }[];
    assert.equal(stockTrasCierre2.find((s) => s.id === materialId)?.currentStock, 44, "50 - 6 = 44");

    const reopen2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(reopen2.status, 200);
    const reopen2Body = (await reopen2.json()) as { reversedRawMaterials: { code: string; kg: number }[] };
    assert.deepEqual(reopen2Body.reversedRawMaterials, [{ code, kg: 6 }], "solo revierte el neto pendiente (6), no el 8 de la vuelta anterior");

    const stockFinal = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
    }[];
    assert.equal(stockFinal.find((s) => s.id === materialId)?.currentStock, 50, "44 + 6 = 50, vuelve a como estaba (no 56)");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("/adjust rechaza un ajuste negativo que dejaría el insumo en negativo (nunca se descuenta a ciegas)", async () => {
    const stockAntes = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as {
      id: number;
      currentStock: number;
    }[];
    const antes = stockAntes.find((s) => s.id === materialId)!.currentStock;

    const bad = await fetch(`${baseUrl}/api/raw-materials/${materialId}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: -(antes + 1000), type: "ajuste" }),
    });
    assert.equal(bad.status, 400, "no hay 1000kg de más que ese insumo no tiene");
    const badBody = (await bad.json()) as { error: string };
    assert.match(badBody.error, /insuficiente/i);

    const stockDespues = (await (await fetch(`${baseUrl}/api/raw-materials/stock`, { headers: headersFor("planeacion") })).json()) as typeof stockAntes;
    assert.equal(stockDespues.find((s) => s.id === materialId)!.currentStock, antes, "el intento rechazado no debe haber tocado el stock");
  });

  it("desactiva y reactiva; desactivada no aparece afectada en /stock (sigue existiendo, solo cambia active)", async () => {
    const off = await fetch(`${baseUrl}/api/raw-materials/${materialId}`, { method: "DELETE", headers: headersFor("planeacion") });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as { active: boolean };
    assert.equal(offBody.active, false);

    const on = await fetch(`${baseUrl}/api/raw-materials/${materialId}/reactivate`, { method: "POST", headers: headersFor("planeacion") });
    assert.equal(on.status, 200);
    const onBody = (await on.json()) as { active: boolean };
    assert.equal(onBody.active, true);
  });
});

describe("despachos", () => {
  it("lista despachos", async () => {
    const res = await fetch(`${baseUrl}/api/dispatches`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const dispatches = (await res.json()) as unknown[];
    assert.ok(Array.isArray(dispatches));
  });

  it("crea un despacho con items (prisma nested create) y lo limpia", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirst({ where: { sku: "BUL-001" } });
    assert.ok(product, "Falta el producto BUL-001 en el catálogo");

    const res = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        clientId: clients[0].id,
        items: [{ productId: product!.id, quantityRequested: 5 }],
      }),
    });
    assert.equal(res.status, 201);
    const dispatch = (await res.json()) as { id: number; items: unknown[] };
    assert.equal(dispatch.items.length, 1);

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });

  it("no se puede despachar más de lo pedido (quantityDispatched > quantityRequested)", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });

    const res = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: 5 }] }),
    });
    const dispatch = (await res.json()) as { id: number; items: { id: number }[] };

    const overshoot = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ quantityDispatched: 10 }),
    });
    assert.equal(overshoot.status, 400);

    const stillPending = await prisma.dispatchItem.findUnique({ where: { id: dispatch.items[0].id } });
    assert.equal(stillPending!.quantityDispatched, null, "el intento rechazado no debe haber descontado nada");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });

  it("POST / valida que el cliente y los productos existan, y que el producto esté activo", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });

    const badClient = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ clientId: 999999999, items: [{ productId: product.id, quantityRequested: 5 }] }),
    });
    assert.equal(badClient.status, 404);

    const badProduct = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: 999999999, quantityRequested: 5 }] }),
    });
    assert.equal(badProduct.status, 404);

    const inactiveProduct = await prisma.product.create({
      data: { sku: `TEST-INACTIVO-${Date.now()}`, name: "Producto de prueba inactivo", category: "tiras", unit: "kg", minStock: 0, active: false },
    });
    const withInactive = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: inactiveProduct.id, quantityRequested: 5 }] }),
    });
    assert.equal(withInactive.status, 400, "un producto desactivado no se puede despachar");

    await prisma.product.delete({ where: { id: inactiveProduct.id } });
  });

  it("devuelve 403 para un rol sin acceso a Despachos, y 200 de solo lectura para Ventas", async () => {
    const res = await fetch(`${baseUrl}/api/dispatches`, { headers: headersFor("produccion") });
    assert.equal(res.status, 403);

    // Ventas puede consultar despachos (para responderle a un cliente sin
    // llamar a Almacén) pero solo lectura -- las mutaciones siguen dando 403.
    const ventasRead = await fetch(`${baseUrl}/api/dispatches`, { headers: headersFor("ventas") });
    assert.equal(ventasRead.status, 200);
    const createForbidden = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId: 1, items: [{ productId: 1, quantityRequested: 1 }] }),
    });
    assert.equal(createForbidden.status, 403);
  });

  it("GET /summary-by-client agrupa lo YA despachado (no lo pendiente) por cliente+producto", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number; name: string }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const client = clients[0];

    const forbidden = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: headersFor("produccion") });
    assert.equal(forbidden.status, 403);

    // Despachar ya no deja el stock en negativo (ver auditoría de
    // inventario) -- si el saldo compartido de dev no alcanza, se sube
    // temporalmente y se restaura exacto al final.
    const stockBefore = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    if (Number(stockBefore?.currentQuantity ?? 0) < 5) {
      await prisma.inventoryStock.upsert({
        where: { productId: product.id },
        create: { productId: product.id, currentQuantity: 5 },
        update: { currentQuantity: 5 },
      });
    }

    const before = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: authHeaders() });
    const rowsBefore = (await before.json()) as { clientId: number; productId: number; totalQuantity: number; dispatchCount: number }[];
    const beforeRow = rowsBefore.find((r) => r.clientId === client.id && r.productId === product.id);

    const dispatch = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ clientId: client.id, items: [{ productId: product.id, quantityRequested: 5 }] }),
    });
    const dispatchBody = (await dispatch.json()) as { id: number; items: { id: number }[] };

    // Pendiente todavía: no debe sumar al resumen (solo cuenta lo YA despachado).
    const stillPending = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: authHeaders() });
    const rowsPending = (await stillPending.json()) as typeof rowsBefore;
    const pendingRow = rowsPending.find((r) => r.clientId === client.id && r.productId === product.id);
    assert.equal(pendingRow?.totalQuantity ?? 0, beforeRow?.totalQuantity ?? 0, "un despacho pendiente (sin completar) no debe sumar al resumen");

    // Se completa el item — ahora sí debe sumar.
    await fetch(`${baseUrl}/api/dispatches/${dispatchBody.id}/items/${dispatchBody.items[0].id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ quantityDispatched: 5 }),
    });

    const after = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: authHeaders() });
    const rowsAfter = (await after.json()) as typeof rowsBefore;
    const afterRow = rowsAfter.find((r) => r.clientId === client.id && r.productId === product.id);
    assert.ok(afterRow, "debe aparecer una fila para este cliente+producto");
    assert.equal(afterRow!.totalQuantity - (beforeRow?.totalQuantity ?? 0), 5, "suma exactamente lo despachado de más");
    assert.equal(afterRow!.dispatchCount - (beforeRow?.dispatchCount ?? 0), 1);

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatchBody.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: dispatchBody.items[0].id } });
    await prisma.dispatch.delete({ where: { id: dispatchBody.id } });
    // Restaura el stock exacto a como estaba antes del test (haya hecho
    // falta subirlo temporalmente o no).
    await prisma.inventoryStock.update({
      where: { productId: product.id },
      data: { currentQuantity: Number(stockBefore?.currentQuantity ?? 0) },
    });
  });

  it("marcar despachado dos veces el mismo ítem (doble clic / reintento) solo descuenta stock una vez", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: 50 }] }),
    });
    const dispatch = (await created.json()) as { id: number; items: { id: number }[] };

    const first = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 50 }),
    });
    assert.equal(first.status, 200);

    const retry = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 50 }),
    });
    assert.equal(retry.status, 400, "un ítem ya despachado se rechaza en el reintento");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(
      Number(stockAntes?.currentQuantity ?? 0) - Number(stockDespues?.currentQuantity ?? 0),
      50,
      "el stock solo debe bajar 50 una vez, no 100"
    );

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: dispatch.items[0].id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
    await prisma.inventoryStock.update({ where: { productId: product.id }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("no se puede despachar más de lo que hay en stock — se rechaza sin tocar el stock", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    const disponible = Number(stockAntes?.currentQuantity ?? 0);

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: disponible + 500 }] }),
    });
    const dispatch = (await created.json()) as { id: number; items: { id: number }[] };

    const res = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: disponible + 500 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /insuficiente/i);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockDespues?.currentQuantity ?? 0), disponible, "el intento rechazado no debe haber tocado el stock");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });

  it("al marcar despachado con locationId, descuenta la ubicación además del total — y rechaza si esa ubicación no tiene suficiente", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const location = await prisma.warehouseLocation.create({ data: { code: `TEST-LOC-${Date.now()}`, label: "Estante de prueba", publicToken: `tok-${Date.now()}` } });
    await prisma.stockLocation.create({ data: { productId: product.id, locationId: location.id, quantity: 20 } });

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: 15 }] }),
    });
    const dispatch = (await created.json()) as { id: number; items: { id: number }[] };

    // La ubicación solo tiene 20 -- pedir 25 desde ahí se rechaza.
    const tooMuch = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 25, locationId: location.id }),
    });
    assert.equal(tooMuch.status, 400, "esa ubicación no tiene 25, aunque el total agregado del producto sí alcance");

    const ok = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 15, locationId: location.id }),
    });
    assert.equal(ok.status, 200);

    const locationStock = await prisma.stockLocation.findUnique({ where: { productId_locationId: { productId: product.id, locationId: location.id } } });
    assert.equal(Number(locationStock?.quantity), 5, "20 - 15 = 5 en esa ubicación puntual");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: dispatch.items[0].id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
    await prisma.stockLocation.deleteMany({ where: { productId: product.id, locationId: location.id } });
    await prisma.warehouseLocation.delete({ where: { id: location.id } });
    await prisma.inventoryStock.update({ where: { productId: product.id }, data: { currentQuantity: { increment: 15 } } });
  });

  it("POST /:id/cancel en un despacho pendiente (nada despachado aún) solo cambia el estado, no toca stock", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: 10 }] }),
    });
    const dispatch = (await created.json()) as { id: number };

    const cancel = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/cancel`, { method: "POST", headers: headersFor("almacen") });
    assert.equal(cancel.status, 200);

    const updated = await prisma.dispatch.findUnique({ where: { id: dispatch.id } });
    assert.equal(updated?.status, "cancelada");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockDespues?.currentQuantity ?? 0), Number(stockAntes?.currentQuantity ?? 0), "nada se había despachado, no hay nada que revertir");

    // Cancelar de nuevo se rechaza.
    const again = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/cancel`, { method: "POST", headers: headersFor("almacen") });
    assert.equal(again.status, 400);

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });

  it("POST /:id/cancel en un despacho ya completado revierte el stock descontado", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: clients[0].id, items: [{ productId: product.id, quantityRequested: 30 }] }),
    });
    const dispatch = (await created.json()) as { id: number; items: { id: number }[] };

    const complete = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 30 }),
    });
    assert.equal(complete.status, 200);

    const stockDespachado = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockAntes?.currentQuantity ?? 0) - Number(stockDespachado?.currentQuantity ?? 0), 30);

    const cancel = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/cancel`, { method: "POST", headers: headersFor("almacen") });
    assert.equal(cancel.status, 200);
    const cancelBody = (await cancel.json()) as { reversedTotal: number };
    assert.equal(cancelBody.reversedTotal, 30);

    const stockFinal = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockFinal?.currentQuantity ?? 0), Number(stockAntes?.currentQuantity ?? 0), "el stock vuelve exacto a como estaba antes de despachar");

    const updated = await prisma.dispatch.findUnique({ where: { id: dispatch.id } });
    assert.equal(updated?.status, "cancelada");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: dispatch.items[0].id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });

  it("un despacho generado por una OP y cancelado ya no bloquea la reapertura de esa OP", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-CANCEL-REOPEN-${Date.now()}` } });
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId: product.id, clientId: client.id, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 6 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const approve = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(approve.status, 201);

    const dispatch = await prisma.dispatch.findFirst({ where: { productionOrderId: order.id } });
    assert.ok(dispatch, "debió crearse el despacho automático");

    const blocked = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, { method: "POST", headers: headersFor("produccion") });
    assert.equal(blocked.status, 400, "mientras el despacho siga vivo, no se puede reabrir");

    const cancel = await fetch(`${baseUrl}/api/dispatches/${dispatch!.id}/cancel`, { method: "POST", headers: headersFor("almacen") });
    assert.equal(cancel.status, 200);

    const reopen = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, { method: "POST", headers: headersFor("produccion") });
    assert.equal(reopen.status, 200, "un despacho cancelado ya no cuenta como 'vivo' para el bloqueo de reapertura");

    await prisma.notification.deleteMany({ where: { type: "despacho_generado_desde_op", message: { contains: order.orderNumber } } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch!.id } });
    await prisma.dispatch.delete({ where: { id: dispatch!.id } });
    await prisma.inventoryMovement.deleteMany({ where: { productId: product.id, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.inventoryStock.update({ where: { productId: product.id }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("GET /summary-by-client no cuenta un despacho cancelado (su stock ya se revirtió)", async () => {
    const clientsRes = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await clientsRes.json()) as { id: number; name: string }[];
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const client = clients[0];

    const before = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: authHeaders() });
    const rowsBefore = (await before.json()) as { clientId: number; productId: number; totalQuantity: number }[];
    const beforeTotal = rowsBefore.find((r) => r.clientId === client.id && r.productId === product.id)?.totalQuantity ?? 0;

    const created = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: client.id, items: [{ productId: product.id, quantityRequested: 7 }] }),
    });
    const dispatch = (await created.json()) as { id: number; items: { id: number }[] };

    await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 7 }),
    });

    const cancel = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/cancel`, { method: "POST", headers: headersFor("almacen") });
    assert.equal(cancel.status, 200);

    const after = await fetch(`${baseUrl}/api/dispatches/summary-by-client`, { headers: authHeaders() });
    const rowsAfter = (await after.json()) as typeof rowsBefore;
    const afterTotal = rowsAfter.find((r) => r.clientId === client.id && r.productId === product.id)?.totalQuantity ?? 0;
    assert.equal(afterTotal, beforeTotal, "un despacho cancelado no debe sumar al histórico, aunque llegó a marcarse despachado");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: dispatch.items[0].id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
  });
});

describe("producción · alta manual e importación", () => {
  it("alta manual: crea la entrada, suma stock y crea el cliente si no existe", async () => {
    const clientName = `TEST-PROD-CLIENTE-${Date.now()}`;
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const res = await fetch(`${baseUrl}/api/production/entries`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ sku: "BUL-001", operatorName: "Test Operario", kilos: 3, clientName }),
    });
    assert.equal(res.status, 201);
    const entry = (await res.json()) as { id: number; status: string };
    assert.equal(entry.status, "recibido");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockDespues!.currentQuantity), Number(stockAntes?.currentQuantity ?? 0) + 3);

    const client = await prisma.client.findFirst({ where: { name: clientName } });
    assert.ok(client, "el cliente debió crearse automáticamente");

    await prisma.inventoryMovement.deleteMany({ where: { productionEntryId: entry.id } });
    await prisma.productionEntry.delete({ where: { id: entry.id } });
    await prisma.inventoryStock.update({ where: { productId: product.id }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
    await prisma.client.delete({ where: { id: client!.id } });
  });

  it("alta manual con SKU inexistente devuelve 400", async () => {
    const res = await fetch(`${baseUrl}/api/production/entries`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ sku: "NO-EXISTE-SKU", operatorName: "Test", kilos: 1 }),
    });
    assert.equal(res.status, 400);
  });

  it("import preview parsea el CSV sin persistir nada", async () => {
    const csv = "SKU,Etiqueta,Operario,Cliente,Medida,Kilos,Conductor,Observaciones\nBUL-001,ETQ-1,Juan,,25kg,10,,\n,,Pedro,,,,,\n";
    const form = new FormData();
    form.append("file", new Blob([csv], { type: "text/csv" }), "reporte.csv");

    const res = await fetch(`${baseUrl}/api/production/import/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.almacen}` },
      body: form,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { totalRows: number; validRows: number; invalidRows: number; rows: any[] };
    assert.equal(body.totalRows, 2);
    assert.equal(body.validRows, 1);
    assert.equal(body.invalidRows, 1);
    assert.equal(body.rows[1].error, "Falta SKU");
  });

  it("import confirm persiste solo las filas válidas y registra import_logs", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });

    const res = await fetch(`${baseUrl}/api/production/import/confirm`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({
        filename: "reporte.csv",
        rows: [
          { sku: "BUL-001", operatorName: "Juan", kilos: 7 },
          { sku: "", operatorName: "", kilos: 0, error: "Falta SKU" },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { processed: number; failed: number };
    assert.equal(body.processed, 1);
    assert.equal(body.failed, 1);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId: product.id } });
    assert.equal(Number(stockDespues!.currentQuantity), Number(stockAntes?.currentQuantity ?? 0) + 7);

    const log = await prisma.importLog.findFirst({ where: { filename: "reporte.csv" }, orderBy: { createdAt: "desc" } });
    assert.ok(log);
    assert.equal(log!.rowsProcessed, 1);
    assert.equal(log!.rowsFailed, 1);

    const entry = await prisma.productionEntry.findFirst({ where: { operatorName: "Juan", kilos: 7 as any }, orderBy: { createdAt: "desc" } });
    assert.ok(entry);
    await prisma.inventoryMovement.deleteMany({ where: { productionEntryId: entry!.id } });
    await prisma.productionEntry.delete({ where: { id: entry!.id } });
    await prisma.inventoryStock.update({ where: { productId: product.id }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
    await prisma.importLog.delete({ where: { id: log!.id } });
  });
});

describe("órdenes de producción · una OP por proceso (derivación, rollos, calidad, planeación)", () => {
  let productId = 0;

  before(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    productId = product.id;
  });

  it("devuelve 403 para un rol sin acceso al módulo (ventas)", async () => {
    const res = await fetch(`${baseUrl}/api/production-orders`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("crea una OP con numeración OP-XXXXX, estación y specs de plantilla", async () => {
    const res = await fetch(`${baseUrl}/api/production-orders`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({
        station: "extrusion",
        productId,
        quantityPlanned: 50,
        specs: { formaMaterial: "Tubular", materiaPrima: [{ ref: "ALTA", pct: 70 }] },
      }),
    });
    assert.equal(res.status, 201);
    const order = (await res.json()) as { id: number; orderNumber: string; status: string; station: string; specs: any };
    assert.match(order.orderNumber, /^OP-\d{5}$/);
    assert.equal(order.status, "borrador", "nace en borrador hasta que Gestión la libere a planta");
    assert.equal(order.station, "extrusion");
    assert.equal(order.specs.formaMaterial, "Tubular");
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("un operario no puede registrar rollos en una OP de otra estación", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "impresion", productId, quantityPlanned: 10 },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 5 }),
    });
    assert.equal(res.status, 403);
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("cargar un rollo pasa la OP a en_proceso; el operario sale del JWT, no del body; gestión puede borrarlo", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 10 },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      // operatorName en el body es ignorado a propósito (se toma del JWT) —
      // se manda igual acá para confirmar que NO pisa al usuario logueado.
      body: JSON.stringify({ shift: "Turno 1", operatorName: "Alguien Falso", label: "R-1", weightKg: 5, wasteKg: 0.5, details: { pResistencia: "SI" } }),
    });
    assert.equal(res.status, 201);
    const roll = (await res.json()) as { id: number; operatorName: string };
    assert.equal(roll.operatorName, "Operario Extrusión", "el operario debe salir del JWT, no del body");

    const updated = await prisma.productionOrder.findUnique({ where: { id: order.id } });
    assert.equal(updated!.status, "en_proceso");

    const del = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls/${roll.id}`, {
      method: "DELETE",
      headers: headersFor("produccion"),
    });
    assert.equal(del.status, 204);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("el código QR del rollo lleva el prefijo del proceso que lo generó (EXT/IMP/SELL/PRE)", async () => {
    const extOrder = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 10 },
    });
    const rollRes = await fetch(`${baseUrl}/api/production-orders/${extOrder.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 5 }),
    });
    const roll = (await rollRes.json()) as { id: number; stationSequence: number };

    const code = `EXT-${roll.stationSequence}`;
    const byCode = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/${code}`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(
      byCode.status,
      200,
      "un rollo de Extrusión se resuelve por el prefijo EXT (no el genérico RL) usando la numeración PROPIA de Extrusión, no el id global"
    );

    // Etiquetas físicas ya impresas ANTES de tener prefijo por estación
    // (formato "RL-<id global>") siguen circulando en planta -- tienen que
    // seguir resolviendo por el id real, no dar "código inválido" de la nada.
    const legacyFormat = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/RL-${roll.id}`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(legacyFormat.status, 200, "el formato viejo RL-<id> sigue resolviendo, por las etiquetas físicas ya impresas");
    const legacyBody = (await legacyFormat.json()) as { id: number };
    assert.equal(legacyBody.id, roll.id);

    const bogusFormat = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/ZZZ-1`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(bogusFormat.status, 400, "un prefijo que no es ninguno de los 4 reales (ni el legado RL-) se rechaza");

    // Un QR mal leído por el escáner (o alguien tipeando cualquier cosa a
    // mano) puede traer un número que ni entra en una columna `integer` de
    // Postgres -- antes esto llegaba crudo a Prisma y explotaba como 500 en
    // vez de un 400 prolijo.
    const numeroEnorme = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/EXT-99999999999999`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(numeroEnorme.status, 400, "un número que se pasa de un integer de Postgres se rechaza en vez de romper con un 500");

    const numeroEnormeLegado = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/RL-99999999999999`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(numeroEnormeLegado.status, 400, "mismo chequeo para el formato legado RL-<id>");

    const inexistente = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/RL-999999999`, {
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(inexistente.status, 404, "un id legado que sí entra en un integer pero no existe da 404, no 400 ni 500");

    await prisma.productionRoll.delete({ where: { id: roll.id } });
    await prisma.productionOrder.delete({ where: { id: extOrder.id } });
  });

  it("cada estación numera aparte -- un rollo de Precorte NO salta el número por rollos de Extrusión en el medio", async () => {
    const ext1 = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 100 },
    });
    const pre1 = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}-2`, station: "precorte", productId, quantityPlanned: 100 },
    });

    // Dos rollos de Extrusión SEGUIDOS: la numeración de esa estación tiene
    // que avanzar +1 entre ellos.
    const e1 = (await (
      await fetch(`${baseUrl}/api/production-orders/${ext1.id}/rolls`, {
        method: "POST",
        headers: headersFor("operario_extrusion"),
        body: JSON.stringify({ weightKg: 5 }),
      })
    ).json()) as { id: number; stationSequence: number };

    // En el medio, un rollo de Precorte -- no debería "robarle" un número a
    // la numeración de Extrusión (antes, con el id global, esto era
    // exactamente lo que pasaba: EXT saltaba de 70 a 72 porque el 71 se lo
    // había llevado un rollo de otra estación).
    await fetch(`${baseUrl}/api/production-orders/${pre1.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
      body: JSON.stringify({ weightKg: 3 }),
    });

    const e2 = (await (
      await fetch(`${baseUrl}/api/production-orders/${ext1.id}/rolls`, {
        method: "POST",
        headers: headersFor("operario_extrusion"),
        body: JSON.stringify({ weightKg: 5 }),
      })
    ).json()) as { id: number; stationSequence: number };

    assert.equal(e2.stationSequence, e1.stationSequence + 1, "Extrusión sigue su propia numeración consecutiva, sin importar qué se cargó en otras estaciones mientras tanto");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: { in: [ext1.id, pre1.id] } } });
    await prisma.productionOrder.delete({ where: { id: ext1.id } });
    await prisma.productionOrder.delete({ where: { id: pre1.id } });
  });

  it("la meta (peso+desperdicio) bloquea cargar más rollos al completarse, y notifica a Gestión al cruzar el 90%", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 100 },
    });

    const notifsBefore = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.equal(notifsBefore, 0);

    // 85kg: todavía no cruza el 90% (90kg).
    const r1 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 85, wasteKg: 0 }),
    });
    assert.equal(r1.status, 201);
    const notifsAfterR1 = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.equal(notifsAfterR1, 0, "todavía no llegó al 90%, no debe notificar");

    // +10kg (peso) +2kg (desperdicio) = 97kg de 100 → cruza el 90% (peso+desperdicio cuenta para la meta).
    // notifyRoles crea una fila POR usuario con rol de Gestión (fan-out), así
    // que no se compara contra "1" sino contra "más que antes" — y que no
    // vuelva a crecer en el siguiente rollo (ver r3).
    const r2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 10, wasteKg: 2 }),
    });
    assert.equal(r2.status, 201);
    const notifsAfterR2 = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.ok(notifsAfterR2 > notifsAfterR1, "cruzó el 90% (97/100), debe notificar a Gestión");

    // Otro rollo que la deje justo en la meta (3kg más → 100kg exactos) no debe volver a notificar "próxima".
    const r3 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 3, wasteKg: 0 }),
    });
    assert.equal(r3.status, 201);
    const notifsAfterR3 = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.equal(notifsAfterR3, notifsAfterR2, "ya llegó a la meta (no solo 'próxima'), no se vuelve a notificar 'próxima a completarse'");

    // Ya en 100/100 — un rollo más se rechaza, aunque sea de otra estación con rol correcto.
    const r4 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 1 }),
    });
    assert.equal(r4.status, 400, "ya se alcanzó la cantidad planificada, no se puede cargar más");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.notification.deleteMany({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("un solo rollo grande no puede pasarse de largo de la meta, aunque todavía no se hubiera completado antes de cargarlo", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });

    // 33kg cargados (bien por debajo de 40) y entra un rollo de 44kg: antes
    // del fix, esto se aceptaba porque solo se chequeaba "¿ya estaba
    // completa ANTES de este rollo?" — 33 < 40, así que dejaba pasar
    // cualquier cosa y terminaba en 82/40kg.
    const r1 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 20, wasteKg: 0 }),
    });
    assert.equal(r1.status, 201);
    const r2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 12, wasteKg: 1 }),
    });
    assert.equal(r2.status, 201); // total: 33/40

    const overshoot = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 44, wasteKg: 5 }),
    });
    assert.equal(overshoot.status, 400, "un rollo de 44+5kg sobre 33/40kg ya cargados se pasa de la meta, debe rechazarse");

    // Uno que sí entra justo (7kg, deja el total en exactamente 40) se acepta.
    const exact = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 7, wasteKg: 0 }),
    });
    assert.equal(exact.status, 201, "un rollo que deja el total EXACTO en la meta sí se acepta");

    const totalAfter = await prisma.productionRoll.aggregate({
      where: { productionOrderId: order.id },
      _sum: { weightKg: true, wasteKg: true },
    });
    assert.equal(Number(totalAfter._sum.weightKg) + Number(totalAfter._sum.wasteKg), 40);

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("GET /reports/por-operario agrupa los rollos por operario+día+proceso sin pedir datos nuevos", async () => {
    type OperarioRow = { operatorName: string; day: string; station: string; rollCount: number; weightKg: number; wasteKg: number };
    const today = new Date().toLocaleDateString("en-CA");
    const reportUrl = `${baseUrl}/api/production-orders/reports/por-operario?from=${today}&to=${today}&station=extrusion`;
    const findRow = (rows: OperarioRow[]) => rows.find((r) => r.operatorName === "Operario Extrusión" && r.day === today && r.station === "extrusion");

    // Se toma una foto de "antes" en vez de asumir que la fila arranca en 0:
    // esto corre contra la base de dev compartida, que puede tener otros
    // rollos de hoy del mismo operario (pruebas manuales, otras corridas) —
    // lo que importa es que el reporte sume exactamente lo que se agrega acá.
    const before = await fetch(reportUrl, { headers: headersFor("produccion") });
    const rowsBefore = (await before.json()) as OperarioRow[];
    const rowBefore = findRow(rowsBefore);

    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 30 },
    });
    const roll1 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 10, wasteKg: 1 }),
    });
    assert.equal(roll1.status, 201);
    const roll2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 8, wasteKg: 0.5 }),
    });
    assert.equal(roll2.status, 201);

    const forbidden = await fetch(`${baseUrl}/api/production-orders/reports/por-operario`, { headers: headersFor("operario_extrusion") });
    assert.equal(forbidden.status, 403, "solo Gestión ve el reporte");

    const res = await fetch(reportUrl, { headers: headersFor("produccion") });
    assert.equal(res.status, 200);
    const rows = (await res.json()) as OperarioRow[];
    const row = findRow(rows);
    assert.ok(row, "debe aparecer una fila agrupada para el operario/día/proceso de los rollos recién cargados");
    assert.equal(row!.rollCount - (rowBefore?.rollCount ?? 0), 2);
    assert.equal(row!.weightKg - (rowBefore?.weightKg ?? 0), 18);
    assert.equal(row!.wasteKg - (rowBefore?.wasteKg ?? 0), 1.5);

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("GET /reports/por-operario suma también el segundo peso de Precorte (details.pesoR2), no solo el peso base", async () => {
    type OperarioRow = { operatorName: string; day: string; station: string; weightKg: number };
    const today = new Date().toLocaleDateString("en-CA");
    const reportUrl = `${baseUrl}/api/production-orders/reports/por-operario?from=${today}&to=${today}&station=precorte`;
    const findRow = (rows: OperarioRow[]) => rows.find((r) => r.operatorName === "Operario Precorte" && r.day === today && r.station === "precorte");

    const before = await fetch(reportUrl, { headers: headersFor("produccion") });
    const rowBefore = findRow((await before.json()) as OperarioRow[]);

    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "precorte", productId, quantityPlanned: 30 },
    });
    const roll = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
      body: JSON.stringify({ weightKg: 10, details: { pesoR2: 6 } }),
    });
    assert.equal(roll.status, 201);

    const res = await fetch(reportUrl, { headers: headersFor("produccion") });
    const row = findRow((await res.json()) as OperarioRow[]);
    assert.ok(row);
    assert.equal(row!.weightKg - (rowBefore?.weightKg ?? 0), 16, "suma peso base (10) + pesoR2 (6), no solo el peso base");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("derivación: extrusión → sellado hereda producto/cantidad; sellado no deriva (400)", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });

    const bad = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "extrusion" }),
    });
    assert.equal(bad.status, 400, "extrusión no puede derivar a extrusión");

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(res.status, 201);
    const derived = (await res.json()) as {
      id: number;
      orderNumber: string;
      station: string;
      parentOrderId: number;
      productId: number;
      quantityPlanned: unknown;
    };
    assert.equal(derived.station, "sellado");
    assert.equal(derived.parentOrderId, parent.id);
    assert.equal(derived.productId, productId);
    assert.equal(Number(derived.quantityPlanned), 40);
    assert.equal(derived.orderNumber, parent.orderNumber, "la OP derivada mantiene el mismo número de la cadena, no uno nuevo");

    // No se puede derivar dos veces al mismo destino — si no, cada clic en
    // "Derivar a Sellado" crea otra fila hija más, sin límite.
    const dupe = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(dupe.status, 400, "ya existe una OP derivada a sellado desde este padre");

    const badFinal = await fetch(`${baseUrl}/api/production-orders/${derived.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte" }),
    });
    assert.equal(badFinal.status, 400, "una OP de sellado es proceso final, no deriva");

    await prisma.productionOrder.delete({ where: { id: derived.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("derivar hereda como meta lo que el padre REALMENTE produjo (suma de rollos), no lo que el padre planificaba", async () => {
    // El padre planificaba 40kg pero solo salieron 37kg reales (2 rollos de
    // 10 y 27) -- la hija no puede seguir esperando los 40kg planificados,
    // porque no hay más material físico que cargar (bug real reportado:
    // "Restan 1 kg" para siempre, sin ningún rollo que escanear).
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });
    await createTestRoll(parent.id, { weightKg: 10 });
    await createTestRoll(parent.id, { weightKg: 27 });

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(res.status, 201);
    const derived = (await res.json()) as { id: number; quantityPlanned: unknown };
    assert.equal(Number(derived.quantityPlanned), 37, "la meta de la hija es lo real producido (10+27), no los 40kg planificados del padre");

    // Los 37 kg ya quedaron asignados a Sellado: una segunda hija no puede
    // pedir más (antes cada hija recibía el 100% y se duplicaba el material).
    const sinDisponible = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte", quantityPlanned: 20 }),
    });
    assert.equal(sinDisponible.status, 400);
    assert.match(((await sinDisponible.json()) as { error: string }).error, /quedan 0 kg/);

    // Gestión reparte: baja Sellado a 17 y le da 20 a Precorte.
    const baja = await fetch(`${baseUrl}/api/production-orders/${derived.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ quantityPlanned: 17 }),
    });
    assert.equal(baja.status, 200);
    const derivedOverride = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte", quantityPlanned: 20 }),
    });
    assert.equal(derivedOverride.status, 201);
    const overrideBody = (await derivedOverride.json()) as { id: number; quantityPlanned: unknown };
    assert.equal(Number(overrideBody.quantityPlanned), 20, "quantityPlanned explícito en el body gana sobre el default calculado");

    // Ya está todo repartido (17 + 20 = 37): derivar otra sin meta se rechaza,
    // y subir la meta de una hija por encima de lo libre también.
    const tercera = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "impresion" }),
    });
    assert.equal(tercera.status, 400);
    assert.match(((await tercera.json()) as { error: string }).error, /Ya se asignaron los 37 kg/);
    const subeDeMas = await fetch(`${baseUrl}/api/production-orders/${derived.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ quantityPlanned: 18 }),
    });
    assert.equal(subeDeMas.status, 400, "17 + 20 ya son los 37 kg del padre");

    await prisma.productionOrder.delete({ where: { id: overrideBody.id } });
    await prisma.productionOrder.delete({ where: { id: derived.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("si el padre carga más rollos DESPUÉS de derivar, la meta de la hija se actualiza sola (mientras la hija no haya producido nada propio)", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });
    await createTestRoll(parent.id, { weightKg: 30 });

    const derive = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    const derived = (await derive.json()) as { id: number; quantityPlanned: unknown };
    assert.equal(Number(derived.quantityPlanned), 30);

    // Se sube el planificado del padre para poder seguir cargando (el cap de
    // /rolls no deja pasarse de lo planificado propio).
    await fetch(`${baseUrl}/api/production-orders/${parent.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ quantityPlanned: 50 }),
    });

    // Un rollo cargado tarde en el padre sube el total real -- la hija (que
    // todavía no cargó nada propio) tiene que poder aprovechar ese material.
    await fetch(`${baseUrl}/api/production-orders/${parent.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 10 }),
    });
    const afterExtraRoll = await prisma.productionOrder.findUnique({ where: { id: derived.id } });
    assert.equal(Number(afterExtraRoll!.quantityPlanned), 40, "la meta de la hija sube junto con el padre (30+10)");

    // Una vez que la hija YA produjo algo propio, deja de seguir la foto del
    // padre -- su propia realidad manda a partir de ahí.
    await createTestRoll(derived.id, { weightKg: 40 });
    await fetch(`${baseUrl}/api/production-orders/${parent.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 5 }),
    });
    const afterOwnProduction = await prisma.productionOrder.findUnique({ where: { id: derived.id } });
    assert.equal(
      Number(afterOwnProduction!.quantityPlanned),
      40,
      "una vez que la hija ya produjo, su meta ya no se pisa con lo que siga cargando el padre"
    );

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: derived.id } });
    await prisma.productionOrder.delete({ where: { id: derived.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("GET /:id trae derivedOrders en el orden real en que se derivaron, no en otro orden", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });

    // A propósito primero Precorte y después Sellado -- si el orden viniera
    // alfabético o por algún criterio que no sea el real, esto lo detecta.
    const derivePrecorte = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte", quantityPlanned: 20 }),
    });
    const precorte = (await derivePrecorte.json()) as { id: number };

    const deriveSellado = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado", quantityPlanned: 20 }),
    });
    const sellado = (await deriveSellado.json()) as { id: number };

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}`, { headers: headersFor("produccion") });
    const body = (await res.json()) as { derivedOrders: { id: number; station: string }[] };
    assert.deepEqual(
      body.derivedOrders.map((d) => d.station),
      ["precorte", "sellado"],
      "precorte se derivó primero, debe listarse primero"
    );

    await prisma.productionOrder.delete({ where: { id: precorte.id } });
    await prisma.productionOrder.delete({ where: { id: sellado.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("derivar hereda specs en común del padre (formaMaterial→tipoMaterial, tratadoCaras→caras, ancho, fuelles, calibre, color); campos vacíos no se copian; specs explícito pisa lo heredado", async () => {
    const parent = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 40,
        specs: { formaMaterial: "Tubular", ancho: "30", anchoUnidad: "Cms.", fuelles: "SI", calibre: "0.6", color: "Blanco", tratadoCaras: "2", materialPara: "SELLADO", densidad: "ALTA" },
      },
    });

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado", quantityPlanned: 20 }),
    });
    assert.equal(res.status, 201);
    const derived = (await res.json()) as { id: number; specs: any };
    assert.equal(derived.specs.tipoMaterial, "Tubular", "formaMaterial del padre se mapea a tipoMaterial del hijo");
    assert.equal(derived.specs.ancho, "30");
    assert.equal(derived.specs.anchoUnidad, "Cms.");
    assert.equal(derived.specs.fuelles, "SI");
    assert.equal(derived.specs.calibre, "0.6");
    assert.equal(derived.specs.color, "Blanco");
    assert.equal(derived.specs.caras, "2", "tratadoCaras (Caras tratadas) del padre se mapea a caras (Caras) del hijo");
    assert.equal(derived.specs.materialPara, undefined, "materialPara es de ruteo de Extrusión, no un concepto de Sellado");
    assert.equal(derived.specs.materialDensidad, "ALTA", "densidad de Extrusión se mapea a materialDensidad del hijo (comparten las mismas opciones BAJA/ALTA)");

    // cantidadKilos/cantidadRollos de Impresión NO se heredan a Sellado/
    // Precorte — el frontend los autocompleta y bloquea con el total real de
    // rollos del padre (ver OrdenProduccionDetalle.tsx), y si el server
    // también los copiaba, ese autocompletado nunca se disparaba porque el
    // campo ya venía "cargado" con la foto vieja de Impresión.
    const impresionConCantidad = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}z`,
        station: "impresion",
        productId,
        quantityPlanned: 10,
        specs: { cantidadKilos: "999", cantidadRollos: "5" },
      },
    });
    const derivedSelladoNoCantidad = await fetch(`${baseUrl}/api/production-orders/${impresionConCantidad.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    const bodySelladoNoCantidad = (await derivedSelladoNoCantidad.json()) as { id: number; specs: any };
    assert.equal(bodySelladoNoCantidad.specs?.cantidadKilos, undefined, "cantidadKilos de Impresión no se copia a Sellado");
    assert.equal(bodySelladoNoCantidad.specs?.cantidadRollos, undefined, "cantidadRollos de Impresión no se copia a Sellado");
    await prisma.productionOrder.delete({ where: { id: bodySelladoNoCantidad.id } });
    await prisma.productionOrder.delete({ where: { id: impresionConCantidad.id } });

    // Mismo mapeo también al derivar directo a Precorte (no solo a Sellado).
    const derivedPrecorte = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte", quantityPlanned: 20 }),
    });
    assert.equal(derivedPrecorte.status, 201);
    const precorteBody = (await derivedPrecorte.json()) as { id: number; specs: any };
    assert.equal(precorteBody.specs.caras, "2", "tratadoCaras también se hereda al derivar directo a Precorte");
    await prisma.productionOrder.delete({ where: { id: precorteBody.id } });

    await prisma.productionOrder.delete({ where: { id: derived.id } });

    // Campo vacío en el padre (fuelles sin cargar) no debe pisar con "" al hijo.
    const parentSinFuelles = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}b`, station: "extrusion", productId, quantityPlanned: 10, specs: { color: "Rojo" } },
    });
    const derivedSinFuelles = await fetch(`${baseUrl}/api/production-orders/${parentSinFuelles.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "impresion", quantityPlanned: 5 }),
    });
    const bodySinFuelles = (await derivedSinFuelles.json()) as { id: number; specs: any };
    assert.equal(bodySinFuelles.specs.color, "Rojo");
    assert.equal(bodySinFuelles.specs.fuelles, undefined, "no se copia un campo que el padre no tenía cargado");
    await prisma.productionOrder.delete({ where: { id: bodySinFuelles.id } });

    // specs explícito en el body de /derive pisa lo heredado.
    const derivedOverride = await fetch(`${baseUrl}/api/production-orders/${parentSinFuelles.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado", quantityPlanned: 5, specs: { color: "Verde" } }),
    });
    const bodyOverride = (await derivedOverride.json()) as { id: number; specs: any };
    assert.equal(bodyOverride.specs.color, "Verde", "el specs explícito del body gana sobre lo heredado");
    await prisma.productionOrder.delete({ where: { id: bodyOverride.id } });

    await prisma.productionOrder.delete({ where: { id: parentSinFuelles.id } });
  });

  it("los campos de lista solo aceptan sus opciones: normaliza mayúsculas/tildes/sinónimos seguros y rechaza lo que no es ninguna opción", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });
    const patch = (specs: Record<string, unknown>) =>
      fetch(`${baseUrl}/api/production-orders/${order.id}`, { method: "PATCH", headers: headersFor("produccion"), body: JSON.stringify({ specs }) });

    const ok = await patch({ densidad: "alta", color: "trasparente", tratadoCaras: "ambas", fuelles: " si ", formaMaterial: "lam. ph", calibre: "0.6" });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { specs: any };
    assert.equal(okBody.specs.densidad, "ALTA", "mayúsculas/minúsculas no importan, se guarda la opción exacta");
    assert.equal(okBody.specs.color, "Transparente", "error de tipeo conocido");
    assert.equal(okBody.specs.tratadoCaras, "2", "'ambas' caras son las 2");
    assert.equal(okBody.specs.fuelles, "SI");
    assert.equal(okBody.specs.formaMaterial, "Lám. PH", "sin tilde ni mayúsculas igual cae en la opción real");
    assert.equal(okBody.specs.calibre, "0.6", "los campos que no son de lista no se tocan");

    const abreviado = await patch({ color: "TRANSP" });
    assert.equal(((await abreviado.json()) as { specs: any }).specs.color, "Transparente", "TRANSP es la abreviatura del papel");

    const confirmados = await patch({ color: "Natural", fuelles: "2", tratadoCaras: "0" });
    assert.equal(confirmados.status, 200);
    const confirmadosBody = (await confirmados.json()) as { specs: any };
    assert.equal(confirmadosBody.specs.color, "Transparente", "Natural = polietileno sin pigmento (confirmado por Gestión)");
    assert.equal(confirmadosBody.specs.fuelles, "SI", "una cantidad de fuelles mayor a 0 es que sí lleva");
    assert.equal(confirmadosBody.specs.tratadoCaras, "", "caras '0' es una OP sin tratado: el campo queda vacío");
    const sinFuelles = await patch({ color: "Natural", fuelles: "0" });
    assert.equal(((await sinFuelles.json()) as { specs: any }).specs.fuelles, "NO");

    const bad = await patch({ color: "Azul", fuelles: "muchos" });
    assert.equal(bad.status, 400, "un valor que no es ninguna opción se rechaza, no se adivina");
    const badBody = (await bad.json()) as { error: string };
    assert.match(badBody.error, /Color = "Azul"/);
    assert.match(badBody.error, /Fuelles = "muchos"/);
    const unchanged = await prisma.productionOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal((unchanged.specs as any).color, "Transparente", "el PATCH rechazado no guarda nada");
    assert.equal((unchanged.specs as any).fuelles, "NO", "el PATCH rechazado no guarda nada");

    const badMaterialPara = await fetch(`${baseUrl}/api/production-orders/${order.id}/material-para`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ materialPara: "LAMINADO" }),
    });
    assert.equal(badMaterialPara.status, 400);
    const goodMaterialPara = await fetch(`${baseUrl}/api/production-orders/${order.id}/material-para`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ materialPara: "sellado" }),
    });
    assert.equal(goodMaterialPara.status, 200);
    assert.equal(((await goodMaterialPara.json()) as { specs: any }).specs.materialPara, "SELLADO");

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("al derivar, lo heredado se lleva a la opción exacta de la hija y un valor viejo fuera de lista no se copia; specs inválido en el body da 400", async () => {
    const parent = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 40,
        status: "en_proceso",
        // Guardado directo (como los datos viejos de producción), sin pasar por la validación nueva.
        specs: { densidad: "baja", color: "Azul", tratadoCaras: "ambas", fuelles: "0" },
      },
    });

    const badBody = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado", specs: { impreso: "tal vez" } }),
    });
    assert.equal(badBody.status, 400, "lo que manda el body se valida contra la plantilla de la hija");

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(res.status, 201, "un dato viejo del padre no traba la derivación");
    const child = (await res.json()) as { id: number; specs: any };
    assert.equal(child.specs.materialDensidad, "BAJA");
    assert.equal(child.specs.caras, "2");
    assert.equal(child.specs.fuelles, "NO");
    assert.equal(child.specs.color, undefined, "'Azul' no es un color de la lista: no se copia a la hija");

    await prisma.productionOrder.delete({ where: { id: child.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("editar specs de una OP ya derivada propaga los campos heredables a la(s) hija(s) existentes, en cascada, pisando lo que ya tuvieran", async () => {
    const root = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40, specs: { formaMaterial: "Tubular", ancho: "10", color: "Rojo" } },
    });

    // Derivar a Precorte con lo que había en ese momento (ancho 10).
    const deriveRes = await fetch(`${baseUrl}/api/production-orders/${root.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "precorte", quantityPlanned: 20 }),
    });
    const precorte = (await deriveRes.json()) as { id: number; specs: any };
    assert.equal(precorte.specs.ancho, "10");

    // Precorte también deriva un nieto (Precorte no deriva realmente, así
    // que se simula un nieto directo desde impresión en su lugar: se prueba
    // la cascada con Extrusión → Impresión → Sellado).
    const impRes = await fetch(`${baseUrl}/api/production-orders/${root.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "impresion", quantityPlanned: 20 }),
    });
    const impresion = (await impRes.json()) as { id: number };
    const selRes = await fetch(`${baseUrl}/api/production-orders/${impresion.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    const sellado = (await selRes.json()) as { id: number; specs: any };
    assert.equal(sellado.specs.ancho, "10", "el nieto también heredó el ancho al derivar");

    // El operario de Precorte ya había tocado el campo a mano — igual se pisa.
    await prisma.productionOrder.update({ where: { id: precorte.id }, data: { specs: { ancho: "999", color: "Rojo", tipoMaterial: "Tubular" } } });

    // Ahora Gestión edita Medidas/Ancho en la OP raíz (Extrusión), ya con hijas creadas.
    const patchRes = await fetch(`${baseUrl}/api/production-orders/${root.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ specs: { formaMaterial: "Tubular", ancho: "25", color: "Rojo" } }),
    });
    assert.equal(patchRes.status, 200);

    const precorteAfter = await fetch(`${baseUrl}/api/production-orders/${precorte.id}`, { headers: headersFor("produccion") });
    const precorteBody = (await precorteAfter.json()) as { specs: any };
    assert.equal(precorteBody.specs.ancho, "25", "el cambio en el padre pisa el valor que ya tenía la hija");
    assert.equal(precorteBody.specs.color, "Rojo");

    const selladoAfter = await fetch(`${baseUrl}/api/production-orders/${sellado.id}`, { headers: headersFor("produccion") });
    const selladoBody = (await selladoAfter.json()) as { specs: any };
    assert.equal(selladoBody.specs.ancho, "25", "propaga en cascada hasta el nieto (a través de Impresión)");

    await prisma.productionOrder.delete({ where: { id: sellado.id } });
    await prisma.productionOrder.delete({ where: { id: impresion.id } });
    await prisma.productionOrder.delete({ where: { id: precorte.id } });
    await prisma.productionOrder.delete({ where: { id: root.id } });
  });

  it('PATCH /:id/material-para: el operario de la estación lo puede editar (no otros campos), un operario de otra estación no', async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 10, specs: { color: "Blanco" } },
    });

    const wrongStation = await fetch(`${baseUrl}/api/production-orders/${order.id}/material-para`, {
      method: "PATCH",
      headers: headersFor("operario_impresion"),
      body: JSON.stringify({ materialPara: "SELLADO" }),
    });
    assert.equal(wrongStation.status, 403);

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/material-para`, {
      method: "PATCH",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ materialPara: "SELLADO" }),
    });
    assert.equal(res.status, 200);
    const updated = (await res.json()) as { specs: { materialPara: string; color: string } };
    assert.equal(updated.specs.materialPara, "SELLADO");
    assert.equal(updated.specs.color, "Blanco", "no toca ningún otro campo de specs ya cargado");

    // Un operario no puede colarse otros campos por acá — el schema del
    // endpoint solo acepta `materialPara`.
    const smuggle = await fetch(`${baseUrl}/api/production-orders/${order.id}/material-para`, {
      method: "PATCH",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ materialPara: "PRECORTE", color: "Rojo" }),
    });
    assert.equal(smuggle.status, 200);
    const afterSmuggle = (await smuggle.json()) as { specs: { color: string } };
    assert.equal(afterSmuggle.specs.color, "Blanco", "el color se ignora, solo se actualiza materialPara");

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("derivar es exclusivo de Gestión/Planeación — ningún operario puede, ni siquiera el de la estación de origen", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 20 },
    });

    const wrongStation = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("operario_impresion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(wrongStation.status, 403, "un operario de impresión no puede derivar una OP de extrusión");

    const ownStation = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(ownStation.status, 403, "ni siquiera el operario de la ESTACIÓN DE ORIGEN puede derivar — es exclusivo de Gestión");

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(res.status, 201);
    const derived = (await res.json()) as { id: number; status: string };
    assert.equal(derived.status, "pendiente", "la OP derivada nace directo en pendiente, no en borrador");

    await prisma.productionOrder.delete({ where: { id: derived.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("una OP en borrador: nace oculta para operarios (403/404 no aplica, simplemente no aparece) y Gestión la libera con /release", async () => {
    const createRes = await fetch(`${baseUrl}/api/production-orders`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "extrusion", productId, quantityPlanned: 15, specs: { materiaPrima: [{ ref: "ALTA", pct: 100 }] } }),
    });
    const order = (await createRes.json()) as { id: number; status: string };
    assert.equal(order.status, "borrador");

    // Un operario no la ve en la lista de su estación...
    const listAsOperario = await fetch(`${baseUrl}/api/production-orders?station=extrusion`, { headers: headersFor("operario_extrusion") });
    const listBody = (await listAsOperario.json()) as { id: number }[];
    assert.ok(!listBody.some((o) => o.id === order.id), "un operario no debe ver una OP en borrador en la cola de su estación");

    // ...ni puede abrirla directo por id.
    const getAsOperario = await fetch(`${baseUrl}/api/production-orders/${order.id}`, { headers: headersFor("operario_extrusion") });
    assert.equal(getAsOperario.status, 404);

    // Gestión sí la ve y puede seguir editando specs mientras está en borrador.
    const patch = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ specs: { color: "Blanco", materiaPrima: [{ ref: "ALTA", pct: 100 }] } }),
    });
    assert.equal(patch.status, 200, "specs se pueden editar mientras la OP está en borrador");

    // Un operario no puede liberarla.
    const releaseDenied = await fetch(`${baseUrl}/api/production-orders/${order.id}/release`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(releaseDenied.status, 403);

    // Gestión la libera: pasa a pendiente y ahora sí la ve el operario.
    const release = await fetch(`${baseUrl}/api/production-orders/${order.id}/release`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(release.status, 200);
    const released = (await release.json()) as { status: string };
    assert.equal(released.status, "pendiente");

    const listAfter = await fetch(`${baseUrl}/api/production-orders?station=extrusion`, { headers: headersFor("operario_extrusion") });
    const listAfterBody = (await listAfter.json()) as { id: number }[];
    assert.ok(listAfterBody.some((o) => o.id === order.id), "una vez liberada, el operario sí la ve");

    // Ya liberada, no se puede volver a liberar.
    const releaseAgain = await fetch(`${baseUrl}/api/production-orders/${order.id}/release`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(releaseAgain.status, 400);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("una OP se crea sin proceso asignado y se deriva a Extrusión en el lugar (mismo id, mismo número, no crea una fila nueva)", async () => {
    const createRes = await fetch(`${baseUrl}/api/production-orders`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ productId, quantityPlanned: 20, specs: { materiaPrima: [{ ref: "ALTA", pct: 100 }] } }),
    });
    assert.equal(createRes.status, 201);
    const order = (await createRes.json()) as { id: number; orderNumber: string; station: string | null; status: string };
    assert.equal(order.station, null, "nace sin proceso asignado, no en extrusión por defecto");
    assert.equal(order.status, "borrador");

    // No se puede liberar a planta sin proceso asignado.
    const releaseNoStation = await fetch(`${baseUrl}/api/production-orders/${order.id}/release`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(releaseNoStation.status, 400);

    // Solo Gestión puede asignar el primer proceso (un operario, aunque
    // exista, no puede porque la OP en borrador ni siquiera le aparece).
    const deriveAsOperario = await fetch(`${baseUrl}/api/production-orders/${order.id}/derive`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ station: "extrusion" }),
    });
    assert.equal(deriveAsOperario.status, 403);

    // El primer proceso siempre tiene que ser Extrusión.
    const deriveWrongStation = await fetch(`${baseUrl}/api/production-orders/${order.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(deriveWrongStation.status, 400);

    const derive = await fetch(`${baseUrl}/api/production-orders/${order.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "extrusion" }),
    });
    assert.equal(derive.status, 200, "asignar el primer proceso actualiza la fila existente (200), no crea una nueva (201)");
    const assigned = (await derive.json()) as { id: number; orderNumber: string; station: string; parentOrderId: number | null };
    assert.equal(assigned.id, order.id, "sigue siendo la misma fila, no una OP hija nueva");
    assert.equal(assigned.orderNumber, order.orderNumber);
    assert.equal(assigned.station, "extrusion");
    assert.equal(assigned.parentOrderId, null);

    // Ahora sí se puede liberar.
    const release = await fetch(`${baseUrl}/api/production-orders/${order.id}/release`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(release.status, 200);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("el rollo de origen escaneado (sourceRollId) tiene que pertenecer a la OP padre real, no a cualquier OP", async () => {
    const parentA = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 10 },
    });
    const rollAjeno = await createTestRoll(parentA.id, { weightKg: 5 });

    const parentB = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}b`, station: "extrusion", productId, quantityPlanned: 10 },
    });
    const derivedFromB = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}c`, station: "impresion", productId, quantityPlanned: 10, parentOrderId: parentB.id },
    });

    const rejected = await fetch(`${baseUrl}/api/production-orders/${derivedFromB.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 5, sourceRollId: rollAjeno.id }),
    });
    assert.equal(rejected.status, 400, "un rollo de una OP no emparentada debe rechazarse");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parentA.id } });
    await prisma.productionOrder.delete({ where: { id: derivedFromB.id } });
    await prisma.productionOrder.delete({ where: { id: parentB.id } });
    await prisma.productionOrder.delete({ where: { id: parentA.id } });
  });

  it("un rollo físico solo se puede consumir una vez como insumo (sourceRollId) — el segundo escaneo del mismo QR se rechaza", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 20 },
    });
    const source = await createTestRoll(parent.id, { weightKg: 20 });
    await placeRollAt(source.id, "impresion");
    const child = await prisma.productionOrder.create({
      // Meta holgada: el segundo escaneo tiene que frenar por "rollo ya consumido", no por meta completa.
      data: { orderNumber: parent.orderNumber, station: "impresion", productId, quantityPlanned: 40, parentOrderId: parent.id },
    });

    const first = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 20, sourceRollId: source.id, sourceRollTokens: { [source.id]: source.possessionToken } }),
    });
    assert.equal(first.status, 201, "el primer escaneo del rollo de origen se acepta");

    const second = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 3, sourceRollId: source.id, sourceRollTokens: { [source.id]: source.possessionToken } }),
    });
    assert.equal(second.status, 400, "un segundo escaneo del mismo rollo de origen se rechaza");
    const secondBody = (await second.json()) as { error: string };
    assert.match(secondBody.error, /ya fue consumido/);

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: child.id } });
    await prisma.productionOrder.delete({ where: { id: child.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("un rollo solo se consume en la estación donde está: sin despachar, o recibido en otra bodega, se rechaza (también al escanear)", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40 },
    });
    const source = await createTestRoll(parent.id, { weightKg: 20 });
    const code = `${ROLL_CODE_PREFIX.extrusion}-${source.stationSequence}`;
    const child = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station: "sellado", productId, quantityPlanned: 40, parentOrderId: parent.id },
    });
    const cargar = () =>
      fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ weightKg: 5, sourceRollIds: [source.id], sourceRollTokens: { [source.id]: source.possessionToken } }),
      });
    const escanear = () =>
      fetch(`${baseUrl}/api/production-orders/rolls/by-code/${code}?token=${source.possessionToken}&forStation=sellado`, { headers: headersFor("produccion") });

    // Nunca salió de Extrusión.
    const sinDespachar = await cargar();
    assert.equal(sinDespachar.status, 400);
    assert.match(((await sinDespachar.json()) as { error: string }).error, /está en la bodega de Extrusión/);
    const escaneoSinDespachar = await escanear();
    assert.equal(escaneoSinDespachar.status, 400, "el escaneo ya avisa, antes de llenar la fila");

    // Lo recibieron en Precorte: tampoco se puede consumir en Sellado.
    await placeRollAt(source.id, "precorte");
    const otraBodega = await cargar();
    assert.equal(otraBodega.status, 400);
    assert.match(((await otraBodega.json()) as { error: string }).error, /está en la bodega de Precorte/);

    // Recibido en la bodega de Sellado: ahora sí.
    await placeRollAt(source.id, "sellado");
    const escaneoOk = await escanear();
    assert.equal(escaneoOk.status, 200);
    assert.deepEqual(((await escaneoOk.json()) as { location: unknown }).location, { status: "en_bodega", station: "sellado" });
    assert.equal((await cargar()).status, 201);

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: child.id } });
    await prisma.productionOrder.delete({ where: { id: child.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("un rollo madre 'en tránsito' hacia otra bodega (ver roll-transfers) no se puede consumir hasta que se confirme la recepción", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 20 },
    });
    const source = await createTestRoll(parent.id, { weightKg: 20 });
    const child = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station: "impresion", productId, quantityPlanned: 20, parentOrderId: parent.id },
    });
    const transfer = await prisma.rollTransfer.create({
      data: {
        rollId: source.id,
        fromStation: "extrusion",
        toStation: "impresion",
        mode: "retiro",
        carrierName: "Camionero Test",
        registeredById: (await prisma.user.findFirstOrThrow({ where: { email: "operario.extrusion@empresa.com" } })).id,
        clientTimezone: "America/Bogota",
        clientUtcOffsetMinutes: -300,
      },
    });

    const blocked = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 20, sourceRollId: source.id, sourceRollTokens: { [source.id]: source.possessionToken } }),
    });
    assert.equal(blocked.status, 400, "el rollo sigue en tránsito, no se puede consumir todavía");
    const blockedBody = (await blocked.json()) as { error: string };
    assert.match(blockedBody.error, /en camino a la bodega de Impresión/);

    // Una vez recibido, sí se puede consumir normalmente.
    await prisma.rollTransfer.update({ where: { id: transfer.id }, data: { status: "recibido", receivedAt: new Date() } });
    const allowed = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 20, sourceRollId: source.id, sourceRollTokens: { [source.id]: source.possessionToken } }),
    });
    assert.equal(allowed.status, 201, "una vez recibido, el rollo se puede consumir");

    await prisma.rollTransfer.deleteMany({ where: { rollId: source.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: child.id } });
    await prisma.productionOrder.delete({ where: { id: child.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  /** Arma un padre de Extrusión con los rollos madre pedidos y una OP hija
   * de la estación indicada, para los tests de consumo parcial. */
  async function setupRolloMadre(station: "sellado" | "precorte", pesos: number[]) {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}-${Math.random()}`, station: "extrusion", productId, quantityPlanned: 500 },
    });
    const madres = [];
    for (const weightKg of pesos) {
      const madre = await createTestRoll(parent.id, { weightKg });
      await placeRollAt(madre.id, station);
      madres.push(madre);
    }
    const child = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station, productId, quantityPlanned: 500, parentOrderId: parent.id },
    });
    return { parent, child, madres };
  }

  async function saldoDe(stationSequence: number) {
    const res = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/EXT-${stationSequence}`, { headers: headersFor("produccion") });
    assert.equal(res.status, 200);
    return ((await res.json()) as { remainingKg: number }).remainingKg;
  }

  async function cargarFila(childId: number, weightKg: number, madres: { id: number; possessionToken: string }[]) {
    return fetch(`${baseUrl}/api/production-orders/${childId}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({
        weightKg,
        sourceRollIds: madres.map((m) => m.id),
        sourceRollTokens: Object.fromEntries(madres.map((m) => [String(m.id), m.possessionToken])),
      }),
    });
  }

  async function limpiar(parentId: number, childId: number) {
    await prisma.rollConsumption.deleteMany({ where: { roll: { productionOrderId: childId } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: childId } });
    await prisma.productionOrder.delete({ where: { id: childId } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parentId } });
    await prisma.productionOrder.delete({ where: { id: parentId } });
  }

  it("el rollo madre alimenta varias filas y se le va descontando el saldo (45 → 30 → 20 → 10)", async () => {
    const { parent, child, madres } = await setupRolloMadre("sellado", [45]);
    const madre = madres[0];

    assert.equal(await saldoDe(madre.stationSequence), 45, "recién salido de Extrusión el saldo es su peso completo");

    // La cuenta exacta que los operarios venían haciendo a mano en el papel.
    for (const [kg, saldoEsperado] of [
      [15, 30],
      [10, 20],
      [10, 10],
    ]) {
      const res = await cargarFila(child.id, kg, [madre]);
      assert.equal(res.status, 201, `cargar ${kg} kg contra el mismo rollo madre se acepta`);
      assert.equal(await saldoDe(madre.stationSequence), saldoEsperado);
    }

    await limpiar(parent.id, child.id);
  });

  it("si el rollo chico se pasa del saldo, hay que escanear el siguiente y el excedente sale de ahí", async () => {
    const { parent, child, madres } = await setupRolloMadre("sellado", [10, 50]);
    const [madreA, madreB] = madres;

    const sinCubrir = await cargarFila(child.id, 15, [madreA]);
    assert.equal(sinCubrir.status, 400, "no alcanza el saldo del rollo madre y no se escaneó otro");
    assert.match(((await sinCubrir.json()) as { error: string }).error, /Faltan 5 kg/);

    const conElSiguiente = await cargarFila(child.id, 15, [madreA, madreB]);
    assert.equal(conElSiguiente.status, 201);

    assert.equal(await saldoDe(madreA.stationSequence), 0, "el rollo madre viejo queda agotado");
    assert.equal(await saldoDe(madreB.stationSequence), 45, "del siguiente salieron solo los 5 kg que faltaban");

    await limpiar(parent.id, child.id);
  });

  it("en Precorte el reparto entre dos rollos madre queda en los dos pares ETIQUETA R / PESO R del papel", async () => {
    const { parent, child, madres } = await setupRolloMadre("precorte", [10, 50]);
    const [madreA, madreB] = madres;

    const res = await cargarFila(child.id, 15, [madreA, madreB]);
    assert.equal(res.status, 201);
    const fila = (await res.json()) as { weightKg: string; details: Record<string, unknown> };

    assert.equal(Number(fila.weightKg), 10, "el primer par lleva lo que salió del primer rollo madre");
    assert.equal(Number(fila.details.pesoR2), 5, "el segundo par lleva el excedente que salió del siguiente");
    assert.equal(fila.details.etiquetaR2, `EXT-${madreB.stationSequence}`);

    await limpiar(parent.id, child.id);
  });

  it("un pesoR2/etiquetaR2 tipeado a mano (PWA con caché vieja) no infla la producción -- el server manda", async () => {
    // La UI ya no tiene ningún input para estos dos campos (son de solo
    // lectura, se calculan solos), pero un cliente con la PWA cacheada de
    // antes de ese cambio todavía podría mandarlos en el body. El server
    // tiene que descartarlos siempre, no solo cuando de verdad hay
    // excedente entre rollos madre.
    const { parent, child, madres } = await setupRolloMadre("precorte", [20]);
    const madre = madres[0];

    // Un solo rollo madre con saldo de sobra: no hay excedente real, pero el
    // body manda pesoR2/etiquetaR2 como si el operario los hubiera tipeado.
    const res = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({
        weightKg: 10,
        sourceRollIds: [madre.id],
        sourceRollTokens: { [madre.id]: madre.possessionToken },
        details: { etiquetaR2: "EXT-999", pesoR2: 5 },
      }),
    });
    assert.equal(res.status, 201);
    const fila = (await res.json()) as { weightKg: string; details: Record<string, unknown> };

    assert.equal(Number(fila.weightKg), 10);
    assert.equal(fila.details.pesoR2, undefined, "sin excedente real, pesoR2 no debe quedar con lo que mandó el cliente");
    assert.equal(fila.details.etiquetaR2, undefined, "sin excedente real, etiquetaR2 no debe quedar con lo que mandó el cliente");
    assert.equal(await saldoDe(madre.stationSequence), 10, "el saldo del madre refleja los 10 kg reales, no 15 (10 + el pesoR2 inventado)");

    await limpiar(parent.id, child.id);
  });

  it("un pesoR2 inventado del cliente viejo no cuenta contra la meta -- una fila que entra justo no debe rechazarse", async () => {
    // Mismo escenario que el test de arriba, pero con una meta AJUSTADA
    // (no 500kg de sobra) para que el chequeo de "¿esto se pasa de lo
    // planificado?" entre en juego -- el bug real que encontró el QA era que
    // ese chequeo corría ANTES de descartar el pesoR2 falso, así que una
    // fila que en los hechos entraba justo (10kg contra una meta de 10kg)
    // se rechazaba como si fueran 15 (10 + los 5 inventados).
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 20 },
    });
    const madre = await createTestRoll(parent.id, { weightKg: 20 });
    await placeRollAt(madre.id, "precorte");
    const child = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station: "precorte", productId, quantityPlanned: 10, parentOrderId: parent.id },
    });

    const res = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 10, sourceRollIds: [madre.id], sourceRollTokens: { [madre.id]: madre.possessionToken }, details: { pesoR2: 5 } }),
    });
    assert.equal(res.status, 201, "10kg reales contra una meta de 10kg debe entrar, aunque el cliente haya mandado un pesoR2 de más");

    await limpiar(parent.id, child.id);
  });

  it("no se puede borrar un rollo madre del que ya se sacó material", async () => {
    const { parent, child, madres } = await setupRolloMadre("sellado", [45]);
    const madre = madres[0];
    assert.equal((await cargarFila(child.id, 15, [madre])).status, 201);

    const del = await fetch(`${baseUrl}/api/production-orders/${parent.id}/rolls/${madre.id}`, {
      method: "DELETE",
      headers: headersFor("produccion"),
    });
    assert.equal(del.status, 400, "borrarlo dejaría la fila que salió de él apuntando a un rollo inexistente");
    assert.match(((await del.json()) as { error: string }).error, /ya se sacó material/);

    await limpiar(parent.id, child.id);
  });

  it("borrar una fila le devuelve los kilos al rollo madre", async () => {
    const { parent, child, madres } = await setupRolloMadre("sellado", [45]);
    const madre = madres[0];

    const res = await cargarFila(child.id, 15, [madre]);
    const fila = (await res.json()) as { id: number };
    assert.equal(await saldoDe(madre.stationSequence), 30);

    const del = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls/${fila.id}`, {
      method: "DELETE",
      headers: headersFor("produccion"),
    });
    assert.equal(del.status, 204);
    assert.equal(await saldoDe(madre.stationSequence), 45, "la fila borrada libera lo que había consumido");

    await limpiar(parent.id, child.id);
  });

  it("cerrar una OP de extrusión la finaliza directo sin mover stock; sin rollos se rechaza", async () => {
    const order = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 10,
        // Cerrar Extrusión exige la fórmula completa; una ref que no está en
        // el catálogo no mueve stock (solo se avisa).
        specs: { materiaPrima: [{ ref: "TEST-NO-EXISTE", pct: 100 }] },
      },
    });

    const sinRollos = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(sinRollos.status, 400, "no se cierra una OP sin rollos");

    await createTestRoll(order.id, { weightKg: 10 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(res.status, 200);
    const closed = (await res.json()) as { status: string };
    assert.equal(closed.status, "finalizada", "extrusión no pasa por calidad");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(Number(stockDespues?.currentQuantity ?? 0), Number(stockAntes?.currentQuantity ?? 0), "extrusión no mueve stock");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("cerrar una OP final (sellado) la deja pendiente_calidad y notifica a Calidad (sin mover stock)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10 },
    });
    await createTestRoll(order.id, { weightKg: 12 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
    });
    assert.equal(res.status, 200);

    const updated = await prisma.productionOrder.findUnique({ where: { id: order.id } });
    assert.equal(updated!.status, "pendiente_calidad");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(Number(stockDespues?.currentQuantity ?? 0), Number(stockAntes?.currentQuantity ?? 0), "el cierre no mueve stock todavía");

    const notif = await prisma.notification.findFirst({
      where: { type: "op_pendiente_calidad", message: { contains: order.orderNumber } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(notif, "Calidad debió recibir una notificación");
    assert.equal(notif!.link, "/calidad");

    await prisma.notification.delete({ where: { id: notif!.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("dos clics casi simultáneos en 'Cerrar' no descuentan materia prima dos veces (gate atómico de estado)", async () => {
    const material = await prisma.rawMaterial.create({
      data: { code: `TEST-RM-${Date.now()}`, name: "Materia prima test" },
    });
    await fetch(`${baseUrl}/api/raw-materials/${material.id}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: 100, type: "compra", notes: "Stock inicial de prueba" }),
    });
    const order = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 10,
        // 50% sobre 10 kg producidos = 5 kg.
        specs: { materiaPrima: [{ ref: material.code, pct: 50 }, { ref: "TEST-NO-EXISTE", pct: 50 }] },
      },
    });
    await createTestRoll(order.id, { weightKg: 10 });

    const close = () =>
      fetch(`${baseUrl}/api/production-orders/${order.id}/close`, { method: "POST", headers: headersFor("operario_extrusion") });
    const [a, b] = await Promise.all([close(), close()]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 400], "solo uno de los dos cierres simultáneos debe tener éxito");

    const stockMaterial = await prisma.rawMaterialStock.findUnique({ where: { rawMaterialId: material.id } });
    assert.equal(Number(stockMaterial!.currentQuantity), 95, "la materia prima solo se descuenta una vez, no dos");

    await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: material.id } });
    await prisma.rawMaterialStock.delete({ where: { rawMaterialId: material.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.rawMaterial.delete({ where: { id: material.id } });
  });

  it("Sellado y Precorte son roles distintos: cada uno solo puede cargar rollos/cerrar OPs de su propia estación", async () => {
    const selladoOrder = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}s`, station: "sellado", productId, quantityPlanned: 10 },
    });
    const precorteOrder = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}p`, station: "precorte", productId, quantityPlanned: 10 },
    });

    const precorteEnSellado = await fetch(`${baseUrl}/api/production-orders/${selladoOrder.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
      body: JSON.stringify({ weightKg: 10 }),
    });
    assert.equal(precorteEnSellado.status, 403, "operario de precorte no puede cargar rollos en una OP de sellado");

    const selladoEnPrecorte = await fetch(`${baseUrl}/api/production-orders/${precorteOrder.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ weightKg: 10 }),
    });
    assert.equal(selladoEnPrecorte.status, 403, "operario de sellado no puede cargar rollos en una OP de precorte");

    await createTestRoll(precorteOrder.id, { weightKg: 10 });
    const cierreCruzado = await fetch(`${baseUrl}/api/production-orders/${precorteOrder.id}/close`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
    });
    assert.equal(cierreCruzado.status, 403, "operario de sellado no puede cerrar una OP de precorte");

    const cierreCorrecto = await fetch(`${baseUrl}/api/production-orders/${precorteOrder.id}/close`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
    });
    assert.equal(cierreCorrecto.status, 200, "el propio operario de precorte sí puede cerrarla");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: precorteOrder.id } });
    await prisma.productionOrder.delete({ where: { id: precorteOrder.id } });
    await prisma.productionOrder.delete({ where: { id: selladoOrder.id } });
  });

  it("Impresión también es proceso final: cerrarla deja pendiente_calidad, y Calidad aprobándola suma al inventario — funciona aunque además tenga una OP derivada a Sellado", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "impresion", productId, quantityPlanned: 20 },
    });
    await createTestRoll(order.id, { weightKg: 20 });

    // Impresión puede además derivar a Sellado — cerrar y derivar son
    // decisiones independientes, no debería bloquear una a la otra.
    const derive = await fetch(`${baseUrl}/api/production-orders/${order.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(derive.status, 201);
    const derived = (await derive.json()) as { id: number };

    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });
    const close = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_impresion"),
    });
    assert.equal(close.status, 200);
    const closed = (await close.json()) as { status: string };
    assert.equal(closed.status, "pendiente_calidad", "Impresión ahora es proceso final, no queda 'finalizada' directo");

    const qc = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(qc.status, 201);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(
      Number(stockDespues?.currentQuantity ?? 0),
      Number(stockAntes?.currentQuantity ?? 0) + 20,
      "al aprobarse, los 20kg de Impresión entran al inventario, igual que Sellado/Precorte"
    );

    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: derived.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("alertThresholdKg configurable: al llegar al umbral elegido (no al 90% por defecto) notifica a Gestión", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 100, alertThresholdKg: 30 },
    });

    // 25kg: todavía no llega al umbral configurado (30kg) — con el 90% por
    // defecto tampoco notificaría, pero lo importante acá es que el default
    // NO se está usando, se está usando el umbral elegido.
    const r1 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 25 }),
    });
    assert.equal(r1.status, 201);
    const notifsAfterR1 = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.equal(notifsAfterR1, 0);

    // +6kg = 31kg, cruza el umbral de 30 configurado (muy por debajo del 90% default de 90kg).
    const r2 = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
      body: JSON.stringify({ weightKg: 6 }),
    });
    assert.equal(r2.status, 201);
    const notifsAfterR2 = await prisma.notification.count({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    assert.ok(notifsAfterR2 > notifsAfterR1, "cruzó el umbral configurado (30kg), aunque sea muy por debajo del 90% por defecto");

    // Gestión puede editarlo por PATCH también.
    const patch = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ alertThresholdKg: 50 }),
    });
    assert.equal(patch.status, 200);
    const patched = (await patch.json()) as { alertThresholdKg: unknown };
    assert.equal(Number(patched.alertThresholdKg), 50);

    await prisma.notification.deleteMany({ where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("Calidad aprueba: genera la entrada de inventario con la suma de kg de los rollos y finaliza la OP", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "precorte", productId, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 5 });
    await createTestRoll(order.id, { weightKg: 3 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(res.status, 201);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(Number(stockDespues!.currentQuantity), Number(stockAntes?.currentQuantity ?? 0) + 8, "entra la suma de los rollos (5+3)");

    const updated = await prisma.productionOrder.findUnique({ where: { id: order.id } });
    assert.equal(updated!.status, "finalizada");

    // Un segundo control de calidad sobre la misma OP debe rechazarse.
    const dup = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(dup.status, 400);

    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("Calidad aprueba una OP con cliente asignado: entra a inventario IGUAL que sin cliente, y además genera un Despacho pendiente para ese cliente, notificando a Almacén", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-QC-CLIENTE-${Date.now()}` } });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, clientId: client.id, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 6 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(res.status, 201);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(
      Number(stockDespues!.currentQuantity),
      Number(stockAntes?.currentQuantity ?? 0) + 6,
      "sigue entrando a inventario igual que una OP sin cliente"
    );

    const dispatch = await prisma.dispatch.findFirst({
      where: { clientId: client.id },
      include: { items: true },
      orderBy: { id: "desc" },
    });
    assert.ok(dispatch, "debió crearse un Despacho para el cliente de la OP");
    assert.equal(dispatch!.status, "pendiente");
    assert.equal(dispatch!.items.length, 1);
    assert.equal(dispatch!.items[0].productId, productId);
    assert.equal(Number(dispatch!.items[0].quantityRequested), 6);
    assert.equal(dispatch!.items[0].quantityDispatched, null, "todavía no se despachó de verdad, solo se preparó");

    const notif = await prisma.notification.findFirst({
      where: { type: "despacho_generado_desde_op", message: { contains: order.orderNumber } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(notif, "Almacén debió recibir una notificación del despacho generado");
    assert.equal(notif!.link, "/despachos");

    await prisma.notification.delete({ where: { id: notif!.id } });
    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch!.id } });
    await prisma.dispatch.delete({ where: { id: dispatch!.id } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("no se puede reabrir una OP que ya generó un Despacho para su cliente — hay que resolver ese despacho primero", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-REOPEN-DISPATCH-${Date.now()}` } });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, clientId: client.id, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 6 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const approve = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(approve.status, 201);

    const dispatch = await prisma.dispatch.findFirst({ where: { productionOrderId: order.id } });
    assert.ok(dispatch, "debió crearse el despacho automático");

    const reopen = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(reopen.status, 400, "no se puede reabrir mientras el despacho siga vivo");
    const reopenBody = (await reopen.json()) as { error: string };
    assert.match(reopenBody.error, new RegExp(`Despacho #${dispatch!.id}`));

    // Al cancelar/borrar el despacho, ya se puede reabrir normalmente.
    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch!.id } });
    await prisma.dispatch.delete({ where: { id: dispatch!.id } });

    const reopenOk = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(reopenOk.status, 200, "una vez resuelto el despacho, sí se puede reabrir");

    await prisma.notification.deleteMany({ where: { type: "despacho_generado_desde_op", message: { contains: order.orderNumber } } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("en Precorte, el segundo peso de la fila (details.pesoR2) cuenta como material real: entra en la meta y en el inventario al aprobar", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "precorte", productId, quantityPlanned: 15 },
    });

    // 8kg del rollo base + 7kg del segundo rollo (details.pesoR2) = 15kg,
    // justo la meta -- si pesoR2 no contara, la OP creería que solo lleva
    // 8kg y dejaría cargar más de lo que hay material físico disponible.
    const roll = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
      body: JSON.stringify({ weightKg: 8, details: { pesoR2: 7 } }),
    });
    assert.equal(roll.status, 201);

    const exceeds = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
      body: JSON.stringify({ weightKg: 1 }),
    });
    assert.equal(exceeds.status, 400, "la meta ya se completó contando pesoR2 (8+7=15), no debería aceptar más");

    const close = await fetch(`${baseUrl}/api/production-orders/${order.id}/close`, {
      method: "POST",
      headers: headersFor("operario_precorte"),
    });
    assert.equal(close.status, 200);

    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });
    const approve = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(approve.status, 201);
    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(
      Number(stockDespues!.currentQuantity) - Number(stockAntes?.currentQuantity ?? 0),
      15,
      "el inventario suma peso base + pesoR2 (8+7), no solo el peso base"
    );

    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("Calidad rechaza: deja la OP detenida sin mover stock y notifica a Producción/Gestión", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, productId, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "rechazado", observations: "Merma excesiva" }),
    });
    assert.equal(res.status, 201);

    const updated = await prisma.productionOrder.findUnique({ where: { id: order.id } });
    assert.equal(updated!.status, "detenida");

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(Number(stockDespues?.currentQuantity ?? 0), Number(stockAntes?.currentQuantity ?? 0));

    const notif = await prisma.notification.findFirst({
      where: { type: "op_rechazada", message: { contains: order.orderNumber } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(notif, "Producción/Gestión debió recibir una notificación de rechazo");

    await prisma.notification.delete({ where: { id: notif!.id } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("reabrir exige gestión de producción (403 para un operario)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, productId, quantityPlanned: 10, status: "detenida" },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("operario_extrusion"),
    });
    assert.equal(res.status, 403);
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("no se puede reabrir una OP que ya está abierta (400)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, productId, quantityPlanned: 10, status: "en_proceso" },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(res.status, 400);
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("reabrir una OP con calidad APROBADA revierte la entrada de inventario, borra el control y vuelve a en_proceso", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "precorte", productId, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 5 });
    await createTestRoll(order.id, { weightKg: 3 });
    const stockAntes = await prisma.inventoryStock.findUnique({ where: { productId } });

    const approve = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(approve.status, 201);
    const stockAprobado = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(Number(stockAprobado!.currentQuantity), Number(stockAntes?.currentQuantity ?? 0) + 8);

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; reversedProductKg: number };
    assert.equal(body.status, "en_proceso");
    assert.equal(body.reversedProductKg, 8);

    const stockDespues = await prisma.inventoryStock.findUnique({ where: { productId } });
    assert.equal(
      Number(stockDespues!.currentQuantity),
      Number(stockAntes?.currentQuantity ?? 0),
      "el stock vuelve exactamente a como estaba antes de aprobar"
    );

    const check = await prisma.qualityCheck.findUnique({ where: { productionOrderId: order.id } });
    assert.equal(check, null, "el control de calidad se borra al reabrir, para poder volver a pasar por Calidad");

    // Ya no se puede reabrir de nuevo (está en_proceso, no en un estado reabrible).
    const again = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(again.status, 400);

    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "manual_adjustment", productId, createdAt: { gte: order.createdAt } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.inventoryStock.update({ where: { productId }, data: { currentQuantity: stockAntes?.currentQuantity ?? 0 } });
  });

  it("si parte del producto que aprobó una OP ya se despachó A MANO (sin pasar por el despacho automático), reabrir se bloquea en vez de dejar el stock en negativo", async () => {
    // Producto dedicado con stock en 0 -- BUL-001 (el `productId` compartido
    // de este describe) acumula stock de cientos de tests anteriores, así
    // que nunca se quedaría corto para un escenario de "no alcanza".
    const dedicatedProduct = await prisma.product.create({
      data: { sku: `TEST-REOPEN-STOCK-${Date.now()}`, name: "Producto dedicado reopen/stock", category: "tiras", unit: "kg", minStock: 0 },
    });
    const client = await prisma.client.create({ data: { name: `TEST-REOPEN-MANUAL-DISPATCH-${Date.now()}` } });
    const order = await prisma.productionOrder.create({
      // Sin clientId -- entra a stock general, no genera despacho automático.
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId: dedicatedProduct.id, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 8 });

    const approve = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(approve.status, 201);

    // Almacén arma un despacho A MANO (no generado por esta OP) y saca casi
    // todo lo que había -- el guard de /reopen busca despachos con
    // productionOrderId = esta OP, así que este NO lo detecta directamente.
    const manualDispatch = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: client.id, items: [{ productId: dedicatedProduct.id, quantityRequested: 7 }] }),
    });
    const manualDispatchBody = (await manualDispatch.json()) as { id: number; items: { id: number }[] };
    const completeManual = await fetch(`${baseUrl}/api/dispatches/${manualDispatchBody.id}/items/${manualDispatchBody.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 7 }),
    });
    assert.equal(completeManual.status, 200);

    // Reabrir intentaría revertir los 8kg que sumó la aprobación, pero solo
    // queda 1kg real en stock (8 - 7 despachados a mano) -- el chequeo de
    // stock nunca-negativo (fix #2) bloquea la reversión en vez de dejar el
    // producto en -7.
    const reopen = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, { method: "POST", headers: headersFor("produccion") });
    assert.equal(reopen.status, 400, "no hay suficiente stock real para revertir los 8kg de la aprobación");
    const reopenBody = (await reopen.json()) as { error: string };
    assert.match(reopenBody.error, /No se puede reabrir/);

    const stockFinal = await prisma.inventoryStock.findUnique({ where: { productId: dedicatedProduct.id } });
    assert.equal(Number(stockFinal?.currentQuantity ?? 0), 1, "8 aprobados - 7 despachados a mano = 1, sin tocar por el intento de reabrir");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: manualDispatchBody.id } });
    await prisma.inventoryMovement.deleteMany({ where: { productId: dedicatedProduct.id } });
    await prisma.dispatch.delete({ where: { id: manualDispatchBody.id } });
    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.inventoryStock.deleteMany({ where: { productId: dedicatedProduct.id } });
    await prisma.product.delete({ where: { id: dedicatedProduct.id } });
  });

  it("reabrir una OP con calidad RECHAZADA solo borra el control (nunca movió stock)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, productId, quantityPlanned: 10, status: "pendiente_calidad" },
    });
    const reject = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "rechazado" }),
    });
    assert.equal(reject.status, 201);

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/reopen`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; reversedProductKg: number };
    assert.equal(body.status, "en_proceso");
    assert.equal(body.reversedProductKg, 0);

    const check = await prisma.qualityCheck.findUnique({ where: { productionOrderId: order.id } });
    assert.equal(check, null);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("cola de Planeación: genera la OP de un ítem pendiente y ya no lo vuelve a listar", async () => {
    const pending = await fetch(`${baseUrl}/api/production-orders/pending-planning`, { headers: headersFor("planeacion") });
    assert.equal(pending.status, 200);
    const items = (await pending.json()) as { pedidoVersionItemId: number; productSku: string }[];
    assert.ok(Array.isArray(items));
    assert.ok(items.length > 0, "El seed (PED-SEED-PLANEACION) debe dejar al menos un ítem pendiente");
    const target = items[0];

    const generate = await fetch(`${baseUrl}/api/production-orders/from-pedido-item/${target.pedidoVersionItemId}`, {
      method: "POST",
      headers: headersFor("planeacion"),
    });
    assert.equal(generate.status, 201);
    const order = (await generate.json()) as { id: number; pedidoVersionItemId: number; station: string | null; clientId: number | null };
    assert.equal(order.pedidoVersionItemId, target.pedidoVersionItemId);
    assert.equal(order.station, null, "la OP de Planeación nace sin proceso asignado, igual que la creación manual");
    assert.ok(order.clientId, "hereda el cliente del pedido");

    const dup = await fetch(`${baseUrl}/api/production-orders/from-pedido-item/${target.pedidoVersionItemId}`, {
      method: "POST",
      headers: headersFor("planeacion"),
    });
    assert.equal(dup.status, 400);

    const after2 = await fetch(`${baseUrl}/api/production-orders/pending-planning`, { headers: headersFor("planeacion") });
    const itemsAfter = (await after2.json()) as { pedidoVersionItemId: number }[];
    assert.ok(!itemsAfter.some((i) => i.pedidoVersionItemId === target.pedidoVersionItemId), "el ítem generado ya no debe listarse");

    // Se libera el ítem para que el seed siga siendo reutilizable en próximas corridas.
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("GET /:id (Trazabilidad) devuelve el detalle completo (rollos, derivación) y 404 si no existe", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 10 },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}`, { headers: headersFor("auditor") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; product: { sku: string }; rolls: unknown[]; derivedOrders: unknown[]; attachments: unknown[] };
    assert.equal(body.id, order.id);
    assert.equal(body.product.sku, "BUL-001");
    assert.ok(Array.isArray(body.rolls));
    assert.ok(Array.isArray(body.derivedOrders));
    assert.ok(Array.isArray(body.attachments));

    const notFound = await fetch(`${baseUrl}/api/production-orders/999999999`, { headers: headersFor("auditor") });
    assert.equal(notFound.status, 404);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("GET /:id/report.pdf devuelve el reporte consolidado en PDF", async () => {
    const order = await prisma.productionOrder.create({
      data: {
        orderNumber: `OP-TEST-${Date.now()}`,
        station: "extrusion",
        productId,
        quantityPlanned: 100,
        specs: { formaMaterial: "Tubular", materiaPrima: [{ ref: "ALTA", pct: 70, lote: "L-1" }], maquina: "Extrusora 1" },
      },
    });
    await createTestRoll(order.id, { shift: "Turno 1", label: "R-1", weightKg: 50, details: { pResistencia: "SI" } });

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/report.pdf`, { headers: headersFor("produccion") });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/pdf/);
    const buffer = Buffer.from(await res.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");
    assert.ok(buffer.length > 1000, "el PDF debe tener contenido real");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("PATCH /:id edita specs solo mientras la OP está abierta", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10, specs: { tipoMaterial: "Tubular" } },
    });

    const ok = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ specs: { tipoMaterial: "Semitubular", medAncho: "14" }, quantityPlanned: 20 }),
    });
    assert.equal(ok.status, 200);
    const updated = (await ok.json()) as { specs: any; quantityPlanned: unknown };
    assert.equal(updated.specs.medAncho, "14");
    assert.equal(Number(updated.quantityPlanned), 20);

    await prisma.productionOrder.update({ where: { id: order.id }, data: { status: "finalizada" } });
    const cerrada = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ specs: { tipoMaterial: "Tubular" } }),
    });
    assert.equal(cerrada.status, 400, "una OP cerrada no se edita");

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("PATCH /:id rechaza un clientId inexistente con 404 (antes tiraba un 500 crudo por la FK)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10 },
    });
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId: 999999999 }),
    });
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Cliente no encontrado/);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("PATCH /:id cambia el destino de la OP (estantería <-> cliente) mientras siga abierta", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-DESTINO-${Date.now()}` } });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10 },
    });
    assert.equal(order.clientId, null, "nace en estantería (sin cliente) por defecto");

    const toClient = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId: client.id }),
    });
    assert.equal(toClient.status, 200);
    const toClientBody = (await toClient.json()) as { clientId: number | null };
    assert.equal(toClientBody.clientId, client.id);

    // Y de vuelta a estantería (clientId: null explícito).
    const toShelf = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId: null }),
    });
    assert.equal(toShelf.status, 200);
    const toShelfBody = (await toShelf.json()) as { clientId: number | null };
    assert.equal(toShelfBody.clientId, null);

    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("PATCH /:id no deja bajar la meta por debajo de lo ya cargado (peso + desperdicio)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 100 },
    });
    await createTestRoll(order.id, { weightKg: 70, wasteKg: 10 });

    const bad = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ quantityPlanned: 20 }),
    });
    assert.equal(bad.status, 400, "80kg ya cargados (70+10), no se puede bajar la meta a 20");

    const ok = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ quantityPlanned: 80 }),
    });
    assert.equal(ok.status, 200, "bajar exactamente a lo ya cargado sí se permite");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("PATCH /:id rechaza un alertThresholdKg mayor a la meta (nunca se cruzaría)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 50 },
    });
    const bad = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ alertThresholdKg: 60 }),
    });
    assert.equal(bad.status, 400);

    const ok = await fetch(`${baseUrl}/api/production-orders/${order.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ alertThresholdKg: 40 }),
    });
    assert.equal(ok.status, 200);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("editar specs del padre NO pisa las specs de una hija ya finalizada/cancelada (solo hijas abiertas/borrador)", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "extrusion", productId, quantityPlanned: 40, specs: { color: "Blanco" } },
    });
    const childFinalizada = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station: "sellado", productId, quantityPlanned: 40, parentOrderId: parent.id, status: "finalizada", specs: { color: "Blanco" } },
    });
    const childAbierta = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station: "precorte", productId, quantityPlanned: 40, parentOrderId: parent.id, specs: { color: "Blanco" } },
    });

    const res = await fetch(`${baseUrl}/api/production-orders/${parent.id}`, {
      method: "PATCH",
      headers: headersFor("produccion"),
      body: JSON.stringify({ specs: { color: "Rojo" } }),
    });
    assert.equal(res.status, 200);

    const finalizadaAfter = await prisma.productionOrder.findUnique({ where: { id: childFinalizada.id } });
    assert.equal((finalizadaAfter!.specs as any).color, "Blanco", "una hija finalizada no se toca (su PDF ya se imprimió/archivó)");

    const abiertaAfter = await prisma.productionOrder.findUnique({ where: { id: childAbierta.id } });
    assert.equal((abiertaAfter!.specs as any).color, "Rojo", "una hija todavía abierta sí sigue recibiendo la cascada");

    await prisma.productionOrder.delete({ where: { id: childFinalizada.id } });
    await prisma.productionOrder.delete({ where: { id: childAbierta.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("no se puede derivar una segunda vez mientras el padre sigue en borrador (sin liberar)", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, productId, quantityPlanned: 40, status: "borrador", specs: { materiaPrima: [{ ref: "ALTA", pct: 100 }] } },
    });
    const toExtrusion = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "extrusion" }),
    });
    assert.equal(toExtrusion.status, 200, "la primera derivación (asignar Extrusión) sí se permite en borrador");

    const toSellado = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(toSellado.status, 400, "derivar a un segundo proceso crea una fila visible para planta -- no puede pasar mientras el padre sigue sin liberar");

    await fetch(`${baseUrl}/api/production-orders/${parent.id}/release`, { method: "POST", headers: headersFor("produccion") });
    const toSelladoOk = await fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ station: "sellado" }),
    });
    assert.equal(toSelladoOk.status, 201, "una vez liberada, sí se puede derivar de nuevo");
    const derivedBody = (await toSelladoOk.json()) as { id: number };

    await prisma.productionOrder.delete({ where: { id: derivedBody.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("adjuntos: un operario de otra estación no puede subir, y no se puede subir a una OP ya cerrada", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10 },
    });

    const wrongStation = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.operario_precorte}` },
      body: (() => {
        const form = new FormData();
        form.append("file", new Blob(["contenido"], { type: "text/plain" }), "nota.txt");
        return form;
      })(),
    });
    assert.equal(wrongStation.status, 403, "un operario de otra estación no puede adjuntar acá");

    await prisma.productionOrder.update({ where: { id: order.id }, data: { status: "finalizada" } });
    const closedOrder = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.operario_sellado}` },
      body: (() => {
        const form = new FormData();
        form.append("file", new Blob(["contenido"], { type: "text/plain" }), "nota.txt");
        return form;
      })(),
    });
    assert.equal(closedOrder.status, 400, "no se puede adjuntar a una OP que ya no está abierta");

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("DELETE /:id/attachments/:attachmentId borra el adjunto (solo Gestión)", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 10 },
    });
    const form = new FormData();
    form.append("file", new Blob(["contenido"], { type: "text/plain" }), "nota.txt");
    const uploaded = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.operario_sellado}` },
      body: form,
    });
    assert.equal(uploaded.status, 201);
    const attachment = (await uploaded.json()) as { id: number };

    const deniedDelete = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: headersFor("operario_sellado"),
    });
    assert.equal(deniedDelete.status, 403, "un operario no puede borrar adjuntos, solo Gestión");

    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments/${attachment.id}`, {
      method: "DELETE",
      headers: headersFor("produccion"),
    });
    assert.equal(res.status, 204);

    const listAfter = await fetch(`${baseUrl}/api/production-orders/${order.id}/attachments`, { headers: headersFor("produccion") });
    const attachmentsAfter = (await listAfter.json()) as { id: number }[];
    assert.ok(!attachmentsAfter.some((a) => a.id === attachment.id));

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("el aviso de completarse dispara aunque el rollo que cruza el umbral complete la OP en el mismo golpe", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 40, alertThresholdKg: 35 },
    });
    // Un solo rollo de 40kg salta directo de 0 a completo (40/40), cruzando
    // el umbral (35) y completando la meta en el mismo golpe -- antes esto
    // no disparaba ningún aviso (ni "próxima" ni ningún otro).
    const res = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ weightKg: 40 }),
    });
    assert.equal(res.status, 201);

    const notif = await prisma.notification.findFirst({
      where: { type: "op_proxima_a_completarse", message: { contains: order.orderNumber } },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(notif, "debió avisar aunque la OP se haya completado en el mismo rollo que cruzó el umbral");
    assert.match(notif!.message, /se completó/);

    await prisma.notification.delete({ where: { id: notif!.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });
});

describe("etiquetas de bulto (E. BULTO escaneable en Sellado/Precorte)", () => {
  let productId = 0;

  before(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    productId = product.id;
  });

  it("devuelve 403 para un rol sin acceso a producción (ventas)", async () => {
    const res = await fetch(`${baseUrl}/api/bulto-labels`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("solo Gestión puede generar un lote; un operario no", async () => {
    const asOperario = await fetch(`${baseUrl}/api/bulto-labels/generate`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ count: 3 }),
    });
    assert.equal(asOperario.status, 403);

    const res = await fetch(`${baseUrl}/api/bulto-labels/generate`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ count: 3 }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: number; code: string; status: string }[];
    assert.equal(created.length, 3);
    assert.ok(created.every((l) => l.status === "disponible"));
    assert.ok(created.every((l) => /^EXT-\d{5}$/.test(l.code)));

    await prisma.bultoLabel.deleteMany({ where: { id: { in: created.map((l) => l.id) } } });
  });

  it("escanear (by-code) y cargar un rollo con bultoLabelCode consume la etiqueta atómicamente; reusarla da 400", async () => {
    const gen = await fetch(`${baseUrl}/api/bulto-labels/generate`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ count: 1 }),
    });
    const [label] = (await gen.json()) as { id: number; code: string }[];

    const byCode = await fetch(`${baseUrl}/api/bulto-labels/by-code/${label.code}`, { headers: headersFor("operario_sellado") });
    assert.equal(byCode.status, 200);
    const resolved = (await byCode.json()) as { status: string };
    assert.equal(resolved.status, "disponible");

    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 200 },
    });

    const roll = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ weightKg: 30, bultoLabelCode: label.code }),
    });
    assert.equal(roll.status, 201);
    const rollBody = (await roll.json()) as { id: number; details: any };
    assert.equal(rollBody.details.eBulto, label.code, "el server completa details.eBulto solo, no hace falta mandarlo aparte");

    const usedLabel = await prisma.bultoLabel.findUnique({ where: { id: label.id } });
    assert.equal(usedLabel?.status, "usada");
    assert.equal(usedLabel?.usedByRollId, rollBody.id);

    // Reusar la misma etiqueta (ya usada) en otro rollo se rechaza.
    const reuse = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ weightKg: 20, bultoLabelCode: label.code }),
    });
    assert.equal(reuse.status, 400);

    const byCodeAfter = await fetch(`${baseUrl}/api/bulto-labels/by-code/${label.code}`, { headers: headersFor("operario_sellado") });
    const resolvedAfter = (await byCodeAfter.json()) as { status: string };
    assert.equal(resolvedAfter.status, "usada");

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.bultoLabel.delete({ where: { id: label.id } });
  });

  it("un código de etiqueta inexistente da 400 al cargar el rollo, y 404 al resolverlo", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-${Date.now()}`, station: "sellado", productId, quantityPlanned: 50 },
    });

    const notFound = await fetch(`${baseUrl}/api/bulto-labels/by-code/EXT-NOEXISTE`, { headers: headersFor("operario_sellado") });
    assert.equal(notFound.status, 404);

    const roll = await fetch(`${baseUrl}/api/production-orders/${order.id}/rolls`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ weightKg: 15, bultoLabelCode: "EXT-NOEXISTE" }),
    });
    assert.equal(roll.status, 400);

    await prisma.productionOrder.delete({ where: { id: order.id } });
  });
});

describe("cotizaciones → pedido → factura → pagos", () => {
  let clientId = 0;
  let productId = 0;
  let unitPrice = 0;

  before(async () => {
    const client = await prisma.client.create({ data: { name: `TEST-COT-CLIENT-${Date.now()}` } });
    clientId = client.id;
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    productId = product.id;
    unitPrice = Number(product.unitPrice);
  });

  after(async () => {
    await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  });

  it("devuelve 403 para un rol sin acceso a Cotizaciones", async () => {
    const res = await fetch(`${baseUrl}/api/cotizaciones`, { headers: headersFor("almacen") });
    assert.equal(res.status, 403);
  });

  it("crea una cotización, hereda el precio de catálogo, la convierte a pedido, factura y cobra", async () => {
    // 1. Cotización: el ítem no trae unitPrice → hereda el del catálogo.
    const cotRes = await fetch(`${baseUrl}/api/cotizaciones`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 4 }] }),
    });
    assert.equal(cotRes.status, 201);
    const cotizacion = (await cotRes.json()) as { id: number; quoteNumber: string; items: { unitPrice: string }[] };
    assert.match(cotizacion.quoteNumber, /^COT-\d{5}$/);
    assert.equal(Number(cotizacion.items[0].unitPrice), unitPrice);

    // 2. Cambiar estado.
    const statusRes = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/status`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "aceptada" }),
    });
    assert.equal(statusRes.status, 200);

    // 3. Convertir a pedido (v1, sin borrar la cotización).
    const pedRes = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/convertir-a-pedido`, {
      method: "POST",
      headers: headersFor("ventas"),
    });
    assert.equal(pedRes.status, 201);
    const pedido = (await pedRes.json()) as { id: number; orderNumber: string; versions: { items: { quantity: string }[] }[] };
    assert.match(pedido.orderNumber, /^PED-\d{5}$/);
    assert.equal(pedido.versions[0].items.length, 1);
    assert.equal(Number(pedido.versions[0].items[0].quantity), 4);

    const cotDespues = await prisma.cotizacion.findUnique({ where: { id: cotizacion.id } });
    assert.ok(cotDespues, "la cotización no se borra al convertir");

    // 4. Editar el pedido crea una v2 (no sobrescribe).
    const editRes = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "aprobado", items: [{ productId, quantity: 6 }] }),
    });
    assert.equal(editRes.status, 201, "PATCH /pedidos/:id crea una versión nueva → 201");
    const versions = await fetch(`${baseUrl}/api/pedidos/${pedido.id}/versions`, { headers: headersFor("ventas") });
    const versionsBody = (await versions.json()) as { versionNumber: number }[];
    assert.equal(versionsBody.length, 2);

    // 5. Factura desde el pedido: copia la ÚLTIMA versión (v2, cantidad 6).
    const facRes = await fetch(`${baseUrl}/api/facturas/desde-pedido/${pedido.id}`, {
      method: "POST",
      headers: headersFor("ventas"),
    });
    assert.equal(facRes.status, 201);
    const factura = (await facRes.json()) as { id: number; invoiceNumber: string; status: string; items: { quantity: string }[] };
    assert.match(factura.invoiceNumber, /^FAC-\d{5}$/);
    assert.equal(factura.status, "emitida");
    assert.equal(Number(factura.items[0].quantity), 6);

    const total = 6 * unitPrice;

    // 6. Abono parcial → pagada_parcial.
    const pagoParcial = await fetch(`${baseUrl}/api/facturas/${factura.id}/payments`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ amount: total / 2, method: "transferencia" }),
    });
    assert.equal(pagoParcial.status, 201);
    let facturaActual = await prisma.factura.findUnique({ where: { id: factura.id } });
    assert.equal(facturaActual!.status, "pagada_parcial");

    // 7. Abono restante → pagada.
    const pagoFinal = await fetch(`${baseUrl}/api/facturas/${factura.id}/payments`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ amount: total / 2, method: "efectivo" }),
    });
    assert.equal(pagoFinal.status, 201);
    facturaActual = await prisma.factura.findUnique({ where: { id: factura.id } });
    assert.equal(facturaActual!.status, "pagada");

    // 8. Anular: acción manual; después no admite más pagos.
    const anular = await fetch(`${baseUrl}/api/facturas/${factura.id}/anular`, {
      method: "PATCH",
      headers: headersFor("ventas"),
    });
    assert.equal(anular.status, 200);
    const pagoTrasAnular = await fetch(`${baseUrl}/api/facturas/${factura.id}/payments`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ amount: 1, method: "efectivo" }),
    });
    assert.equal(pagoTrasAnular.status, 400);

    // Cleanup completo del árbol creado.
    await prisma.payment.deleteMany({ where: { facturaId: factura.id } });
    await prisma.facturaItem.deleteMany({ where: { facturaId: factura.id } });
    await prisma.factura.delete({ where: { id: factura.id } });
    const allVersions = await prisma.pedidoVersion.findMany({ where: { pedidoId: pedido.id } });
    for (const v of allVersions) {
      await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersionId: v.id } });
    }
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });
    await prisma.cotizacionItem.deleteMany({ where: { cotizacionId: cotizacion.id } });
    await prisma.cotizacion.delete({ where: { id: cotizacion.id } });
  });

  it("no se puede convertir dos veces la misma cotización (400, no un choque de FK crudo)", async () => {
    const cotRes = await fetch(`${baseUrl}/api/cotizaciones`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 2 }] }),
    });
    const cotizacion = (await cotRes.json()) as { id: number };

    const noAceptada = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/convertir-a-pedido`, {
      method: "POST",
      headers: headersFor("ventas"),
    });
    assert.equal(noAceptada.status, 400, "solo se puede convertir una cotización aceptada");

    await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/status`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "aceptada" }),
    });

    const first = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/convertir-a-pedido`, {
      method: "POST",
      headers: headersFor("ventas"),
    });
    assert.equal(first.status, 201);
    const pedido = (await first.json()) as { id: number };

    const second = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/convertir-a-pedido`, {
      method: "POST",
      headers: headersFor("ventas"),
    });
    assert.equal(second.status, 400);

    const allVersions = await prisma.pedidoVersion.findMany({ where: { pedidoId: pedido.id } });
    for (const v of allVersions) await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersionId: v.id } });
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });
    await prisma.cotizacionItem.deleteMany({ where: { cotizacionId: cotizacion.id } });
    await prisma.cotizacion.delete({ where: { id: cotizacion.id } });
  });

  it("PATCH /pedidos/:id rechaza transiciones inválidas y productos repetidos", async () => {
    const createRes = await fetch(`${baseUrl}/api/pedidos`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 1 }] }),
    });
    const pedido = (await createRes.json()) as { id: number };

    // borrador → despachado: transición imposible, se salta todo el flujo.
    const badTransition = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "despachado", items: [{ productId, quantity: 1 }] }),
    });
    assert.equal(badTransition.status, 400);

    const dupeItems = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({
        status: "pendiente",
        items: [
          { productId, quantity: 1 },
          { productId, quantity: 2 },
        ],
      }),
    });
    assert.equal(dupeItems.status, 400, "el mismo producto dos veces en items debe rechazarse");

    await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersion: { pedidoId: pedido.id } } });
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });
  });

  it("PATCH /pedidos/:id se bloquea si ya hay una OP generada desde el pedido", async () => {
    const createRes = await fetch(`${baseUrl}/api/pedidos`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 3 }] }),
    });
    const pedido = (await createRes.json()) as { id: number; versions: { items: { id: number }[] }[] };

    // El PATCH crea una v2 (mismo comportamiento aunque solo cambie el
    // status) -- el ítem que sirve para generar la OP es el de la versión
    // NUEVA (currentVersion), no el de la v1 original.
    const aprobar = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "aprobado", items: [{ productId, quantity: 3 }] }),
    });
    assert.equal(aprobar.status, 201);
    const aprobarBody = (await aprobar.json()) as { items: { id: number }[] };
    const itemId = aprobarBody.items[0].id;

    const generate = await fetch(`${baseUrl}/api/production-orders/from-pedido-item/${itemId}`, {
      method: "POST",
      headers: headersFor("planeacion"),
    });
    assert.equal(generate.status, 201);
    const order = (await generate.json()) as { id: number };

    const blockedEdit = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "en_produccion", items: [{ productId, quantity: 5 }] }),
    });
    assert.equal(blockedEdit.status, 400, "no se puede cambiar los ítems de un pedido con OP ya generada");

    // Pero SÍ se puede avanzar el status con los mismos ítems -- si no, el
    // pedido queda clavado en "aprobado" para siempre en cuanto Planeación
    // genera la OP, sin poder pasar a en_produccion/despachado ni cancelarse.
    const advanceStatus = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "en_produccion", items: [{ productId, quantity: 3 }] }),
    });
    assert.equal(advanceStatus.status, 201, "avanzar el status con los mismos ítems debe permitirse aunque haya OP");

    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersion: { pedidoId: pedido.id } } });
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });
  });

  it("POST /production-orders/from-pedido-item rechaza una versión reemplazada del pedido", async () => {
    const createRes = await fetch(`${baseUrl}/api/pedidos`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 2 }] }),
    });
    const pedido = (await createRes.json()) as { id: number; versions: { items: { id: number }[] }[] };
    const staleItemId = pedido.versions[0].items[0].id;

    // Editar crea v2 (status aprobado) -- v1 queda reemplazada.
    const editRes = await fetch(`${baseUrl}/api/pedidos/${pedido.id}`, {
      method: "PATCH",
      headers: headersFor("ventas"),
      body: JSON.stringify({ status: "aprobado", items: [{ productId, quantity: 2 }] }),
    });
    assert.equal(editRes.status, 201);

    const staleGenerate = await fetch(`${baseUrl}/api/production-orders/from-pedido-item/${staleItemId}`, {
      method: "POST",
      headers: headersFor("planeacion"),
    });
    assert.equal(staleGenerate.status, 400, "no se puede generar OP desde un ítem de una versión reemplazada");

    await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersion: { pedidoId: pedido.id } } });
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });
  });

  it("crear cotización sin ítems devuelve 400 (zod min 1)", async () => {
    const res = await fetch(`${baseUrl}/api/cotizaciones`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [] }),
    });
    assert.equal(res.status, 400);
  });

  it("crear factura con producto inexistente devuelve 400", async () => {
    const res = await fetch(`${baseUrl}/api/facturas`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId: 999999999, quantity: 1 }] }),
    });
    assert.equal(res.status, 400);
  });

  it("GET /:id/pdf genera un PDF descargable para cotización y factura", async () => {
    const cotRes = await fetch(`${baseUrl}/api/cotizaciones`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 2 }] }),
    });
    const cotizacion = (await cotRes.json()) as { id: number; quoteNumber: string };

    const cotPdf = await fetch(`${baseUrl}/api/cotizaciones/${cotizacion.id}/pdf`, { headers: headersFor("ventas") });
    assert.equal(cotPdf.status, 200);
    assert.match(cotPdf.headers.get("content-type") ?? "", /application\/pdf/);
    assert.match(cotPdf.headers.get("content-disposition") ?? "", new RegExp(`${cotizacion.quoteNumber}\\.pdf`));
    const cotBuf = await cotPdf.arrayBuffer();
    assert.ok(cotBuf.byteLength > 0);
    // Firma binaria estándar de un PDF: "%PDF-".
    assert.equal(Buffer.from(cotBuf.slice(0, 5)).toString("ascii"), "%PDF-");

    const facRes = await fetch(`${baseUrl}/api/facturas`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 1 }], dueDate: "2020-01-01" }),
    });
    const factura = (await facRes.json()) as { id: number; invoiceNumber: string };

    const facPdf = await fetch(`${baseUrl}/api/facturas/${factura.id}/pdf`, { headers: headersFor("ventas") });
    assert.equal(facPdf.status, 200);
    assert.match(facPdf.headers.get("content-type") ?? "", /application\/pdf/);
    const facBuf = await facPdf.arrayBuffer();
    assert.ok(facBuf.byteLength > 0);

    const pdfNotFound = await fetch(`${baseUrl}/api/facturas/999999999/pdf`, { headers: headersFor("ventas") });
    assert.equal(pdfNotFound.status, 404);

    await prisma.facturaItem.deleteMany({ where: { facturaId: factura.id } });
    await prisma.factura.delete({ where: { id: factura.id } });
    await prisma.cotizacionItem.deleteMany({ where: { cotizacionId: cotizacion.id } });
    await prisma.cotizacion.delete({ where: { id: cotizacion.id } });
  });

  it("factura con dueDate vencido: la cartera del cliente la marca 'vencida' y aporta a carteraVencida del dashboard", async () => {
    const carteraAntes = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: authHeaders() });
    const { carteraVencida: vencidaAntes } = (await carteraAntes.json()) as { carteraVencida: number };

    const facRes = await fetch(`${baseUrl}/api/facturas`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, items: [{ productId, quantity: 3 }], dueDate: "2020-01-01" }),
    });
    assert.equal(facRes.status, 201);
    const factura = (await facRes.json()) as { id: number };

    const cartera = await fetch(`${baseUrl}/api/clients/${clientId}/cartera`, { headers: headersFor("ventas") });
    assert.equal(cartera.status, 200);
    const carteraBody = (await cartera.json()) as {
      facturasPendientes: { id: number; vencida: boolean; dueDate: string | null }[];
    };
    const facturaEnCartera = carteraBody.facturasPendientes.find((f) => f.id === factura.id);
    assert.ok(facturaEnCartera, "la factura recién creada debe listarse en la cartera");
    assert.equal(facturaEnCartera!.vencida, true);
    assert.ok(facturaEnCartera!.dueDate);

    const total = unitPrice * 3;
    const carteraDespues = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: authHeaders() });
    const { carteraVencida: vencidaDespues } = (await carteraDespues.json()) as { carteraVencida: number };
    assert.equal(vencidaDespues, vencidaAntes + total, "la factura vencida debe sumar su saldo completo a carteraVencida");

    // Una vez pagada, deja de estar vencida (saldo = 0) aunque la fecha ya pasó.
    await fetch(`${baseUrl}/api/facturas/${factura.id}/payments`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ amount: total, method: "efectivo" }),
    });
    const carteraFinal = await fetch(`${baseUrl}/api/clients/${clientId}/cartera`, { headers: headersFor("ventas") });
    const carteraFinalBody = (await carteraFinal.json()) as { facturasPendientes: { id: number }[] };
    assert.ok(!carteraFinalBody.facturasPendientes.some((f) => f.id === factura.id), "pagada, ya no tiene saldo pendiente");

    await prisma.payment.deleteMany({ where: { facturaId: factura.id } });
    await prisma.facturaItem.deleteMany({ where: { facturaId: factura.id } });
    await prisma.factura.delete({ where: { id: factura.id } });
  });
});

describe("clientes · productos que más pide", () => {
  let clientId = 0;
  let productA = 0;
  let productB = 0;

  before(async () => {
    const client = await prisma.client.create({ data: { name: `TEST-TOPPROD-CLIENT-${Date.now()}` } });
    clientId = client.id;
    productA = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
    productB = (await prisma.product.findFirstOrThrow({ where: { sku: "ROL-PL-001" } })).id;
  });

  after(async () => {
    await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  });

  it("ordena por en cuántos pedidos distintos aparece cada producto, no por cantidad total", async () => {
    // productA aparece en 2 pedidos (cantidades chicas); productB en 1 solo
    // pedido pero con una cantidad grande — productA debe salir primero por
    // frecuencia, aunque su cantidad total sea menor.
    for (const items of [
      [{ productId: productA, quantity: 2 }],
      [{ productId: productA, quantity: 3 }, { productId: productB, quantity: 100 }],
    ]) {
      const res = await fetch(`${baseUrl}/api/pedidos`, {
        method: "POST",
        headers: headersFor("ventas"),
        body: JSON.stringify({ clientId, items }),
      });
      assert.equal(res.status, 201);
    }

    const topRes = await fetch(`${baseUrl}/api/clients/${clientId}/top-products`, { headers: headersFor("ventas") });
    assert.equal(topRes.status, 200);
    const top = (await topRes.json()) as { product: { id: number }; frequency: number; totalQuantity: number }[];
    assert.equal(top.length, 2);
    assert.equal(top[0].product.id, productA, "productA aparece en 2 pedidos, debe ir primero pese a tener menos cantidad total");
    assert.equal(top[0].frequency, 2);
    assert.equal(top[0].totalQuantity, 5);
    assert.equal(top[1].product.id, productB);
    assert.equal(top[1].frequency, 1);
    assert.equal(top[1].totalQuantity, 100);

    await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersion: { pedido: { clientId } } } });
    await prisma.pedidoVersion.deleteMany({ where: { pedido: { clientId } } });
    await prisma.pedido.deleteMany({ where: { clientId } });
  });

  it("devuelve lista vacía para un cliente sin pedidos, y 404 para uno inexistente", async () => {
    const otroCliente = await prisma.client.create({ data: { name: `TEST-TOPPROD-VACIO-${Date.now()}` } });
    const res = await fetch(`${baseUrl}/api/clients/${otroCliente.id}/top-products`, { headers: headersFor("ventas") });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
    await prisma.client.delete({ where: { id: otroCliente.id } });

    const notFound = await fetch(`${baseUrl}/api/clients/999999999/top-products`, { headers: headersFor("ventas") });
    assert.equal(notFound.status, 404);
  });
});

describe("clientes · productos cargados a mano", () => {
  let clientId = 0;
  let productA = 0;
  let productB = 0;

  before(async () => {
    const client = await prisma.client.create({ data: { name: `TEST-MANUALPROD-CLIENT-${Date.now()}` } });
    clientId = client.id;
    productA = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
    productB = (await prisma.product.findFirstOrThrow({ where: { sku: "ROL-PL-001" } })).id;
  });

  after(async () => {
    await prisma.clientManualProduct.deleteMany({ where: { clientId } });
    await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  });

  it("un rol sin acceso a Ventas no puede ver ni cargar (403)", async () => {
    const get = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, { headers: headersFor("almacen") });
    assert.equal(get.status, 403);

    const post = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ productId: productA }),
    });
    assert.equal(post.status, 403);
  });

  it("carga un producto a mano, no se mezcla con los calculados por pedidos, y cargar el mismo producto de nuevo actualiza en vez de duplicar", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ productId: productA, quantity: 15, notes: "Lo pedía antes del sistema" }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: number; quantity: string; notes: string; product: { id: number } };
    assert.equal(created.product.id, productA);
    assert.equal(Number(created.quantity), 15);
    assert.equal(created.notes, "Lo pedía antes del sistema");

    const list = (await (
      await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, { headers: headersFor("ventas") })
    ).json()) as { id: number }[];
    assert.equal(list.length, 1);

    // top-products (calculado por pedidos) sigue vacío -- las dos listas son independientes.
    const top = await (await fetch(`${baseUrl}/api/clients/${clientId}/top-products`, { headers: headersFor("ventas") })).json();
    assert.deepEqual(top, []);

    // Cargar el mismo producto de nuevo actualiza la fila (upsert), no duplica.
    const upsert = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ productId: productA, quantity: 40 }),
    });
    assert.equal(upsert.status, 201);
    const upserted = (await upsert.json()) as { id: number; quantity: string };
    assert.equal(upserted.id, created.id, "mismo id: actualizó la fila existente");
    assert.equal(Number(upserted.quantity), 40);

    const listAfter = (await (
      await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, { headers: headersFor("ventas") })
    ).json()) as { id: number }[];
    assert.equal(listAfter.length, 1, "sigue habiendo una sola fila, no dos");
  });

  it("DELETE quita el producto cargado a mano; 404 si no pertenece a ese cliente", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ productId: productB }),
    });
    const created = (await res.json()) as { id: number };

    const otroCliente = await prisma.client.create({ data: { name: `TEST-MANUALPROD-OTRO-${Date.now()}` } });
    const wrongClient = await fetch(`${baseUrl}/api/clients/${otroCliente.id}/manual-products/${created.id}`, {
      method: "DELETE",
      headers: headersFor("ventas"),
    });
    assert.equal(wrongClient.status, 404, "no se puede borrar pasando el id de otro cliente");
    await prisma.client.delete({ where: { id: otroCliente.id } });

    const del = await fetch(`${baseUrl}/api/clients/${clientId}/manual-products/${created.id}`, {
      method: "DELETE",
      headers: headersFor("ventas"),
    });
    assert.equal(del.status, 204);

    const listAfter = (await (
      await fetch(`${baseUrl}/api/clients/${clientId}/manual-products`, { headers: headersFor("ventas") })
    ).json()) as { id: number }[];
    assert.ok(!listAfter.some((mp) => mp.id === created.id));
  });
});

describe("dashboard · indicadores con rango de fechas", () => {
  it("con from/to filtra por ese rango exacto (sin depender de cuántos checks reales haya hoy)", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const matchingRange = "from=2025-12-25&to=2026-01-05";
    const nonMatchingRange = "from=2025-06-01&to=2025-06-02";

    const getAprobadas = async (query: string) => {
      const res = await fetch(`${baseUrl}/api/dashboard/indicadores?${query}`, { headers: authHeaders() });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { calidad: { aprobadas: number } };
      return body.calidad.aprobadas;
    };

    const dentroAntes = await getAprobadas(matchingRange);
    const fueraAntes = await getAprobadas(nonMatchingRange);

    const viejo = await prisma.qualityCheck.create({
      data: {
        productionOrder: {
          create: { orderNumber: `OP-TEST-OLD-${Date.now()}`, productId: product.id, quantityPlanned: 1, status: "finalizada" },
        },
        result: "aprobado",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const dentroDespues = await getAprobadas(matchingRange);
    const fueraDespues = await getAprobadas(nonMatchingRange);

    assert.equal(dentroDespues, dentroAntes + 1, "el check de enero 2026 debe contarse cuando el rango lo incluye");
    assert.equal(fueraDespues, fueraAntes, "un rango que no lo incluye no debe verse afectado");

    await prisma.qualityCheck.delete({ where: { id: viejo.id } });
    await prisma.productionOrder.delete({ where: { id: viejo.productionOrderId } });
  });
});

describe("despachos · notificación por WhatsApp al completarse", () => {
  it("sin credenciales de WhatsApp configuradas, queda en modo no-op (no rompe el flujo) y no duplica el aviso", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-WA-CLIENT-${Date.now()}` } });
    await prisma.clientContact.create({ data: { clientId: client.id, name: "Contacto", phone: "3001234567", isPrimary: true } });
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });

    const dispatchRes = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: client.id, items: [{ productId: product.id, quantityRequested: 2 }] }),
    });
    const dispatch = (await dispatchRes.json()) as { id: number; items: { id: number }[] };

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = ((...args: unknown[]) => {
      logs.push(args.join(" "));
    }) as typeof console.log;

    try {
      const complete = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
        method: "PATCH",
        headers: headersFor("almacen"),
        body: JSON.stringify({ quantityDispatched: 2 }),
      });
      assert.equal(complete.status, 200);

      // Reintento sobre el mismo item ya completado: ahora se rechaza (ver
      // fix de idempotencia — antes esto pisaba `quantityDispatched` con el
      // mismo valor pero volvía a descontar stock, duplicando la salida) —
      // así que tampoco debe reenviar el aviso.
      const retry = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
        method: "PATCH",
        headers: headersFor("almacen"),
        body: JSON.stringify({ quantityDispatched: 2 }),
      });
      assert.equal(retry.status, 400, "un reintento sobre un ítem ya despachado se rechaza, no se vuelve a aplicar");
    } finally {
      console.log = originalLog;
    }

    const whatsappLogs = logs.filter((l) => l.includes("WhatsApp no enviado"));
    assert.equal(whatsappLogs.length, 1, "debe intentar avisar una sola vez, no en cada PATCH");
    assert.ok(whatsappLogs[0].includes("3001234567"));
    assert.ok(whatsappLogs[0].includes(client.name));

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
    await prisma.clientContact.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });

  it("un cliente sin teléfono no rompe el flujo (no hay a quién avisar)", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-WA-SINFONO-${Date.now()}` } });
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });

    const dispatchRes = await fetch(`${baseUrl}/api/dispatches`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ clientId: client.id, items: [{ productId: product.id, quantityRequested: 1 }] }),
    });
    const dispatch = (await dispatchRes.json()) as { id: number; items: { id: number }[] };

    const complete = await fetch(`${baseUrl}/api/dispatches/${dispatch.id}/items/${dispatch.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 1 }),
    });
    assert.equal(complete.status, 200);

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: dispatch.id } });
    await prisma.dispatch.delete({ where: { id: dispatch.id } });
    await prisma.client.delete({ where: { id: client.id } });
  });
});

describe("auditoría", () => {
  it("devuelve 403 para un rol sin acceso (ventas)", async () => {
    const res = await fetch(`${baseUrl}/api/audit-log`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("lista la bitácora paginada y filtra por tabla", async () => {
    // El create de cliente en el describe "clientes" ya deja rastro en audit_logs.
    const created = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-AUDIT" }),
    });
    const client = (await created.json()) as { id: number };

    const res = await fetch(`${baseUrl}/api/audit-log?tableName=Client&pageSize=10`, { headers: headersFor("auditor") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { tableName: string; action: string }[]; total: number; page: number; pageSize: number };
    assert.ok(body.items.length > 0);
    assert.ok(body.items.every((i) => i.tableName === "Client"));
    assert.ok(body.items.some((i) => i.action === "create"));

    await prisma.client.delete({ where: { id: client.id } });
  });

  it("un ajuste de materia prima deja rastro en Auditoría (RawMaterialMovement)", async () => {
    const material = await prisma.rawMaterial.create({ data: { code: `TEST-AUDIT-RM-${Date.now()}` } });
    await fetch(`${baseUrl}/api/raw-materials/${material.id}/adjust`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ quantity: 10, type: "compra" }),
    });

    const res = await fetch(`${baseUrl}/api/audit-log?tableName=RawMaterialMovement&pageSize=10`, { headers: headersFor("auditor") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { tableName: string; action: string; after: any }[] };
    assert.ok(body.items.some((i) => i.action === "create" && i.after?.rawMaterialId === material.id));

    await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: material.id } });
    await prisma.rawMaterialStock.deleteMany({ where: { rawMaterialId: material.id } });
    await prisma.rawMaterial.delete({ where: { id: material.id } });
  });

  it("GET /audit-log/reconciliation devuelve 403 para un rol sin acceso (ventas)", async () => {
    const res = await fetch(`${baseUrl}/api/audit-log/reconciliation`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("GET /audit-log/reconciliation compara el stock contra la suma real de movimientos y detecta un descuadre manual", async () => {
    // Producto dedicado y recién creado: sabemos con certeza que arranca
    // en 0/0 (sin depender de que BUL-001 -- compartido por cientos de
    // tests de esta base de dev -- cuadre en este momento puntual).
    const product = await prisma.product.create({
      data: { sku: `TEST-RECONCILIATION-${Date.now()}`, name: "Producto dedicado reconciliación", category: "tiras", unit: "kg", minStock: 0 },
    });

    const ok = await fetch(`${baseUrl}/api/audit-log/reconciliation`, { headers: headersFor("auditor") });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { ok: boolean; products: { productId: number }[]; rawMaterials: unknown[] };
    assert.ok(!okBody.products.some((p) => p.productId === product.id), "un producto recién creado, sin movimientos, debe cuadrar (0 = 0)");

    // Se fuerza un descuadre escribiendo el stock directo, sin movimiento
    // (exactamente lo que hacía el seed viejo antes de este fix) -- el
    // reconciliador tiene que verlo.
    await prisma.inventoryStock.upsert({
      where: { productId: product.id },
      create: { productId: product.id, currentQuantity: 37 },
      update: { currentQuantity: { increment: 37 } },
    });

    const withMismatch = await fetch(`${baseUrl}/api/audit-log/reconciliation`, { headers: headersFor("auditor") });
    const mismatchBody = (await withMismatch.json()) as { ok: boolean; products: { productId: number; difference: number }[] };
    assert.equal(mismatchBody.ok, false);
    const found = mismatchBody.products.find((p) => p.productId === product.id);
    assert.ok(found, "debió detectar el descuadre del producto dedicado");
    assert.equal(found!.difference, 37);

    await prisma.inventoryStock.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });
});

describe("productos", () => {
  let productId = 0;
  let productSku = "";

  after(async () => {
    if (productId) await prisma.product.delete({ where: { id: productId } }).catch(() => {});
  });

  it("GET / exige gestión de catálogo (Admin/Planeación) — ventas y Gerente de Producción quedan afuera", async () => {
    const ok = await fetch(`${baseUrl}/api/products`, { headers: headersFor("planeacion") });
    assert.equal(ok.status, 200);
    const products = (await ok.json()) as { sku: string }[];
    assert.ok(products.some((p) => p.sku === "BUL-001"));

    for (const role of ["ventas", "produccion"]) {
      const res = await fetch(`${baseUrl}/api/products`, { headers: headersFor(role) });
      assert.equal(res.status, 403, `${role} no debería poder ver el catálogo completo`);
    }
  });

  it("crear/editar/desactivar exige gestión de catálogo (403 para ventas y para Gerente de Producción)", async () => {
    for (const role of ["ventas", "produccion"]) {
      const res = await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: headersFor(role),
        body: JSON.stringify({ name: "Test", category: "bultos", unit: "kg", minStock: 0, unitPrice: 100 }),
      });
      assert.equal(res.status, 403, `${role} no debería poder crear productos`);
    }
  });

  it("genera el SKU solo (el cliente no lo entendía, ver comentario en products.ts) con el prefijo de la categoría, sin pedirlo en el body", async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({
        sku: "ESTO-SE-IGNORA",
        name: "Test Producto",
        category: "bultos",
        unit: "kg",
        minStock: 5,
        unitPrice: 1000,
        talla: "M",
        color: "Negro",
        densidad: "ALTA",
        medidaRef: "Ref-1",
        calibre: "0.5",
        measureUnit: "Cms.",
      }),
    });
    assert.equal(res.status, 201);
    const product = (await res.json()) as { id: number; active: boolean; sku: string; color: string; densidad: string };
    productId = product.id;
    productSku = product.sku;
    assert.equal(product.active, true);
    assert.match(product.sku, /^BUL-\d{3}$/, "el SKU se genera con el prefijo BUL de la categoría, no con el que mandó el body");
    assert.notEqual(product.sku, "ESTO-SE-IGNORA");
    assert.equal(product.color, "Negro");
    assert.equal(product.densidad, "ALTA");

    // Un segundo producto de la misma categoría saca el siguiente consecutivo.
    const second = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Test Producto 2", category: "bultos", unit: "kg", minStock: 0, unitPrice: 1 }),
    });
    assert.equal(second.status, 201);
    const secondProduct = (await second.json()) as { id: number; sku: string };
    assert.notEqual(secondProduct.sku, productSku, "cada producto de la misma categoría saca un SKU distinto");
    await prisma.product.delete({ where: { id: secondProduct.id } }).catch(() => {});
  });

  it("rechaza un color/densidad fuera de la lista fija", async () => {
    const res = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Test", category: "bultos", unit: "kg", minStock: 0, unitPrice: 1, color: "Fucsia" }),
    });
    assert.equal(res.status, 400);

    const res2 = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Test", category: "bultos", unit: "kg", minStock: 0, unitPrice: 1, densidad: "MEDIA" }),
    });
    assert.equal(res2.status, 400);
  });

  it("GET /:id/label devuelve un QR en data URL", async () => {
    const res = await fetch(`${baseUrl}/api/products/${productId}/label`, { headers: headersFor("produccion") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sku: string; qrDataUrl: string };
    assert.equal(body.sku, productSku);
    assert.ok(body.qrDataUrl.startsWith("data:image"));
  });

  it("PATCH edita el producto y rechaza body vacío", async () => {
    const empty = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: "PATCH",
      headers: headersFor("planeacion"),
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);

    const res = await fetch(`${baseUrl}/api/products/${productId}`, {
      method: "PATCH",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Renombrado" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { name: string };
    assert.equal(body.name, "Renombrado");
  });

  it("DELETE desactiva el producto (deja de aparecer en el catálogo de venta) y POST /reactivate lo devuelve", async () => {
    const del = await fetch(`${baseUrl}/api/products/${productId}`, { method: "DELETE", headers: headersFor("planeacion") });
    assert.equal(del.status, 200);
    const deleted = (await del.json()) as { active: boolean };
    assert.equal(deleted.active, false);

    const catalog = await fetch(`${baseUrl}/api/inventory/products`, { headers: authHeaders() });
    const catalogBody = (await catalog.json()) as { sku: string }[];
    assert.ok(!catalogBody.some((p) => p.sku === productSku), "un producto inactivo no debe verse en el selector de venta");

    const reactivate = await fetch(`${baseUrl}/api/products/${productId}/reactivate`, { method: "POST", headers: headersFor("planeacion") });
    assert.equal(reactivate.status, 200);
    const reactivated = (await reactivate.json()) as { active: boolean };
    assert.equal(reactivated.active, true);
  });
});

describe("usuarios y permisos", () => {
  const email = `test-user-${Date.now()}@x.com`;
  let userId = 0;
  let adminId = 0;

  before(async () => {
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders() });
    const meBody = (await me.json()) as { id: number };
    adminId = meBody.id;
  });

  after(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it("devuelve 403 para un rol que no es admin", async () => {
    const res = await fetch(`${baseUrl}/api/users`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("crea un usuario, rechaza email duplicado y nunca expone passwordHash", async () => {
    const res = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Test User", email, password: "password123", role: "calidad" }),
    });
    assert.equal(res.status, 201);
    const user = (await res.json()) as { id: number; role: string; passwordHash?: string };
    userId = user.id;
    assert.equal(user.role, "calidad");
    assert.equal(user.passwordHash, undefined);

    const dup = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Otro", email, password: "password123", role: "calidad" }),
    });
    assert.equal(dup.status, 409);
  });

  it("PATCH edita rol y nombre", async () => {
    const res = await fetch(`${baseUrl}/api/users/${userId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ role: "auditor", name: "Test User Editado" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { role: string; name: string };
    assert.equal(body.role, "auditor");
    assert.equal(body.name, "Test User Editado");
  });

  it("un admin no puede autodesactivarse", async () => {
    const res = await fetch(`${baseUrl}/api/users/${adminId}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(res.status, 400);
  });

  it("DELETE desactiva y bloquea el login; POST /reactivate lo restaura", async () => {
    const del = await fetch(`${baseUrl}/api/users/${userId}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(del.status, 200);
    const deleted = (await del.json()) as { active: boolean };
    assert.equal(deleted.active, false);

    const loginBlocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    assert.equal(loginBlocked.status, 401);

    const reactivate = await fetch(`${baseUrl}/api/users/${userId}/reactivate`, { method: "POST", headers: authHeaders() });
    assert.equal(reactivate.status, 200);

    const loginOk = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    assert.equal(loginOk.status, 200);
  });
});

describe("almacén / WMS + ubicación pública por QR", () => {
  const code = `TEST-LOC-${Date.now()}`;
  let locationId = 0;
  let productId = 0;

  before(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "ROL-PL-001" } });
    productId = product.id;
  });

  after(async () => {
    if (locationId) {
      await prisma.stockLocation.deleteMany({ where: { locationId } });
      await prisma.warehouseLocation.delete({ where: { id: locationId } }).catch(() => {});
    }
  });

  it("devuelve 403 para un rol sin acceso a Almacén", async () => {
    const res = await fetch(`${baseUrl}/api/warehouse/locations`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("crea una ubicación (sin exponer el publicToken) y rechaza código duplicado", async () => {
    const res = await fetch(`${baseUrl}/api/warehouse/locations`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ code, label: "Estante de prueba" }),
    });
    assert.equal(res.status, 201);
    const location = (await res.json()) as Record<string, unknown>;
    locationId = location.id as number;
    assert.ok(!("publicToken" in location), "el publicToken no debe viajar en la respuesta de creación");

    const dup = await fetch(`${baseUrl}/api/warehouse/locations`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ code, label: "Otro" }),
    });
    assert.equal(dup.status, 400);
  });

  it("asigna stock, lo refleja en /stock, y el QR + la ruta pública sin login exponen lo mismo", async () => {
    const assign = await fetch(`${baseUrl}/api/warehouse/assign`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ productId, toLocationId: locationId, quantity: 15 }),
    });
    assert.equal(assign.status, 201);

    const stock = await fetch(`${baseUrl}/api/warehouse/stock`, { headers: headersFor("almacen") });
    assert.equal(stock.status, 200);
    const stockBody = (await stock.json()) as { productId: number; locations: { locationId: number; quantity: number }[] }[];
    const row = stockBody.find((p) => p.productId === productId);
    assert.ok(row);
    assert.ok(row!.locations.some((l) => l.locationId === locationId && l.quantity === 15));

    const qr = await fetch(`${baseUrl}/api/warehouse/locations/${locationId}/qr`, { headers: headersFor("almacen") });
    assert.equal(qr.status, 200);
    const qrBody = (await qr.json()) as { dataUrl: string; url: string };
    assert.ok(qrBody.dataUrl.startsWith("data:image"));
    const token = qrBody.url.split("/qr/")[1];
    assert.ok(token && token.length === 32, "el publicToken es un hex de 32 caracteres");

    const byToken = await fetch(`${baseUrl}/api/warehouse/locations/by-token/${token}`, { headers: headersFor("almacen") });
    assert.equal(byToken.status, 200);
    const byTokenBody = (await byToken.json()) as { id: number; code: string };
    assert.equal(byTokenBody.id, locationId);
    assert.equal(byTokenBody.code, code);

    // La ruta pública: SIN Authorization, debe funcionar igual.
    const publicRes = await fetch(`${baseUrl}/api/public/locations/${token}`);
    assert.equal(publicRes.status, 200);
    const publicBody = (await publicRes.json()) as { location: { code: string }; items: { productId: number; quantity: number }[] };
    assert.equal(publicBody.location.code, code);
    assert.ok(publicBody.items.some((i) => i.productId === productId && i.quantity === 15));

    const invalidToken = await fetch(`${baseUrl}/api/public/locations/token-que-no-existe`);
    assert.equal(invalidToken.status, 404);
  });

  it("ubicar desde 'sin ubicar' (sin fromLocationId) rechaza pedir más de lo que realmente está sin ubicar", async () => {
    const stock = await fetch(`${baseUrl}/api/warehouse/stock`, { headers: headersFor("almacen") });
    const stockBody = (await stock.json()) as { productId: number; unassigned: number }[];
    const row = stockBody.find((p) => p.productId === productId);
    const unassigned = row?.unassigned ?? 0;

    const tooMuch = await fetch(`${baseUrl}/api/warehouse/assign`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ productId, toLocationId: locationId, quantity: unassigned + 500 }),
    });
    assert.equal(tooMuch.status, 400, "no hay 500 unidades de más sin ubicar");
    const body = (await tooMuch.json()) as { error: string };
    assert.match(body.error, /sin ubicar/i);
  });

  it("mover stock entre ubicaciones valida que el origen tenga suficiente", async () => {
    const otherCode = `TEST-LOC-2-${Date.now()}`;
    const other = await prisma.warehouseLocation.create({
      data: { code: otherCode, label: "Segundo estante", publicToken: `${Date.now()}${Math.random()}`.padEnd(32, "0").slice(0, 32) },
    });

    const tooMuch = await fetch(`${baseUrl}/api/warehouse/assign`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ productId, toLocationId: other.id, quantity: 999999, fromLocationId: locationId }),
    });
    assert.equal(tooMuch.status, 400);

    const move = await fetch(`${baseUrl}/api/warehouse/assign`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ productId, toLocationId: other.id, quantity: 5, fromLocationId: locationId }),
    });
    assert.equal(move.status, 201);

    const fromRow = await prisma.stockLocation.findUnique({ where: { productId_locationId: { productId, locationId } } });
    const toRow = await prisma.stockLocation.findUnique({ where: { productId_locationId: { productId, locationId: other.id } } });
    assert.equal(Number(fromRow!.quantity), 10);
    assert.equal(Number(toRow!.quantity), 5);

    await prisma.stockLocation.deleteMany({ where: { locationId: other.id } });
    await prisma.warehouseLocation.delete({ where: { id: other.id } });
  });
});

describe("dashboard", () => {
  it("devuelve 403 para un rol que no es admin", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("GET /resumen devuelve KPIs y 6 meses de ventas", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ventasUltimos6Meses: { mes: string; total: number }[];
      carteraPendiente: number;
      topClientesSaldo: unknown[];
    };
    assert.equal(body.ventasUltimos6Meses.length, 6);
    assert.equal(typeof body.carteraPendiente, "number");
    assert.ok(Array.isArray(body.topClientesSaldo));
  });

  it("GET /resumen trae las secciones nuevas (embudo, alertas, ordenes en curso) y acepta period", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      period: string;
      ventasDelPeriodo: number;
      kgProducidosDelPeriodo: number;
      cotizacionesAbiertas: number;
      valorCotizacionesAbiertas: number;
      alertas: { severity: string; title: string; detail: string }[];
      ordenesEnCurso: { id: number; orderNumber: string; avancePct: number }[];
      ordenesEnCursoTotal: number;
    };
    assert.equal(body.period, "mes");
    assert.equal(typeof body.ventasDelPeriodo, "number");
    assert.equal(typeof body.kgProducidosDelPeriodo, "number");
    assert.equal(typeof body.cotizacionesAbiertas, "number");
    assert.equal(typeof body.valorCotizacionesAbiertas, "number");
    assert.ok(Array.isArray(body.alertas));
    assert.ok(Array.isArray(body.ordenesEnCurso));
    assert.equal(typeof body.ordenesEnCursoTotal, "number");

    const trimestre = await fetch(`${baseUrl}/api/dashboard/resumen?period=trimestre`, { headers: authHeaders() });
    assert.equal((await trimestre.json() as { period: string }).period, "trimestre");

    const invalido = await fetch(`${baseUrl}/api/dashboard/resumen?period=nope`, { headers: authHeaders() });
    assert.equal((await invalido.json() as { period: string }).period, "mes");
  });

  it("GET /indicadores devuelve la tasa de aprobación de calidad", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/indicadores`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      topProductosDespachados: unknown[];
      calidad: { aprobadas: number; rechazadas: number; pctAprobacion: number | null };
    };
    assert.ok(Array.isArray(body.topProductosDespachados));
    assert.equal(typeof body.calidad.aprobadas, "number");
  });
});

describe("exportaciones", () => {
  it("GET /inventario devuelve un .xlsx no vacío para roles con acceso a Existencias, y 403 para Gerente de Producción/operarios", async () => {
    const res = await fetch(`${baseUrl}/api/export/inventario`, { headers: headersFor("almacen") });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /spreadsheetml/);
    assert.match(res.headers.get("content-disposition") ?? "", /inventario\.xlsx/);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);

    // Mismo guard que GET /inventory (ROLES.EXISTENCIAS) -- a pedido del
    // cliente, Gerente de Producción no ve cuánto stock hay, y menos un
    // operario de planta. El export se había quedado sin este guard.
    const denied = await fetch(`${baseUrl}/api/export/inventario`, { headers: headersFor("produccion") });
    assert.equal(denied.status, 403);
    const deniedOperario = await fetch(`${baseUrl}/api/export/inventario`, { headers: headersFor("operario_extrusion") });
    assert.equal(deniedOperario.status, 403);
  });

  it("/pedidos y /facturas exigen además rol de ventas (403 para almacén)", async () => {
    const res = await fetch(`${baseUrl}/api/export/pedidos`, { headers: headersFor("almacen") });
    assert.equal(res.status, 403);

    const ok = await fetch(`${baseUrl}/api/export/pedidos`, { headers: headersFor("ventas") });
    assert.equal(ok.status, 200);
  });

  it("GET /clientes devuelve un .xlsx para ventas", async () => {
    const res = await fetch(`${baseUrl}/api/export/clientes`, { headers: headersFor("ventas") });
    assert.equal(res.status, 200);
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 0);
  });
});

describe("notificaciones", () => {
  let calidadUserId = 0;
  let otherUserId = 0;
  let ownNotifId = 0;
  let otherNotifId = 0;

  before(async () => {
    const calidadUser = await prisma.user.findFirstOrThrow({ where: { email: "calidad@empresa.com" } });
    calidadUserId = calidadUser.id;
    const otherUser = await prisma.user.findFirstOrThrow({ where: { email: "auditor@empresa.com" } });
    otherUserId = otherUser.id;

    const own = await prisma.notification.create({
      data: { userId: calidadUserId, type: "test_notif", message: "TEST notificación propia", link: "/calidad" },
    });
    ownNotifId = own.id;
    const other = await prisma.notification.create({
      data: { userId: otherUserId, type: "test_notif", message: "TEST notificación ajena" },
    });
    otherNotifId = other.id;
  });

  after(async () => {
    await prisma.notification.deleteMany({ where: { id: { in: [ownNotifId, otherNotifId] } } });
  });

  it("lista solo las notificaciones propias, más recientes primero", async () => {
    const res = await fetch(`${baseUrl}/api/notifications`, { headers: headersFor("calidad") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { id: number; message: string }[];
    assert.ok(body.some((n) => n.id === ownNotifId));
    assert.ok(!body.some((n) => n.id === otherNotifId), "no debe ver notificaciones de otro usuario");
  });

  it("unread-count refleja las no leídas y PATCH /:id/read las marca", async () => {
    const before1 = await fetch(`${baseUrl}/api/notifications/unread-count`, { headers: headersFor("calidad") });
    const beforeBody = (await before1.json()) as { count: number };
    assert.ok(beforeBody.count >= 1);

    const read = await fetch(`${baseUrl}/api/notifications/${ownNotifId}/read`, { method: "PATCH", headers: headersFor("calidad") });
    assert.equal(read.status, 200);
    const readBody = (await read.json()) as { read: boolean };
    assert.equal(readBody.read, true);

    const after1 = await fetch(`${baseUrl}/api/notifications/unread-count`, { headers: headersFor("calidad") });
    const afterBody = (await after1.json()) as { count: number };
    assert.equal(afterBody.count, beforeBody.count - 1);
  });

  it("no puede marcar como leída una notificación de otro usuario (404)", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/${otherNotifId}/read`, { method: "PATCH", headers: headersFor("calidad") });
    assert.equal(res.status, 404);
  });

  it("PATCH /read-all marca todas las propias como leídas", async () => {
    const fresh = await prisma.notification.create({
      data: { userId: calidadUserId, type: "test_notif", message: "TEST notif fresca sin leer" },
    });
    const res = await fetch(`${baseUrl}/api/notifications/read-all`, { method: "PATCH", headers: headersFor("calidad") });
    assert.equal(res.status, 200);
    const remaining = await prisma.notification.count({ where: { userId: calidadUserId, read: false } });
    assert.equal(remaining, 0);
    await prisma.notification.delete({ where: { id: fresh.id } });
  });
});

describe("contactos", () => {
  let clientId = 0;
  const created: number[] = [];

  before(async () => {
    const res = await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() });
    const clients = (await res.json()) as { id: number; name: string }[];
    const acme = clients.find((c) => c.name === "Cliente ACME") ?? clients[0];
    clientId = acme.id;
  });

  after(async () => {
    for (const id of created) {
      await fetch(`${baseUrl}/api/clients/${clientId}/contacts/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      }).catch(() => {});
    }
  });

  it("lista contactos del cliente", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const contacts = (await res.json()) as unknown[];
    assert.ok(Array.isArray(contacts));
  });

  it("404 para cliente inexistente", async () => {
    const res = await fetch(`${baseUrl}/api/clients/99999999/contacts`, { headers: authHeaders() });
    assert.equal(res.status, 404);
  });

  it("400 para id de cliente inválido", async () => {
    const res = await fetch(`${baseUrl}/api/clients/abc/contacts`, { headers: authHeaders() });
    assert.equal(res.status, 400);
  });

  it("400 para email inválido", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Test", email: "no-es-email" }),
    });
    assert.equal(res.status, 400);
  });

  it("crea un contacto no principal", async () => {
    const name = `TEST-A-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name, isPrimary: false }),
    });
    assert.equal(res.status, 201);
    const contact = (await res.json()) as { id: number; isPrimary: boolean };
    assert.equal(contact.isPrimary, false);
    created.push(contact.id);
  });

  it("crear un contacto principal desmarca al anterior", async () => {
    const name = `TEST-B-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name, isPrimary: true }),
    });
    assert.equal(res.status, 201);
    const contact = (await res.json()) as { id: number; isPrimary: boolean };
    assert.equal(contact.isPrimary, true);
    created.push(contact.id);

    const listRes = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, { headers: authHeaders() });
    const contacts = (await listRes.json()) as { name: string; isPrimary: boolean }[];
    const a = contacts.find((c) => c.name.startsWith("TEST-A-"));
    const b = contacts.find((c) => c.name === name);
    assert.ok(a && b);
    assert.equal(a!.isPrimary, false, "El contacto anterior debió quedar desmarcado");
    assert.equal(b!.isPrimary, true);
  });

  it("borrar el principal reasigna al más reciente", async () => {
    const listBefore = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, { headers: authHeaders() });
    const before = (await listBefore.json()) as { id: number; name: string; isPrimary: boolean }[];
    const b = before.find((c) => c.name.startsWith("TEST-B-"));
    const a = before.find((c) => c.name.startsWith("TEST-A-"));
    assert.ok(b && b.isPrimary, "Debe existir el contacto principal TEST-B");

    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts/${b!.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);

    const listAfter = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, { headers: authHeaders() });
    const after = (await listAfter.json()) as { id: number; name: string; isPrimary: boolean }[];
    const aAfter = after.find((c) => c.id === a!.id);
    assert.equal(aAfter!.isPrimary, true, "El contacto más reciente restante debió quedar como principal");
  });

  it("PATCH edita datos y al marcar principal desmarca a los demás", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: `TEST-EDIT-${Date.now()}`, isPrimary: false, position: "Vendedor" }),
    });
    assert.equal(res.status, 201);
    const contact = (await res.json()) as { id: number };
    created.push(contact.id);

    const patch = await fetch(`${baseUrl}/api/clients/${clientId}/contacts/${contact.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-EDIT Renombrado", position: "Gerente", phone: "123", email: "e@x.com", isPrimary: true }),
    });
    assert.equal(patch.status, 200);
    const updated = (await patch.json()) as { name: string; position: string; phone: string; email: string; isPrimary: boolean };
    assert.equal(updated.name, "TEST-EDIT Renombrado");
    assert.equal(updated.position, "Gerente");
    assert.equal(updated.phone, "123");
    assert.equal(updated.email, "e@x.com");
    assert.equal(updated.isPrimary, true);

    const listRes = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, { headers: authHeaders() });
    const list = (await listRes.json()) as { name: string; isPrimary: boolean }[];
    const prev = list.find((c) => c.name.startsWith("TEST-A-") && !c.name.includes("Renombrado"));
    assert.equal(prev?.isPrimary, false, "El principal anterior debió quedar desmarcado");
  });

  it("PATCH valida y responde 404 si el contacto no existe", async () => {
    const bad = await fetch(`${baseUrl}/api/clients/${clientId}/contacts/99999999`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ name: "X" }),
    });
    assert.equal(bad.status, 404);

    const badBody = await fetch(`${baseUrl}/api/clients/${clientId}/contacts/${created[0] ?? 1}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ name: "" }),
    });
    assert.equal(badBody.status, 400);
  });
});

describe("clientes · nuevo CRM (edición, visitas, avatar, lista global)", () => {
  let clientId = 0;

  before(async () => {
    const res = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-CRM" }),
    });
    assert.equal(res.status, 201);
    const client = (await res.json()) as { id: number };
    clientId = client.id;
  });

  after(async () => {
    await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  });

  it("PATCH /:id edita nombre, contactInfo y creditLimit", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-CRM Editado", contactInfo: { email: "x@y.com", notes: "n" }, creditLimit: 5000 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { name: string; contactInfo: { email: string; phone?: string }; creditLimit: string };
    assert.equal(body.name, "TEST-CRM Editado");
    assert.equal(body.contactInfo.email, "x@y.com");
    assert.equal(Number(body.creditLimit), 5000);
  });

  it("POST /:id/visit incrementa viewCount y setea lastViewedAt", async () => {
    const antes = await prisma.client.findUnique({ where: { id: clientId } });
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/visit`, { method: "POST", headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewCount: number; lastViewedAt: string };
    const despues = await prisma.client.findUnique({ where: { id: clientId } });
    assert.equal(body.viewCount, (antes!.viewCount ?? 0) + 1);
    assert.equal(despues!.viewCount, (antes!.viewCount ?? 0) + 1);
    assert.ok(body.lastViewedAt);
  });

  it("POST /:id/visit con racha en el umbral hace boost en vivo a máximo+1", async () => {
    // Un cliente con 4 interacciones en la semana: la siguiente visita cruza el
    // umbral (5) y sube el viewCount al máximo actual + 1, no solo +1.
    await prisma.client.update({
      where: { id: clientId },
      data: { cycleInteractions: HOT_THRESHOLD - 1, viewCount: 0 },
    });
    const antes = await prisma.client.aggregate({ _max: { viewCount: true } });

    const res = await fetch(`${baseUrl}/api/clients/${clientId}/visit`, { method: "POST", headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { viewCount: number; cycleInteractions: number };
    assert.equal(body.cycleInteractions, 0, "el boost se consume: las interacciones vuelven a 0");
    assert.equal(body.viewCount, (antes._max.viewCount ?? 0) + 1, "el boost sube al máximo + 1");

    // La siguiente visita ya no cruza el umbral: solo +1 (necesita 5 nuevas).
    const segunda = await fetch(`${baseUrl}/api/clients/${clientId}/visit`, { method: "POST", headers: authHeaders() });
    const body2 = (await segunda.json()) as { viewCount: number; cycleInteractions: number };
    assert.equal(body2.viewCount, body.viewCount + 1, "sin boost: solo incrementa en +1");
    assert.equal(body2.cycleInteractions, 1, "arranca de nuevo el conteo de interacciones");
  });

  it("POST /clients crea el cliente arriba del ranking (máximo+1 y hot)", async () => {
    const antes = await prisma.client.aggregate({ _max: { viewCount: true } });
    const res = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-BOOST-CREATE" }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { id: number; viewCount: number; cycleInteractions: number };
    assert.equal(body.viewCount, (antes._max.viewCount ?? 0) + 1);
    assert.equal(body.cycleInteractions, HOT_THRESHOLD, "nace 'hot'");
    await prisma.client.delete({ where: { id: body.id } });
  });

  it("POST /clients rechaza un nombre duplicado (case-insensitive) entre clientes activos", async () => {
    const name = `TEST-DUP-${Date.now()}`;
    const first = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    assert.equal(first.status, 201);
    const created = (await first.json()) as { id: number };

    const dup = await fetch(`${baseUrl}/api/clients`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: name.toLowerCase() }),
    });
    assert.equal(dup.status, 400);

    await prisma.client.delete({ where: { id: created.id } });
  });

  it("DELETE /:id se bloquea si el cliente tiene un pedido o despacho abierto", async () => {
    const client = await prisma.client.create({ data: { name: `TEST-OPEN-WORK-${Date.now()}` } });
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });

    const pedido = await prisma.pedido.create({
      data: {
        orderNumber: `PED-TEST-${Date.now()}`,
        clientId: client.id,
        status: "pendiente",
        currentVersion: 1,
        versions: { create: { versionNumber: 1, status: "pendiente", items: { create: { productId: product.id, quantity: 1, unitPrice: 1 } } } },
      },
    });

    const blocked = await fetch(`${baseUrl}/api/clients/${client.id}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(blocked.status, 400);

    await prisma.pedidoVersionItem.deleteMany({ where: { pedidoVersion: { pedidoId: pedido.id } } });
    await prisma.pedidoVersion.deleteMany({ where: { pedidoId: pedido.id } });
    await prisma.pedido.delete({ where: { id: pedido.id } });

    const okNow = await fetch(`${baseUrl}/api/clients/${client.id}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(okNow.status, 200, "sin trabajo abierto, la desactivación funciona normal");

    await prisma.client.delete({ where: { id: client.id } });
  });

  it("PATCH /:id/contacts/:contactId acepta null explícito para borrar teléfono/email", async () => {
    const created = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-CLEAR-CONTACT", phone: "3001234567", email: "test@example.com" }),
    });
    const contact = (await created.json()) as { id: number };

    const cleared = await fetch(`${baseUrl}/api/clients/${clientId}/contacts/${contact.id}`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ phone: null, email: null }),
    });
    assert.equal(cleared.status, 200);
    const body = (await cleared.json()) as { phone: string | null; email: string | null; name: string };
    assert.equal(body.phone, null);
    assert.equal(body.email, null);
    assert.equal(body.name, "TEST-CLEAR-CONTACT", "editar sin mandar name no lo borra (name sigue siendo opcional en el PATCH)");

    await prisma.clientContact.delete({ where: { id: contact.id } });
  });

  it("POST /contacts/:id/visit incrementa la frecuencia DEL CONTACTO (independiente del cliente)", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-CONTACT-FREQ" }),
    });
    assert.equal(res.status, 201);
    const contact = (await res.json()) as { id: number; viewCount: number; cycleInteractions: number; clientId: number };

    const clientAntes = (await prisma.client.findUnique({ where: { id: clientId } }))?.viewCount ?? 0;

    const visit = await fetch(`${baseUrl}/api/clients/contacts/${contact.id}/visit`, { method: "POST", headers: authHeaders() });
    assert.equal(visit.status, 200);
    const body = (await visit.json()) as { viewCount: number; cycleInteractions: number };
    assert.equal(body.viewCount, (contact.viewCount ?? 0) + 1, "la visita cruza el umbral del contacto: sube +1 sobre su conteo");

    const clientDespues = (await prisma.client.findUnique({ where: { id: clientId } }))?.viewCount ?? 0;
    assert.equal(clientDespues, clientAntes, "la visita del contacto NO toca la frecuencia del cliente");

    await prisma.clientContact.delete({ where: { id: contact.id } });
  });

  it("POST /contacts/:id/visit: umbral → boost a máximo+1 y consume (necesita 5 frescas)", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/contacts`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "TEST-CONTAC-FRESH" }),
    });
    const contact = (await res.json()) as { id: number };

    await prisma.clientContact.update({
      where: { id: contact.id },
      data: { cycleInteractions: HOT_THRESHOLD - 1, viewCount: 0 },
    });
    const antesMax = await prisma.clientContact.aggregate({ _max: { viewCount: true } });

    const primera = await fetch(`${baseUrl}/api/clients/contacts/${contact.id}/visit`, { method: "POST", headers: authHeaders() });
    const b1 = (await primera.json()) as { viewCount: number; cycleInteractions: number };
    assert.equal(b1.viewCount, (antesMax._max.viewCount ?? 0) + 1, "cruza el umbral: boost a máximo+1");
    assert.equal(b1.cycleInteractions, 0, "boost consumido");

    const segunda = await fetch(`${baseUrl}/api/clients/contacts/${contact.id}/visit`, { method: "POST", headers: authHeaders() });
    const b2 = (await segunda.json()) as { viewCount: number; cycleInteractions: number };
    assert.equal(b2.viewCount, b1.viewCount + 1, "sin umbral: solo +1");
    assert.equal(b2.cycleInteractions, 1);

    await prisma.clientContact.delete({ where: { id: contact.id } });
  });

  it("GET /contacts devuelve contactos con empresa relacionada", async () => {
    const res = await fetch(`${baseUrl}/api/clients/contacts`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const contacts = (await res.json()) as {
      name: string;
      viewCount?: number;
      cycleInteractions?: number;
      client: { id: number; name: string } | null;
    }[];
    assert.ok(Array.isArray(contacts));
    assert.ok(contacts.length > 0, "El seed incluye contactos");
    assert.ok(contacts.every((c) => c.client && typeof c.client.name === "string"));
    // La frecuencia es propia del contacto: el listado expone sus contadores.
    assert.ok(contacts.every((c) => typeof c.viewCount === "number" && typeof c.cycleInteractions === "number"));
  });

  it("POST /:id/avatar rechaza un archivo que no es imagen", async () => {
    const form = new FormData();
    form.append("avatar", new Blob(["texto"], { type: "text/plain" }));
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(res.status, 400);
  });

  it("POST /:id/avatar sube un PNG válido y setea avatarUrl", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    const form = new FormData();
    form.append("avatar", new File([png as any], "avatar.png", { type: "image/png" }));
    const res = await fetch(`${baseUrl}/api/clients/${clientId}/avatar`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const bodyText = await res.text();
    assert.equal(res.status, 200, `avatar PNG reply: ${bodyText}`);
    const body = JSON.parse(bodyText) as { avatarUrl: string };
    assert.ok(body.avatarUrl.startsWith("/api/uploads/clients/"));

    const stored = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "server",
      "uploads",
      "clients",
      path.basename(body.avatarUrl)
    );
    assert.ok(fs.existsSync(stored), "El archivo debe existir en disco");
    fs.rmSync(stored, { force: true });

    await prisma.client.update({ where: { id: clientId }, data: { avatarUrl: null } });
  });

  it("DELETE /:id desactiva el cliente", async () => {
    const res = await fetch(`${baseUrl}/api/clients/${clientId}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { active: boolean };
    assert.equal(body.active, false);
    const enDb = await prisma.client.findUnique({ where: { id: clientId } });
    assert.equal(enDb!.active, false);
    // Ya no aparece en el listado (solo clientes activos).
    const list = (await (await fetch(`${baseUrl}/api/clients`, { headers: authHeaders() })).json()) as { id: number }[];
    assert.ok(!list.some((c) => c.id === clientId));
  });
});

describe("productos", () => {
  it("crea un producto con el rol correcto, rechaza el rol incorrecto, y genera el SKU con el prefijo de la categoría", async () => {
    const forbidden = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("almacen"),
      body: JSON.stringify({ name: "Producto de test", category: "tubular", unit: "unidad", minStock: 1, unitPrice: 100 }),
    });
    assert.equal(forbidden.status, 403);

    const res = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Producto de test", category: "tubular", unit: "unidad", minStock: 1, unitPrice: 100 }),
    });
    assert.equal(res.status, 201);
    const product = (await res.json()) as { id: number; sku: string };
    assert.match(product.sku, /^TUB-\d{3}$/);

    await prisma.product.delete({ where: { id: product.id } });
  });

  it("edita, desactiva y reactiva un producto — desactivado sale del selector filtrado pero no del catálogo completo", async () => {
    const created = (await (
      await fetch(`${baseUrl}/api/products`, {
        method: "POST",
        headers: headersFor("planeacion"),
        body: JSON.stringify({ name: "Producto B", category: "bultos", unit: "unidad", minStock: 1, unitPrice: 100 }),
      })
    ).json()) as { id: number };

    const patched = await fetch(`${baseUrl}/api/products/${created.id}`, {
      method: "PATCH",
      headers: headersFor("planeacion"),
      body: JSON.stringify({ name: "Producto B editado" }),
    });
    assert.equal(patched.status, 200);

    const deactivated = await fetch(`${baseUrl}/api/products/${created.id}`, { method: "DELETE", headers: headersFor("planeacion") });
    assert.equal(deactivated.status, 200);
    assert.equal(((await deactivated.json()) as { active: boolean }).active, false);

    const filtered = (await (await fetch(`${baseUrl}/api/inventory/products`, { headers: authHeaders() })).json()) as { id: number }[];
    assert.ok(!filtered.some((p) => p.id === created.id));
    const full = (await (await fetch(`${baseUrl}/api/products`, { headers: authHeaders() })).json()) as { id: number }[];
    assert.ok(full.some((p) => p.id === created.id));

    const reactivated = await fetch(`${baseUrl}/api/products/${created.id}/reactivate`, { method: "POST", headers: headersFor("planeacion") });
    assert.equal(reactivated.status, 200);
    assert.equal(((await reactivated.json()) as { active: boolean }).active, true);

    await prisma.product.delete({ where: { id: created.id } });
  });
});

describe("usuarios", () => {
  it("crea un usuario con el rol correcto, rechaza el rol incorrecto, y rechaza email duplicado", async () => {
    const email = `test-user-${Date.now()}@empresa.com`;
    const forbidden = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ name: "Test User", email, password: "testpass123", role: "ventas_pedidos" }),
    });
    assert.equal(forbidden.status, 403);

    const res = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Test User", email, password: "testpass123", role: "ventas_pedidos" }),
    });
    assert.equal(res.status, 201);
    const user = (await res.json()) as { id: number };

    const dup = await fetch(`${baseUrl}/api/users`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ name: "Otro", email, password: "testpass123", role: "ventas_pedidos" }),
    });
    assert.equal(dup.status, 409);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it("un admin no puede desactivarse a sí mismo; desactivar bloquea el login y reactivar lo devuelve", async () => {
    const me = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@empresa.com", password: "password123" }),
    });
    const meBody = (await me.json()) as { user: { id: number } };

    const selfDeactivate = await fetch(`${baseUrl}/api/users/${meBody.user.id}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(selfDeactivate.status, 400);

    const email = `test-deact-${Date.now()}@empresa.com`;
    const created = (await (
      await fetch(`${baseUrl}/api/users`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Test Deact", email, password: "testpass123", role: "ventas_pedidos" }),
      })
    ).json()) as { id: number };

    const deactivated = await fetch(`${baseUrl}/api/users/${created.id}`, { method: "DELETE", headers: authHeaders() });
    assert.equal(deactivated.status, 200);

    const loginBlocked = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "testpass123" }),
    });
    assert.equal(loginBlocked.status, 401);

    const reactivated = await fetch(`${baseUrl}/api/users/${created.id}/reactivate`, { method: "POST", headers: authHeaders() });
    assert.equal(reactivated.status, 200);

    const loginOk = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "testpass123" }),
    });
    assert.equal(loginOk.status, 200);

    await prisma.user.delete({ where: { id: created.id } });
  });
});

describe("notificaciones", () => {
  it("lista, cuenta, marca como leída (propia sí, ajena no) y marca todas", async () => {
    const me = (await (
      await fetch(`${baseUrl}/api/auth/me`, { headers: authHeaders() })
    ).json()) as { id: number };
    const otherUser = await prisma.user.findFirst({ where: { email: "ventas@empresa.com" } });

    const notif = await prisma.notification.create({
      data: { userId: me.id, type: "test", message: "TEST-notificación", read: false },
    });

    const list = (await (await fetch(`${baseUrl}/api/notifications`, { headers: authHeaders() })).json()) as { id: number }[];
    assert.ok(list.some((n) => n.id === notif.id));

    const countBefore = (await (
      await fetch(`${baseUrl}/api/notifications/unread-count`, { headers: authHeaders() })
    ).json()) as { count: number };
    assert.ok(countBefore.count >= 1);

    const foreignAttempt = await fetch(`${baseUrl}/api/notifications/${notif.id}/read`, {
      method: "PATCH",
      headers: headersFor("ventas"),
    });
    assert.equal(foreignAttempt.status, 404);

    const markRead = await fetch(`${baseUrl}/api/notifications/${notif.id}/read`, { method: "PATCH", headers: authHeaders() });
    assert.equal(markRead.status, 200);
    assert.equal(((await markRead.json()) as { read: boolean }).read, true);

    const markAll = await fetch(`${baseUrl}/api/notifications/read-all`, { method: "PATCH", headers: authHeaders() });
    assert.equal(markAll.status, 200);

    await prisma.notification.delete({ where: { id: notif.id } });
    void otherUser;
  });
});

describe("inventario · movimientos", () => {
  it("Almacén puede listar, Ventas no puede, y un query param inválido da 400", async () => {
    const ok = await fetch(`${baseUrl}/api/inventory/movements`, { headers: headersFor("almacen") });
    assert.equal(ok.status, 200);
    const okBody = (await ok.json()) as { items: unknown[] };
    assert.ok(Array.isArray(okBody.items));

    const forbidden = await fetch(`${baseUrl}/api/inventory/movements`, { headers: headersFor("ventas") });
    assert.equal(forbidden.status, 403);

    const badQuery = await fetch(`${baseUrl}/api/inventory/movements?productId=abc`, { headers: headersFor("almacen") });
    assert.equal(badQuery.status, 400);
  });
});

describe("dashboard", () => {
  it("GET /resumen trae carteraVencida numérico", async () => {
    const res = await fetch(`${baseUrl}/api/dashboard/resumen`, { headers: authHeaders() });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { carteraVencida: number };
    assert.equal(typeof body.carteraVencida, "number");
  });

  it("GET /indicadores funciona sin params y con rango, y rechaza rol incorrecto", async () => {
    const sinRango = await fetch(`${baseUrl}/api/dashboard/indicadores`, { headers: authHeaders() });
    assert.equal(sinRango.status, 200);

    const conRango = await fetch(`${baseUrl}/api/dashboard/indicadores?from=2026-01-01&to=2026-12-31`, { headers: authHeaders() });
    assert.equal(conRango.status, 200);

    const forbidden = await fetch(`${baseUrl}/api/dashboard/indicadores`, { headers: headersFor("almacen") });
    assert.equal(forbidden.status, 403);
  });
});

describe("exportaciones", () => {
  it("inventario es accesible para roles con acceso a Existencias; pedidos requiere Ventas", async () => {
    const inv = await fetch(`${baseUrl}/api/export/inventario`, { headers: headersFor("almacen") });
    assert.equal(inv.status, 200);
    assert.ok(inv.headers.get("content-type")?.includes("spreadsheetml"));

    const forbidden = await fetch(`${baseUrl}/api/export/pedidos`, { headers: headersFor("almacen") });
    assert.equal(forbidden.status, 403);

    const allowed = await fetch(`${baseUrl}/api/export/pedidos`, { headers: headersFor("ventas") });
    assert.equal(allowed.status, 200);
  });
});

describe("facturas · vencimiento y PDF", () => {
  it("una factura con dueDate pasado y sin pagos queda 'vencida' en la cartera del cliente", async () => {
    const acme = await prisma.client.findFirst({ where: { name: "Cliente ACME" } });
    const bulto = await prisma.product.findFirst({ where: { sku: "BUL-001" } });
    assert.ok(acme && bulto, "requiere el seed (Cliente ACME, producto BUL-001)");

    const res = await fetch(`${baseUrl}/api/facturas`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({
        clientId: acme!.id,
        dueDate: "2020-01-01",
        items: [{ productId: bulto!.id, quantity: 1, unitPrice: 1000 }],
      }),
    });
    assert.equal(res.status, 201);
    const factura = (await res.json()) as { id: number; invoiceNumber: string };

    const cartera = (await (
      await fetch(`${baseUrl}/api/clients/${acme!.id}/cartera`, { headers: headersFor("ventas") })
    ).json()) as { facturasPendientes: { id: number; vencida: boolean }[] };
    const found = cartera.facturasPendientes.find((f) => f.id === factura.id);
    assert.ok(found, "la factura recién creada debe aparecer como pendiente");
    assert.equal(found!.vencida, true);

    const pdf = await fetch(`${baseUrl}/api/facturas/${factura.id}/pdf`, { headers: headersFor("ventas") });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const buffer = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");

    await prisma.facturaItem.deleteMany({ where: { facturaId: factura.id } });
    await prisma.factura.delete({ where: { id: factura.id } });
  });
});

describe("cotizaciones · PDF", () => {
  it("genera un PDF válido para una cotización", async () => {
    const acme = await prisma.client.findFirst({ where: { name: "Cliente ACME" } });
    const bulto = await prisma.product.findFirst({ where: { sku: "BUL-001" } });
    assert.ok(acme && bulto, "requiere el seed (Cliente ACME, producto BUL-001)");

    const created = (await (
      await fetch(`${baseUrl}/api/cotizaciones`, {
        method: "POST",
        headers: headersFor("ventas"),
        body: JSON.stringify({ clientId: acme!.id, items: [{ productId: bulto!.id, quantity: 1, unitPrice: 1000 }] }),
      })
    ).json()) as { id: number };

    const pdf = await fetch(`${baseUrl}/api/cotizaciones/${created.id}/pdf`, { headers: headersFor("ventas") });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const buffer = Buffer.from(await pdf.arrayBuffer());
    assert.equal(buffer.subarray(0, 4).toString(), "%PDF");

    await prisma.cotizacionItem.deleteMany({ where: { cotizacionId: created.id } });
    await prisma.cotizacion.delete({ where: { id: created.id } });
  });
});

describe("despachos · completar no rompe (hook de WhatsApp)", () => {
  it("marcar el último ítem pendiente completa el despacho sin error, aunque WhatsApp no esté configurado", async () => {
    const acme = await prisma.client.findFirst({ where: { name: "Cliente ACME" } });
    const bulto = await prisma.product.findFirst({ where: { sku: "BUL-001" } });
    assert.ok(acme && bulto);

    const created = (await (
      await fetch(`${baseUrl}/api/dispatches`, {
        method: "POST",
        headers: headersFor("almacen"),
        body: JSON.stringify({ clientId: acme!.id, items: [{ productId: bulto!.id, quantityRequested: 1 }] }),
      })
    ).json()) as { id: number; items: { id: number }[] };

    const res = await fetch(`${baseUrl}/api/dispatches/${created.id}/items/${created.items[0].id}`, {
      method: "PATCH",
      headers: headersFor("almacen"),
      body: JSON.stringify({ quantityDispatched: 1 }),
    });
    assert.equal(res.status, 200);

    const dispatch = await prisma.dispatch.findUnique({ where: { id: created.id } });
    assert.equal(dispatch!.status, "despachado");

    await prisma.dispatchItem.deleteMany({ where: { dispatchId: created.id } });
    await prisma.inventoryMovement.deleteMany({ where: { referenceType: "dispatch_item", referenceId: created.items[0].id } });
    await prisma.dispatch.delete({ where: { id: created.id } });
    // applyMovement() ya restó 1 al stock real de BUL-001 (currentQuantity)
    // al marcar el ítem despachado — borrar el movimiento no revierte ese
    // efecto solo, hay que reponerlo a mano o el stock del seed se va
    // achicando 1 unidad cada vez que corre la suite.
    await prisma.inventoryStock.update({ where: { productId: bulto!.id }, data: { currentQuantity: { increment: 1 } } });
  });
});

describe("almacén · ubicación por token", () => {
  it("resuelve el token del QR a la ubicación correcta, 404 con token inválido, 403 con rol incorrecto", async () => {
    const code = `TEST-LOC-${Date.now()}`;
    const location = (await (
      await fetch(`${baseUrl}/api/warehouse/locations`, {
        method: "POST",
        headers: headersFor("almacen"),
        body: JSON.stringify({ code, label: "Ubicación de test" }),
      })
    ).json()) as { id: number; code: string };

    const qr = (await (
      await fetch(`${baseUrl}/api/warehouse/locations/${location.id}/qr`, { headers: headersFor("almacen") })
    ).json()) as { url: string };
    const locToken = qr.url.split("/").pop()!;

    const resolved = await fetch(`${baseUrl}/api/warehouse/locations/by-token/${locToken}`, { headers: headersFor("almacen") });
    assert.equal(resolved.status, 200);
    const resolvedBody = (await resolved.json()) as { id: number; code: string };
    assert.equal(resolvedBody.id, location.id);
    assert.equal(resolvedBody.code, code);

    const notFound = await fetch(`${baseUrl}/api/warehouse/locations/by-token/token-invalido`, { headers: headersFor("almacen") });
    assert.equal(notFound.status, 404);

    const forbidden = await fetch(`${baseUrl}/api/warehouse/locations/by-token/${locToken}`, { headers: headersFor("ventas") });
    assert.equal(forbidden.status, 403);

    await prisma.warehouseLocation.delete({ where: { id: location.id } });
  });
});

describe("frecuentes · ranking, boost por interacciones y purga semanal", () => {
  it("redistribuye en ranking: el mas visitado conserva el valor mas alto", () => {
    const next = redistributeScores([
      { id: 1, score: 50 },
      { id: 2, score: 37 },
      { id: 3, score: 12 },
      { id: 4, score: 2 },
    ]);
    assert.deepEqual(
      next.sort((a, b) => a.id - b.id).map((c) => c.score),
      [3, 2, 1, 0]
    );
  });

  it("desempata por visitas más recientes", () => {
    const next = redistributeScores([
      { id: 1, score: 10, lastActiveAt: "2026-08-01T00:00:00Z" },
      { id: 2, score: 10, lastActiveAt: "2026-08-07T00:00:00Z" },
    ]);
    const byId: Record<number, number> = Object.fromEntries(next.map((c) => [c.id, c.score]));
    assert.equal(byId[2], 1, "el visto más recientemente gana el tie");
    assert.equal(byId[1], 0);
  });

  it("con un solo cliente queda en 0", () => {
    const next = redistributeScores([{ id: 1, score: 999 }]);
    assert.deepEqual(next, [{ id: 1, score: 0 }]);
  });

  it("boostValue iguala el maximo y suma uno", () => {
    assert.equal(boostValue(10), 11);
    assert.equal(boostValue(null), 1);
    assert.equal(boostValue(0), 1);
  });

  it("isHot/nextCycle se basan en interacciones del ciclo", () => {
    assert.equal(isHot(4, HOT_THRESHOLD), false);
    assert.equal(isHot(5, HOT_THRESHOLD), true);
    assert.equal(nextCycle(null), 1);
    assert.equal(nextCycle(4), 5);
  });

  it("nextVisitState: +1 normal o boost consumido al cruzar el umbral (motor común)", () => {
    assert.deepEqual(nextVisitState({ viewCount: 3, cycleInteractions: 4 }, 10), { viewCount: 11, cycleInteractions: 0 });
    assert.deepEqual(nextVisitState({ viewCount: 3, cycleInteractions: 2 }, 10), { viewCount: 4, cycleInteractions: 3 });
  });
});

describe("despacho de rollos a bodegas internas", () => {
  let orderId = 0;
  let roll: Awaited<ReturnType<typeof createTestRoll>>;
  let rollCode = "";
  const clock = { clientTimezone: "America/Bogota", clientUtcOffsetMinutes: -300 };

  before(async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-TRASLADO-${Date.now()}`, station: "extrusion", productId: product.id, quantityPlanned: 100 },
    });
    orderId = order.id;
    roll = await createTestRoll(order.id, { weightKg: 40 });
    rollCode = `${ROLL_CODE_PREFIX.extrusion}-${roll.stationSequence}`;
  });

  after(async () => {
    await prisma.rollTransfer.deleteMany({ where: { rollId: roll.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: orderId } });
    await prisma.productionOrder.delete({ where: { id: orderId } });
  });

  const post = (role: string, path: string, body: unknown) =>
    fetch(`${baseUrl}/api/roll-transfers${path}`, { method: "POST", headers: headersFor(role), body: JSON.stringify(body) });

  it("ventas no tiene acceso al módulo", async () => {
    const res = await fetch(`${baseUrl}/api/roll-transfers`, { headers: headersFor("ventas") });
    assert.equal(res.status, 403);
  });

  it("escanear sin el token correcto da 403 (hay que tener el rollo en la mano)", async () => {
    const res = await fetch(`${baseUrl}/api/roll-transfers/scan/${rollCode}?token=AAAAAAAAAAAAAAAA`, { headers: headersFor("operario_extrusion") });
    assert.equal(res.status, 403);
    const create = await post("operario_extrusion", "", { code: rollCode, token: "AAAAAAAAAAAAAAAA", toStation: "sellado", mode: "retiro", ...clock });
    assert.equal(create.status, 403);
  });

  it("escanear con el token devuelve el rollo y las bodegas a las que puede ir", async () => {
    const res = await fetch(`${baseUrl}/api/roll-transfers/scan/${rollCode}?token=${roll.possessionToken}`, { headers: headersFor("operario_extrusion") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.roll.code, rollCode);
    assert.equal(body.roll.remainingKg, 40);
    assert.deepEqual(body.destinations, ["impresion", "sellado", "precorte"]);
    assert.equal(body.openTransfer, null);
    assert.equal(body.roll.possessionTokenHash, undefined, "el hash nunca sale del servidor");
  });

  it("valida destino, nombre en modo entrega y zona horaria", async () => {
    const base = { code: rollCode, token: roll.possessionToken, ...clock };
    assert.equal((await post("operario_extrusion", "", { ...base, toStation: "extrusion", mode: "retiro" })).status, 400);
    assert.equal((await post("operario_extrusion", "", { ...base, toStation: "sellado", mode: "entrega" })).status, 400);
    assert.equal((await post("operario_extrusion", "", { ...base, toStation: "sellado", mode: "retiro", clientTimezone: "Marte/Olympus" })).status, 400);
  });

  it("entrega: el operario tipea quién se lo lleva; no se puede despachar dos veces sin recibir", async () => {
    const res = await post("operario_extrusion", "", {
      code: rollCode,
      token: roll.possessionToken,
      toStation: "sellado",
      mode: "entrega",
      carrierName: "Juan Camionero",
      ...clock,
    });
    assert.equal(res.status, 201);
    const transfer = (await res.json()) as any;
    assert.equal(transfer.carrierName, "Juan Camionero");
    assert.equal(transfer.registeredBy.name, "Operario Extrusión");
    assert.equal(transfer.status, "en_transito");
    assert.equal(transfer.clientTimezone, "America/Bogota");
    assert.equal(transfer.rollCode, rollCode);

    const again = await post("operario_extrusion", "", { code: rollCode, token: roll.possessionToken, toStation: "precorte", mode: "retiro", ...clock });
    assert.equal(again.status, 409);
  });

  it("recepción: solo un operario de la bodega destino, con el QR, y una sola vez", async () => {
    const open = await prisma.rollTransfer.findFirstOrThrow({ where: { rollId: roll.id, status: "en_transito" } });
    const body = { code: rollCode, token: roll.possessionToken, clientTimezone: "America/Lima", clientUtcOffsetMinutes: -300 };

    assert.equal((await post("operario_precorte", `/${open.id}/receive`, body)).status, 403, "otra bodega no lo recibe");
    assert.equal((await post("operario_sellado", `/${open.id}/receive`, { ...body, token: "AAAAAAAAAAAAAAAA" })).status, 403);

    const ok = await post("operario_sellado", `/${open.id}/receive`, body);
    assert.equal(ok.status, 200);
    const received = (await ok.json()) as any;
    assert.equal(received.status, "recibido");
    assert.equal(received.receivedBy.name, "Operario Sellado");
    assert.equal(received.receivedTimezone, "America/Lima");

    assert.equal((await post("operario_sellado", `/${open.id}/receive`, body)).status, 409);
  });

  it("recibir escaneando el QR de OTRO rollo (no el del despacho) se rechaza", async () => {
    const otherRoll = await createTestRoll(orderId, { weightKg: 10 });
    const otherCode = `${ROLL_CODE_PREFIX.extrusion}-${otherRoll.stationSequence}`;
    const dispatch = await post("operario_extrusion", "", { code: otherCode, token: otherRoll.possessionToken, toStation: "impresion", mode: "retiro", ...clock });
    assert.equal(dispatch.status, 201);
    const transfer = (await dispatch.json()) as any;

    // Escanea el QR del `roll` de la fixture (un rollo real, pero NO el de
    // este despacho) al intentar recibir el despacho de `otherRoll`.
    const wrongScan = await post("operario_impresion", `/${transfer.id}/receive`, { code: rollCode, token: roll.possessionToken, ...clock });
    assert.equal(wrongScan.status, 400);
    const body = (await wrongScan.json()) as { error: string };
    assert.match(body.error, /no es el del rollo/);

    await prisma.rollTransfer.deleteMany({ where: { rollId: otherRoll.id } });
    await prisma.productionRoll.delete({ where: { id: otherRoll.id } });
  });

  it("guarda los kilos con que sale el rollo y avisa a Gestión si llega con otro peso", async () => {
    const madre = await createTestRoll(orderId, { weightKg: 30 });
    const code = `${ROLL_CODE_PREFIX.extrusion}-${madre.stationSequence}`;
    const salida = await post("operario_extrusion", "", { code, token: madre.possessionToken, toStation: "sellado", mode: "retiro", ...clock });
    assert.equal(salida.status, 201);
    const transfer = (await salida.json()) as any;
    assert.equal(Number(transfer.dispatchedKg), 30, "sale con el saldo real del rollo");

    const recibido = await post("operario_sellado", `/${transfer.id}/receive`, { code, token: madre.possessionToken, receivedKg: 27.5, ...clock });
    assert.equal(recibido.status, 200);
    assert.equal(Number(((await recibido.json()) as any).receivedKg), 27.5);
    const aviso = await prisma.notification.findFirst({ where: { type: "despacho_diferencia_peso", message: { contains: `rollo ${code} ` } } });
    assert.ok(aviso, "2,5 kg de diferencia genera un aviso para Gestión");
    assert.match(aviso!.message, /-2\.5 kg/);

    // Dentro de la tolerancia (0,5 kg) no se avisa.
    const otro = await createTestRoll(orderId, { weightKg: 10 });
    const otroCode = `${ROLL_CODE_PREFIX.extrusion}-${otro.stationSequence}`;
    const salidaOtro = (await (await post("operario_extrusion", "", { code: otroCode, token: otro.possessionToken, toStation: "sellado", mode: "retiro", ...clock })).json()) as any;
    // Solo los avisos de ESTA recepción: los números de rollo se reusan
    // entre corridas y pueden quedar avisos viejos con el mismo código.
    const antesDeRecibir = new Date();
    await post("operario_sellado", `/${salidaOtro.id}/receive`, { code: otroCode, token: otro.possessionToken, receivedKg: 9.8, ...clock });
    assert.equal(
      await prisma.notification.count({
        where: { type: "despacho_diferencia_peso", message: { contains: `rollo ${otroCode} ` }, createdAt: { gte: antesDeRecibir } },
      }),
      0
    );

    await prisma.notification.deleteMany({ where: { type: "despacho_diferencia_peso", message: { contains: `rollo ${code} ` } } });
    await prisma.productionRoll.deleteMany({ where: { id: { in: [madre.id, otro.id] } } });
  });

  it("el nombre de quien se lleva el rollo se guarda normalizado y se sugiere en /carriers", async () => {
    const r = await createTestRoll(orderId, { weightKg: 12 });
    const code = `${ROLL_CODE_PREFIX.extrusion}-${r.stationSequence}`;
    const res = await post("operario_extrusion", "", {
      code,
      token: r.possessionToken,
      toStation: "impresion",
      mode: "entrega",
      carrierName: "  josé   de la PEÑA ",
      ...clock,
    });
    assert.equal(res.status, 201);
    assert.equal(((await res.json()) as any).carrierName, "José De La Peña");
    const carriers = (await (await fetch(`${baseUrl}/api/roll-transfers/carriers`, { headers: headersFor("operario_extrusion") })).json()) as string[];
    assert.ok(carriers.includes("José De La Peña"));
    await prisma.productionRoll.delete({ where: { id: r.id } });
  });

  it("retiro: queda a nombre de la cuenta que escanea; el historial filtra por bodega", async () => {
    const res = await post("almacen", "", { code: rollCode, token: roll.possessionToken, toStation: "precorte", mode: "retiro", carrierName: "ignorado", ...clock });
    assert.equal(res.status, 201);
    const transfer = (await res.json()) as any;
    assert.equal(transfer.mode, "retiro");
    assert.equal(transfer.carrierName, "Encargado Despacho");
    assert.equal(transfer.fromStation, "sellado", "sale de la bodega donde lo recibieron, no de su estación de origen");

    const list = (await (await fetch(`${baseUrl}/api/roll-transfers?toStation=precorte&status=en_transito`, { headers: headersFor("operario_precorte") })).json()) as any[];
    assert.ok(list.some((t) => t.id === transfer.id));
    assert.ok(list.every((t) => t.toStation === "precorte" && t.status === "en_transito"));
  });

  it("anular es solo de Gestión y solo mientras está en tránsito", async () => {
    const received = await prisma.rollTransfer.findFirstOrThrow({ where: { rollId: roll.id, status: "recibido" } });
    const deniedReceived = await fetch(`${baseUrl}/api/roll-transfers/${received.id}`, { method: "DELETE", headers: headersFor("produccion") });
    assert.equal(deniedReceived.status, 400);

    const open = await prisma.rollTransfer.findFirstOrThrow({ where: { rollId: roll.id, status: "en_transito" } });
    const denied = await fetch(`${baseUrl}/api/roll-transfers/${open.id}`, { method: "DELETE", headers: headersFor("operario_extrusion") });
    assert.equal(denied.status, 403);
    const ok = await fetch(`${baseUrl}/api/roll-transfers/${open.id}`, { method: "DELETE", headers: headersFor("produccion") });
    assert.equal(ok.status, 204);
  });
});

describe("revisión trazabilidad / inventario / almacén / avisos", () => {
  const stamp = Date.now();

  it("al heredar, un valor viejo que significa 'no aplica' (caras 'no') llega a la hija como vacío, igual que normalizeSpecOptions", () => {
    assert.deepEqual(inheritSpecs("extrusion", "sellado", { tratadoCaras: "no" }), { caras: "" });
    assert.deepEqual(inheritSpecs("extrusion", "sellado", { tratadoCaras: "ambas" }), { caras: "2" });
  });

  it("trazabilidad: busca la OP desde el QR de un rollo, una etiqueta de bulto o el número de OP, y devuelve la cadena completa del rollo", async () => {
    const product = await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } });
    const orderNumber = `OP-${stamp}`;
    const parent = await prisma.productionOrder.create({ data: { orderNumber, station: "extrusion", productId: product.id, quantityPlanned: 50 } });
    const madre = await createTestRoll(parent.id, { weightKg: 20 });
    const child = await prisma.productionOrder.create({
      data: { orderNumber, station: "sellado", productId: product.id, quantityPlanned: 50, parentOrderId: parent.id },
    });
    await placeRollAt(madre.id, "sellado");
    const bultoCode = `EXT-${String(stamp).slice(-5)}`;
    await prisma.bultoLabel.deleteMany({ where: { code: bultoCode } });
    await prisma.bultoLabel.create({ data: { code: bultoCode } });
    const fila = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 8, sourceRollIds: [madre.id], sourceRollTokens: { [madre.id]: madre.possessionToken }, bultoLabelCode: bultoCode }),
    });
    assert.equal(fila.status, 201);
    const hijo = (await fila.json()) as { id: number };

    const trace = (code: string) => fetch(`${baseUrl}/api/production-orders/trace/by-code/${encodeURIComponent(code)}`, { headers: headersFor("produccion") });

    const porRollo = (await (await trace(`EXT-${madre.stationSequence}`)).json()) as any;
    assert.deepEqual(porRollo, { kind: "rollo", orderId: parent.id, rollId: madre.id });
    const porBulto = (await (await trace(bultoCode)).json()) as any;
    assert.deepEqual(porBulto, { kind: "bulto", orderId: child.id, rollId: hijo.id }, "la etiqueta de bulto lleva al rollo que la usó");
    const porOp = (await (await trace(orderNumber)).json()) as any;
    assert.equal(porOp.orderId, parent.id, "el número de OP abre la etapa raíz de la cadena");
    assert.equal((await trace("EXT-999999999")).status, 404);

    // Un operario no confirma la existencia de una OP en borrador (misma regla que GET /:id).
    const borradorNumber = `OP-${stamp + 1}`;
    const borrador = await prisma.productionOrder.create({
      data: { orderNumber: borradorNumber, station: "extrusion", productId: product.id, quantityPlanned: 10, status: "borrador" },
    });
    const traceComo = (role: string, c: string) =>
      fetch(`${baseUrl}/api/production-orders/trace/by-code/${encodeURIComponent(c)}`, { headers: headersFor(role) });
    assert.equal((await traceComo("operario_extrusion", borradorNumber)).status, 404);
    assert.equal((await traceComo("produccion", borradorNumber)).status, 200);
    await prisma.productionOrder.delete({ where: { id: borrador.id } });
    assert.equal((await trace("cualquier cosa")).status, 400);

    const detalle = (await (await fetch(`${baseUrl}/api/production-orders/${child.id}`, { headers: headersFor("produccion") })).json()) as any;
    const r = detalle.rolls.find((x: any) => x.id === hijo.id);
    assert.equal(r.consumptions.length, 1);
    assert.equal(r.consumptions[0].sourceRoll.stationSequence, madre.stationSequence);
    assert.equal(Number(r.consumptions[0].quantityKg), 8);
    assert.equal(r.bultoLabel.code, bultoCode);
    const madreEnPadre = ((await (await fetch(`${baseUrl}/api/production-orders/${parent.id}`, { headers: headersFor("produccion") })).json()) as any).rolls.find(
      (x: any) => x.id === madre.id
    );
    assert.equal(madreEnPadre.transfers.length, 1, "el despacho a la bodega de Sellado aparece en la trazabilidad del rollo");
    assert.equal(madreEnPadre.transfers[0].toStation, "sellado");

    await prisma.bultoLabel.deleteMany({ where: { code: bultoCode } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: child.id } });
    await prisma.productionOrder.delete({ where: { id: child.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });

  it("la entrada a inventario al aprobar Calidad apunta a la OP y Movimientos dice de dónde salió", async () => {
    const product = await prisma.product.create({
      data: { sku: `TEST-QC-${stamp}`, name: `Producto QC ${stamp}`, category: "rollos_fuelle", unit: "kg" },
    });
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-QC-${stamp}`, station: "sellado", productId: product.id, quantityPlanned: 20, status: "pendiente_calidad" },
    });
    await createTestRoll(order.id, { weightKg: 12 });

    const qc = await fetch(`${baseUrl}/api/production-orders/${order.id}/quality-check`, {
      method: "POST",
      headers: headersFor("calidad"),
      body: JSON.stringify({ result: "aprobado" }),
    });
    assert.equal(qc.status, 201);
    const mov = await prisma.inventoryMovement.findFirstOrThrow({ where: { productId: product.id } });
    assert.equal(mov.referenceType, "production_order", "ya no queda como 'ajuste manual'");
    assert.equal(mov.referenceId, order.id);

    const movimientos = (await (await fetch(`${baseUrl}/api/inventory/movements?productId=${product.id}`, { headers: headersFor("almacen") })).json()) as any;
    assert.match(movimientos.items[0].origin.label, new RegExp(`Aprobada en Calidad · OP-TEST-QC-${stamp}`));
    assert.equal(movimientos.items[0].origin.link, undefined, "Almacén no puede abrir la hoja de la OP: el origen va sin link");
    const comoAdmin = (await (await fetch(`${baseUrl}/api/inventory/movements?productId=${product.id}`, { headers: headersFor("super_admin") })).json()) as any;
    assert.equal(comoAdmin.items[0].origin.link, `/produccion/ordenes/${order.id}`);

    await prisma.qualityCheck.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.inventoryMovement.deleteMany({ where: { productId: product.id } });
    await prisma.inventoryStock.deleteMany({ where: { productId: product.id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it("almacén: una salida sin ubicación no puede tocar lo que está en estantes; los errores nombran el producto; aviso al cruzar el mínimo", async () => {
    const product = await prisma.product.create({
      data: { sku: `TEST-ALM-${stamp}`, name: `Producto almacén ${stamp}`, category: "rollos_fuelle", unit: "kg", minStock: 10 },
    });
    const location = await prisma.warehouseLocation.create({ data: { code: `T-${stamp}`, label: "Test", publicToken: `tok-${stamp}` } });
    await prisma.$transaction((tx) => applyMovement(tx, { productId: product.id, quantity: 30, movementType: "entrada_produccion", referenceType: "manual_adjustment" }));
    // Total 30: 20 en el estante, 10 sin ubicar.
    await prisma.stockLocation.create({ data: { productId: product.id, locationId: location.id, quantity: 20 } });

    const salida = (quantity: number, locationId?: number) =>
      prisma.$transaction((tx) =>
        applyMovement(tx, { productId: product.id, quantity: -quantity, movementType: "salida_despacho", referenceType: "manual_adjustment", locationId })
      );

    await assert.rejects(salida(15), (err: unknown) => {
      assert.ok(err instanceof InsufficientStockError);
      assert.match((err as Error).message, new RegExp(`Producto almacén ${stamp}.*elegí de qué ubicación sale`));
      return true;
    }, "sin ubicar hay solo 10: sacar 15 sin elegir estante dejaría el estante con más de lo que existe");
    await salida(5); // lo que está sin ubicar sí sale sin elegir estante (total 25, estante 20)
    await assert.rejects(salida(22, location.id), new RegExp(`La ubicación T-${stamp} no tiene suficiente Producto almacén ${stamp}.*hay 20`));
    await assert.rejects(salida(1000), new RegExp(`Stock insuficiente de Producto almacén ${stamp}`));

    await salida(16, location.id); // total 25 -> 9: cruza el mínimo de 10
    const aviso = await prisma.notification.findFirst({ where: { type: "stock_bajo_minimo", message: { contains: `TEST-ALM-${stamp}` } } });
    assert.ok(aviso, "al cruzar el mínimo se avisa a Almacén/Gestión");
    const avisosAntes = await prisma.notification.count({ where: { type: "stock_bajo_minimo", message: { contains: `TEST-ALM-${stamp}` } } });
    await salida(1, location.id); // ya estaba bajo mínimo: no se repite
    assert.equal(await prisma.notification.count({ where: { type: "stock_bajo_minimo", message: { contains: `TEST-ALM-${stamp}` } } }), avisosAntes);

    await prisma.notification.deleteMany({ where: { type: "stock_bajo_minimo", message: { contains: `TEST-ALM-${stamp}` } } });
    await prisma.stockLocation.deleteMany({ where: { productId: product.id } });
    await prisma.inventoryMovement.deleteMany({ where: { productId: product.id } });
    await prisma.inventoryStock.deleteMany({ where: { productId: product.id } });
    await prisma.warehouseLocation.delete({ where: { id: location.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it("materia prima: el error de stock nombra el insumo y se avisa al cruzar el mínimo", async () => {
    const material = await prisma.rawMaterial.create({ data: { code: `TMP-${stamp}`, minStock: 20 } });
    const mov = (quantity: number) =>
      prisma.$transaction((tx) =>
        applyRawMaterialMovement(tx, { rawMaterialId: material.id, quantity, movementType: quantity > 0 ? "compra" : "consumo_produccion" })
      );
    await mov(30);
    await assert.rejects(mov(-100), new RegExp(`Stock insuficiente de materia prima TMP-${stamp}: hay 30 kg`));
    await mov(-15); // 30 -> 15: cruza el mínimo de 20
    assert.ok(await prisma.notification.findFirst({ where: { type: "materia_prima_bajo_minimo", message: { contains: `TMP-${stamp}` } } }));

    await prisma.notification.deleteMany({ where: { message: { contains: `TMP-${stamp}` } } });
    await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: material.id } });
    await prisma.rawMaterialStock.deleteMany({ where: { rawMaterialId: material.id } });
    await prisma.rawMaterial.delete({ where: { id: material.id } });
  });
});

describe("órdenes de producción · sugerencias (manual + por frecuencia)", () => {
  let clientId = 0;
  let productId = 0;

  before(async () => {
    const client = await prisma.client.create({ data: { name: `TEST-OPSUGG-CLIENT-${Date.now()}` } });
    clientId = client.id;
    productId = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
  });

  after(async () => {
    await prisma.productionOrder.deleteMany({ where: { clientId, productId } });
    await prisma.productionOrderPreset.deleteMany({ where: { clientId, productId } });
    await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  });

  it("un rol sin acceso a Producción no puede ver ni cargar sugerencias (403)", async () => {
    const get = await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
      headers: headersFor("ventas"),
    });
    assert.equal(get.status, 403);

    const post = await fetch(`${baseUrl}/api/production-orders/presets`, {
      method: "POST",
      headers: headersFor("ventas"),
      body: JSON.stringify({ clientId, productId, station: "root", measure: "1x1" }),
    });
    assert.equal(post.status, 403);
  });

  it("sin historial ni sugerencia manual, devuelve manual null y frecuente en cero", async () => {
    const res = await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
      headers: headersFor("produccion"),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { manual: unknown; frequent: { sampleSize: number; measure: unknown; quantityPlanned: unknown } };
    assert.equal(body.manual, null);
    assert.equal(body.frequent.sampleSize, 0);
    assert.equal(body.frequent.measure, null);
    assert.equal(body.frequent.quantityPlanned, null);
  });

  it("station inválida en la consulta da 400", async () => {
    const res = await fetch(
      `${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=no-existe`,
      { headers: headersFor("produccion") }
    );
    assert.equal(res.status, 400);
  });

  it("clientId/productId faltantes o no numéricos dan 400, no un 500 ni una consulta vacía silenciosa", async () => {
    const sinClientId = await fetch(`${baseUrl}/api/production-orders/suggestions?productId=${productId}&station=root`, {
      headers: headersFor("produccion"),
    });
    assert.equal(sinClientId.status, 400);

    const clientIdInvalido = await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=abc&productId=${productId}&station=root`, {
      headers: headersFor("produccion"),
    });
    assert.equal(clientIdInvalido.status, 400);
  });

  it("carga una sugerencia manual de medida/cantidad (root); cargar la misma combinación de nuevo actualiza en vez de duplicar", async () => {
    const res = await fetch(`${baseUrl}/api/production-orders/presets`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId, productId, station: "root", measure: "1.20 x 30", quantityPlanned: 45 }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { id: number; measure: string; quantityPlanned: string };
    assert.equal(created.measure, "1.20 x 30");
    assert.equal(Number(created.quantityPlanned), 45);

    const suggestions = (await (
      await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
        headers: headersFor("produccion"),
      })
    ).json()) as { manual: { id: number; measure: string } };
    assert.equal(suggestions.manual.id, created.id);
    assert.equal(suggestions.manual.measure, "1.20 x 30");

    const upsert = await fetch(`${baseUrl}/api/production-orders/presets`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId, productId, station: "root", measure: "2.00 x 40", quantityPlanned: 60 }),
    });
    assert.equal(upsert.status, 201);
    const upserted = (await upsert.json()) as { id: number; measure: string };
    assert.equal(upserted.id, created.id, "mismo id: actualizó la fila existente, no duplicó");
    assert.equal(upserted.measure, "2.00 x 40");
  });

  it("calcula la sugerencia por frecuencia (root) sobre el historial real de OPs raíz -- gana la medida más repetida", async () => {
    for (const measure of ["0.80 x 15", "0.80 x 15", "0.90 x 20"]) {
      const res = await fetch(`${baseUrl}/api/production-orders`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ productId, clientId, quantityPlanned: 20, measure }),
      });
      assert.equal(res.status, 201);
    }
    const suggestions = (await (
      await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
        headers: headersFor("produccion"),
      })
    ).json()) as { frequent: { sampleSize: number; measure: string } };
    assert.equal(suggestions.frequent.sampleSize, 3);
    assert.equal(suggestions.frequent.measure, "0.80 x 15", "la medida que más se repite gana, no la última cargada");
  });

  it("borra la sugerencia manual (root); un segundo borrado del mismo id da 404", async () => {
    const before = (await (
      await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
        headers: headersFor("produccion"),
      })
    ).json()) as { manual: { id: number } };
    const id = before.manual.id;

    const del = await fetch(`${baseUrl}/api/production-orders/presets/${id}`, { method: "DELETE", headers: headersFor("produccion") });
    assert.equal(del.status, 204);

    const again = await fetch(`${baseUrl}/api/production-orders/presets/${id}`, { method: "DELETE", headers: headersFor("produccion") });
    assert.equal(again.status, 404);

    const after = (await (
      await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=root`, {
        headers: headersFor("produccion"),
      })
    ).json()) as { manual: unknown };
    assert.equal(after.manual, null);
  });

  it("la sugerencia manual de specs por estación valida contra las opciones de la plantilla (400 si el valor no está en la lista)", async () => {
    const res = await fetch(`${baseUrl}/api/production-orders/presets`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ clientId, productId, station: "extrusion", specs: { color: "Rosado" } }),
    });
    assert.equal(res.status, 400);
  });

  it("specs por estación: la manual y la de frecuencia se calculan por separado, incluida Materia Prima (por ref, aparte de los campos simples)", async () => {
    const manual = await fetch(`${baseUrl}/api/production-orders/presets`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({
        clientId,
        productId,
        station: "extrusion",
        specs: { color: "Negro", materiaPrima: [{ ref: "BAJA", pct: 60 }] },
      }),
    });
    assert.equal(manual.status, 201);

    // Historial real en Extrusión: 2 OPs con Color Blanco y BAJA 40%.
    for (let i = 0; i < 2; i++) {
      const root = (await (
        await fetch(`${baseUrl}/api/production-orders`, {
          method: "POST",
          headers: headersFor("produccion"),
          body: JSON.stringify({ productId, clientId, quantityPlanned: 20 }),
        })
      ).json()) as { id: number };
      const derive = await fetch(`${baseUrl}/api/production-orders/${root.id}/derive`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ station: "extrusion", specs: { color: "Blanco", materiaPrima: [{ ref: "BAJA", pct: 40 }] } }),
      });
      // Root -> Extrusión es la PRIMERA derivación (station todavía null):
      // actualiza la misma fila en vez de crear una hija, por eso 200 y no
      // 201 (ver POST /:id/derive, rama "parent.station === null").
      assert.equal(derive.status, 200);
    }

    const suggestions = (await (
      await fetch(`${baseUrl}/api/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=extrusion`, {
        headers: headersFor("produccion"),
      })
    ).json()) as {
      manual: { specs: { color: string; materiaPrima: { ref: string; pct: number }[] } };
      frequent: { sampleSize: number; specs: { color: string; materiaPrima: { ref: string; pct: number }[] } };
    };

    assert.equal(suggestions.manual.specs.color, "Negro");
    assert.equal(suggestions.manual.specs.materiaPrima[0].ref, "BAJA");
    assert.equal(Number(suggestions.manual.specs.materiaPrima[0].pct), 60);

    assert.equal(suggestions.frequent.sampleSize, 2);
    assert.equal(suggestions.frequent.specs.color, "Blanco", "el color más repetido en el historial, no el de la manual");
    const freqBaja = suggestions.frequent.specs.materiaPrima.find((r) => r.ref === "BAJA");
    assert.ok(freqBaja, "Materia Prima entra en la frecuencia igual que un campo simple");
    assert.equal(Number(freqBaja!.pct), 40, "el % más repetido del historial (no el de la manual)");
  });

  it("regresión: derivar de la 2da estación en adelante conserva las notas del padre si no se mandan explícitas", async () => {
    const root = (await (
      await fetch(`${baseUrl}/api/production-orders`, {
        method: "POST",
        headers: headersFor("produccion"),
        // La fórmula de materia prima es obligatoria para liberar Extrusión.
        body: JSON.stringify({ productId, clientId, quantityPlanned: 20, notes: "Nota del cliente", specs: { materiaPrima: [{ ref: "ALTA", pct: 100 }] } }),
      })
    ).json()) as { id: number };

    const extrusion = (await (
      await fetch(`${baseUrl}/api/production-orders/${root.id}/derive`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ station: "extrusion" }),
      })
    ).json()) as { id: number; notes: string | null };
    assert.equal(extrusion.notes, "Nota del cliente");

    const release = await fetch(`${baseUrl}/api/production-orders/${extrusion.id}/release`, {
      method: "POST",
      headers: headersFor("produccion"),
    });
    assert.equal(release.status, 200);

    const sellado = (await (
      await fetch(`${baseUrl}/api/production-orders/${extrusion.id}/derive`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ station: "sellado" }),
      })
    ).json()) as { notes: string | null };
    assert.equal(sellado.notes, "Nota del cliente", "la UI real no manda `notes` al derivar -- tiene que heredarse del padre");
  });
});

describe("bloque de kilos: merma, cuadre de Impresión, materia prima real y reparto entre hermanas", () => {
  let productId = 0;
  const stamp = Date.now();
  const cleanup: (() => Promise<unknown>)[] = [];

  before(async () => {
    productId = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
  });

  after(async () => {
    for (const fn of cleanup.reverse()) await fn();
  });

  /** OP de Extrusión con rollos propios + OP derivada en `station`, con los
   * rollos madre ya recibidos en la bodega de esa estación. */
  async function cadena(station: "impresion" | "sellado" | "precorte", pesos: number[], childPlanned = 500) {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-KG-${stamp}-${Math.random()}`, station: "extrusion", productId, quantityPlanned: 500 },
    });
    const madres = [];
    for (const weightKg of pesos) {
      const m = await createTestRoll(parent.id, { weightKg });
      await placeRollAt(m.id, station);
      madres.push(m);
    }
    const child = await prisma.productionOrder.create({
      data: { orderNumber: parent.orderNumber, station, productId, quantityPlanned: childPlanned, parentOrderId: parent.id },
    });
    cleanup.push(async () => {
      await prisma.productionRoll.deleteMany({ where: { productionOrderId: child.id } });
      await prisma.productionOrder.delete({ where: { id: child.id } });
      await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
      await prisma.productionOrder.delete({ where: { id: parent.id } });
    });
    return { parent, child, madres };
  }

  function fila(childId: number, weightKg: number, wasteKg: number, madres: { id: number; possessionToken: string }[], extra: object = {}) {
    return fetch(`${baseUrl}/api/production-orders/${childId}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({
        weightKg,
        wasteKg,
        sourceRollIds: madres.map((m) => m.id),
        sourceRollTokens: Object.fromEntries(madres.map((m) => [String(m.id), m.possessionToken])),
        ...extra,
      }),
    });
  }

  async function saldo(m: { stationSequence: number }) {
    const res = await fetch(`${baseUrl}/api/production-orders/rolls/by-code/EXT-${m.stationSequence}`, { headers: headersFor("produccion") });
    return ((await res.json()) as { remainingKg: number }).remainingKg;
  }

  // ---------------- escaneo obligatorio ----------------

  it("una OP derivada no acepta filas sin escanear el rollo de origen (Impresión incluida)", async () => {
    for (const station of ["impresion", "sellado", "precorte"] as const) {
      const { child } = await cadena(station, [20]);
      const res = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ weightKg: 5 }),
      });
      assert.equal(res.status, 400, `${station} sin escaneo`);
      assert.match(((await res.json()) as { error: string }).error, /Escaneá el QR del rollo/);
    }
  });

  // ---------------- merma contra el rollo madre ----------------

  it("Sellado: del rollo madre sale el peso MÁS el desperdicio, y alcanzar o no se mide contra ese total", async () => {
    const { child, madres } = await cadena("sellado", [50, 30]);
    const [a, b] = madres;

    assert.equal((await fila(child.id, 20, 5, [a])).status, 201);
    assert.equal(await saldo(a), 25, "50 − (20 + 5 de merma)");

    const noAlcanza = await fila(child.id, 20, 6, [a]);
    assert.equal(noAlcanza.status, 400, "25 kg no cubren 20 + 6");
    assert.match(((await noAlcanza.json()) as { error: string }).error, /Faltan 1 kg/);

    const conOtro = await fila(child.id, 20, 6, [a, b]);
    assert.equal(conOtro.status, 201, "con el siguiente madre sí alcanza");
    const creado = (await conOtro.json()) as { id: number };
    assert.equal(await saldo(a), 0);
    assert.equal(await saldo(b), 29, "del segundo sale 1 kg (el resto de los 26)");
    const reparto = await prisma.rollConsumption.findMany({ where: { rollId: creado.id }, orderBy: { id: "asc" } });
    assert.deepEqual(reparto.map((r) => Number(r.quantityKg)), [25, 1]);

    // Borrar la fila devuelve peso Y merma a los madres.
    const del = await fetch(`${baseUrl}/api/production-orders/${child.id}/rolls/${creado.id}`, { method: "DELETE", headers: headersFor("produccion") });
    assert.equal(del.status, 204);
    assert.equal(await saldo(a), 25);
    assert.equal(await saldo(b), 30);
  });

  it("Precorte: el segundo par ETIQUETA R / PESO R lleva solo peso; la merma se toma al final y no cuenta como producido", async () => {
    const { child, madres } = await cadena("precorte", [10, 50]);
    const [a, b] = madres;

    // Peso 15 + merma 3 = 18: A da 10 (todo peso), B da 8 (5 de peso + 3 de merma).
    const r1 = await fila(child.id, 15, 3, [a, b]);
    assert.equal(r1.status, 201);
    const row1 = (await r1.json()) as { id: number; weightKg: string; details: any };
    assert.equal(Number(row1.weightKg), 10);
    assert.equal(row1.details.pesoR2, 5, "el segundo par es solo el peso que faltó, no la merma");
    assert.equal(row1.details.etiquetaR2, `EXT-${b.stationSequence}`);
    assert.equal(await saldo(b), 42);

    // Peso que entra en el madre pero la merma lo desborda: no hay segundo par.
    const { child: c2, madres: m2 } = await cadena("precorte", [10, 50]);
    const r2 = await fila(c2.id, 8, 4, m2);
    assert.equal(r2.status, 201);
    const row2 = (await r2.json()) as { weightKg: string; details: any };
    assert.equal(Number(row2.weightKg), 8);
    assert.equal(row2.details?.pesoR2, undefined, "la merma que salió del segundo madre no genera PESO R2");
    assert.equal(await saldo(m2[0]), 0);
    assert.equal(await saldo(m2[1]), 48);

    // Lo producido de la OP es el peso (10 + 5), la merma va aparte.
    const detalle = (await (await fetch(`${baseUrl}/api/production-orders/${child.id}`, { headers: headersFor("produccion") })).json()) as any;
    const r = detalle.rolls.find((x: any) => x.id === row1.id);
    assert.equal(Number(r.weightKg) + Number(r.details.pesoR2), 15);
    assert.equal(Number(r.wasteKg), 3);
  });

  // ---------------- cuadre de Impresión ----------------

  it("Impresión: peso + desperdicio tiene que cuadrar con el rollo que entra (2% o 0,5 kg de tolerancia)", async () => {
    const casos: { entra: number; peso: number; merma: number; ok: boolean; msg?: RegExp }[] = [
      { entra: 40, peso: 38, merma: 2, ok: true },
      { entra: 40, peso: 39.3, merma: 0, ok: true }, // diferencia 0,7 ≤ 0,8 (2% de 40)
      { entra: 40, peso: 39, merma: 0, ok: false, msg: /faltan 1 kg/ }, // 1 > 0,8
      { entra: 40, peso: 15, merma: 0, ok: false, msg: /faltan 25 kg\. Si es merma, cargala en desperdicio/ },
      { entra: 40, peso: 45, merma: 0, ok: false, msg: /sobran 5 kg/ },
      { entra: 10, peso: 9.6, merma: 0, ok: true }, // 0,4 ≤ 0,5 (mínimo)
      { entra: 10, peso: 9.4, merma: 0, ok: false, msg: /faltan 0\.6 kg/ },
    ];
    for (const c of casos) {
      const { child, madres } = await cadena("impresion", [c.entra]);
      const res = await fila(child.id, c.peso, c.merma, madres);
      assert.equal(res.status, c.ok ? 201 : 400, `entra ${c.entra}, sale ${c.peso} + ${c.merma}`);
      if (!c.ok) {
        assert.match(((await res.json()) as { error: string }).error, c.msg!);
        assert.equal(await saldo(madres[0]), c.entra, "rechazada: el rollo no queda consumido");
      } else {
        assert.equal(await saldo(madres[0]), 0, "aceptada: el rollo queda consumido entero");
      }
    }
  });

  it("Impresión con dos rollos de origen: cuadra contra la suma de los dos", async () => {
    const { child, madres } = await cadena("impresion", [20, 20]);
    const mal = await fila(child.id, 30, 0, madres);
    assert.equal(mal.status, 400);
    assert.match(((await mal.json()) as { error: string }).error, new RegExp(`Entraron 40 kg \\(EXT-${madres[0].stationSequence} \\+ EXT-${madres[1].stationSequence}\\)`));
    assert.equal((await fila(child.id, 38, 2, madres)).status, 201);
    assert.equal(await saldo(madres[0]), 0);
    assert.equal(await saldo(madres[1]), 0);
  });

  // ---------------- materia prima ----------------

  it("materia prima: sin fórmula al 100% no se libera ni se cierra; al cerrar se descuenta el % sobre lo producido real (peso + desperdicio)", async () => {
    const m1 = await prisma.rawMaterial.create({ data: { code: `TKG1-${stamp}` } });
    const m2 = await prisma.rawMaterial.create({ data: { code: `TKG2-${stamp}` } });
    for (const m of [m1, m2]) {
      await prisma.$transaction((tx) => applyRawMaterialMovement(tx, { rawMaterialId: m.id, quantity: 100, movementType: "compra" }));
    }
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-MP-${stamp}`, station: "extrusion", productId, quantityPlanned: 50, status: "borrador" },
    });
    cleanup.push(async () => {
      await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
      await prisma.productionOrder.delete({ where: { id: order.id } });
      for (const m of [m1, m2]) {
        await prisma.rawMaterialMovement.deleteMany({ where: { rawMaterialId: m.id } });
        await prisma.rawMaterialStock.deleteMany({ where: { rawMaterialId: m.id } });
        await prisma.rawMaterial.delete({ where: { id: m.id } });
      }
    });
    const liberar = () => fetch(`${baseUrl}/api/production-orders/${order.id}/release`, { method: "POST", headers: headersFor("produccion") });
    const cerrar = () => fetch(`${baseUrl}/api/production-orders/${order.id}/close`, { method: "POST", headers: headersFor("operario_extrusion") });
    const formula = (materiaPrima: object[]) =>
      fetch(`${baseUrl}/api/production-orders/${order.id}`, { method: "PATCH", headers: headersFor("produccion"), body: JSON.stringify({ specs: { materiaPrima } }) });

    const sinFormula = await liberar();
    assert.equal(sinFormula.status, 400);
    assert.match(((await sinFormula.json()) as { error: string }).error, /Cargá la fórmula de materia prima/);

    await formula([{ ref: m1.code, pct: 70 }, { ref: m2.code, pct: 20 }]);
    const incompleta = await liberar();
    assert.equal(incompleta.status, 400);
    assert.match(((await incompleta.json()) as { error: string }).error, /suma 90%/);

    await formula([{ ref: m1.code, pct: 70 }, { ref: m2.code, pct: 30 }]);
    assert.equal((await liberar()).status, 200);

    // Meta 50 kg, pero lo real es 10 + 2 de merma + 8 = 20 kg.
    await createTestRoll(order.id, { weightKg: 10, wasteKg: 2 });
    await createTestRoll(order.id, { weightKg: 8 });

    // Si alguien rompe la fórmula después de liberar, tampoco se cierra.
    await prisma.productionOrder.update({ where: { id: order.id }, data: { specs: { materiaPrima: [{ ref: m1.code, pct: 70 }] } } });
    assert.equal((await cerrar()).status, 400);
    await prisma.productionOrder.update({
      where: { id: order.id },
      data: { specs: { materiaPrima: [{ ref: m1.code, pct: 70 }, { ref: m2.code, pct: 30 }] } },
    });

    assert.equal((await cerrar()).status, 200);
    const stock = async (id: number) => Number((await prisma.rawMaterialStock.findUniqueOrThrow({ where: { rawMaterialId: id } })).currentQuantity);
    assert.equal(await stock(m1.id), 86, "70% de 20 kg reales = 14 (no 35 sobre la meta de 50)");
    assert.equal(await stock(m2.id), 94, "30% de 20 kg = 6");
  });

  // ---------------- reparto entre hermanas ----------------

  it("reparto entre hermanas: sin producción la base es la meta del padre; una hermana cancelada libera su meta", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-REP-${stamp}`, station: "extrusion", productId, quantityPlanned: 40, status: "en_proceso" },
    });
    const derive = (station: string, quantityPlanned?: number) =>
      fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ station, quantityPlanned }),
      });

    const a = (await (await derive("sellado", 25)).json()) as { id: number; quantityPlanned: string };
    const b = await derive("precorte");
    assert.equal(b.status, 201);
    const bBody = (await b.json()) as { id: number; quantityPlanned: string };
    assert.equal(Number(bBody.quantityPlanned), 15, "sin meta explícita toma lo que queda: 40 − 25");
    assert.equal((await derive("impresion")).status, 400, "ya no queda nada");

    await prisma.productionOrder.update({ where: { id: a.id }, data: { status: "cancelada" } });
    const c = await derive("impresion");
    assert.equal(c.status, 201, "la cancelada no cuenta");
    const cBody = (await c.json()) as { id: number; quantityPlanned: string };
    assert.equal(Number(cBody.quantityPlanned), 25);

    for (const id of [cBody.id, bBody.id, a.id, parent.id]) await prisma.productionOrder.delete({ where: { id } });
  });

  it("con varias hijas, cargar más rollos en el padre NO les cambia la meta (el reparto es de Gestión); con una sola, sí la sigue", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-SYNC-${stamp}`, station: "extrusion", productId, quantityPlanned: 100, status: "en_proceso" },
    });
    await createTestRoll(parent.id, { weightKg: 30 });
    const derive = (station: string, quantityPlanned?: number) =>
      fetch(`${baseUrl}/api/production-orders/${parent.id}/derive`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ station, quantityPlanned }),
      });
    const cargarEnPadre = (weightKg: number) =>
      fetch(`${baseUrl}/api/production-orders/${parent.id}/rolls`, { method: "POST", headers: headersFor("produccion"), body: JSON.stringify({ weightKg }) });

    const unica = (await (await derive("sellado")).json()) as { id: number };
    assert.equal((await cargarEnPadre(10)).status, 201);
    assert.equal(Number((await prisma.productionOrder.findUniqueOrThrow({ where: { id: unica.id } })).quantityPlanned), 40, "hija única sigue al padre");

    await prisma.productionOrder.update({ where: { id: unica.id }, data: { quantityPlanned: 20 } });
    const otra = (await (await derive("precorte", 20)).json()) as { id: number };
    assert.equal((await cargarEnPadre(10)).status, 201);
    for (const id of [unica.id, otra.id]) {
      assert.equal(Number((await prisma.productionOrder.findUniqueOrThrow({ where: { id } })).quantityPlanned), 20, "con dos hijas nadie se sube solo al 100%");
    }

    for (const id of [otra.id, unica.id]) await prisma.productionOrder.delete({ where: { id } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: parent.id } });
    await prisma.productionOrder.delete({ where: { id: parent.id } });
  });
});

describe("inventario de bodegas: existencias por bodega, en camino, antigüedad, conteo y peso al recibir", () => {
  let productId = 0;
  const stamp = Date.now();
  const clock = { clientTimezone: "America/Bogota", clientUtcOffsetMinutes: -300 };
  const orderIds: number[] = [];

  before(async () => {
    productId = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
  });

  after(async () => {
    for (const id of orderIds.reverse()) {
      await prisma.productionRoll.deleteMany({ where: { productionOrderId: id } });
      await prisma.productionOrder.delete({ where: { id } }).catch(() => {});
    }
  });

  async function opExtrusion() {
    const o = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-INV-${stamp}-${Math.random()}`, station: "extrusion", productId, quantityPlanned: 500 },
    });
    orderIds.push(o.id);
    return o;
  }
  const code = (r: { stationSequence: number }) => `EXT-${r.stationSequence}`;
  const inventory = async (role = "produccion") =>
    (await (await fetch(`${baseUrl}/api/roll-transfers/inventory`, { headers: headersFor(role) })).json()) as any;
  const whereIs = (inv: any, rollId: number) => {
    for (const w of inv.warehouses) {
      const item = w.items.find((i: any) => i.rollId === rollId);
      if (item) return { station: w.station, item };
    }
    const t = inv.inTransit.find((i: any) => i.rollId === rollId);
    return t ? { station: "en_camino", item: t } : null;
  };
  const post = (role: string, path: string, body: unknown) =>
    fetch(`${baseUrl}/api/roll-transfers${path}`, { method: "POST", headers: headersFor(role), body: JSON.stringify(body) });
  const saldo = async (r: { stationSequence: number }) =>
    ((await (await fetch(`${baseUrl}/api/production-orders/rolls/by-code/${code(r)}`, { headers: headersFor("produccion") })).json()) as any).remainingKg;

  it("cada rollo aparece en la bodega donde está, los en camino aparte, y los totales cuadran", async () => {
    const op = await opExtrusion();
    const enExtrusion = await createTestRoll(op.id, { weightKg: 30 });
    const enSellado = await createTestRoll(op.id, { weightKg: 40 });
    const enCamino = await createTestRoll(op.id, { weightKg: 50 });
    await placeRollAt(enSellado.id, "sellado");
    const salida = await post("operario_extrusion", "", { code: code(enCamino), token: enCamino.possessionToken, toStation: "precorte", mode: "retiro", ...clock });
    assert.equal(salida.status, 201);

    const inv = await inventory();
    assert.equal(whereIs(inv, enExtrusion.id)?.station, "extrusion", "nunca se movió: sigue en la bodega donde se produjo");
    assert.equal(whereIs(inv, enSellado.id)?.station, "sellado");
    const camino = whereIs(inv, enCamino.id);
    assert.equal(camino?.station, "en_camino");
    assert.equal(camino?.item.toStation, "precorte");
    assert.equal(camino?.item.dispatchedKg, 50);
    const precorte = inv.warehouses.find((w: any) => w.station === "precorte");
    assert.ok(precorte.inTransitCount >= 1, "la bodega destino cuenta lo que tiene en camino");

    for (const w of inv.warehouses) {
      const suma = Math.round(w.items.reduce((acc: number, i: any) => acc + i.remainingKg, 0) * 100) / 100;
      assert.equal(w.totalKg, suma, `total de ${w.station} = suma de sus rollos`);
      assert.equal(w.rollCount, w.items.length);
    }
  });

  it("solo cuenta rollos con saldo que alimentan otra estación: un rollo agotado o de Sellado/Precorte no aparece", async () => {
    const op = await opExtrusion();
    const agotado = await createTestRoll(op.id, { weightKg: 20 });
    await placeRollAt(agotado.id, "impresion");
    const imp = await prisma.productionOrder.create({
      data: { orderNumber: op.orderNumber, station: "impresion", productId, quantityPlanned: 20, parentOrderId: op.id },
    });
    orderIds.push(imp.id);
    const fila = await fetch(`${baseUrl}/api/production-orders/${imp.id}/rolls`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ weightKg: 20, sourceRollIds: [agotado.id], sourceRollTokens: { [agotado.id]: agotado.possessionToken } }),
    });
    assert.equal(fila.status, 201);
    const impreso = (await fila.json()) as { id: number };

    const sellado = await prisma.productionOrder.create({ data: { orderNumber: `OP-TEST-INV-S-${stamp}`, station: "sellado", productId, quantityPlanned: 10 } });
    orderIds.push(sellado.id);
    const final = await createTestRoll(sellado.id, { weightKg: 10 });

    const inv = await inventory();
    assert.equal(whereIs(inv, agotado.id), null, "el rollo de Extrusión se consumió entero en Impresión");
    assert.equal(whereIs(inv, impreso.id)?.station, "impresion", "el rollo impreso sí: puede ir a Sellado/Precorte");
    assert.equal(whereIs(inv, final.id), null, "lo de Sellado es producto terminado, no stock de bodega");
  });

  it("antigüedad: días desde que llegó a la bodega (o desde que se produjo), y se marca parado a partir de 7 días", async () => {
    const op = await opExtrusion();
    const viejo = await createTestRoll(op.id, { weightKg: 15 });
    await placeRollAt(viejo.id, "sellado");
    const hace10 = new Date(Date.now() - 10 * 86_400_000);
    await prisma.rollTransfer.updateMany({ where: { rollId: viejo.id }, data: { receivedAt: hace10 } });
    const nuevo = await createTestRoll(op.id, { weightKg: 15 });

    const inv = await inventory();
    const v = whereIs(inv, viejo.id)!.item;
    assert.equal(v.days, 10);
    assert.equal(v.stale, true);
    const n = whereIs(inv, nuevo.id)!.item;
    assert.equal(n.days, 0);
    assert.equal(n.stale, false);
    assert.ok(inv.warehouses.find((w: any) => w.station === "sellado").staleCount >= 1);
    assert.equal(inv.staleDays, 7);
  });

  it("el peso medido al recibir pasa a ser el saldo del rollo (con su ajuste) y lo usa el siguiente despacho y consumo", async () => {
    const op = await opExtrusion();
    const r = await createTestRoll(op.id, { weightKg: 60 });
    const salida = (await (await post("operario_extrusion", "", { code: code(r), token: r.possessionToken, toStation: "sellado", mode: "retiro", ...clock })).json()) as any;
    const recibo = await post("operario_sellado", `/${salida.id}/receive`, { code: code(r), token: r.possessionToken, receivedKg: 57.5, ...clock });
    assert.equal(recibo.status, 200);
    assert.equal(await saldo(r), 57.5);

    const adj = await prisma.rollAdjustment.findFirstOrThrow({ where: { rollId: r.id } });
    assert.equal(adj.reason, "recepcion");
    assert.equal(adj.transferId, salida.id);
    assert.equal(Number(adj.previousKg), 60);
    assert.equal(Number(adj.deltaKg), -2.5);
    const original = await prisma.productionRoll.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(Number(original.weightKg), 60, "el peso original del rollo no se toca");

    // Consumir 58 kg ya no alcanza: el saldo real es 57,5.
    const sel = await prisma.productionOrder.create({
      data: { orderNumber: op.orderNumber, station: "sellado", productId, quantityPlanned: 500, parentOrderId: op.id },
    });
    orderIds.push(sel.id);
    const cargar = (weightKg: number) =>
      fetch(`${baseUrl}/api/production-orders/${sel.id}/rolls`, {
        method: "POST",
        headers: headersFor("produccion"),
        body: JSON.stringify({ weightKg, sourceRollIds: [r.id], sourceRollTokens: { [r.id]: r.possessionToken } }),
      });
    assert.equal((await cargar(58)).status, 400);
    assert.equal((await cargar(57.5)).status, 201);
    assert.equal(await saldo(r), 0);

    // Recibir sin pesar, o con el mismo saldo, no crea ajuste.
    const otro = await createTestRoll(op.id, { weightKg: 20 });
    const s2 = (await (await post("operario_extrusion", "", { code: code(otro), token: otro.possessionToken, toStation: "sellado", mode: "retiro", ...clock })).json()) as any;
    await post("operario_sellado", `/${s2.id}/receive`, { code: code(otro), token: otro.possessionToken, receivedKg: 20, ...clock });
    assert.equal(await prisma.rollAdjustment.count({ where: { rollId: otro.id } }), 0);
  });

  it("ajuste por conteo: solo Gestión, con motivo, no en camino ni producto terminado; el saldo pasa a lo contado", async () => {
    const op = await opExtrusion();
    const r = await createTestRoll(op.id, { weightKg: 40 });
    const contar = (role: string, body: object, rollId = r.id) => post(role, `/rolls/${rollId}/count`, body);

    assert.equal((await contar("operario_extrusion", { countedKg: 38, notes: "pesaje" })).status, 403, "un operario no ajusta");
    assert.equal((await contar("produccion", { countedKg: 38 })).status, 400, "sin motivo no");
    assert.equal((await contar("produccion", { countedKg: -1, notes: "pesaje" })).status, 400);

    const ok = await contar("produccion", { countedKg: 38.25, notes: "Pesaje de inventario" });
    assert.equal(ok.status, 201);
    const body = (await ok.json()) as any;
    assert.deepEqual([body.previousKg, body.newKg, body.deltaKg], [40, 38.25, -1.75]);
    assert.equal(await saldo(r), 38.25);
    const inv = await inventory();
    const item = whereIs(inv, r.id)!.item;
    assert.equal(item.remainingKg, 38.25);
    assert.equal(Number(item.lastCount.newKg), 38.25);

    // Un segundo conteo parte del saldo ya ajustado.
    const segundo = (await (await contar("produccion", { countedKg: 39, notes: "Re-pesaje" })).json()) as any;
    assert.deepEqual([segundo.previousKg, segundo.deltaKg], [38.25, 0.75]);

    // En camino: primero hay que recibirlo.
    const s = (await (await post("operario_extrusion", "", { code: code(r), token: r.possessionToken, toStation: "impresion", mode: "retiro", ...clock })).json()) as any;
    assert.equal(Number(s.dispatchedKg), 39, "el despacho sale con el saldo ajustado");
    const enCamino = await contar("produccion", { countedKg: 30, notes: "pesaje" });
    assert.equal(enCamino.status, 400);
    assert.match(((await enCamino.json()) as { error: string }).error, /está en camino/);

    // Contado en 0: el rollo ya no está y sale del inventario.
    await post("operario_impresion", `/${s.id}/receive`, { code: code(r), token: r.possessionToken, ...clock });
    assert.equal((await contar("produccion", { countedKg: 0, notes: "No está en la bodega" })).status, 201);
    assert.equal(whereIs(await inventory(), r.id), null);

    // Producto terminado (Sellado) no se ajusta acá.
    const sellado = await prisma.productionOrder.create({ data: { orderNumber: `OP-TEST-INV-C-${stamp}`, station: "sellado", productId, quantityPlanned: 10 } });
    orderIds.push(sellado.id);
    const final = await createTestRoll(sellado.id, { weightKg: 10 });
    assert.equal((await contar("produccion", { countedKg: 9, notes: "pesaje" }, final.id)).status, 400);

    // Queda en Trazabilidad.
    const detalle = (await (await fetch(`${baseUrl}/api/production-orders/${op.id}`, { headers: headersFor("produccion") })).json()) as any;
    const enTraza = detalle.rolls.find((x: any) => x.id === r.id);
    assert.deepEqual(enTraza.adjustments.map((a: any) => a.reason), ["conteo", "conteo", "conteo"]);
  });

  it("el inventario lo ven los roles de despacho a bodegas; Ventas no", async () => {
    assert.equal((await fetch(`${baseUrl}/api/roll-transfers/inventory`, { headers: headersFor("ventas") })).status, 403);
    for (const role of ["operario_sellado", "almacen", "produccion"]) {
      assert.equal((await fetch(`${baseUrl}/api/roll-transfers/inventory`, { headers: headersFor(role) })).status, 200, role);
    }
  });
});

describe("ajustes del QA previo al despliegue (2026-10-02)", () => {
  let productId = 0;
  const stamp = Date.now();
  const clock = { clientTimezone: "America/Bogota", clientUtcOffsetMinutes: -300 };

  before(async () => {
    productId = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
  });

  it("una hija ya sobre-asignada (OPs viejas) se puede seguir editando si no se toca la meta; subirla sí se valida", async () => {
    const parent = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-QA2-${stamp}`, station: "extrusion", productId, quantityPlanned: 40, status: "en_proceso" },
    });
    // Como se derivaba antes: cada hija con el 100%.
    const a = await prisma.productionOrder.create({ data: { orderNumber: parent.orderNumber, station: "sellado", productId, quantityPlanned: 40, parentOrderId: parent.id } });
    const b = await prisma.productionOrder.create({ data: { orderNumber: parent.orderNumber, station: "precorte", productId, quantityPlanned: 40, parentOrderId: parent.id } });
    const patch = (body: object) =>
      fetch(`${baseUrl}/api/production-orders/${a.id}`, { method: "PATCH", headers: headersFor("produccion"), body: JSON.stringify(body) });

    assert.equal((await patch({ quantityPlanned: 40, notes: "solo cambio la nota" })).status, 200, "misma meta: no se revalida el reparto");
    assert.equal((await patch({ quantityPlanned: 41 })).status, 400, "subirla sí");
    assert.equal((await patch({ quantityPlanned: 0.5 })).status, 200, "bajarla a lo que entra sí");

    for (const id of [a.id, b.id, parent.id]) await prisma.productionOrder.delete({ where: { id } });
  });

  it("cerrar Extrusión: un operario de otra estación recibe 403 antes que el aviso de fórmula; el de Extrusión recibe el aviso con a quién pedírsela", async () => {
    const order = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-QA2-C-${stamp}`, station: "extrusion", productId, quantityPlanned: 20, status: "en_proceso" },
    });
    await createTestRoll(order.id, { weightKg: 10 });
    const cerrar = (role: string) => fetch(`${baseUrl}/api/production-orders/${order.id}/close`, { method: "POST", headers: headersFor(role) });

    assert.equal((await cerrar("operario_sellado")).status, 403);
    const res = await cerrar("operario_extrusion");
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /Pedile a Gestión que complete la fórmula/);

    await prisma.productionRoll.deleteMany({ where: { productionOrderId: order.id } });
    await prisma.productionOrder.delete({ where: { id: order.id } });
  });

  it("peso al recibir muy distinto de lo despachado (error de tipeo): no cambia el saldo, se marca y se avisa a Gestión", async () => {
    const op = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-QA2-R-${stamp}`, station: "extrusion", productId, quantityPlanned: 500 },
    });
    const r = await createTestRoll(op.id, { weightKg: 47.8 });
    const code = `EXT-${r.stationSequence}`;
    const salida = (await (
      await fetch(`${baseUrl}/api/roll-transfers`, {
        method: "POST",
        headers: headersFor("operario_extrusion"),
        body: JSON.stringify({ code, token: r.possessionToken, toStation: "sellado", mode: "retiro", ...clock }),
      })
    ).json()) as any;
    const recibo = await fetch(`${baseUrl}/api/roll-transfers/${salida.id}/receive`, {
      method: "POST",
      headers: headersFor("operario_sellado"),
      body: JSON.stringify({ code, token: r.possessionToken, receivedKg: 478, ...clock }),
    });
    assert.equal(recibo.status, 200);
    const body = (await recibo.json()) as any;
    assert.equal(body.balanceNotAdjusted, true);
    assert.equal(body.balanceAdjusted, false);
    assert.equal(Number(body.receivedKg), 478, "el dato medido queda registrado igual");
    assert.equal(await prisma.rollAdjustment.count({ where: { rollId: r.id } }), 0, "pero no se ajusta el saldo");
    const saldo = ((await (await fetch(`${baseUrl}/api/production-orders/rolls/by-code/${code}`, { headers: headersFor("produccion") })).json()) as any).remainingKg;
    assert.equal(saldo, 47.8);
    const aviso = await prisma.notification.findFirst({ where: { type: "despacho_diferencia_peso", message: { contains: `rollo ${code} ` } } });
    assert.match(aviso!.message, /NO se ajustó el saldo/);

    await prisma.notification.deleteMany({ where: { type: "despacho_diferencia_peso", message: { contains: `rollo ${code} ` } } });
    await prisma.productionRoll.deleteMany({ where: { productionOrderId: op.id } });
    await prisma.productionOrder.delete({ where: { id: op.id } });
  });
});

describe("bodegas: datos para autocompletar (destino esperado, transportista, en camino viejo, rollos para la OP)", () => {
  let productId = 0;
  const stamp = Date.now();
  const clock = { clientTimezone: "America/Bogota", clientUtcOffsetMinutes: -300 };
  const orderIds: number[] = [];

  before(async () => {
    productId = (await prisma.product.findFirstOrThrow({ where: { sku: "BUL-001" } })).id;
  });

  after(async () => {
    for (const id of orderIds.reverse()) {
      await prisma.productionRoll.deleteMany({ where: { productionOrderId: id } });
      await prisma.productionOrder.delete({ where: { id } }).catch(() => {});
    }
  });

  async function op(data: { station: "extrusion" | "impresion" | "sellado" | "precorte"; parentOrderId?: number; status?: "pendiente" | "en_proceso" | "finalizada" | "borrador"; specs?: object }) {
    const o = await prisma.productionOrder.create({
      data: { orderNumber: `OP-TEST-AUTO-${stamp}`, productId, quantityPlanned: 100, status: data.status ?? "en_proceso", station: data.station, parentOrderId: data.parentOrderId, specs: data.specs },
    });
    orderIds.push(o.id);
    return o;
  }
  const code = (r: { stationSequence: number }) => `EXT-${r.stationSequence}`;
  const scan = async (r: { stationSequence: number; possessionToken: string }) =>
    (await (
      await fetch(`${baseUrl}/api/roll-transfers/scan/${code(r)}?token=${encodeURIComponent(r.possessionToken)}`, { headers: headersFor("produccion") })
    ).json()) as any;

  it("al escanear: a qué destinos los espera una OP derivada ABIERTA, y el Material para de la OP", async () => {
    const padre = await op({ station: "extrusion", specs: { materialPara: "SELLADO" } });
    await op({ station: "sellado", parentOrderId: padre.id, status: "pendiente" });
    await op({ station: "precorte", parentOrderId: padre.id, status: "finalizada" });
    await op({ station: "impresion", parentOrderId: padre.id, status: "borrador" });
    const r = await createTestRoll(padre.id, { weightKg: 30 });

    const body = await scan(r);
    assert.deepEqual(body.expectingStations, ["sellado"], "ni la cerrada ni el borrador cuentan");
    assert.equal(body.materialPara, "sellado");
    assert.equal(body.roll.productionOrder.specs, undefined, "las specs de la OP no se exponen en el escaneo");

    // Ya en la bodega de Sellado: Sellado deja de ser destino, y deja de
    // sugerirse aunque su OP siga abierta.
    await placeRollAt(r.id, "sellado");
    const again = await scan(r);
    assert.ok(!again.destinations.includes("sellado"));
    assert.deepEqual(again.expectingStations, []);
  });

  it("el último transportista que registró esta cuenta (solo en 'entrega'), para precargarlo", async () => {
    const padre = await op({ station: "extrusion" });
    const a = await createTestRoll(padre.id, { weightKg: 10 });
    const b = await createTestRoll(padre.id, { weightKg: 10 });
    const carrier = `Montacarguista ${stamp}`;
    const post = (r: any, body: object) =>
      fetch(`${baseUrl}/api/roll-transfers`, {
        method: "POST",
        headers: headersFor("operario_extrusion"),
        body: JSON.stringify({ code: code(r), token: r.possessionToken, toStation: "sellado", ...clock, ...body }),
      });
    assert.equal((await post(a, { mode: "entrega", carrierName: carrier })).status, 201);
    assert.equal((await post(b, { mode: "retiro" })).status, 201, "un retiro después no lo pisa");

    const last = async (role: string) =>
      ((await (await fetch(`${baseUrl}/api/roll-transfers/carriers/last-mine`, { headers: headersFor(role) })).json()) as any).carrierName;
    assert.equal(await last("operario_extrusion"), carrier);
    assert.notEqual(await last("operario_impresion"), carrier, "es por cuenta, no global");
  });

  it("inventario: 'pendiente de despachar a' por rollo, y lo que lleva más de 24 h en camino se marca", async () => {
    const padre = await op({ station: "extrusion" });
    await op({ station: "sellado", parentOrderId: padre.id, status: "en_proceso" });
    const quieto = await createTestRoll(padre.id, { weightKg: 20 });
    const yaAlla = await createTestRoll(padre.id, { weightKg: 20 });
    await placeRollAt(yaAlla.id, "sellado");
    const viejo = await createTestRoll(padre.id, { weightKg: 25 });
    const salida = (await (
      await fetch(`${baseUrl}/api/roll-transfers`, {
        method: "POST",
        headers: headersFor("operario_extrusion"),
        body: JSON.stringify({ code: code(viejo), token: viejo.possessionToken, toStation: "precorte", mode: "retiro", ...clock }),
      })
    ).json()) as any;
    await prisma.rollTransfer.update({ where: { id: salida.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } });

    const inv = (await (await fetch(`${baseUrl}/api/roll-transfers/inventory`, { headers: headersFor("produccion") })).json()) as any;
    assert.equal(inv.staleTransitHours, 24);
    const item = (rollId: number) => inv.warehouses.flatMap((w: any) => w.items).find((i: any) => i.rollId === rollId);
    assert.deepEqual(item(quieto.id).pendingTo, ["sellado"]);
    assert.deepEqual(item(yaAlla.id).pendingTo, [], "ya está en la bodega que lo espera");
    const t = inv.inTransit.find((i: any) => i.rollId === viejo.id);
    assert.equal(t.stale, true);
    assert.ok(t.hours >= 25);
    assert.ok(inv.warehouses.find((w: any) => w.station === "precorte").staleTransitCount >= 1);
  });

  it("hoja de la OP derivada: rollos de la OP padre en su bodega con saldo, y los que vienen en camino", async () => {
    const padre = await op({ station: "extrusion" });
    const sellado = await op({ station: "sellado", parentOrderId: padre.id, status: "en_proceso" });
    const aca = await createTestRoll(padre.id, { weightKg: 30 });
    const vacio = await createTestRoll(padre.id, { weightKg: 30 });
    const otraBodega = await createTestRoll(padre.id, { weightKg: 30 });
    const sinMover = await createTestRoll(padre.id, { weightKg: 30 });
    const enCamino = await createTestRoll(padre.id, { weightKg: 30 });
    await placeRollAt(aca.id, "sellado");
    await placeRollAt(vacio.id, "sellado");
    await placeRollAt(otraBodega.id, "precorte");
    const conteo = await fetch(`${baseUrl}/api/roll-transfers/rolls/${vacio.id}/count`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ countedKg: 0, notes: "se terminó" }),
    });
    assert.equal(conteo.status, 201);
    await fetch(`${baseUrl}/api/roll-transfers`, {
      method: "POST",
      headers: headersFor("produccion"),
      body: JSON.stringify({ code: code(enCamino), token: enCamino.possessionToken, toStation: "sellado", mode: "entrega", carrierName: "Pedro", ...clock }),
    });

    const detail = async (id: number) =>
      ((await (await fetch(`${baseUrl}/api/production-orders/${id}`, { headers: headersFor("operario_sellado") })).json()) as any).availableSourceRolls;
    const rolls = await detail(sellado.id);
    const byId = new Map(rolls.map((r: any) => [r.id, r]));
    assert.equal((byId.get(aca.id) as any)?.status, "en_bodega");
    assert.equal((byId.get(aca.id) as any)?.remainingKg, 30);
    assert.equal((byId.get(aca.id) as any)?.code, code(aca));
    assert.equal((byId.get(enCamino.id) as any)?.status, "en_transito");
    assert.equal((byId.get(enCamino.id) as any)?.carrierName, "Pedro");
    for (const r of [vacio, otraBodega, sinMover]) assert.ok(!byId.has(r.id), `rollo ${code(r)} no se ofrece`);

    assert.deepEqual(await detail(padre.id), [], "una OP sin padre no lista nada");
    await prisma.productionOrder.update({ where: { id: sellado.id }, data: { status: "finalizada" } });
    assert.deepEqual(await detail(sellado.id), [], "ni una OP cerrada");
  });
});

