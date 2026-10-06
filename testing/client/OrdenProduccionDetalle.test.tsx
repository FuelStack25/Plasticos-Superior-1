import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import OrdenProduccionDetalle from "../../client/src/pages/OrdenProduccionDetalle";
import { AuthProvider } from "../../client/src/auth/AuthContext";
import { ConfirmProvider } from "../../client/src/components/ConfirmDialog";

vi.mock("../../client/src/api/client", async () => {
  const actual = await vi.importActual<typeof import("../../client/src/api/client")>("../../client/src/api/client");
  return {
    ApiError: actual.ApiError,
    api: {
      getProductionOrder: vi.fn(),
      getClients: vi.fn().mockResolvedValue([]),
      getProductionRollByCode: vi.fn(),
      getBultoLabelByCode: vi.fn(),
      createProductionRoll: vi.fn().mockResolvedValue({}),
      updateMaterialPara: vi.fn().mockResolvedValue({}),
      updateProductionOrder: vi.fn().mockResolvedValue({}),
      deleteProductionRoll: vi.fn().mockResolvedValue({}),
      closeProductionOrder: vi.fn().mockResolvedValue({}),
      reopenProductionOrder: vi.fn().mockResolvedValue({}),
      releaseProductionOrder: vi.fn().mockResolvedValue({}),
      deriveProductionOrder: vi.fn().mockResolvedValue({}),
      downloadProductionOrderPdf: vi.fn(),
      downloadProductionOrderAttachment: vi.fn(),
      uploadProductionOrderAttachment: vi.fn().mockResolvedValue({}),
      deleteProductionOrderAttachment: vi.fn().mockResolvedValue({}),
    },
  };
});

import { api, ApiError } from "../../client/src/api/client";

