import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, Check, FileDown, GitBranch, Lock, Paperclip, Pencil, Printer, RotateCcw, ScanLine, Send, Trash2, X } from "lucide-react";
import { api, ApiError } from "../api/client";
import { useAuth, type UserRole } from "../auth/AuthContext";
import { ADMIN, OP_EXTRUSION, OP_IMPRESION, OP_SELLADO, OP_PRECORTE, PRODUCCION_GESTION } from "../components/navConfig";
import BarcodeScanner from "../components/BarcodeScanner";
import { splitScannedCode } from "../lib/rollQr";
import { useConfirm } from "../components/ConfirmDialog";
import ErrorToast from "../components/ErrorToast";
import { SkeletonRows } from "../components/Skeleton";
import { SuggestionSources } from "../components/SuggestionSources";
import {
  DERIVATIONS,
  FINAL_STATIONS,
  OPEN_STATUSES,
  REOPENABLE_STATUSES,
  OP_TEMPLATES,
  OpRollColumn,
  OpStation,
  STATION_LABELS,
  ROLL_CODE_PREFIX,
} from "../opTemplates";

const STATUS_LABELS: Record<string, string> = {
  borrador: "Borrador",
  pendiente: "Pendiente",
  en_proceso: "En proceso",
  pendiente_calidad: "Pendiente de calidad",
  detenida: "Detenida",
  finalizada: "Terminada",
  cancelada: "Cancelada",
};

/** Qué roles pueden cargar rollos/cerrar en cada estación (espejo del guard
 * OPERARIO_STATIONS del backend — los grupos OP_* ya incluyen a gestión). */
const STATION_OPERATE: Record<OpStation, UserRole[]> = {
  extrusion: OP_EXTRUSION,
  impresion: OP_IMPRESION,
  sellado: OP_SELLADO,
  precorte: OP_PRECORTE,
};

/** Cerrar la OP es del operario de esa estación, no de Gestión (espejo de
 * ROLES.CIERRE_OP del backend) — a diferencia de STATION_OPERATE de arriba,
 * que sí deja cargar rollos/derivar a Gestión. */
const STATION_CLOSE: Record<OpStation, UserRole[]> = {
  extrusion: [...ADMIN, "operario_extrusion"],
  impresion: [...ADMIN, "operario_impresion"],
  sellado: [...ADMIN, "operario_sellado"],
  precorte: [...ADMIN, "operario_precorte"],
};

// Clases compartidas de la "hoja" estilo Excel
const cellBorder = "border border-slate-300 dark:border-slate-600";
const cellLabel = "block text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";
const sheetInput =
  "w-full bg-transparent text-sm text-slate-800 dark:text-slate-100 focus:outline-none focus:bg-sky-50 dark:focus:bg-slate-800 disabled:text-slate-500 dark:disabled:text-slate-400";
/** Mismo campo que `sheetInput`, pero SOLO para la fila de carga de un rollo
 * nuevo (Registro de rollos): ahí el fondo transparente sin borde de
 * `sheetInput` (pensado para que la hoja se vea como papel impreso) hace que
 * en celular no se note cuáles campos son de verdad tocables/editables hasta
 * que ya se tocaron — acá el input necesita parecer un input de formulario
 * de verdad (fondo sólido, borde visible), no una celda de hoja de cálculo. */
const draftInput =
  "w-full bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded text-sm text-slate-800 dark:text-slate-100 px-2 py-1 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:border-sky-500";

/** El dueño pidió que "Medidas" (ej. "12x18") precargue Ancho (primer
 * número, casilla ANCHO de Especificaciones/Material) y, cuando el formato
 * es "AxB", el segundo número se reparte según pinta: si es chico/decimal
 * (< 1, ej. "0.00045") es un CALIBRE, no un largo — se guarda en `calibre`
 * (existe en las 4 estaciones). Si es un número "de tamaño normal" (ej.
 * "18"), se interpreta como el Largo del par Ancho/Largo de "Medidas
 * finales" (medAncho/medLargo) — esas dos claves solo existen en Sellado/
 * Precorte, en Extrusión/Impresión simplemente no aplican y no se setean. */
function deriveSpecsFromMeasure(measure: string): Record<string, string> {
  const value = measure.trim();
  const result: Record<string, string> = {};
  const anchoMatch = /^(\d+(?:[.,]\d+)?)/.exec(value);
  if (anchoMatch) result.ancho = anchoMatch[1];

  const parMatch = /^(\d+(?:[.,]\d+)?)\s*[xX]\s*(\d+(?:[.,]\d+)?)/.exec(value);
  if (parMatch) {
    const second = Number(parMatch[2].replace(",", "."));
    if (second > 0 && second < 1) {
      result.calibre = parMatch[2];
    } else {
      result.medAncho = parMatch[1];
      result.medLargo = parMatch[2];
    }
  }
  return result;
}

function SheetBand({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 text-[11px] font-bold uppercase tracking-wider px-3 py-1.5">
      {children}
    </div>
  );
}

/** Mismo patrón que printLabels en Productos.tsx: ventana nueva
 * autocontenida + @media print, con el mismo cuidado de escapar el texto
 * interpolado y esperar a que el QR (data: URI) termine de decodificar antes
 * de imprimir (si no, la primera impresión sale con el QR vacío). */
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function printRollLabel(label: { code: string; orderNumber: string; productName: string; weightKg: unknown; qrDataUrl: string }) {
  const win = window.open("", "_blank");
  if (!win) return;

  const code = escapeHtml(label.code);
  const info = escapeHtml(`${label.orderNumber} · ${label.productName} · ${Number(label.weightKg)} kg`);

  win.document.write(`<!DOCTYPE html>
    <html>
      <head>
        <title>Etiqueta de rollo</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: sans-serif; margin: 0; padding: 8mm; }
          .label {
            width: 6cm; min-height: 4cm; height: auto;
            border: 1px dashed #999; border-radius: 3mm;
            padding: 3mm; display: flex; align-items: center; gap: 3mm;
          }
          .label img { width: 2.6cm; height: 2.6cm; flex-shrink: 0; }
          .label .text { overflow: hidden; min-width: 0; }
          .label .code { font-weight: bold; font-size: 12pt; margin: 0 0 2mm; overflow-wrap: anywhere; word-break: break-word; }
          .label .info { font-size: 8pt; margin: 0; color: #333; overflow-wrap: anywhere; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="label">
          <img src="${label.qrDataUrl}" alt="QR ${code}" />
          <div class="text">
            <p class="code">${code}</p>
            <p class="info">${info}</p>
          </div>
        </div>
      </body>
    </html>`);
  win.document.close();

  let printed = false;
  const doPrint = () => {
    if (printed) return;
    printed = true;
    win.focus();
    win.print();
  };
  win.onload = doPrint;
  setTimeout(doPrint, 400);
}

interface MateriaPrimaRow {
  ref: string;
  /** % del insumo sobre la cantidad planificada de la OP — es el único
   * dato que se tipea; el Kg se calcula solo como `% × cantidad
   * planificada / 100` (ver handleSaveSpecs), no se vuelve a pedir por
   * separado. Así lo pidió el cliente: al colocar el %, el sistema calcula
   * los kg, no al revés. */
  pct: string;
  lote: string;
}

interface ColorRow {
  unidad: string;
  color: string;
  lote: string;
}

/** Rollo de la OP padre en la bodega de esta estación (o en camino), de
 * GET /production-orders/:id → availableSourceRolls. */
interface AvailableSourceRoll {
  id: number;
  code: string;
  remainingKg: number;
  status: "en_bodega" | "en_transito";
  carrierName: string | null;
}

/** Un rollo madre escaneado, con el saldo que le quedaba al momento del
 * escaneo (`remainingKg`, lo calcula el server en GET /rolls/by-code).
 * `possessionToken` es la parte del QR que demuestra que se tiene el rollo
 * físico en mano (ver server/src/services/rollPossessionToken.ts) — viaja
 * junto con el resto del chip hasta el POST final que lo consume. */
interface SourceRollChip {
  id: number;
  code: string;
  label: string | null;
  weightKg: number;
  remainingKg: number;
  createdByName?: string | null;
  possessionToken: string;
}

/** Un rollo ya completado en el formulario pero todavía no mandado al
 * servidor (ver `pendingRolls`). `body` es el payload listo para
 * `api.createProductionRoll`; `rollDraft`/`sourceRolls`/`bultoLabel` son una
 * copia de cómo estaba el formulario al agregarlo, para poder recargarlo si
 * la persona lo quiere editar antes de confirmar el lote. */
interface PendingRoll {
  localId: string;
  body: Parameters<typeof api.createProductionRoll>[1];
  rollDraft: Record<string, string>;
  sourceRolls: SourceRollChip[];
  bultoLabel: { id: number; code: string } | null;
}

/** Reparte los kilos de la fila entre los rollos madre escaneados, agotando
 * cada uno antes de pasar al siguiente — la misma cuenta que hace el server
 * al guardar (allocateFromSourceRolls). Acá es solo para mostrarle al
 * operario cómo va a quedar el reparto ANTES de guardar. */
function previewAllocation(rolls: SourceRollChip[], quantityKg: number) {
  const allocations: { roll: SourceRollChip; quantityKg: number }[] = [];
  let pending = Math.round(quantityKg * 100) / 100;
  for (const roll of rolls) {
    if (pending <= 0) break;
    if (roll.remainingKg <= 0) continue;
    const take = Math.round(Math.min(roll.remainingKg, pending) * 100) / 100;
    allocations.push({ roll, quantityKg: take });
    pending = Math.round((pending - take) * 100) / 100;
  }
  return { allocations, missingKg: pending > 0.005 ? pending : 0 };
}

/** Mismo criterio que massBalanceToleranceKg en el servidor: en Impresión
 * (insumo que se consume entero) lo que sale más el desperdicio tiene que
 * coincidir con lo que entró, con hasta 2% o 0,5 kg de tolerancia. */
function massBalanceToleranceKg(entradaKg: number): number {
  return Math.max(0.5, entradaKg * 0.02);
}

/** Kilos que una fila le saca a sus rollos madre: el rollo chico MÁS su
 * desperdicio (la merma también sale del madre — mismo cálculo que el
 * servidor al guardar). */
function rowConsumedKg(weight: unknown, waste: unknown): number {
  return Math.round(((Number(weight) || 0) + (Number(waste) || 0)) * 100) / 100;
}

/** Cómo mostrar el rollo madre de un rollo ya guardado (campo "Insumo: rollo
 * X" bajo cada fila): su etiqueta manual si la tiene, o si no el código de
 * QR numerado dentro de SU estación (EXT-3, PRE-1...) — antes caía a "#<id>
 * global>", que no es el código real que tiene pegado en el rollo físico. */
function sourceRollLabel(sourceRoll: { label: string | null; station: OpStation; stationSequence: number } | null | undefined): string {
  if (!sourceRoll) return "—";
  return sourceRoll.label ?? `${ROLL_CODE_PREFIX[sourceRoll.station]}-${sourceRoll.stationSequence}`;
}

/** Cómo van a quedar repartidos los kilos de la fila entre los rollos madre
 * escaneados, o cuánto falta todavía por cubrir. Se muestra mientras el
 * operario tipea el peso, para que no se entere recién al guardar. */
function SourceAllocationHint({ rolls, weightKg }: { rolls: SourceRollChip[]; weightKg: number }) {
  const { allocations, missingKg } = previewAllocation(rolls, weightKg);
  if (missingKg > 0) {
    return (
      <span className="text-[10px] text-amber-700 dark:text-amber-400">
        Faltan {missingKg} kg — escaneá el siguiente rollo madre
      </span>
    );
  }
  if (allocations.length < 2) return null;
  return (
    <span className="text-[10px] text-slate-600 dark:text-slate-300">
      Sale de: {allocations.map((a) => `${a.roll.code} ${a.quantityKg} kg`).join(" + ")}
    </span>
  );
}