// Reemplazo del escáner real (usa la cámara vía html5-qrcode, no disponible
// en jsdom) por su mismo formulario de "código a mano" — onDetected/onClose
// son la única interfaz que le importa a OrdenProduccionDetalle.tsx.
vi.mock("../../client/src/components/BarcodeScanner", () => ({
  default: ({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) => {
    const [value, setValue] = useState("");
    return (
      <div>
        <input placeholder="código escaneado" value={value} onChange={(e) => setValue(e.target.value)} />
        <button type="button" onClick={() => onDetected(value)}>
          Usar código
        </button>
        <button type="button" onClick={onClose}>
          Cerrar escaneo
        </button>
      </div>
    );
  },
}));

function baseSellado(overrides: Record<string, any> = {}) {
  return {
    id: 5,
    orderNumber: "OP-00005",
    station: "sellado",
    status: "en_proceso",
    quantityPlanned: 1000,
    measure: "",
    notes: "",
    alertThresholdKg: null,
    clientId: null,
    client: null,
    createdAt: "2026-09-20T00:00:00Z",
    specs: {},
    parentOrderId: 1,
    parent: { id: 1, orderNumber: "OP-00001", station: "extrusion", rolls: [{ weightKg: "50" }] },
    derivedOrders: [],
    attachments: [],
    rolls: [],
    product: { id: 1, name: "Bolsa 20x30", sku: "SKU1", measure: null, calibre: null, color: null, measureUnit: null, densidad: null },
    qualityCheck: null,
    ...overrides,
  };
}

function baseExtrusion(overrides: Record<string, any> = {}) {
  return {
    id: 8,
    orderNumber: "OP-00008",
    station: "extrusion",
    status: "en_proceso",
    quantityPlanned: 1000,
    measure: "",
    notes: "",
    alertThresholdKg: null,
    clientId: null,
    client: null,
    createdAt: "2026-09-20T00:00:00Z",
    specs: {},
    parentOrderId: null,
    parent: null,
    derivedOrders: [],
    attachments: [],
    rolls: [],
    product: { id: 2, name: "Rollo base", sku: "SKU2", measure: null, calibre: null, color: null, measureUnit: null, densidad: null },
    qualityCheck: null,
    ...overrides,
  };
}

function renderOrden(orderId = 5, user = { id: 1, name: "Ana Operaria", role: "operario_sellado", email: "ana@empresa.com" }) {
  localStorage.setItem("token", "t");
  localStorage.setItem("user", JSON.stringify(user));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[`/produccion/ordenes/${orderId}`]}>
            <Routes>
              <Route path="/produccion/ordenes/:id" element={<OrdenProduccionDetalle />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

/** La hoja repite cada control en dos layouts paralelos (tabla de
 * escritorio + tarjetas de celular, ver docs/07-frontend.md) — jsdom no
 * aplica `md:hidden`, así que ambos quedan en el DOM a la vez. Todas las
 * interacciones de estos tests apuntan siempre a la tarjeta de celular para
 * no toparse con el duplicado de la tabla de escritorio. */
function mobileCard(container: HTMLElement): HTMLElement {
  const el = container.querySelector(".md\\:hidden.space-y-2.p-2");
  if (!el) throw new Error("No se encontró la tarjeta de celular");
  return el as HTMLElement;
}

/** Ubica el input/select de un campo de la fila de carga por su etiqueta.
 * La etiqueta y el contenido son hermanos bajo el mismo div (ver
 * OrdenProduccionDetalle.tsx, sección "Fila de carga" del md:hidden) — una
 * vez que el campo pasa a editable, ese div ya no tiene más texto propio
 * que el de la etiqueta, así que también matchea getByText y hay que
 * quedarse con el <span> real, no con su contenedor. */
function fieldNear(scope: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const labelSpan = within(scope)
    .getAllByText(label)
    .find((el) => el.tagName === "SPAN");
  if (!labelSpan) throw new Error(`No se encontró la etiqueta "${label}"`);
  const row = labelSpan.closest("div") as HTMLElement;
  const field = row.querySelector("input, select");
  if (!field) throw new Error(`El campo "${label}" no es editable todavía`);
  return field as HTMLInputElement | HTMLSelectElement;
}

function draftField(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  return fieldNear(mobileCard(container), label);
}

/** Campos de ESPECIFICACIONES/encabezado (fuera de la tarjeta de rollos):
 * a diferencia de la fila de carga, estos no se duplican entre escritorio y
 * celular, así que se buscan en todo el contenedor. */
function sheetField(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  return fieldNear(container, label);
}

async function scanCode(code: string) {
  const user = userEvent.setup();
  await user.click(screen.getByTitle(/^Escanear/));
  await user.type(screen.getByPlaceholderText("código escaneado"), code);
  await user.click(screen.getByRole("button", { name: "Usar código" }));
}

describe("OrdenProduccionDetalle · carga en lote de rollos (Sellado)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getClients).mockResolvedValue([]);
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado());
  });

  it("añade rollos a la lista de pendientes y los confirma en orden", async () => {
    const { container } = renderOrden();
    await screen.findByText("OP-00005");

    vi.mocked(api.getProductionRollByCode).mockResolvedValueOnce({
      id: 10,
      code: "EXT-1",
      label: null,
      weightKg: "50",
      remainingKg: "50",
      createdBy: { name: "Luis" },
    });
    await scanCode("EXT-1");
    expect((await screen.findAllByText("50 kg")).length).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.type(draftField(container, "PESO (KG)"), "20");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));
    expect((await screen.findAllByText(/Fila 1 por confirmar · Peso 20 kg/)).length).toBeGreaterThan(0);

    await user.type(draftField(container, "PESO (KG)"), "15");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));
    expect((await screen.findAllByText(/Fila 2 por confirmar · Peso 15 kg/)).length).toBeGreaterThan(0);

    await user.click(within(mobileCard(container)).getByRole("button", { name: /Confirmar 2 rollos/ }));

    await waitFor(() => expect(api.createProductionRoll).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.createProductionRoll).mock.calls[0][1]).toMatchObject({ weightKg: 20, sourceRollIds: [10] });
    expect(vi.mocked(api.createProductionRoll).mock.calls[1][1]).toMatchObject({ weightKg: 15, sourceRollIds: [10] });
    expect(await screen.findByText("Se confirmaron 2 rollos.")).toBeInTheDocument();
  });

  it("recalcula el saldo del rollo madre al editar una fila anterior (regresión 2927ba9/c4a0a5b)", async () => {
    const { container } = renderOrden();
    await screen.findByText("OP-00005");
    const user = userEvent.setup();

    vi.mocked(api.getProductionRollByCode).mockResolvedValueOnce({
      id: 10,
      code: "EXT-1",
      label: null,
      weightKg: "50",
      remainingKg: "50",
      createdBy: { name: "Luis" },
    });
    await scanCode("EXT-1");

    await user.type(draftField(container, "PESO (KG)"), "10");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));

    await user.type(draftField(container, "PESO (KG)"), "15");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));
    expect((await screen.findAllByText("25 kg")).length).toBeGreaterThan(0);

    // Editar la fila 1 (10 kg): el saldo mostrado debe descontar SOLO lo que
    // sigue pendiente (fila 2, 15 kg) sobre el saldo original (50 kg) — no
    // la foto vieja de la fila (50 kg, ignora la fila 2) ni el saldo actual
    // en pantalla (25 kg, que además descuenta la propia fila 1 que se está
    // por reeditar).
    const editButtons = within(mobileCard(container)).getAllByTitle("Editar");
    await user.click(editButtons[0]);
    expect((await screen.findAllByText("35 kg")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Peso 10 kg/).length).toBe(0);
    expect((await screen.findAllByText(/Fila 1 por confirmar · Peso 15 kg/)).length).toBeGreaterThan(0);
  });

  it("devuelve el saldo del rollo madre al borrar una fila pendiente (regresión 2927ba9/c4a0a5b)", async () => {
    const { container } = renderOrden();
    await screen.findByText("OP-00005");
    const user = userEvent.setup();

    vi.mocked(api.getProductionRollByCode).mockResolvedValueOnce({
      id: 10,
      code: "EXT-1",
      label: null,
      weightKg: "50",
      remainingKg: "50",
      createdBy: { name: "Luis" },
    });
    await scanCode("EXT-1");

    await user.type(draftField(container, "PESO (KG)"), "10");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));

    await user.type(draftField(container, "PESO (KG)"), "15");
    await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));
    expect((await screen.findAllByText("25 kg")).length).toBeGreaterThan(0);

    // Borra la fila 2 (15 kg): esos kilos tienen que volver al rollo madre,
    // dejando el saldo real (50 - 10 de la fila 1 que queda) = 40 kg.
    const deleteButtons = within(mobileCard(container)).getAllByTitle("Quitar de la lista");
    await user.click(deleteButtons[deleteButtons.length - 1]);

    expect((await screen.findAllByText("40 kg")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Fila 1 por confirmar · Peso 10 kg/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Fila 2 por confirmar/).length).toBe(0);
  });
});

describe("OrdenProduccionDetalle · ScanDock (regresión ba5489a)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getClients).mockResolvedValue([]);
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado());
  });

  it("un 404 con forma inconfundible de etiqueta de bulto NO reintenta como rollo", async () => {
    renderOrden();
    await screen.findByText("OP-00005");

    vi.mocked(api.getBultoLabelByCode).mockRejectedValueOnce(new ApiError("not found", 404));
    await scanCode("EXT-00007");

    expect(await screen.findByRole("alert")).toHaveTextContent("No se encontró la etiqueta de bulto EXT-00007");
    expect(api.getProductionRollByCode).not.toHaveBeenCalled();
  });

  it("un código de rollo ambiguo que da 404 sí reintenta como etiqueta de bulto", async () => {
    renderOrden();
    await screen.findByText("OP-00005");

    vi.mocked(api.getProductionRollByCode).mockRejectedValueOnce(new ApiError("not found", 404));
    vi.mocked(api.getBultoLabelByCode).mockResolvedValueOnce({ id: 3, code: "EXT-00099", status: "disponible" });
    await scanCode("EXT-00099-manual");

    expect((await screen.findAllByText(/Etiqueta de bulto:/)).length).toBeGreaterThan(0);
  });
});

describe("OrdenProduccionDetalle · Material para (regresión efcc680)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getClients).mockResolvedValue([]);
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseExtrusion());
  });

  it("cambiar 'Material para' no pisa un valor de Calibre sin guardar todavía", async () => {
    const { container } = renderOrden(8, { id: 2, name: "Luis Gestión", role: "gerente_produccion", email: "luis@empresa.com" });
    await screen.findByText("OP-00008");
    const user = userEvent.setup();

    const calibreInput = sheetField(container, "Calibre") as HTMLInputElement;
    await user.type(calibreInput, "0.045");
    expect(calibreInput).toHaveValue("0.045");

    const materialParaSelect = sheetField(container, "Material para") as HTMLSelectElement;
    await user.selectOptions(materialParaSelect, "SELLADO");

    await waitFor(() => expect(api.updateMaterialPara).toHaveBeenCalledWith(8, "SELLADO"));
    expect(calibreInput).toHaveValue("0.045");
  });
});