export default function OrdenProduccionDetalle() {
  const { id } = useParams<{ id: string }>();
  const orderId = Number(id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [specsDraft, setSpecsDraft] = useState<Record<string, any>>({});
  const [materiaPrima, setMateriaPrima] = useState<MateriaPrimaRow[]>([]);
  const [colores, setColores] = useState<{ cara1: ColorRow[]; cara2: ColorRow[] }>({ cara1: [], cara2: [] });
  const [headerDraft, setHeaderDraft] = useState({ quantityPlanned: "", measure: "", notes: "", alertThresholdKg: "", clientId: "" });
  const [dirty, setDirty] = useState(false);
  const [rollDraft, setRollDraft] = useState<Record<string, string>>({});
  // Rollos madre escaneados para la fila que se está cargando, EN ORDEN. En
  // Extrusión/Impresión siempre es uno solo (el insumo se consume entero);
  // en Sellado/Precorte puede haber un segundo cuando el rollo chico se pasa
  // del saldo que le quedaba al primero.
  const [sourceRolls, setSourceRolls] = useState<SourceRollChip[]>([]);
  const [bultoLabel, setBultoLabel] = useState<{ id: number; code: string } | null>(null);
  // Botón flotante de escaneo (ver ScanDock más abajo): un solo modal, que
  // detecta sola qué tipo de código se escaneó (ver handleScanAny) — no le
  // pregunta al operario si es un rollo madre o una etiqueta de bulto.
  const [scanning, setScanning] = useState(false);
  // Rollos ya completados en el formulario pero todavía SIN mandar al
  // servidor -- "Añadir rollo" los agrega acá (se pueden seguir editando o
  // borrando de la lista); "Confirmar rollos" recién ahí los manda todos en
  // orden. Una vez confirmado cada uno se comporta como cualquier fila ya
  // guardada de siempre: solo se puede borrar, no editar (ver
  // handleDeleteRoll) -- lo que cambia es que ahora ese "punto sin vuelta
  // atrás" es una acción explícita sobre todo el lote, no automática en cada
  // fila.
  const [pendingRolls, setPendingRolls] = useState<PendingRoll[]>([]);
  const [confirmingPending, setConfirmingPending] = useState(false);
  // Etiquetas listas para imprimir de los rollos que se acaban de confirmar
  // (ver handleConfirmPendingRolls) -- el QR con el token de posesión de
  // cada uno viene YA armado en la respuesta de creación (qrDataUrl), esta
  // es la única oportunidad de imprimirlo tal cual: el token nunca se
  // guarda en texto plano, así que no se puede volver a pedir después (ver
  // handleReissueLabel para esa situación).
  const [justCreatedLabels, setJustCreatedLabels] = useState<
    { rollId: number; code: string; qrDataUrl: string; weightKg: unknown; orderNumber: string; productName: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const {
    data: order,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["productionOrder", orderId],
    queryFn: () => api.getProductionOrder(orderId),
    enabled: Number.isInteger(orderId),
  });
  // Para poder editar el destino (Estantería/Cliente) desde la hoja.
  const { data: clients } = useQuery({ queryKey: ["clients"], queryFn: api.getClients });

  // Sugerencia de specs para este cliente+producto+estación -- mismo criterio
  // de "sugerido a mano + sugerido por frecuencia" que la medida/cantidad al
  // crear la OP (ver OrdenesProduccion.tsx) y que "Sugeridos"/"Pide seguido"
  // al elegir productos de un cliente (ver GET /production-orders/suggestions).
  // Antes del early-return de "sin estación" de abajo porque los hooks no
  // pueden llamarse condicionalmente.
  // Solo Gestión puede ver/cargar sugerencias (GET /suggestions es de
  // Gestión): para un operario la consulta solo generaba un 403 en cada carga.
  const suggestionsEnabled =
    !!order?.station && !!order?.clientId && !!order?.productId && !!user && (PRODUCCION_GESTION as UserRole[]).includes(user.role);
  const { data: specSuggestions, refetch: refetchSpecSuggestions } = useQuery({
    queryKey: ["productionOrderSuggestions", order?.clientId, order?.productId, order?.station],
    queryFn: () => api.getProductionOrderSuggestions(order!.clientId, order!.productId, order!.station),
    enabled: suggestionsEnabled,
  });

  // Sincroniza los borradores locales cuando llega/cambia la OP del server.
  useEffect(() => {
    if (!order) return;
    const specs = { ...(order.specs ?? {}) } as Record<string, any>;
    // Si la OP ya nace con Medidas cargadas (ej. viene de un pedido) pero
    // nunca se guardaron Ancho/Largo, hay que precargarlos igual que cuando
    // se tipea Medidas a mano — si no, quedan vacíos hasta que alguien los
    // retipee. Solo completa lo que esté vacío, nunca pisa un valor guardado.
    // Igual que arriba pero con las Medidas propias del producto (ver
    // ProductoForm.tsx) como segunda fuente, por si la OP no nació con
    // "Medidas" propia (ej. creada directo por API) — Medidas de la OP
    // manda si existe, si no se usa la del producto.
    for (const source of [order.measure, order.product.measure]) {
      if (!source) continue;
      const derived = deriveSpecsFromMeasure(source);
      for (const [key, value] of Object.entries(derived)) {
        if (!specs[key]) specs[key] = value;
      }
    }
    // El resto de los atributos del producto (Color/Densidad/Calibre/Unidad
    // de ancho, ver ProductoForm.tsx) se precargan en cualquier campo de
    // Especificaciones de esta estación que tenga la misma clave — cada
    // plantilla usa nombres un poco distintos (ej. "densidad" en Extrusión
    // vs. "materialDensidad" en las demás), así que se prueban ambos.
    if (order.station) {
      const fieldKeys = new Set(OP_TEMPLATES[order.station as OpStation].sections.flatMap((s) => s.fields.map((f) => f.key)));
      const product = order.product;
      if (product.calibre && fieldKeys.has("calibre") && !specs.calibre) specs.calibre = product.calibre;
      if (product.color && fieldKeys.has("color") && !specs.color) specs.color = product.color;
      if (product.measureUnit && fieldKeys.has("anchoUnidad") && !specs.anchoUnidad) specs.anchoUnidad = product.measureUnit;
      // "Unidad" de Medidas finales (Sellado/Precorte) parte de la misma
      // unidad que "Unidad de ancho" de más arriba -- el cliente pidió que no
      // quede vacía si ya se sabe en qué unidad viene el ancho.
      if (fieldKeys.has("medidasUnidad") && !specs.medidasUnidad && specs.anchoUnidad) specs.medidasUnidad = specs.anchoUnidad;
      if (product.densidad) {
        if (fieldKeys.has("densidad") && !specs.densidad) specs.densidad = product.densidad;
        if (fieldKeys.has("materialDensidad") && !specs.materialDensidad) specs.materialDensidad = product.densidad;
      }
      // "Cantidad (kilos)"/"Cantidad (rollos)" (Impresión/Sellado/Precorte)
      // son el material que LLEGÓ de la OP de Extrusión padre, no lo que se
      // produce en esta misma OP (eso ya se ve aparte en la fila "Total" de
      // la tabla de rollos de acá abajo) — el cliente pidió que salgan del
      // pesaje final real de esa OP padre en vez de tipearse a mano.
      if (order.parent) {
        const parentRolls = (order.parent.rolls ?? []) as { weightKg: unknown }[];
        if (parentRolls.length > 0) {
          if (fieldKeys.has("cantidadKilos") && !specs.cantidadKilos) {
            // Redondeado igual que el panel de solo lectura "ORDEN DE
            // EXTRUSIÓN" de más arriba (mismo dato) -- sin esto, el error de
            // punto flotante de sumar decimales de a dos puede dejar algo
            // como "60.599999999999994" en vez de "60.6".
            const sumaKg = parentRolls.reduce((acc, r) => acc + Number(r.weightKg), 0);
            specs.cantidadKilos = String(Math.round(sumaKg * 100) / 100);
          }
          if (fieldKeys.has("cantidadRollos") && !specs.cantidadRollos) {
            specs.cantidadRollos = String(parentRolls.length);
          }
        }
      }
    }
    setSpecsDraft(specs);
    if (order.station === null) return;
    // Color/Densidad (Precorte) ya vienen heredados de Extrusión en estas
    // mismas Especificaciones (`specDefaultKey`, ver opTemplates.ts) — se
    // precargan acá para que el operario no tenga que retipearlos fila por
    // fila. Solo completa lo que esté vacío: nunca pisa una fila que ya se
    // esté cargando con un valor distinto.
    const stationTemplate = OP_TEMPLATES[order.station as OpStation];
    setRollDraft((d) => {
      const next = { ...d };
      for (const col of stationTemplate.rollColumns) {
        if (col.source === "detail" && col.specDefaultKey && !next[`detail:${col.detailKey}`] && specs[col.specDefaultKey]) {
          next[`detail:${col.detailKey}`] = String(specs[col.specDefaultKey]);
        }
      }
      return next;
    });
    // Las filas de materia prima son fijas (las mismas 10 refs impresas en
    // el papel, en su mismo orden) — no una lista donde se van agregando;
    // se guardan solo las que tengan % o kg cargado (ver handleSaveSpecs).
    const savedRows = (specs.materiaPrima as any[]) ?? [];
    const refs = OP_TEMPLATES[order.station as OpStation].materiaPrimaRefs ?? [];
    setMateriaPrima(
      refs.map((ref) => {
        const saved = savedRows.find((r) => r.ref === ref);
        return {
          ref,
          pct: saved ? String(saved.pct ?? "") : "",
          lote: saved ? String(saved.lote ?? "") : "",
        };
      })
    );
    setColores({
      cara1: ((specs.coloresCara1 as any[]) ?? []).map((c) => ({ unidad: String(c.unidad ?? ""), color: String(c.color ?? ""), lote: String(c.lote ?? "") })),
      cara2: ((specs.coloresCara2 as any[]) ?? []).map((c) => ({ unidad: String(c.unidad ?? ""), color: String(c.color ?? ""), lote: String(c.lote ?? "") })),
    });
    setHeaderDraft({
      quantityPlanned: String(Number(order.quantityPlanned)),
      measure: order.measure ?? "",
      notes: order.notes ?? "",
      alertThresholdKg: order.alertThresholdKg != null ? String(Number(order.alertThresholdKg)) : "",
      clientId: order.clientId != null ? String(order.clientId) : "",
    });
    // El autocompletado de arriba (Medidas, Color/Densidad/Calibre del
    // producto, Cantidad heredada del padre) puede haber agregado datos que
    // todavía no están guardados -- si se deja `dirty=false` acá, Gestión ve
    // la hoja ya llena pero el botón Guardar no aparece: si no toca ningún
    // otro campo, esos valores nunca llegan a la base y el PDF sale con esas
    // casillas vacías aunque en pantalla se vean cargadas.
    setDirty(JSON.stringify(specs) !== JSON.stringify(order.specs ?? {}));
  }, [order]);

  if (!Number.isInteger(orderId)) return <p className="text-red-600 dark:text-red-400">OP inválida.</p>;
  if (isLoading) return <SkeletonRows rows={6} cols={2} />;
  // Antes esto quedaba en "Cargando..." para siempre si la petición
  // realmente fallaba (isLoading pasa a false pero order sigue undefined) —
  // el operario nunca se enteraba de que había un error real.
  if (isError || !order) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 text-center p-6 bg-white dark:bg-slate-900 rounded-lg shadow">
        <AlertTriangle size={22} className="text-red-500" aria-hidden="true" />
        <p className="text-red-600 dark:text-red-400 text-sm">No se pudo cargar la orden de producción.</p>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-1.5 bg-slate-800 text-white text-sm px-4 py-2 rounded hover:bg-slate-700"
        >
          <RotateCcw size={14} aria-hidden="true" /> Reintentar
        </button>
      </div>
    );
  }

  const canGestion = !!user && (PRODUCCION_GESTION as UserRole[]).includes(user.role);

  // La OP se crea "en blanco", sin proceso asignado — recién se convierte en
  // una OP de Extrusión (el proceso base) cuando Gestión la deriva
  // explícitamente. Hasta entonces no hay plantilla que mostrar (no existe
  // un OP_TEMPLATES[null]), así que esta es toda la pantalla.
  if (order.station === null) {
    return (
      <div className="max-w-lg mx-auto bg-white dark:bg-slate-900 rounded-lg shadow p-6 space-y-4 text-center">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">{order.orderNumber}</p>
        <h1 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
          {order.product.name}
          {" · "}
          {order.client?.name ? `Cliente: ${order.client.name}` : "Estantería (stock general)"}
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Esta OP todavía no tiene un proceso asignado. El primer paso siempre es Extrusión.
        </p>
        <ErrorToast message={error} onClose={() => setError(null)} />
        {canGestion ? (
          <button onClick={() => handleDerive("extrusion")} className="inline-flex items-center gap-2 bg-slate-800 text-white text-sm px-4 py-2 rounded">
            <Send size={14} /> Derivar a Extrusión
          </button>
        ) : (
          <p className="text-sm text-amber-600 dark:text-amber-400">Solo Gestión/Planeación puede asignar el proceso.</p>
        )}
      </div>
    );
  }

  const station = order.station as OpStation;
  const template = OP_TEMPLATES[station];
  const isDraft = order.status === "borrador";
  const isOpen = OPEN_STATUSES.includes(order.status);
  const isReopenable = REOPENABLE_STATUSES.includes(order.status);
  const canOperate = !!user && STATION_OPERATE[station].includes(user.role);
  const canClose = !!user && STATION_CLOSE[station].includes(user.role);
  // En "borrador" también se edita specs — es justo cuando Gestión carga
  // materia prima/medidas/cliente/referencia antes de liberarla a planta.
  const canEditSpecs = canGestion && (isDraft || isOpen);

  // Qué opciones ofrece el botón flotante de escaneo (ScanDock, más abajo)
  // en este momento — espejo de las condiciones que antes mostraban cada
  // bloque fijo de "Registro de rollos / avance".
  const canScanSourceRoll = !!order.parentOrderId && canOperate && isOpen && (sourceRolls.length === 0 || template.consumesSourceByWeight);
  const canScanBultoLabel = canOperate && isOpen && template.rollColumns.some((c) => c.scanBultoLabel) && !bultoLabel;
  const hasScannedSourceRoll = canOperate && isOpen && sourceRolls.length > 0;
  const hasScannedBultoLabel = canOperate && isOpen && !!bultoLabel;

  // Precorte carga 2 rollos de insumo por fila (ver opTemplates.ts) — el
  // segundo peso queda en details.pesoR2, pero sigue siendo material real
  // que entra a la OP, así que cuenta en todo total de kg junto al peso
  // base (meta, avance, inventario al aprobar en Calidad, etc.).
  function rollTotalWeightKg(r: any): number {
    const base = Number(r.weightKg);
    const r2 = station === "precorte" ? Number(r.details?.pesoR2 ?? 0) : 0;
    return base + (Number.isFinite(r2) ? r2 : 0);
  }

  const totalKg = order.rolls.reduce((acc: number, r: any) => acc + rollTotalWeightKg(r), 0);
  const totalWaste = order.rolls.reduce((acc: number, r: any) => acc + Number(r.wasteKg), 0);
  // Base de la tabla de materia prima: lo producido real (peso + desperdicio)
  // en cuanto hay rollos — es lo que el servidor descuenta al cerrar
  // Extrusión —, o la meta mientras todavía no se produjo nada.
  const mpBaseIsReal = totalKg + totalWaste > 0;
  const mpBaseKg = mpBaseIsReal ? Math.round((totalKg + totalWaste) * 100) / 100 : Number(headerDraft.quantityPlanned) || 0;
  // Los que están en la lista "por confirmar" todavía no son filas reales de
  // la OP (no llegaron al servidor), pero ya van a pesar en la meta apenas se
  // confirmen -- sin esto, alguien podría seguir agregando a la lista más
  // allá de lo planificado sin darse cuenta hasta que "Confirmar rollos"
  // reciente lo rechace fila por fila.
  const pendingKg = pendingRolls.reduce((acc, p) => acc + Number(p.body.weightKg) + Number((p.body.details as any)?.pesoR2 ?? 0), 0);
  const pendingWaste = pendingRolls.reduce((acc, p) => acc + Number(p.body.wasteKg ?? 0), 0);
  // La meta se completa con PESO + DESPERDICIO, no solo peso producido (así
  // lo pidió el cliente) — una vez alcanzada, se oculta la fila de carga
  // (el server además la rechaza si alguien la manda igual, ver
  // POST /:id/rolls).
  const plannedKg = Number(order.quantityPlanned);
  const producedPlusWaste = totalKg + totalWaste + pendingKg + pendingWaste;
  const remainingKg = plannedKg > 0 ? Math.max(0, Math.round((plannedKg - producedPlusWaste) * 100) / 100) : 0;
  const isQuantityComplete = plannedKg > 0 && producedPlusWaste >= plannedKg;
  // Acumulado hasta cada fila (columna TOTAL del papel) — order.rolls ya
  // viene ordenado por fecha/id asc desde el backend.
  const rollCumulative: number[] = [];
  order.rolls.reduce((acc: number, r: any, i: number) => {
    const next = acc + rollTotalWeightKg(r);
    rollCumulative[i] = next;
    return next;
  }, 0);

  function markDirty() {
    setDirty(true);
    setMessage(null);
  }

  function setSpec(key: string, value: string) {
    setSpecsDraft((prev) => ({ ...prev, [key]: value }));
    markDirty();
  }

  /** Solo completa los campos que todavía están vacíos -- nunca pisa algo
   * que Gestión ya haya tipeado a mano. Materia Prima es una lista de filas
   * fijas (una por ref), no un valor simple -- se completa por ref, cada
   * fila el % solo si esa fila todavía está vacía. */
  function applySpecs(specs: Record<string, unknown>) {
    setSpecsDraft((prev) => {
      const next = { ...prev };
      for (const [key, value] of Object.entries(specs)) {
        if (key === "materiaPrima") continue;
        if (!next[key] && (typeof value === "string" || typeof value === "number")) next[key] = String(value);
      }
      return next;
    });
    const materiaPrimaSuggested = specs.materiaPrima;
    if (Array.isArray(materiaPrimaSuggested)) {
      setMateriaPrima((prev) =>
        prev.map((row) => {
          if (row.pct) return row;
          const suggested = materiaPrimaSuggested.find((r) => r && typeof r === "object" && (r as any).ref === row.ref);
          return suggested ? { ...row, pct: String((suggested as any).pct ?? "") } : row;
        })
      );
    }
    markDirty();
  }

  function specsPreview(specs: Record<string, unknown>) {
    return Object.entries(specs)
      .map(([key, value]) => {
        if (key === "materiaPrima" && Array.isArray(value)) {
          return value
            .filter((r) => r && typeof r === "object")
            .map((r: any) => `${r.ref} ${r.pct}%`)
            .join(", ");
        }
        return `${key}: ${value}`;
      })
      .join(", ");
  }

  async function handleSaveSpecSuggestion() {
    if (!order?.clientId || !order?.productId || !order?.station) return;
    const specs: Record<string, unknown> = { ...specsDraft };
    if (template.materiaPrimaRefs) {
      const rows = materiaPrima.filter((r) => r.pct).map((r) => ({ ref: r.ref, pct: Number(r.pct) }));
      if (rows.length) specs.materiaPrima = rows;
    }
    setError(null);
    try {
      await api.saveProductionOrderPreset({
        clientId: order.clientId,
        productId: order.productId,
        station: order.station,
        specs,
      });
      refetchSpecSuggestions();
      setMessage("Sugerencia guardada.");
    } catch (err) {
      // Ej. un valor de lista fuera de la plantilla: antes el clic no hacía
      // nada visible y el error quedaba solo en la consola.
      setError(err instanceof Error && err.message ? `No se pudo guardar la sugerencia: ${err.message}` : "No se pudo guardar la sugerencia");
    }
  }

  async function handleDeleteSpecSuggestion() {
    if (!specSuggestions?.manual) return;
    setError(null);
    try {
      await api.deleteProductionOrderPreset(specSuggestions.manual.id);
      refetchSpecSuggestions();
    } catch (err) {
      setError(err instanceof Error && err.message ? `No se pudo quitar la sugerencia: ${err.message}` : "No se pudo quitar la sugerencia");
    }
  }

  // La manual (cargada a mano por Gestión) y la calculada por frecuencia se
  // listan como fuentes separadas, nunca mezcladas en un solo valor -- la
  // primera queda visible, el resto bajo "+N más" (ver SuggestionSources).
  const specSuggestionItems = [
    ...(specSuggestions?.manual?.specs && Object.keys(specSuggestions.manual.specs).length > 0
      ? [
          {
            key: "manual",
            label: "Sugerido para este cliente + producto",
            detail: specsPreview(specSuggestions.manual.specs),
            onApply: () => applySpecs(specSuggestions.manual!.specs as Record<string, unknown>),
            onRemove: handleDeleteSpecSuggestion,
          },
        ]
      : []),
    ...(specSuggestions?.frequent.specs && Object.keys(specSuggestions.frequent.specs).length > 0
      ? [
          {
            key: "frequent",
            label: `Frecuente en esta estación (${specSuggestions.frequent.sampleSize} OP${specSuggestions.frequent.sampleSize === 1 ? "" : "s"})`,
            detail: specsPreview(specSuggestions.frequent.specs),
            onApply: () => applySpecs(specSuggestions.frequent.specs as Record<string, unknown>),
          },
        ]
      : []),
  ];

  async function handleSaveSpecs() {
    setError(null);
    // Si Gestión vacía este campo o pone 0, `Number(...) || undefined` lo
    // convertía en "no tocar este campo" -- el guardado quedaba en silencio
    // sin avisar, y la pantalla seguía mostrando el valor tipeado hasta
    // recargar. Mejor cortar acá con un mensaje claro.
    const quantityPlannedNum = Number(headerDraft.quantityPlanned);
    if (!headerDraft.quantityPlanned || !Number.isFinite(quantityPlannedNum) || quantityPlannedNum <= 0) {
      setError("La cantidad planificada tiene que ser mayor a 0");
      return;
    }
    try {
      const specs: Record<string, any> = { ...specsDraft };
      if (template.materiaPrimaRefs) {
        // El % es lo que se tipea; el Kg se calcula solo como su parte de
        // la cantidad planificada de la OP — al revés de como era antes,
        // a pedido del cliente.
        const totalPlanned = Number(headerDraft.quantityPlanned) || 0;
        specs.materiaPrima = materiaPrima
          .filter((r) => r.pct)
          .map((r) => ({
            ref: r.ref,
            pct: r.pct ? Number(r.pct) : undefined,
            kg: r.pct && totalPlanned > 0 ? Math.round(((Number(r.pct) / 100) * totalPlanned) * 100) / 100 : undefined,
            lote: r.lote || undefined,
          }));
      }
      if (template.colores) {
        specs.coloresCara1 = colores.cara1.filter((c) => c.color).map((c) => ({ unidad: c.unidad, color: c.color, lote: c.lote || undefined }));
        specs.coloresCara2 = colores.cara2.filter((c) => c.color).map((c) => ({ unidad: c.unidad, color: c.color, lote: c.lote || undefined }));
      }
      await api.updateProductionOrder(orderId, {
        specs,
        quantityPlanned: quantityPlannedNum,
        // "" (campo vaciado a propósito) tiene que mandarse como null, no
        // como undefined — undefined se cae del JSON y el backend interpreta
        // "no tocar este campo", dejando pisado el valor viejo.
        measure: headerDraft.measure || null,
        notes: headerDraft.notes || null,
        alertThresholdKg: headerDraft.alertThresholdKg ? Number(headerDraft.alertThresholdKg) : null,
        clientId: headerDraft.clientId ? Number(headerDraft.clientId) : null,
      });
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
      setMessage("Cambios guardados.");
    } catch (err) {
      // El servidor dice el motivo real (meta que se pasa de lo disponible
      // entre OPs hermanas, valor fuera de la lista de un campo, meta menor a
      // lo ya cargado...) — antes se tapaba con un genérico y Gestión no
      // sabía qué corregir.
      setError(err instanceof Error && err.message ? `No se pudieron guardar los cambios: ${err.message}` : "No se pudieron guardar los cambios");
    }
  }

  // "Material para" es el único campo del encabezado que también puede
  // tocar el operario (a qué estación va a derivar) — se guarda solo al
  // cambiarlo, ya que el operario no tiene acceso al botón general
  // "Guardar cambios" (eso sigue siendo exclusivo de Gestión).
  async function handleMaterialParaChange(value: string) {
    setSpecsDraft((prev) => ({ ...prev, materialPara: value }));
    setError(null);
    try {
      await api.updateMaterialPara(orderId, value || null);
      // OJO: no se invalida ["productionOrder", orderId] acá. Ese refetch
      // dispara de nuevo el useEffect que sincroniza specsDraft con
      // order.specs (línea ~267) y, como el servidor solo guardó
      // materialPara, pisaba con eso cualquier otro campo de ESPECIFICACIONES
      // que el usuario ya hubiera escrito pero no hubiera guardado todavía
      // (ese guardado es aparte, con el botón "Guardar" de handleSaveSpecs).
      // materialPara ya quedó reflejado arriba a mano; no hace falta releer
      // toda la OP para este campo puntual.
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
    } catch {
      setError('No se pudo guardar "Material para"');
    }
  }

  /** Valida el formulario actual y arma el payload que se mandaría a
   * POST /:id/rolls -- lo comparten `handleQueueRoll` (que lo guarda en
   * `pendingRolls` en vez de mandarlo) y `handleConfirmPendingRolls` en el
   * fondo usa el mismo shape ya armado. */
  function validateAndBuildRollBody(): { body: PendingRoll["body"] } | { error: string } {
    if (!rollDraft.weight || Number(rollDraft.weight) <= 0) {
      return { error: "El peso tiene que ser mayor a 0" };
    }
    // En Sellado/Precorte, ETIQUETA/PESO son el rollo de origen escaneado
    // (ver handleScannedSource) — sin un escaneo vigente no hay forma de que
    // esos valores sean confiables (podrían ser un resto de un escaneo que
    // se quitó con "Quitar" sin volver a escanear), así que se bloquea acá
    // además de en la UI.
    // En una OP derivada (Impresión incluida) cada fila tiene que decir de
    // qué rollo salió: sin eso no hay contra qué cuadrar los kilos. Mismo
    // chequeo que el servidor.
    if (order.parentOrderId && sourceRolls.length === 0) {
      return { error: "Escaneá el QR del rollo que estás tomando como insumo antes de registrar la fila" };
    }
    // El rollo chico (más su desperdicio, que también sale del madre) no
    // puede salir de la nada: si pesa más de lo que queda entre todos los
    // rollos madre escaneados, falta montar el siguiente. El server lo vuelve
    // a chequear (es el que manda), esto es para avisarle al operario antes.
    if (template.consumesSourceByWeight) {
      const { missingKg } = previewAllocation(sourceRolls, rowConsumedKg(rollDraft.weight, rollDraft.waste));
      if (missingKg > 0) {
        return { error: `Faltan ${missingKg} kg para cubrir esta fila (peso + desperdicio) — escaneá el siguiente rollo madre` };
      }
    } else if (sourceRolls.length > 0) {
      // Impresión: el insumo se consume entero, así que lo que sale (peso +
      // desperdicio) tiene que cuadrar con lo que entró.
      const entradaKg = Math.round(sourceRolls.reduce((acc, r) => acc + r.remainingKg, 0) * 100) / 100;
      const salidaKg = rowConsumedKg(rollDraft.weight, rollDraft.waste);
      const diffKg = Math.round((entradaKg - salidaKg) * 100) / 100;
      if (Math.abs(diffKg) > massBalanceToleranceKg(entradaKg)) {
        return {
          error:
            diffKg > 0
              ? `Entraron ${entradaKg} kg y salen ${salidaKg} kg (peso + desperdicio): faltan ${diffKg} kg. Si es merma, cargala en desperdicio.`
              : `Salen ${salidaKg} kg (peso + desperdicio) pero solo entraron ${entradaKg} kg: sobran ${-diffKg} kg. Revisá el peso.`,
        };
      }
    }
    // E. BULTO no se tipea a mano — o se escanea la etiqueta física (se
    // manda por separado como `bultoLabelCode` más abajo) o se deja vacío y
    // se autogenera al guardar (ver rollCellDisplay), pero nunca es un
    // input editable como el resto de las columnas de detalle.
    const details: Record<string, string> = {};
    for (const col of template.rollColumns) {
      if (col.source === "detail" && !col.scanBultoLabel && rollDraft[`detail:${col.detailKey}`]) {
        details[col.detailKey!] = rollDraft[`detail:${col.detailKey}`];
      }
    }
    return {
      body: {
        // FECHA/HORA/TURNO ya no se tipean — se omiten acá para que el
        // server los deje en el momento real de guardado (igual que
        // `date DateTime @default(now())`), más confiable que lo que el
        // operario recuerde escribir o el reloj de su navegador.
        // El operario SIEMPRE es quien está logueado, no un campo libre —
        // así el registro queda atado a la cuenta real, no a lo que alguien
        // tipee. Cada operario necesita su propia cuenta (Configuración →
        // Usuarios) para que esto sea trazabilidad real y no una firma falsa.
        operatorName: user!.name,
        machine: rollDraft.machine || undefined,
        // ETIQUETA: en Extrusión e Impresión es la identidad del rollo que
        // se está creando ahora mismo — no tiene sentido pedirla a mano, se
        // genera sola (código <prefijo>-<id>, ver rollCellDisplay) apenas se
        // guarda la fila. En Sellado/Precorte sigue siendo el rollo de ORIGEN que
        // se está tomando como insumo, así que ahí se mantiene manual/editable.
        label: template.labelIsOwnRoll ? undefined : rollDraft.label || undefined,
        weightKg: Number(rollDraft.weight),
        wasteKg: rollDraft.waste ? Number(rollDraft.waste) : undefined,
        details: Object.keys(details).length ? details : undefined,
        sourceRollIds: sourceRolls.length > 0 ? sourceRolls.map((r) => r.id) : undefined,
        // El server exige el token de cada rollo madre para consumirlo (ver
        // POST /:id/rolls del server) -- viaja junto con los ids, uno por
        // cada rollo escaneado para esta fila.
        sourceRollTokens:
          sourceRolls.length > 0 ? Object.fromEntries(sourceRolls.map((r) => [r.id, r.possessionToken])) : undefined,
        bultoLabelCode: bultoLabel?.code,
      },
    };
  }

  /** "Añadir rollo": agrega la fila completada a la lista de pendientes, SIN
   * mandarla al servidor todavía. Mientras esté en esa lista se puede editar
   * (handleEditPendingRoll) o borrar (handleDeletePendingRoll) libremente. */
  function handleQueueRoll(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const result = validateAndBuildRollBody();
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setPendingRolls((prev) => [...prev, { localId: crypto.randomUUID(), body: result.body, rollDraft, sourceRolls, bultoLabel }]);
    // No se limpia del todo -- Color/Densidad (Precorte) heredados de
    // Extrusión se vuelven a precargar en la fila nueva (ver el useEffect
    // de sincronización más arriba), en vez de dejarlos vacíos hasta el
    // próximo refetch de la OP.
    const defaults: Record<string, string> = {};
    for (const col of template.rollColumns) {
      if (col.source === "detail" && col.specDefaultKey && specsDraft[col.specDefaultKey]) {
        defaults[`detail:${col.detailKey}`] = String(specsDraft[col.specDefaultKey]);
      }
    }
    // El rollo madre SIGUE montado en la máquina después de sacarle un
    // rollo chico: se le descuenta lo que se acaba de llevar y queda listo
    // para la fila siguiente. Solo se suelta cuando se agota — ahí el
    // operario tiene que escanear el que monte a continuación. Obligarlo a
    // re-escanear el mismo rollo en cada fila sería pelearse con el proceso
    // real de planta. Este saldo es una cuenta LOCAL (ninguna fila pendiente
    // tocó el servidor todavía) — se recalcula solo con lo que hay en
    // pantalla, el servidor vuelve a validar todo esto recién al confirmar.
    let nextSourceRolls: SourceRollChip[] = [];
    if (template.consumesSourceByWeight) {
      const { allocations } = previewAllocation(sourceRolls, rowConsumedKg(rollDraft.weight, rollDraft.waste));
      const takenById = new Map(allocations.map((a) => [a.roll.id, a.quantityKg]));
      nextSourceRolls = sourceRolls
        .map((r) => ({ ...r, remainingKg: Math.round((r.remainingKg - (takenById.get(r.id) ?? 0)) * 100) / 100 }))
        .filter((r) => r.remainingKg > 0.005);
    }
    if (nextSourceRolls.length > 0) defaults.label = nextSourceRolls[0].code;
    setSourceRolls(nextSourceRolls);
    setRollDraft(defaults);
    setBultoLabel(null);
  }

  /** "Confirmar rollos": manda todo el lote pendiente al servidor, una fila
   * a la vez y en el orden en que se agregaron (mismo orden en que se
   * escanearon los rollos madre, importa para que el reparto por saldo dé el
   * mismo resultado que el operario vio en pantalla). Si una fila falla a
   * mitad del lote, se para ahí: las que ya se confirmaron se sacan de la
   * lista (ya son filas reales, no hace falta reintentarlas) y las que
   * quedan -- incluida la que falló -- se quedan pendientes para corregir y
   * reintentar. Una vez que una fila se confirma queda igual que cualquier
   * fila cargada de siempre: ya no se puede editar, solo borrar (ver
   * handleDeleteRoll). */
  async function handleConfirmPendingRolls() {
    if (pendingRolls.length === 0 || confirmingPending) return;
    setError(null);
    setConfirmingPending(true);
    let confirmedCount = 0;
    const newLabels: typeof justCreatedLabels = [];
    try {
      for (const pending of pendingRolls) {
        const created = await api.createProductionRoll(orderId, pending.body);
        confirmedCount++;
        if (created.qrDataUrl) {
          newLabels.push({
            rollId: created.id,
            code: `${ROLL_CODE_PREFIX[station]}-${created.stationSequence}`,
            qrDataUrl: created.qrDataUrl,
            weightKg: created.weightKg,
            orderNumber: order.orderNumber,
            productName: order.product.name,
          });
        }
      }
      setPendingRolls([]);
      setJustCreatedLabels(newLabels);
      setMessage(`Se confirmaron ${confirmedCount} rollo${confirmedCount === 1 ? "" : "s"}.`);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
    } catch (err: any) {
      setPendingRolls((prev) => prev.slice(confirmedCount));
      // Las que sí se alcanzaron a crear antes del error también necesitan
      // su etiqueta -- es la única oportunidad de imprimirlas.
      if (newLabels.length > 0) setJustCreatedLabels(newLabels);
      const detail = err?.message?.includes("403") ? "Tu rol no puede registrar rollos en esta estación" : err?.message || "No se pudo registrar el rollo";
      setError(
        confirmedCount > 0
          ? `Se confirmaron ${confirmedCount} de ${pendingRolls.length} rollos. La fila ${confirmedCount + 1} no se pudo guardar: ${detail}`
          : `No se pudo guardar la fila 1: ${detail}`
      );
      if (confirmedCount > 0) {
        queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
        queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
      }
    } finally {
      setConfirmingPending(false);
    }
  }

  /** Saldo "de verdad" de un rollo madre en este momento: no la foto vieja
   * que haya quedado guardada en alguna fila pendiente, sino el valor que
   * devolvió el servidor la primera vez que se escaneó (todavía nadie le
   * había sacado nada) — se busca en la fila pendiente MÁS ANTIGUA que lo
   * haya usado, porque su `sourceRolls` es justo el saldo de antes de que
   * esa fila le sacara algo. Si ninguna fila pendiente lo usa, lo que hay
   * ahora mismo en el formulario (`sourceRolls`) ya es ese valor sin tocar. */
  function rootSourceRollBalances(ids: number[]): SourceRollChip[] {
    return ids.map((id) => {
      for (const p of pendingRolls) {
        const found = p.sourceRolls.find((r) => r.id === id);
        if (found) return found;
      }
      return sourceRolls.find((r) => r.id === id) ?? { id, code: "?", label: null, weightKg: 0, remainingKg: 0, possessionToken: "" };
    });
  }

  /** Simula en orden el consumo de `rows` sobre `rootRolls`, para saber
   * cuánto queda de verdad DESPUÉS de esas filas. Se usa para recalcular el
   * saldo al editar o borrar una fila del lote en vez de mutar a mano un
   * saldo guardado -- que es justo lo que se desincronizaba antes: al editar
   * se perdía el consumo de las filas agregadas después, y al borrar nunca
   * se devolvía nada. */
  function recomputeSourceRollBalances(rootRolls: SourceRollChip[], rows: PendingRoll[]): SourceRollChip[] {
    let running = rootRolls;
    for (const row of rows) {
      if (row.sourceRolls.length === 0) continue;
      const rowRolls = row.sourceRolls.map((r) => running.find((x) => x.id === r.id)).filter((r): r is SourceRollChip => r != null);
      if (rowRolls.length === 0) continue;
      const { allocations } = previewAllocation(rowRolls, rowConsumedKg(row.body.weightKg, row.body.wasteKg));
      const takenById = new Map(allocations.map((a) => [a.roll.id, a.quantityKg]));
      running = running.map((r) => (takenById.has(r.id) ? { ...r, remainingKg: Math.round((r.remainingKg - (takenById.get(r.id) ?? 0)) * 100) / 100 } : r));
    }
    return running;
  }

  /** Vuelve a cargar una fila pendiente en el formulario para corregirla —
   * la saca de la lista mientras tanto, "Añadir rollo" la vuelve a poner.
   * El saldo de los rollos madre que trae la fila NO es la foto que se
   * guardó al agregarla (esa foto no sabe nada de filas que se hayan sumado
   * después y también hayan tomado kilos de esos mismos rollos) — se
   * recalcula de cero contra lo que de verdad sigue pendiente.
   *
   * El set de ids que se le pasa a `rootSourceRollBalances` NO es solo el de
   * la fila que se edita: tiene que incluir TODOS los ids que aparezcan en
   * cualquier fila de `remainingRows` también. Si no, una fila intermedia
   * que haya repartido su peso entre DOS rollos madre (el caso normal de
   * "se pasó del saldo, siguió con el segundo") pierde uno de los dos en la
   * simulación -- `recomputeSourceRollBalances` le sigue restando el peso
   * COMPLETO de esa fila al único rollo que sobrevivió en el set, dejándolo
   * en un saldo menor al real. */
  function handleEditPendingRoll(localId: string) {
    const pending = pendingRolls.find((p) => p.localId === localId);
    if (!pending) return;
    const remainingRows = pendingRolls.filter((p) => p.localId !== localId);
    const targetIds = pending.sourceRolls.map((r) => r.id);
    const allIds = Array.from(new Set([...targetIds, ...remainingRows.flatMap((r) => r.sourceRolls.map((x) => x.id))]));
    const liveRolls = recomputeSourceRollBalances(rootSourceRollBalances(allIds), remainingRows)
      .filter((r) => targetIds.includes(r.id))
      .filter((r) => r.remainingKg > 0.005);
    setPendingRolls(remainingRows);
    setRollDraft(pending.rollDraft);
    setSourceRolls(liveRolls);
    setBultoLabel(pending.bultoLabel);
    setError(null);
  }

  /** Borra una fila pendiente y recalcula el saldo real de sus rollos madre
   * -- no solo los que estén escaneados AHORA en el formulario (`sourceRolls`
   * puede estar vacío si el rollo madre de la fila borrada ya se había
   * agotado y su chip había desaparecido, que es el caso más común), sino
   * también los propios de la fila que se borra, para que reaparezcan con
   * su saldo correcto en vez de quedar "perdidos" hasta re-escanear.
   * Mismo cuidado que en `handleEditPendingRoll` con el set de ids completo
   * para que la simulación no pierda un rollo madre compartido. */
  function handleDeletePendingRoll(localId: string) {
    const pending = pendingRolls.find((p) => p.localId === localId);
    const remainingRows = pendingRolls.filter((p) => p.localId !== localId);
    const targetIds = Array.from(new Set([...sourceRolls.map((r) => r.id), ...(pending?.sourceRolls.map((r) => r.id) ?? [])]));
    if (targetIds.length > 0) {
      const allIds = Array.from(new Set([...targetIds, ...remainingRows.flatMap((r) => r.sourceRolls.map((x) => x.id))]));
      const liveRolls = recomputeSourceRollBalances(rootSourceRollBalances(allIds), remainingRows)
        .filter((r) => targetIds.includes(r.id))
        .filter((r) => r.remainingKg > 0.005);
      setSourceRolls(liveRolls);
    }
    setPendingRolls(remainingRows);
  }

  /** Genera un token de posesión NUEVO para un rollo ya guardado e imprime
   * su QR -- para cuando la etiqueta original (la que se pudo imprimir una
   * sola vez, justo al confirmarlo) nunca se imprimió, se dañó o se
   * perdió. Invalida cualquier etiqueta física anterior: su token viejo
   * deja de matchear apenas se reemite uno nuevo. */
  async function handleReissueLabel(rollId: number, code: string) {
    setError(null);
    if (!(await confirm(`La etiqueta física actual de ${code} (si existe) va a dejar de servir. ¿Reemitir de todos modos?`, { title: "¿Reemitir etiqueta?", tone: "danger" }))) {
      return;
    }
    try {
      const label = await api.reissueProductionRollLabel(orderId, rollId);
      printRollLabel(label);
    } catch {
      setError("No se pudo reemitir la etiqueta");
    }
  }

  /** "Quitar" en el chip del rollo de origen: además de soltar `sourceRoll`,
   * hay que borrar lo que handleScannedSource haya precargado en el
   * borrador — si no, queda un ETIQUETA/PESO viejo sentado en rollDraft que
   * ya no corresponde a ningún escaneo vigente pero igual se mandaría al
   * guardar la fila (el campo se ve bloqueado, así que el operario no tiene
   * forma de notar ni corregir ese resto). */
  function handleClearSourceRoll(rollId?: number) {
    const remaining = rollId == null ? [] : sourceRolls.filter((r) => r.id !== rollId);
    setSourceRolls(remaining);
    setRollDraft((d) => {
      const next = { ...d };
      if (template.originRollFields) {
        delete next[`detail:${template.originRollFields.labelDetailKey}`];
        delete next[`detail:${template.originRollFields.weightDetailKey}`];
      } else if (!template.labelIsOwnRoll) {
        // La ETIQUETA es el rollo madre principal: si todavía queda alguno
        // escaneado pasa a serlo el primero de los que quedan, y si no queda
        // ninguno se limpia. El PESO en estas estaciones lo tipea el
        // operario (son los kilos que salió el rollo chico), así que no se
        // toca — borrarlo le haría perder lo que ya venía cargando.
        if (remaining.length > 0) next.label = remaining[0].code;
        else delete next.label;
        if (!template.consumesSourceByWeight) delete next.weight;
      }
      for (const col of template.rollColumns) {
        if (col.source === "detail" && col.kind === "siNo") {
          delete next[`detail:${col.detailKey}`];
        }
      }
      return next;
    });
  }

  /** Busca el rollo madre por código y lo agrega a `sourceRolls`/precarga
   * `rollDraft`. `token` es la parte del QR que demuestra posesión física
   * (ver deriveScannedCode más abajo) — se manda al server para feedback
   * inmediato si es falso, y se guarda en el chip para poder mandarlo de
   * nuevo al confirmar la fila (el chequeo que de verdad importa es ese).
   * Tira (ApiError con status, o un Error si ya estaba escaneado) — lo usa
   * `handleScanAny` para decidir si sigue probando como etiqueta de bulto. */
  async function applyScannedSourceRoll(code: string, token: string): Promise<void> {
    const roll = await api.getProductionRollByCode(code, token, station);
    const chip: SourceRollChip = {
      id: roll.id,
      code,
      label: roll.label ?? null,
      weightKg: Number(roll.weightKg),
      remainingKg: Number(roll.remainingKg ?? roll.weightKg),
      createdByName: roll.createdBy?.name ?? null,
      possessionToken: token,
    };
    if (sourceRolls.some((r) => r.id === chip.id)) {
      throw new Error("Ese rollo madre ya está escaneado para esta fila");
    }
    // En Sellado/Precorte se pueden acumular rollos madre (el segundo cubre
    // lo que se pasó del primero); en el resto, escanear reemplaza porque el
    // insumo se consume entero y es uno solo.
    const nextRolls = template.consumesSourceByWeight ? [...sourceRolls, chip] : [chip];
    setSourceRolls(nextRolls);
    setRollDraft((d) => {
      const next = { ...d };
      if (template.originRollFields) {
        next[`detail:${template.originRollFields.labelDetailKey}`] = roll.label ?? code;
        next[`detail:${template.originRollFields.weightDetailKey}`] = String(Number(roll.weightKg));
      } else if (!template.labelIsOwnRoll) {
        // Sellado/Precorte no tienen columnas de detalle propias para el
        // rollo de origen (a diferencia de Impresión) — ahí la columna base
        // ETIQUETA es el rollo madre. El PESO ya NO se precarga con el peso
        // del madre: son los kilos que salió el rollo chico, los tipea el
        // operario y le descuentan saldo al madre.
        next.label = nextRolls[0].code;
        if (!template.consumesSourceByWeight) next.weight = String(Number(roll.weightKg));
      }
      // Pruebas SI/NO (ej. P. RESISTENCIA): si el rollo escaneado ya tiene
      // esa misma prueba registrada de su propia estación, se precarga acá
      // como punto de partida — el operario la puede cambiar, no queda
      // trabada.
      for (const col of template.rollColumns) {
        if (col.source === "detail" && col.kind === "siNo" && roll.details?.[col.detailKey!] != null) {
          next[`detail:${col.detailKey}`] = String(roll.details[col.detailKey!]);
        }
      }
      return next;
    });
  }

  /** Busca la etiqueta de bulto por código y la guarda en `bultoLabel`. Tira
   * igual que `applyScannedSourceRoll`, para el mismo mecanismo de
   * `handleScanAny`. */
  async function applyScannedBultoLabel(code: string): Promise<void> {
    const label = await api.getBultoLabelByCode(code);
    if (label.status !== "disponible") {
      throw new Error(`La etiqueta ${label.code} ya fue usada`);
    }
    setBultoLabel(label);
  }

  /** Único punto de entrada del botón de escaneo: no le pregunta al
   * operario qué escaneó, detecta el tipo sola. Las etiquetas de bulto
   * siempre son "EXT-" + 5 dígitos con cero a la izquierda (el server las
   * genera con `padStart(5, "0")`, ver POST /bulto-labels/generate); un
   * rollo real de Extrusión nunca lleva cero a la izquierda porque su
   * numeración por estación no usa padding (ver ROLL_CODE_RE en
   * production-orders.ts) — alcanza para elegir sin ambigüedad qué probar
   * primero. Si el primero da 404 y el código NO tenía la forma
   * inconfundible de etiqueta de bulto, prueba el otro antes de rendirse.
   *
   * Cuando SÍ tiene esa forma (ver `primaryWasAmbiguousBultoShape` abajo) NO
   * se reintenta como rollo aunque la etiqueta dé 404: `ROLL_CODE_RE` en el
   * server no exige "sin cero a la izquierda", así que "EXT-00007" matchea
   * igual el código de un rollo real (`Number("00007") === 7`). Esto no es
   * un caso raro de "algún día 10.000 rollos" — pasa hoy con cualquier
   * etiqueta mal tipeada, con el QR dañado, o todavía sin imprimir: sin este
   * corte, un 404 de la etiqueta terminaba enganchando en silencio el rollo
   * de Extrusión #7 y descontándole kilos que no tienen nada que ver. */
  async function handleScanAny(code: string) {
    setScanning(false);
    setError(null);
    const trimmed = code.trim();
    const { code: scannedCode, token: scannedToken } = splitScannedCode(trimmed);
    const looksLikeBulto = /^EXT-0\d{4}$/.test(scannedCode);

    const rollAttempt = { kind: "roll" as const, ok: canScanSourceRoll, run: () => applyScannedSourceRoll(scannedCode, scannedToken) };
    const bultoAttempt = { kind: "bulto" as const, ok: canScanBultoLabel, run: () => applyScannedBultoLabel(scannedCode) };
    const [first, second] = looksLikeBulto ? [bultoAttempt, rollAttempt] : [rollAttempt, bultoAttempt];

    if (!first.ok && !second.ok) {
      setError("No hay nada para escanear en este momento");
      return;
    }

    const primary = first.ok ? first : second;
    const fallback = first.ok ? second : first;
    const primaryWasAmbiguousBultoShape = looksLikeBulto && primary.kind === "bulto";

    try {
      await primary.run();
    } catch (err) {
      const notFound = err instanceof ApiError && err.status === 404;
      if (notFound && primaryWasAmbiguousBultoShape) {
        setError(`No se encontró la etiqueta de bulto ${scannedCode}`);
        return;
      }
      if (notFound && fallback.ok) {
        try {
          await fallback.run();
          return;
        } catch (err2) {
          setError(err2 instanceof Error ? err2.message : "No se pudo procesar el código escaneado");
          return;
        }
      }
      setError(err instanceof Error ? err.message : "No se pudo procesar el código escaneado");
    }
  }

  async function handleDeleteRoll(rollId: number) {
    setError(null);
    try {
      await api.deleteProductionRoll(orderId, rollId);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
    } catch {
      setError("No se pudo borrar el rollo");
    }
  }

  async function handleDerive(target: OpStation) {
    setError(null);
    try {
      const derived = await api.deriveProductionOrder(orderId, { station: target });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
      // Caso especial: si esta OP no tenía proceso asignado, "derivar" la
      // actualiza en el lugar (mismo id) en vez de crear una hija — hay que
      // invalidar su propia query para que la pantalla deje de mostrar el
      // estado "sin proceso" y muestre ya la plantilla de Extrusión.
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      if (derived.id !== orderId) navigate(`/produccion/ordenes/${derived.id}`);
    } catch (err: any) {
      // El server manda mensajes específicos (ej. "Esta OP ya fue derivada
      // a Sellado (OP #12)", "Primero derivá la OP a Extrusión") que tapaba
      // este genérico — mostrarlos tal cual ayuda mucho más a entender qué
      // pasó.
      setError(err?.message || "No se pudo derivar la OP");
    }
  }

  async function handleClose() {
    setError(null);
    const isFinal = FINAL_STATIONS.includes(station);
    const confirmMsg = isFinal
      ? "Pasará a revisión de Calidad y, si se aprueba, sus kilos entran al inventario."
      : "Quedará terminada (su material sigue en las OPs derivadas).";
    if (!(await confirm(confirmMsg, { title: "¿Cerrar la OP?", confirmLabel: "Cerrar OP" }))) return;
    try {
      const result = await api.closeProductionOrder(orderId);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
      // El server avisa (sin bloquear el cierre) si alguna ref de materia
      // prima de la tabla no matcheó ningún código del catálogo -- antes el
      // frontend directamente ignoraba ese dato y nadie se enteraba de que
      // un insumo no se descontó del inventario.
      if (result?.skippedRawMaterialRefs?.length > 0) {
        setMessage(`OP cerrada. Ojo: no se descontó materia prima para estas refs (no matchean el catálogo): ${result.skippedRawMaterialRefs.join(", ")}`);
      }
    } catch (err: any) {
      setError(err?.message ?? "No se pudo cerrar la OP");
    }
  }

  async function handleReopen() {
    setError(null);
    const shouldReopen = await confirm(
      "Si tenía calidad aprobada, se revierte la entrada al inventario; si es de Extrusión, se devuelve la materia prima descontada. Vas a tener que volver a cerrarla (y pasarla por Calidad si corresponde) después de corregirla.",
      { title: "¿Reabrir la OP para corregir un error?", confirmLabel: "Reabrir", tone: "danger" }
    );
    if (!shouldReopen) return;
    setReopening(true);
    try {
      await api.reopenProductionOrder(orderId);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
    } catch (err: any) {
      setError(err?.message ?? "No se pudo reabrir la OP");
    } finally {
      setReopening(false);
    }
  }

  async function handleRelease() {
    setError(null);
    // Liberar valida lo GUARDADO (ej. la fórmula de materia prima): con cambios
    // sin guardar, el servidor rechazaba con un motivo que no coincidía con lo
    // que se ve en pantalla.
    if (dirty) {
      setError("Hay cambios sin guardar — tocá \"Guardar cambios\" antes de liberar la OP.");
      return;
    }
    const shouldRelease = await confirm(`A partir de ahora la va a ver la cola de ${STATION_LABELS[station]} y va a poder cargar rollos.`, {
      title: "¿Liberar esta OP a planta?",
      confirmLabel: "Liberar",
    });
    if (!shouldRelease) return;
    setReleasing(true);
    try {
      await api.releaseProductionOrder(orderId);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
      queryClient.invalidateQueries({ queryKey: ["productionOrders"] });
    } catch (err: any) {
      setError(err?.message ?? "No se pudo liberar la OP");
    } finally {
      setReleasing(false);
    }
  }

  async function handleUploadAttachment() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await api.uploadProductionOrderAttachment(orderId, file);
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
    } catch {
      setError("No se pudo subir el archivo");
    }
  }

  async function handleDeleteAttachment(attachmentId: number) {
    if (!confirm("¿Borrar este adjunto?")) return;
    setError(null);
    try {
      await api.deleteProductionOrderAttachment(orderId, attachmentId);
      queryClient.invalidateQueries({ queryKey: ["productionOrder", orderId] });
    } catch {
      setError("No se pudo borrar el adjunto");
    }
  }

  /** `cumulative` es la suma de kg hasta esta fila inclusive (columna TOTAL
   * del papel) — la calcula el caller recorriendo order.rolls en orden. */
  function rollCellDisplay(roll: any, col: OpRollColumn, cumulative?: number) {
    switch (col.source) {
      case "date":
        return new Date(roll.date).toLocaleDateString();
      case "time":
        // 24h ("14:30") — la versión de 12h con AM/PM es muy larga para la
        // columna angosta de HORA.
        return new Date(roll.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
      case "shift":
        return roll.shift ?? "—";
      case "operator":
        return roll.operatorName;
      case "machine":
        return roll.machine ?? "—";
      case "label":
        // En Extrusión/Impresión la etiqueta no se tipea, se genera sola
        // (mismo código <prefijo>-<n> de la etiqueta QR impresa, numerado
        // dentro de esta estación) — así igual queda algo identificable en
        // la tabla en vez de un "—" vacío.
        return roll.label ?? (template.labelIsOwnRoll ? `${ROLL_CODE_PREFIX[station]}-${roll.stationSequence}` : "—");
      case "weight":
        return String(Number(roll.weightKg));
      case "waste":
        return String(Number(roll.wasteKg));
      case "cumulativeWeight":
        return String(Math.round((cumulative ?? 0) * 100) / 100);
      case "detail": {
        const value = roll.details?.[col.detailKey!];
        if (value != null && value !== "") return String(value);
        // E. BULTO: a diferencia de ETIQUETA, acá no hay ningún código real
        // que autogenerar si no se escaneó una etiqueta física — mostrar un
        // `BULTO-<id>` inventado (que además usaba el prefijo viejo ya
        // reemplazado por EXT-) hacía parecer que ese bulto tenía una
        // etiqueta física cuando no la tiene, y no coincidía con el PDF
        // (que sí queda en blanco en ese caso).
        return "—";
      }
    }
  }

  /** Contenido de una celda de la fila de carga inline (la de escribir un
   * rollo nuevo), factorizado para reusarlo tal cual en la tabla de
   * escritorio y en las tarjetas de celular — antes esta lógica vivía
   * duplicada como puro JSX dentro del `<tr>`, ahora es una sola función que
   * decide qué mostrar según la columna. */
  /** `className` es exactamente lo que tenía cada celda en la versión vieja
   * (antes de factorizar esto en una función) — cada caso tenía un tono/
   * alineación levemente distinto (ej. el operario no iba centrado ni en
   * cursiva, a diferencia de los demás "se completa sola"), no son todos
   * iguales aunque varios compartan el estado "bloqueado". */
  function draftCellContent(col: OpRollColumn): { content: ReactNode; className: string; title?: string; editable?: boolean } {
    const key = rollDraftKey(col);
    if (col.source === "operator") {
      return { content: user!.name, className: "text-slate-500 dark:text-slate-400", title: "El operario es siempre la cuenta con la que iniciaste sesión" };
    }
    if (col.source === "cumulativeWeight") {
      return { content: "—", className: "text-slate-400 dark:text-slate-500 text-center", title: "Se calcula solo al guardar" };
    }
    if (col.source === "date" || col.source === "time" || (col.source === "label" && template.labelIsOwnRoll)) {
      return {
        content: "se completa sola",
        className: "text-slate-400 dark:text-slate-500 text-center italic",
        title: col.source === "label" ? "Se genera sola (código del rollo) al guardar" : "Se completa sola con el momento en que se guarda",
      };
    }
    // TURNO: solo hay Día/Noche en planta, se calcula solo de la hora real
    // de Colombia al guardar (mismo criterio que FECHA/HORA) — acá se
    // muestra una vista previa (hora de Colombia, no la del huso del
    // navegador/celular), el valor que realmente queda es el que calcula el
    // servidor al momento de guardar la fila.
    if (col.source === "shift") {
      const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Bogota", hour: "numeric", hour12: false }).format(new Date())) % 24;
      const shiftPreview = hour >= 6 && hour < 18 ? "Día" : "Noche";
      return { content: shiftPreview, className: "text-slate-500 dark:text-slate-400 text-center italic", title: "Se completa solo según la hora (6:00–17:59 Día, resto Noche)" };
    }
    // ETIQUETA/PESO son el rollo de ORIGEN en Sellado/Precorte (a diferencia
    // de Extrusión/Impresión, donde arriba ya se resuelve como "rollo
    // propio"). El jefe pidió que acá no se pueda tipear a mano: se
    // bloquean hasta escanear el QR del rollo de origen, que es lo que los
    // rellena — recién ahí quedan editables por si hace falta corregir algo.
    if ((col.source === "label" || col.source === "weight") && !template.labelIsOwnRoll && sourceRolls.length === 0) {
      return { content: "escaneá el QR", className: "text-slate-400 dark:text-slate-500 text-center italic", title: "Se completa al escanear el QR del rollo de origen" };
    }
    // Con el rollo madre ya escaneado, la ETIQUETA es ese rollo (no se tipea)
    // y el PESO pasa a ser lo único que carga el operario: cuántos kilos
    // salió el rollo chico que acaba de sacar.
    if (col.source === "label" && template.consumesSourceByWeight && sourceRolls.length > 0) {
      return {
        content: sourceRolls[0].code,
        className: "text-slate-800 dark:text-slate-100 text-center font-medium",
        title: "Rollo madre del que está saliendo esta fila",
      };
    }
    // E. BULTO: no se tipea a mano — solo se completa si se escanea una
    // etiqueta física pre-impresa (ver EtiquetasBulto.tsx, mercancía
    // comprada afuera); si no se escanea ninguna, queda vacía (no es un
    // bulto con etiqueta externa) — el campo en sí queda bloqueado, nunca
    // es un input libre.
    if (col.scanBultoLabel) {
      return {
        content: bultoLabel ? bultoLabel.code : "—",
        className: `text-center ${bultoLabel ? "text-slate-800 dark:text-slate-100 font-medium" : "text-slate-400 dark:text-slate-500 italic"}`,
        title: bultoLabel ? undefined : "Solo se completa si escaneás la etiqueta física de una mercadería comprada afuera",
      };
    }
    // COLOR/DENSIDAD (Precorte) ya vienen heredados de Extrusión en las
    // Especificaciones de esta misma OP -- se dejó de pedir a mano fila por
    // fila para que no se pueda escribir un valor distinto al del
    // encabezado por error. Si el encabezado todavía no tiene ese dato
    // cargado (OP vieja, o Gestión no lo completó), se cae al input
    // editable de siempre en vez de mostrar una celda bloqueada en blanco.
    if (col.source === "detail" && col.specDefaultKey && specsDraft[col.specDefaultKey]) {
      return {
        content: String(specsDraft[col.specDefaultKey]),
        className: "text-slate-800 dark:text-slate-100 text-center",
        title: "Viene de las Especificaciones de esta OP (heredado de Extrusión) — se edita ahí arriba, no acá",
      };
    }
    // Segundo par ETIQUETA R / PESO R (Precorte): es el excedente que sale
    // del SIGUIENTE rollo madre cuando el actual no alcanza (ver reparto en
    // el chip de arriba) -- se calcula solo del escaneo, no se tipea.
    if (col.source === "detail" && (col.detailKey === "etiquetaR2" || col.detailKey === "pesoR2") && template.consumesSourceByWeight) {
      const { allocations } = previewAllocation(sourceRolls, Number(rollDraft.weight) || 0);
      // El excedente puede venir de MÁS de un rollo madre siguiente (si
      // escanearon un tercero, un cuarto...) — el server suma todo lo que no
      // sea el primer reparto en un solo PESO R2 (ver weightKg/spillKg en
      // POST /:id/rolls), así que la vista previa tiene que sumar igual, no
      // mostrar solo el segundo.
      const spill = allocations.slice(1);
      if (spill.length === 0) {
        return { content: "—", className: "text-slate-400 dark:text-slate-500 text-center italic", title: "Se completa solo si el rollo madre actual no alcanza" };
      }
      const spillKg = Math.round(spill.reduce((acc, a) => acc + a.quantityKg, 0) * 100) / 100;
      return {
        content: col.detailKey === "etiquetaR2" ? spill[0].roll.code : String(spillKg),
        className: "text-slate-800 dark:text-slate-100 text-center font-medium",
        title: "Excedente que salió del siguiente rollo madre escaneado",
      };
    }
    return {
      // "editable: true" es lo que la tarjeta de celular usa para resaltar
      // esta fila como un campo tocable de verdad (ver más abajo, sección
      // "Fila de carga" del md:hidden) — no es una clase CSS, es la señal de
      // "este campo sí lo llena la persona".
      className: "",
      editable: true,
      content:
        col.kind === "siNo" ? (
          <select className={draftInput} value={rollDraft[key] ?? ""} onChange={(e) => setRollDraft((d) => ({ ...d, [key]: e.target.value }))}>
            <option value="">—</option>
            <option value="SI">SI</option>
            <option value="NO">NO</option>
          </select>
        ) : (
          <input
            className={draftInput}
            type={col.kind === "number" ? "number" : "text"}
            step={col.kind === "number" ? "0.01" : undefined}
            value={rollDraft[key] ?? ""}
            onChange={(e) => setRollDraft((d) => ({ ...d, [key]: e.target.value }))}
          />
        ),
    };
  }

  function rollDraftKey(col: OpRollColumn) {
    return col.source === "detail" ? `detail:${col.detailKey}` : col.source === "operator" ? "operator" : col.source;
  }

  // Una OP solo puede derivar una vez a cada estación destino (ver guard en
  // el backend) — se ocultan los botones de las que ya tienen una hija para
  // no ofrecer una acción que el server va a rechazar con 400.
  const derivedStations = new Set((order.derivedOrders ?? []).map((d: any) => d.station));
  const derivations = DERIVATIONS[station].filter((s) => !derivedStations.has(s));

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/produccion/ordenes" className="text-sm text-sky-700 dark:text-sky-400 hover:underline">
          ← Órdenes de producción
        </Link>
        <div className="flex flex-wrap gap-2">
          {canGestion && isDraft && (
            <button
              type="button"
              onClick={handleRelease}
              disabled={releasing}
              className="inline-flex items-center gap-1.5 text-sm bg-sky-700 hover:bg-sky-600 text-white rounded px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Send size={14} aria-hidden="true" /> {releasing ? "Liberando..." : "Liberar a planta"}
            </button>
          )}
          {/* Derivar es exclusivo de Gestión/Planeación — ningún operario
              puede mandar la OP al siguiente proceso, esa decisión la
              pidió el cliente que quede siempre centralizada. */}
          {canGestion &&
            derivations.map((target) => (
              <button
                key={target}
                type="button"
                onClick={() => handleDerive(target)}
                className="inline-flex items-center gap-1.5 text-sm border border-slate-300 dark:border-slate-600 rounded px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800"
              >
                <GitBranch size={14} aria-hidden="true" /> Derivar a {STATION_LABELS[target]}
              </button>
            ))}
          {canClose && isOpen && (
            <button
              type="button"
              onClick={handleClose}
              className="inline-flex items-center gap-1.5 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5"
            >
              <Lock size={14} aria-hidden="true" /> Cerrar OP
            </button>
          )}
          {canGestion && isReopenable && (
            <button
              type="button"
              onClick={handleReopen}
              disabled={reopening}
              className="inline-flex items-center gap-1.5 text-sm border border-amber-400 text-amber-700 dark:text-amber-400 dark:border-amber-500 rounded px-3 py-1.5 hover:bg-amber-50 dark:hover:bg-amber-950 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RotateCcw size={14} aria-hidden="true" /> {reopening ? "Reabriendo..." : "Reabrir OP"}
            </button>
          )}
          <button
            type="button"
            onClick={() => api.downloadProductionOrderPdf(orderId, order.orderNumber)}
            className="inline-flex items-center gap-1.5 text-sm bg-slate-800 hover:bg-slate-700 text-white rounded px-3 py-1.5"
          >
            <FileDown size={14} aria-hidden="true" /> Reporte PDF
          </button>
        </div>
      </div>

      <ErrorToast message={error} onClose={() => setError(null)} />
      {message && <p className="text-emerald-700 dark:text-emerald-400 text-sm">{message}</p>}

      {/* Etiquetas de los rollos recién confirmados: el QR con el token de
          posesión solo se puede armar en este momento (ver
          handleConfirmPendingRolls) -- si no se imprime acá, después hace
          falta reemitir (botón "Reemitir etiqueta" en la fila del rollo). */}
      {justCreatedLabels.length > 0 && (
        <div className="bg-emerald-50 dark:bg-emerald-950 border border-emerald-300 dark:border-emerald-700 rounded-lg p-3 flex flex-wrap items-center gap-2">
          <p className="text-sm text-emerald-800 dark:text-emerald-300 font-medium">
            Etiquetas listas para imprimir ({justCreatedLabels.length}):
          </p>
          {justCreatedLabels.map((l) => (
            <button
              key={l.rollId}
              type="button"
              onClick={() => printRollLabel(l)}
              className="inline-flex items-center gap-1.5 text-sm bg-emerald-700 hover:bg-emerald-600 text-white rounded px-3 py-1.5"
            >
              <Printer size={14} aria-hidden="true" /> {l.code}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setJustCreatedLabels([])}
            className="text-sm text-emerald-700 dark:text-emerald-400 hover:underline ml-auto"
          >
            Ocultar
          </button>
        </div>
      )}

      {/* ---- La hoja, con la estructura del formato en papel ---- */}
      <div className="bg-white dark:bg-slate-900 border-2 border-slate-400 dark:border-slate-500 shadow">
        {/* Banda de título */}
        <div className="grid grid-cols-[1fr_2fr_1fr] border-b-2 border-slate-400 dark:border-slate-500">
          <div className={`${cellBorder} border-t-0 border-l-0 p-2 flex items-center`}>
            <img src="/logo-full.png" alt="Plásticos Superior San Judas S.A.S." className="h-8 w-auto" />
          </div>
          <div className={`${cellBorder} border-t-0 p-2 flex items-center justify-center`}>
            <p className="text-sm sm:text-base font-bold text-slate-800 dark:text-slate-100 text-center">{template.title}</p>
          </div>
          <div className={`${cellBorder} border-t-0 border-r-0 p-2 text-[10px] text-slate-500 dark:text-slate-400 space-y-0.5`}>
            <p className="font-semibold">{template.cod}</p>
            <p>FECHA {new Date(order.createdAt).toLocaleDateString()}</p>
            <p className="uppercase font-semibold">{STATUS_LABELS[order.status]}</p>
          </div>
        </div>

        {/* Encabezado */}
        <div className="grid grid-cols-2 sm:grid-cols-3">
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel}>Nro O.Prod</span>
            <span className="text-sm font-bold text-slate-800 dark:text-slate-100">{order.orderNumber}</span>
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel} title="A qué cliente se despacha esta OP al aprobarse en Calidad -- vacío = entra a stock general (estantería)">
              Destino
            </span>
            {canEditSpecs ? (
              <select
                className={sheetInput}
                value={headerDraft.clientId}
                onChange={(e) => {
                  setHeaderDraft((h) => ({ ...h, clientId: e.target.value }));
                  markDirty();
                }}
              >
                <option value="">Estantería (stock general)</option>
                {clients?.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    Cliente: {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-sm text-slate-800 dark:text-slate-100">
                {order.client?.name ? `Cliente: ${order.client.name}` : "Estantería (stock general)"}
              </span>
            )}
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel}>Referencia</span>
            <span className="text-sm text-slate-800 dark:text-slate-100">
              {order.product.name} ({order.product.sku})
            </span>
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel}>Medidas</span>
            <input
              className={sheetInput}
              value={headerDraft.measure}
              disabled={!canEditSpecs}
              onChange={(e) => {
                const value = e.target.value;
                setHeaderDraft((h) => ({ ...h, measure: value }));
                // El dueño pidió que si acá ponen "12x18", el primer número
                // (el ancho) se cargue solo en la casilla ANCHO de más abajo
                // — y en Sellado/Precorte, que también complete el par
                // Ancho/Largo de "Medidas finales" (mismo "12x18" = ancho x
                // largo del producto). No hace falta tipearlo varias veces;
                // sigue siendo editable a mano después, esto solo precarga.
                // Se limpian los 4 campos derivados ANTES de volver a
                // derivar -- si no, borrar/editar Medidas hasta un punto
                // donde ya no matchea el patrón (ej. "12x0.0000045" → "12x")
                // dejaba pegado para siempre el último valor derivado con
                // éxito, aunque el cuadro de Medidas ya no dijera eso.
                setSpecsDraft((prev) => ({
                  ...prev,
                  ancho: "",
                  calibre: "",
                  medAncho: "",
                  medLargo: "",
                  ...deriveSpecsFromMeasure(value),
                }));
                markDirty();
              }}
            />
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel}>Cantidad (kilos)</span>
            <input
              className={sheetInput}
              type="number"
              step="0.01"
              value={headerDraft.quantityPlanned}
              disabled={!canEditSpecs}
              onChange={(e) => {
                setHeaderDraft((h) => ({ ...h, quantityPlanned: e.target.value }));
                markDirty();
              }}
            />
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel}>Máquina</span>
            <input className={sheetInput} value={specsDraft.maquina ?? ""} disabled={!canEditSpecs} onChange={(e) => setSpec("maquina", e.target.value)} />
          </div>
          <div className={`${cellBorder} p-2`}>
            <span className={cellLabel} title="A cuántos kg (peso + desperdicio) avisar que la OP está por completarse. Vacío = default (90% de lo planificado).">
              Alertar a los (kg)
            </span>
            <input
              className={sheetInput}
              type="number"
              step="0.01"
              placeholder={plannedKg > 0 ? `def. ${Math.round(plannedKg * 0.9 * 100) / 100}` : "90% por defecto"}
              value={headerDraft.alertThresholdKg}
              disabled={!canEditSpecs}
              onChange={(e) => {
                setHeaderDraft((h) => ({ ...h, alertThresholdKg: e.target.value }));
                markDirty();
              }}
            />
          </div>
          {order.parent && (
            <div className={`${cellBorder} p-2`}>
              <span className={cellLabel}>Derivada de</span>
              <Link to={`/produccion/ordenes/${order.parent.id}`} className="text-sm text-sky-700 dark:text-sky-400 hover:underline">
                {order.parent.orderNumber} ({STATION_LABELS[order.parent.station as OpStation]})
              </Link>
            </div>
          )}
          {order.derivedOrders?.length > 0 && (
            <div className={`${cellBorder} p-2`}>
              <span className={cellLabel}>Deriva en</span>
              <span className="text-sm space-x-2">
                {order.derivedOrders.map((d: any) => (
                  <Link key={d.id} to={`/produccion/ordenes/${d.id}`} className="text-sky-700 dark:text-sky-400 hover:underline">
                    {d.orderNumber} ({STATION_LABELS[d.station as OpStation]})
                  </Link>
                ))}
              </span>
            </div>
          )}
        </div>

        {/* Materia prima (solo Extrusión): las 10 filas son fijas, en el
            mismo orden que el papel — no se agregan ni se quitan. Solo se
            tipea el Kg de cada insumo; el % se calcula solo como su parte
            del total de kg cargado (no se pide por separado, para que
            nunca quede desalineado con lo que realmente se descuenta del
            inventario de materia prima al cerrar la OP). */}
        {template.materiaPrimaRefs && (
          <>
            <SheetBand>Materia prima</SheetBand>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400">
                  <th className={`${cellBorder} px-2 py-1`}>Ref.</th>
                  <th className={`${cellBorder} px-2 py-1 w-24`}>%</th>
                  <th
                    className={`${cellBorder} px-2 py-1 w-28`}
                    title={mpBaseIsReal ? "Sobre lo producido real (peso + desperdicio): es lo que se descuenta al cerrar" : "Sobre la meta: se recalcula con lo producido real al cerrar"}
                  >
                    Kg {mpBaseIsReal ? "(real)" : "(meta)"}
                  </th>
                  <th className={`${cellBorder} px-2 py-1 w-32`}>Lote</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const totalPlanned = mpBaseKg;
                  return materiaPrima.map((row, i) => {
                    const pct = Number(row.pct) || 0;
                    const kg = totalPlanned > 0 ? Math.round(((pct / 100) * totalPlanned) * 100) / 100 : 0;
                    return (
                      <tr key={row.ref}>
                        <td className={`${cellBorder} px-2 py-1 font-medium`}>{row.ref}</td>
                        <td className={`${cellBorder} px-2 py-1`}>
                          <input
                            className={sheetInput}
                            type="number"
                            step="0.01"
                            value={row.pct}
                            disabled={!canEditSpecs}
                            onChange={(e) => {
                              const typed = e.target.value;
                              setMateriaPrima((prev) => {
                                // El total entre todas las refs no puede pasar
                                // de 100% — el pedido del cliente fue que se
                                // "bloquee" al completar el 100%, salvo que
                                // se borre/reduzca otra fila para liberar
                                // espacio. Se recorta acá en vez de con un
                                // input disabled porque esto último no deja
                                // reducir una fila para hacerle lugar a otra.
                                const othersTotal = prev.reduce((acc, r, idx) => (idx === i ? acc : acc + (Number(r.pct) || 0)), 0);
                                const room = Math.max(0, 100 - othersTotal);
                                const clamped = typed === "" ? "" : String(Math.min(Number(typed) || 0, room));
                                return prev.map((r, idx) => (idx === i ? { ...r, pct: clamped } : r));
                              });
                              markDirty();
                            }}
                          />
                        </td>
                        <td className={`${cellBorder} px-2 py-1 text-slate-500 dark:text-slate-400`}>{pct > 0 ? kg : "—"}</td>
                        <td className={`${cellBorder} px-2 py-1`}>
                          <input
                            className={sheetInput}
                            value={row.lote}
                            disabled={!canEditSpecs}
                            onChange={(e) => {
                              setMateriaPrima((prev) => prev.map((r, idx) => (idx === i ? { ...r, lote: e.target.value } : r)));
                              markDirty();
                            }}
                          />
                        </td>
                      </tr>
                    );
                  });
                })()}
                <tr className="font-semibold">
                  <td className={`${cellBorder} px-2 py-1`}>Total</td>
                  <td className={`${cellBorder} px-2 py-1`}>
                    {Math.round(materiaPrima.reduce((acc, r) => acc + (Number(r.pct) || 0), 0) * 100) / 100}%
                  </td>
                  <td className={`${cellBorder} px-2 py-1`}>
                    {(() => {
                      const totalPlanned = mpBaseKg;
                      const totalPct = materiaPrima.reduce((acc, r) => acc + (Number(r.pct) || 0), 0);
                      return totalPlanned > 0 ? Math.round(((totalPct / 100) * totalPlanned) * 100) / 100 : 0;
                    })()}
                  </td>
                  <td className={`${cellBorder} px-2 py-1`} />
                </tr>
                {materiaPrima.reduce((acc, r) => acc + (Number(r.pct) || 0), 0) >= 100 && (
                  <tr>
                    <td colSpan={4} className={`${cellBorder} px-2 py-1.5 text-center text-xs text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950`}>
                      Completaste el 100%. Si deseás añadir más, bajá los porcentajes de las demás refs.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}

        {canEditSpecs && <SuggestionSources items={specSuggestionItems} />}
        {canEditSpecs && !specSuggestions?.manual && (Object.keys(specsDraft).length > 0 || materiaPrima.some((r) => r.pct)) && (
          <div className="flex justify-end my-1">
            <button type="button" onClick={handleSaveSpecSuggestion} className="text-xs text-sky-700 dark:text-sky-400 hover:underline">
              Guardar lo actual como sugerencia
            </button>
          </div>
        )}

        {/* Secciones de specs de la estación */}
        {template.sections.map((section) => (
          <div key={section.title}>
            <SheetBand>{section.title}</SheetBand>
            <div className="grid grid-cols-2 sm:grid-cols-3">
              {section.fields.map((field) => {
                // "Material para" (a qué estación va a derivar) es el único
                // campo del encabezado que también edita el operario, no
                // solo Gestión — y se guarda solo al cambiarlo (ver
                // handleMaterialParaChange), no con el botón general.
                const isMaterialPara = field.key === "materialPara";
                // "Cantidad (kilos)"/"Cantidad (rollos)" son el pesaje real
                // de la OP de Extrusión padre (ver más arriba en este mismo
                // useEffect) — el cliente pidió que no se puedan tocar a
                // mano, ya que "corregirlas" acá las desconectaría del dato
                // real que ya quedó pesado y cerrado en la OP padre.
                const isParentDerivedTotal = (field.key === "cantidadKilos" || field.key === "cantidadRollos") && !!order.parent;
                const canEditThis = isMaterialPara ? canEditSpecs || canOperate : isParentDerivedTotal ? false : canEditSpecs;
                return (
                  <div key={field.key} className={`${cellBorder} p-2`}>
                    <span className={cellLabel}>{field.label}</span>
                    {field.kind === "options" ? (
                      (() => {
                        // Un valor guardado que no es ninguna de las opciones
                        // (texto libre viejo, ej. "Natural" en Color) antes se
                        // veía en blanco, como si el campo estuviera vacío. Se
                        // muestra tal cual, marcado, para que Gestión elija la
                        // opción correcta — el servidor ya no deja guardarlo así.
                        const current = specsDraft[field.key];
                        const invalid = current != null && current !== "" && !field.options!.includes(String(current));
                        return (
                          <select
                            className={`${sheetInput} ${invalid ? "text-red-600 dark:text-red-400 ring-1 ring-red-400" : ""}`}
                            value={current ?? ""}
                            disabled={!canEditThis}
                            title={invalid ? `"${current}" no es una opción válida de ${field.label} — elegí una de la lista` : undefined}
                            onChange={(e) => (isMaterialPara ? handleMaterialParaChange(e.target.value) : setSpec(field.key, e.target.value))}
                          >
                            <option value="">—</option>
                            {invalid && (
                              <option value={String(current)} disabled>
                                {String(current)} (no válido)
                              </option>
                            )}
                            {field.options!.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        );
                      })()
                    ) : (
                      <input
                        className={sheetInput}
                        type={field.kind === "number" ? "number" : "text"}
                        value={specsDraft[field.key] ?? ""}
                        disabled={!canEditThis}
                        title={isParentDerivedTotal ? "Es el pesaje real de la OP de Extrusión padre, no se puede editar acá" : undefined}
                        // El title no se ve en celular (touch, sin hover) — si
                        // encima el campo queda vacío (el padre todavía no
                        // tiene rollos pesados), el placeholder es la única
                        // pista visible de por qué está bloqueado y en blanco.
                        placeholder={isParentDerivedTotal ? "se completa con el pesaje del padre" : undefined}
                        onChange={(e) => setSpec(field.key, e.target.value)}
                      />
                    )}
                  </div>
                );
              })}
              {/* Mismo cuadro de "a dónde deriva" pero como acción directa,
                  al lado de "Material para" — exclusivo de Gestión, igual
                  que los botones "Derivar a..." de arriba (ver comentario). */}
              {section.fields.some((f) => f.key === "materialPara") && canGestion && derivations.length > 0 && (
                <div className={`${cellBorder} p-2`}>
                  <span className={cellLabel}>Derivar a</span>
                  <select
                    className={sheetInput}
                    value=""
                    onChange={(e) => {
                      const target = e.target.value as OpStation;
                      if (target) handleDerive(target);
                    }}
                  >
                    <option value="">—</option>
                    {derivations.map((target) => (
                      <option key={target} value={target}>
                        {STATION_LABELS[target]}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>
        ))}

        {/* Orden de <estación padre> / Orden <esta estación> (solo Sellado):
            kilos y rollos/bultos/desperdicio calculados de los rollos reales
            cargados, no texto libre — Unid. es el único campo manual. */}
        {template.ordenReferencia && (
          <>
            <SheetBand>
              {order.parent ? `Orden de ${STATION_LABELS[order.parent.station as OpStation]}` : "Orden de la OP padre"}
            </SheetBand>
            <div className="grid grid-cols-2 sm:grid-cols-3">
              {order.parent ? (
                <>
                  <div className={`${cellBorder} p-2`}>
                    <span className={cellLabel}>OP</span>
                    <Link to={`/produccion/ordenes/${order.parent.id}`} className="text-sm text-sky-700 dark:text-sky-400 hover:underline">
                      {order.parent.orderNumber}
                    </Link>
                  </div>
                  <div className={`${cellBorder} p-2`}>
                    <span className={cellLabel}>Kilos</span>
                    <span className="text-sm text-slate-800 dark:text-slate-100">
                      {Math.round((order.parent.rolls ?? []).reduce((acc: number, r: any) => acc + Number(r.weightKg), 0) * 100) / 100} kg
                    </span>
                  </div>
                  <div className={`${cellBorder} p-2`}>
                    <span className={cellLabel}>Rollos</span>
                    <span className="text-sm text-slate-800 dark:text-slate-100">{(order.parent.rolls ?? []).length}</span>
                  </div>
                </>
              ) : (
                <div className={`${cellBorder} p-2 sm:col-span-3`}>
                  <span className="text-sm text-slate-500 dark:text-slate-400">Esta OP no deriva de ninguna otra.</span>
                </div>
              )}
            </div>

            <SheetBand>Orden {STATION_LABELS[station].toUpperCase()}</SheetBand>
            <div className="grid grid-cols-2 sm:grid-cols-3">
              <div className={`${cellBorder} p-2`}>
                <span className={cellLabel}>Kilos</span>
                <span className="text-sm text-slate-800 dark:text-slate-100">{Math.round(totalKg * 100) / 100} kg</span>
              </div>
              <div className={`${cellBorder} p-2`}>
                <span className={cellLabel}>Bultos</span>
                <span className="text-sm text-slate-800 dark:text-slate-100">{order.rolls.length}</span>
              </div>
              {template.ordenReferenciaUnidField && (
                <div className={`${cellBorder} p-2`}>
                  <span className={cellLabel}>{template.ordenReferenciaUnidField.label}</span>
                  <input
                    className={sheetInput}
                    type="number"
                    value={specsDraft[template.ordenReferenciaUnidField.key] ?? ""}
                    disabled={!canEditSpecs}
                    onChange={(e) => setSpec(template.ordenReferenciaUnidField!.key, e.target.value)}
                  />
                </div>
              )}
              <div className={`${cellBorder} p-2`}>
                <span className={cellLabel}>Despr.</span>
                <span className="text-sm text-slate-800 dark:text-slate-100">{Math.round(totalWaste * 100) / 100} kg</span>
              </div>
            </div>
          </>
        )}

        {/* Colores cara 1/2 (solo Impresión) */}
        {template.colores &&
          ([1, 2] as const).map((cara) => {
            const key = `cara${cara}` as "cara1" | "cara2";
            const rows = colores[key];
            if (!canEditSpecs && rows.length === 0) return null;
            return (
              <div key={cara}>
                <SheetBand>Colores cara {cara}</SheetBand>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[10px] uppercase text-slate-500 dark:text-slate-400">
                      <th className={`${cellBorder} px-2 py-1 w-24`}>Unidad</th>
                      <th className={`${cellBorder} px-2 py-1`}>Color</th>
                      <th className={`${cellBorder} px-2 py-1 w-32`}>Lote</th>
                      {canEditSpecs && <th className={`${cellBorder} px-2 py-1 w-10`} />}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i}>
                        {(["unidad", "color", "lote"] as const).map((fieldKey) => (
                          <td key={fieldKey} className={`${cellBorder} px-2 py-1`}>
                            <input
                              className={sheetInput}
                              value={row[fieldKey]}
                              disabled={!canEditSpecs}
                              onChange={(e) => {
                                setColores((prev) => ({
                                  ...prev,
                                  [key]: prev[key].map((r, idx) => (idx === i ? { ...r, [fieldKey]: e.target.value } : r)),
                                }));
                                markDirty();
                              }}
                            />
                          </td>
                        ))}
                        {canEditSpecs && (
                          <td className={`${cellBorder} px-2 py-1 text-center`}>
                            <button
                              type="button"
                              className="text-red-600 dark:text-red-400"
                              onClick={() => {
                                setColores((prev) => ({ ...prev, [key]: prev[key].filter((_, idx) => idx !== i) }));
                                markDirty();
                              }}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {canEditSpecs && (
                  <button
                    type="button"
                    className="text-xs text-sky-700 dark:text-sky-400 hover:underline px-3 py-1.5"
                    onClick={() => setColores((prev) => ({ ...prev, [key]: [...prev[key], { unidad: String(prev[key].length + 1), color: "", lote: "" }] }))}
                  >
                    + Agregar color
                  </button>
                )}
              </div>
            );
          })}

        {canEditSpecs && dirty && (
          <div className="p-3 border-t border-slate-300 dark:border-slate-600 bg-amber-50 dark:bg-amber-950 flex items-center justify-between gap-2">
            <p className="text-xs text-amber-700 dark:text-amber-400">Hay cambios sin guardar en el encabezado.</p>
            <button type="button" onClick={handleSaveSpecs} className="bg-slate-800 text-white text-sm px-4 py-1.5 rounded">
              Guardar cambios
            </button>
          </div>
        )}

        {/* Qué rollos de la OP padre hay YA en la bodega de esta estación (y
            cuáles vienen en camino): el operario sabe cuál buscar sin ir a
            Inventario de bodegas. Solo informativo — igual se escanea. */}
        {order.parent && isOpen && (canOperate || canGestion) && (order.availableSourceRolls ?? []).length > 0 && (
          <div className="p-3 border-t border-slate-300 dark:border-slate-600 bg-sky-50 dark:bg-slate-800 text-sm">
            <p className="font-medium text-slate-700 dark:text-slate-200">
              Rollos de {order.parent.orderNumber} ({STATION_LABELS[order.parent.station as OpStation]}) para esta orden
            </p>
            <ul className="mt-1 flex flex-wrap gap-2">
              {(order.availableSourceRolls as AvailableSourceRoll[]).map((r) => (
                <li
                  key={r.id}
                  className={`rounded border px-2 py-1 text-xs ${
                    r.status === "en_bodega"
                      ? "border-emerald-300 dark:border-emerald-700 text-emerald-800 dark:text-emerald-300 bg-white dark:bg-slate-900"
                      : "border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 bg-white dark:bg-slate-900"
                  }`}
                >
                  <strong>{r.code}</strong> · {r.remainingKg} kg
                  {r.status === "en_bodega" ? (canOperate ? " · en tu bodega" : " · en la bodega") : ` · en camino (lo lleva ${r.carrierName})`}
                </li>
              ))}
            </ul>
            {canOperate && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Escaneá el QR del rollo que vayas a montar al cargar la fila.</p>}
          </div>
        )}

        {/* Tabla real solo en escritorio, con scroll propio (la más ancha,
            hasta 11 columnas en Extrusión) en vez de para toda la hoja — así
            el resto de las secciones se ven enteras sin deslizar. En celular
            se reemplaza por tarjetas de verdad más abajo (md:hidden) — un
            intento anterior con un truco de CSS (pseudo-elemento con el
            nombre de columna) no se renderizaba bien en algunos navegadores
            de celular, mostraba etiquetas y valores por separado. */}
        <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="text-left text-[9px] sm:text-[10px] uppercase text-slate-500 dark:text-slate-400">
              {template.rollColumns.map((col) => (
                <th key={col.detailKey ?? col.source} className={`${cellBorder} px-1.5 py-1`}>
                  {col.label}
                </th>
              ))}
              {canOperate && <th className={`${cellBorder} px-1.5 py-1 w-14`} />}
            </tr>
          </thead>
          <tbody>
            {order.rolls.map((roll: any, i: number) => (
              <Fragment key={roll.id}>
                <tr>
                  {template.rollColumns.map((col) => (
                    <td key={col.detailKey ?? col.source} className={`${cellBorder} px-1.5 py-1 text-slate-800 dark:text-slate-100`}>
                      {rollCellDisplay(roll, col, rollCumulative[i])}
                    </td>
                  ))}
                  {canOperate && (
                    <td className={`${cellBorder} px-1.5 py-1 text-center whitespace-nowrap`}>
                      {canGestion && (
                        <button
                          type="button"
                          className="text-slate-500 dark:text-slate-400"
                          title="Reemitir etiqueta (invalida la anterior)"
                          onClick={() => handleReissueLabel(roll.id, `${ROLL_CODE_PREFIX[station]}-${roll.stationSequence}`)}
                        >
                          <RotateCcw size={13} aria-hidden="true" />
                        </button>
                      )}
                      {canGestion && isOpen && (
                        <button type="button" className="text-red-600 dark:text-red-400 ml-1.5" title="Borrar rollo" onClick={() => handleDeleteRoll(roll.id)}>
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
                {roll.sourceRoll && (
                  <tr className="bg-slate-50 dark:bg-slate-800/60">
                    <td
                      colSpan={template.rollColumns.length + (canOperate ? 1 : 0)}
                      className={`${cellBorder} px-1.5 py-0.5 text-[10px] text-slate-500 dark:text-slate-400`}
                    >
                      Insumo: rollo {sourceRollLabel(roll.sourceRoll)} ({Number(roll.sourceRoll.weightKg)} kg) — escaneado por{" "}
                      {roll.createdBy?.name ?? roll.operatorName}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {order.rolls.length === 0 && (
              <tr>
                <td className={`${cellBorder} px-2 py-3 text-center text-slate-500 dark:text-slate-400`} colSpan={template.rollColumns.length + (canOperate ? 1 : 0)}>
                  Sin rollos registrados todavía.
                </td>
              </tr>
            )}
            {/* Rollos ya completados en el formulario pero sin confirmar
                todavía (ver pendingRolls) — se pueden editar (recargan el
                formulario) o borrar de la lista libremente, todavía no
                tocaron el servidor. */}
            {pendingRolls.map((pending, i) => (
              <tr key={pending.localId} className="bg-amber-50 dark:bg-amber-950/40">
                <td className={`${cellBorder} px-1.5 py-1 text-amber-800 dark:text-amber-300 font-medium`} colSpan={Math.max(1, template.rollColumns.length - 2)}>
                  Fila {i + 1} por confirmar · Peso {Number(pending.body.weightKg)} kg
                  {pending.body.wasteKg ? ` · Desp. ${Number(pending.body.wasteKg)} kg` : ""}
                </td>
                <td className={`${cellBorder} px-1.5 py-1 text-amber-700 dark:text-amber-400`} colSpan={2}>
                  Sin confirmar
                </td>
                <td className={`${cellBorder} px-1 py-1 text-center whitespace-nowrap`}>
                  <button type="button" onClick={() => handleEditPendingRoll(pending.localId)} title="Editar" className="text-slate-600 dark:text-slate-300">
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => handleDeletePendingRoll(pending.localId)} title="Quitar de la lista" className="text-red-600 dark:text-red-400 ml-1.5">
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
            {/* Fila de carga inline */}
            {canOperate && isOpen && !isQuantityComplete && (
              <tr className="bg-sky-50 dark:bg-slate-800">
                {template.rollColumns.map((col) => {
                  const { content, className, title } = draftCellContent(col);
                  return (
                    <td
                      key={col.detailKey ?? col.source}
                      className={`${cellBorder} ${className ? "px-1.5 py-1" : "px-1 py-1"} ${className}`}
                      title={title}
                    >
                      {content}
                    </td>
                  );
                })}
                <td className={`${cellBorder} px-1 py-1`}>
                  <button type="button" onClick={handleQueueRoll} title="Añadir rollo a la lista" className="bg-slate-800 text-white text-xs px-2 py-1 rounded whitespace-nowrap">
                    +
                  </button>
                </td>
              </tr>
            )}
            {canOperate && pendingRolls.length > 0 && (
              <tr>
                <td className={`${cellBorder} px-1.5 py-1`} colSpan={template.rollColumns.length + 1}>
                  <button
                    type="button"
                    onClick={handleConfirmPendingRolls}
                    disabled={confirmingPending}
                    title="Después de confirmar ya no vas a poder editar los rollos, solo borrarlos"
                    className="inline-flex items-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-medium px-3 py-1.5 rounded disabled:opacity-60"
                  >
                    <Check size={13} aria-hidden="true" /> {confirmingPending ? "Confirmando..." : `Confirmar ${pendingRolls.length} rollo${pendingRolls.length === 1 ? "" : "s"}`}
                  </button>
                </td>
              </tr>
            )}
            {canOperate && isOpen && isQuantityComplete && (
              <tr>
                <td
                  className={`${cellBorder} px-2 py-2 text-center text-emerald-700 dark:text-emerald-400 text-xs font-medium`}
                  colSpan={template.rollColumns.length + (canOperate ? 1 : 0)}
                >
                  Ya se completaron los {plannedKg} kg planificados (peso + desperdicio) — no se pueden cargar más rollos.
                </td>
              </tr>
            )}
            {/* Totales */}
            <tr className="font-semibold bg-slate-100 dark:bg-slate-800">
              <td className={`${cellBorder} px-1.5 py-1`} colSpan={Math.max(1, template.rollColumns.length - 2)}>
                Total · {order.rolls.length} rollos · {Math.round(totalKg * 100) / 100} kg producidos
              </td>
              <td className={`${cellBorder} px-1.5 py-1`}>
                {plannedKg > 0 ? (
                  <span className={isQuantityComplete ? "text-emerald-600 dark:text-emerald-400" : ""}>
                    {isQuantityComplete ? "Completado" : `Restan ${remainingKg} kg`}
                  </span>
                ) : (
                  `${Math.round(totalKg * 100) / 100} kg`
                )}
              </td>
              <td className={`${cellBorder} px-1.5 py-1`} colSpan={canOperate ? 2 : 1}>
                Desp. {Math.round(totalWaste * 100) / 100} kg
              </td>
            </tr>
          </tbody>
        </table>
        </div>

        {/* Tarjetas en celular: cada rollo es una tarjeta con pares
            "etiqueta: valor" en HTML real (no un truco de CSS) — más
            confiable entre navegadores que el pseudo-elemento que se probó
            antes. */}
        <div className="md:hidden space-y-2 p-2">
          {order.rolls.map((roll: any, i: number) => (
            <div key={roll.id} className="border border-slate-300 dark:border-slate-600 rounded-lg overflow-hidden">
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {template.rollColumns.map((col) => (
                  <div key={col.detailKey ?? col.source} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                    <span className="uppercase tracking-wide text-slate-500 dark:text-slate-400 shrink-0">{col.label}</span>
                    <span className="text-slate-800 dark:text-slate-100 text-right">{rollCellDisplay(roll, col, rollCumulative[i])}</span>
                  </div>
                ))}
                {canOperate && (
                  <div className="flex items-center justify-end gap-3 px-3 py-1.5">
                    {canGestion && (
                      <button
                        type="button"
                        className="text-slate-500 dark:text-slate-400"
                        title="Reemitir etiqueta (invalida la anterior)"
                        onClick={() => handleReissueLabel(roll.id, `${ROLL_CODE_PREFIX[station]}-${roll.stationSequence}`)}
                      >
                        <RotateCcw size={15} aria-hidden="true" />
                      </button>
                    )}
                    {canGestion && isOpen && (
                      <button type="button" className="text-red-600 dark:text-red-400" title="Borrar rollo" onClick={() => handleDeleteRoll(roll.id)}>
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                )}
              </div>
              {roll.sourceRoll && (
                <div className="bg-slate-50 dark:bg-slate-800/60 px-3 py-1.5 text-[10px] text-slate-500 dark:text-slate-400 border-t border-slate-200 dark:border-slate-700">
                  Insumo: rollo {sourceRollLabel(roll.sourceRoll)} ({Number(roll.sourceRoll.weightKg)} kg) — escaneado por{" "}
                  {roll.createdBy?.name ?? roll.operatorName}
                </div>
              )}
            </div>
          ))}

          {order.rolls.length === 0 && (
            <p className="text-center text-slate-500 dark:text-slate-400 text-sm py-3">Sin rollos registrados todavía.</p>
          )}

          {/* Rollos completados en el formulario pero todavía sin confirmar
              (ver pendingRolls) — editables/borrables libres de la lista. */}
          {pendingRolls.map((pending, i) => (
            <div key={pending.localId} className="border-2 border-amber-300 dark:border-amber-700 rounded-lg overflow-hidden bg-amber-50 dark:bg-amber-950/40">
              <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="text-amber-800 dark:text-amber-300 font-medium">
                  Fila {i + 1} por confirmar · Peso {Number(pending.body.weightKg)} kg
                  {pending.body.wasteKg ? ` · Desp. ${Number(pending.body.wasteKg)} kg` : ""}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <button type="button" onClick={() => handleEditPendingRoll(pending.localId)} title="Editar">
                    <Pencil size={15} className="text-slate-600 dark:text-slate-300" aria-hidden="true" />
                  </button>
                  <button type="button" onClick={() => handleDeletePendingRoll(pending.localId)} title="Quitar de la lista">
                    <Trash2 size={15} className="text-red-600 dark:text-red-400" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          ))}

          {canOperate && isOpen && !isQuantityComplete && (
            <div className="border-2 border-sky-300 dark:border-sky-700 rounded-lg overflow-hidden bg-sky-50 dark:bg-slate-800">
              <div className="divide-y divide-sky-200 dark:divide-slate-700">
                {template.rollColumns.map((col) => {
                  const { content, className, title, editable } = draftCellContent(col);
                  return (
                    <div
                      key={col.detailKey ?? col.source}
                      className={`flex items-center justify-between gap-3 px-3 py-2 text-xs ${editable ? "bg-white dark:bg-slate-900" : ""}`}
                      title={title}
                    >
                      <span className="uppercase tracking-wide text-slate-500 dark:text-slate-400 shrink-0 inline-flex items-center gap-1">
                        {!editable && <Lock size={10} aria-hidden="true" className="text-slate-400 dark:text-slate-500" />}
                        {col.label}
                      </span>
                      {editable ? (
                        // Campo de verdad tocable: fondo blanco + borde
                        // visible (ver `draftInput`) para que se note sin
                        // tener que tocarlo primero — antes usaba el mismo
                        // estilo "hoja de papel" transparente que el resto de
                        // la pantalla, y en celular no se distinguía de una
                        // celda de solo lectura.
                        <div className="flex-1 flex justify-end">{content}</div>
                      ) : (
                        <span className={className}>{content}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={handleQueueRoll}
                className="w-full inline-flex items-center justify-center gap-1.5 bg-slate-800 text-white text-sm font-medium px-3 py-2.5"
              >
                + Añadir rollo
              </button>
            </div>
          )}

          {canOperate && pendingRolls.length > 0 && (
            <button
              type="button"
              onClick={handleConfirmPendingRolls}
              disabled={confirmingPending}
              title="Después de confirmar ya no vas a poder editar los rollos, solo borrarlos"
              className="w-full inline-flex items-center justify-center gap-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium px-3 py-2.5 rounded-lg disabled:opacity-60"
            >
              <Check size={15} aria-hidden="true" /> {confirmingPending ? "Confirmando..." : `Confirmar ${pendingRolls.length} rollo${pendingRolls.length === 1 ? "" : "s"}`}
            </button>
          )}

          {canOperate && isOpen && isQuantityComplete && (
            <p className="text-center text-emerald-700 dark:text-emerald-400 text-xs font-medium py-2">
              Ya se completaron los {plannedKg} kg planificados (peso + desperdicio) — no se pueden cargar más rollos.
            </p>
          )}

          <div className="border border-slate-300 dark:border-slate-600 rounded-lg bg-slate-100 dark:bg-slate-800 px-3 py-2 text-xs font-semibold space-y-0.5">
            <p>
              Total · {order.rolls.length} rollos · {Math.round(totalKg * 100) / 100} kg producidos
            </p>
            <p>
              {plannedKg > 0 ? (
                <span className={isQuantityComplete ? "text-emerald-600 dark:text-emerald-400" : ""}>
                  {isQuantityComplete ? "Completado" : `Restan ${remainingKg} kg`}
                </span>
              ) : (
                `${Math.round(totalKg * 100) / 100} kg`
              )}
              {" · "}Desp. {Math.round(totalWaste * 100) / 100} kg
            </p>
          </div>
        </div>

        {/* Notas / Observaciones — Sellado las tiene como dos cuadros
            separados en el papel; el resto solo tiene "Observaciones:". */}
        {template.ordenReferencia && (
          <div className={`${cellBorder} p-0`}>
            <SheetBand>Notas</SheetBand>
            <textarea
              className={`${sheetInput} p-2 min-h-16 resize-y`}
              value={headerDraft.notes}
              disabled={!canEditSpecs}
              onChange={(e) => {
                setHeaderDraft((h) => ({ ...h, notes: e.target.value }));
                markDirty();
              }}
            />
          </div>
        )}
        <div className={`${cellBorder} p-0`}>
          <SheetBand>Observaciones</SheetBand>
          <textarea
            className={`${sheetInput} p-2 min-h-16 resize-y`}
            value={specsDraft.observaciones ?? ""}
            disabled={!canEditSpecs}
            onChange={(e) => setSpec("observaciones", e.target.value)}
          />
        </div>

        {/* Resultado de calidad, si ya pasó */}
        {order.qualityCheck && (
          <div
            className={`px-3 py-2 text-sm border-t border-slate-300 dark:border-slate-600 max-w-[80vw] break-words ${
              order.qualityCheck.result === "aprobado"
                ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"
                : "bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-400"
            }`}
          >
            Calidad: <strong>{order.qualityCheck.result}</strong>
            {order.qualityCheck.observations && <> — {order.qualityCheck.observations}</>}
            {order.qualityCheck.createdBy?.name && <> · {order.qualityCheck.createdBy.name}</>}
          </div>
        )}
      </div>

      {/* Adjuntos */}
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow p-4 space-y-3">
        <p className="text-sm font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-1.5">
          <Paperclip size={14} aria-hidden="true" /> Adjuntos
        </p>
        <ul className="divide-y divide-slate-100 dark:divide-slate-700">
          {order.attachments?.map((a: any) => (
            <li key={a.id} className="py-2 flex items-center justify-between text-sm">
              <span className="text-slate-800 dark:text-slate-100">
                {a.originalName}{" "}
                <span className="text-xs text-slate-500 dark:text-slate-400">({Math.round(a.sizeBytes / 1024)} KB)</span>
              </span>
              <span className="flex items-center gap-3">
                <button
                  onClick={() => api.downloadProductionOrderAttachment(orderId, a.id, a.originalName)}
                  className="text-sky-700 dark:text-sky-400 text-xs hover:underline"
                >
                  Descargar
                </button>
                {canGestion && (
                  <button onClick={() => handleDeleteAttachment(a.id)} className="text-red-600 dark:text-red-400 text-xs hover:underline">
                    Borrar
                  </button>
                )}
              </span>
            </li>
          ))}
          {(!order.attachments || order.attachments.length === 0) && (
            <p className="text-slate-500 dark:text-slate-400 text-sm py-1">Sin adjuntos todavía.</p>
          )}
        </ul>
        {canOperate && (
          <div className="flex gap-2 items-center border-t border-slate-100 dark:border-slate-700 pt-3">
            <input ref={fileInputRef} type="file" className="text-sm dark:bg-slate-800 dark:text-slate-100" />
            <button onClick={handleUploadAttachment} className="bg-slate-800 text-white text-sm px-4 py-2 rounded">
              Subir
            </button>
          </div>
        )}
      </div>

      {/* Botón flotante de escaneo (ScanDock): reemplaza los avisos fijos que
          antes ocupaban una banda entera de la hoja ("Registro de rollos /
          avance") por un botón minimalista abajo a la derecha. Lo ya
          escaneado aparece arriba del botón como una notificación chica;
          las explicaciones largas quedan en el tooltip de cada opción. */}
      {(() => {
        const hasAnyScan = hasScannedSourceRoll || hasScannedBultoLabel;
        // Contenido completo del aviso — igual en celular y PC, la única
        // diferencia entre medios es CUÁNDO se ve entero (ver más abajo).
        const fullNotifications = (
          <>
            {hasScannedSourceRoll &&
              sourceRolls.map((roll, i) => (
                <div
                  key={roll.id}
                  className="animate-toast-in flex items-center gap-2 max-w-[min(90vw,20rem)] text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 rounded-lg shadow-lg px-3 py-2"
                >
                  <ScanLine size={13} aria-hidden="true" className="shrink-0" />
                  <span>
                    {template.consumesSourceByWeight ? (i === 0 ? "Rollo madre: " : "Sigue con: ") : "Rollo de origen: "}
                    <strong>{roll.code}</strong>{" "}
                    {template.consumesSourceByWeight ? (
                      <>
                        · quedan <strong>{roll.remainingKg} kg</strong> de {roll.weightKg}
                      </>
                    ) : (
                      <>({roll.weightKg} kg)</>
                    )}
                    {roll.createdByName && <> · producido por {roll.createdByName}</>}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleClearSourceRoll(roll.id)}
                    title="Quitar"
                    className="shrink-0 text-emerald-700 dark:text-emerald-400"
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            {hasScannedSourceRoll && template.consumesSourceByWeight && Number(rollDraft.weight) > 0 && (
              <div className="animate-toast-in text-[10px] bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg shadow-lg px-3 py-1.5 text-slate-600 dark:text-slate-300">
                <SourceAllocationHint rolls={sourceRolls} weightKg={rowConsumedKg(rollDraft.weight, rollDraft.waste)} />
              </div>
            )}
            {hasScannedBultoLabel && bultoLabel && (
              <div className="animate-toast-in flex items-center gap-2 text-xs bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 rounded-lg shadow-lg px-3 py-2">
                <ScanLine size={13} aria-hidden="true" className="shrink-0" />
                <span>
                  Etiqueta de bulto: <strong>{bultoLabel.code}</strong>
                </span>
                <button
                  type="button"
                  onClick={() => setBultoLabel(null)}
                  title="Quitar"
                  className="shrink-0 text-emerald-700 dark:text-emerald-400"
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            )}
          </>
        );
        return (
          <>
            {/* Celular: notificación fija ARRIBA, estilo push notification,
                visible todo el tiempo que el rollo/etiqueta sigan
                seleccionados — sin ningún toque de más para verla. Arriba y
                no junto al botón porque en una pantalla chica ahí abajo no
                hay lugar de sobra sin tapar los campos de la fila que se
                está llenando. */}
            {hasAnyScan && <div className="md:hidden fixed top-2 inset-x-2 z-50 flex flex-col gap-2">{fullNotifications}</div>}

            <div className="fixed bottom-5 right-4 z-40 flex flex-col items-end gap-2">
              {/* PC: el mismo aviso, siempre entero, junto al botón — hay
                  pantalla de sobra y no tapa ninguna fila de la tabla. */}
              {hasAnyScan && <div className="hidden md:flex md:flex-col md:items-end md:gap-2">{fullNotifications}</div>}

              {(canScanSourceRoll || canScanBultoLabel) && (
                <button
                  type="button"
                  onClick={() => setScanning(true)}
                  title={
                    canScanSourceRoll && canScanBultoLabel
                      ? "Escanear: detecta sola si es un rollo madre o una etiqueta de bulto"
                      : canScanSourceRoll
                        ? template.consumesSourceByWeight
                          ? "Escaneá el rollo grande que montaste: cada fila le descuenta los kilos que sacás. Si se acaba a mitad de un rollo, escaneá el siguiente y el resto sale de ahí."
                          : "Escaneá el QR pegado al rollo que estás tomando como insumo"
                        : "Etiqueta de bulto opcional — si el bulto es propio no hace falta, se identifica solo. Si viene de un lote comprado afuera, escaneá su etiqueta."
                  }
                  className="flex items-center justify-center w-12 h-12 rounded-full bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 shadow-lg hover:opacity-90"
                >
                  <ScanLine size={20} aria-hidden="true" />
                </button>
              )}
            </div>
          </>
        );
      })()}

      {scanning && <BarcodeScanner title="Escanear código" onDetected={handleScanAny} onClose={() => setScanning(false)} />}
    </div>
  );
}