function madre(weight: number, id = 10, code = "EXT-1") {
  return { id, code, label: null, weightKg: String(weight), remainingKg: String(weight), createdBy: { name: "Luis" } };
}

/** Escanea y espera a que el rollo quede cargado. El botón se titula
 * "Escanear: …" o "Escaneá el …" según la estación (Impresión solo escanea
 * rollo), por eso el prefijo común "Escane". */
async function scanMadre(code: string, weight: number) {
  const user = userEvent.setup();
  await user.click(screen.getByTitle(/^Escane/));
  await user.type(screen.getByPlaceholderText("código escaneado"), code);
  await user.click(screen.getByRole("button", { name: "Usar código" }));
  // Sellado lo muestra "50 kg" (saldo) e Impresión "(50 kg)" (se consume entero).
  expect((await screen.findAllByText(new RegExp(weight + " kg"))).length).toBeGreaterThan(0);
}

async function addRow(container: HTMLElement) {
  const user = userEvent.setup();
  await user.click(within(mobileCard(container)).getByRole("button", { name: "+ Añadir rollo" }));
}

describe("OrdenProduccionDetalle · bloque de kilos (merma, cuadre de Impresión, escaneo obligatorio)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks no descarta respuestas "Once" que otro test dejó sin
    // consumir: sin este reset, el escaneo de acá podía recibir el rollo de
    // un test anterior.
    vi.mocked(api.getProductionRollByCode).mockReset();
    vi.mocked(api.getClients).mockResolvedValue([]);
  });

  it("Sellado: el desperdicio también sale del rollo madre (saldo y 'Faltan' cuentan peso + merma)", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado());
    const { container } = renderOrden();
    await screen.findByText("OP-00005");
    const user = userEvent.setup();

    vi.mocked(api.getProductionRollByCode).mockResolvedValueOnce(madre(50));
    await scanMadre("EXT-1", 50);

    await user.type(draftField(container, "PESO (KG)"), "20");
    await user.type(draftField(container, "DESPERD"), "5");
    await addRow(container);
    expect((await screen.findAllByText(/Fila 1 por confirmar · Peso 20 kg · Desp\. 5 kg/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("25 kg")).length).toBeGreaterThan(0); // 50 − (20 + 5)

    await user.type(draftField(container, "PESO (KG)"), "20");
    await user.type(draftField(container, "DESPERD"), "6");
    await addRow(container);
    expect(await screen.findByText(/Faltan 1 kg para cubrir esta fila \(peso \+ desperdicio\)/)).toBeInTheDocument();
  });

  it("Impresión: no deja añadir una fila que no cuadra con el rollo de entrada, y sí una que cuadra", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado({ station: "impresion" }));
    const { container } = renderOrden(5, { id: 1, name: "Ana Operaria", role: "operario_impresion", email: "ana@empresa.com" });
    await screen.findByText("OP-00005");
    const user = userEvent.setup();

    vi.mocked(api.getProductionRollByCode).mockResolvedValueOnce(madre(50));
    await scanMadre("EXT-1", 50);

    await user.type(draftField(container, "P. IMP (KG)"), "30");
    await addRow(container);
    expect(await screen.findByText(/Entraron 50 kg y salen 30 kg \(peso \+ desperdicio\): faltan 20 kg/)).toBeInTheDocument();

    const peso = draftField(container, "P. IMP (KG)");
    await user.clear(peso);
    await user.type(peso, "60");
    await addRow(container);
    expect(await screen.findByText(/sobran 10 kg/)).toBeInTheDocument();

    await user.clear(peso);
    await user.type(peso, "48");
    await user.type(draftField(container, "DESP."), "2");
    await addRow(container);
    expect((await screen.findAllByText(/Fila 1 por confirmar · Peso 48 kg · Desp\. 2 kg/)).length).toBeGreaterThan(0);
  });

  it("una OP derivada lista los rollos de la OP padre que ya están en su bodega o vienen en camino", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(
      baseSellado({
        availableSourceRolls: [
          { id: 11, code: "EXT-11", remainingKg: 42.5, status: "en_bodega", carrierName: null },
          { id: 12, code: "EXT-12", remainingKg: 50, status: "en_transito", carrierName: "Pedro" },
        ],
      })
    );
    renderOrden();
    await screen.findByText("OP-00005");
    expect(screen.getByText(/Rollos de OP-00001 \(Extrusión\) para esta orden/)).toBeInTheDocument();
    expect(screen.getByText("EXT-11").closest("li")).toHaveTextContent("EXT-11 · 42.5 kg · en tu bodega");
    expect(screen.getByText("EXT-12").closest("li")).toHaveTextContent("en camino (lo lleva Pedro)");
  });

  it("una OP derivada no deja añadir la fila sin escanear el rollo de origen (Impresión incluida)", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado({ station: "impresion" }));
    const { container } = renderOrden(5, { id: 1, name: "Ana Operaria", role: "operario_impresion", email: "ana@empresa.com" });
    await screen.findByText("OP-00005");
    const user = userEvent.setup();

    await user.type(draftField(container, "P. IMP (KG)"), "20");
    await addRow(container);
    expect(await screen.findByText(/Escaneá el QR del rollo que estás tomando como insumo/)).toBeInTheDocument();
    expect(api.createProductionRoll).not.toHaveBeenCalled();
  });

  it("si el servidor rechaza 'Guardar cambios', la hoja muestra el motivo real (ej. meta que se pasa del reparto entre hermanas)", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(baseSellado());
    vi.mocked(api.updateProductionOrder).mockRejectedValueOnce(
      new ApiError("La meta se pasa de lo disponible: el padre tiene 180 kg y sus otras derivadas ya tienen 120 kg — como máximo 60 kg", 400)
    );
    const { container } = renderOrden(5, { id: 1, name: "Gestión", role: "gerente_produccion", email: "g@empresa.com" });
    await screen.findByText("OP-00005");
    const user = userEvent.setup();
    const cantidad = container.querySelectorAll("input[type='number']")[0] as HTMLInputElement;
    await user.clear(cantidad);
    await user.type(cantidad, "70");
    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    expect(await screen.findByText(/No se pudieron guardar los cambios: La meta se pasa de lo disponible.*como máximo 60 kg/)).toBeInTheDocument();
  });

  it("la tabla de materia prima calcula los kg sobre lo producido real en cuanto hay rollos", async () => {
    vi.mocked(api.getProductionOrder).mockResolvedValue(
      baseExtrusion({
        quantityPlanned: 1000,
        specs: { materiaPrima: [{ ref: "ALTA", pct: 70 }, { ref: "LINEAL", pct: 30 }] },
        rolls: [
          { id: 1, station: "extrusion", stationSequence: 1, weightKg: "10", wasteKg: "2", details: {}, date: "2026-09-20T10:00:00Z", operatorName: "Ana" },
          { id: 2, station: "extrusion", stationSequence: 2, weightKg: "8", wasteKg: "0", details: {}, date: "2026-09-20T11:00:00Z", operatorName: "Ana" },
        ],
      })
    );
    renderOrden(8, { id: 1, name: "Gestión", role: "gerente_produccion", email: "g@empresa.com" });
    await screen.findByText("OP-00008");
    expect(screen.getByText("Kg (real)")).toBeInTheDocument();
    // 70% y 30% de 20 kg reales (10 + 2 de merma + 8), no de la meta de 1000.
    expect(screen.getByText("14")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
  });
});
