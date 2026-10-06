const API_BASE = "/api";

/** Error de una respuesta no-OK de la API, con el status HTTP adjunto —
 * a diferencia de un `Error` plano, deja distinguir un 404 real ("no
 * existe") de otro código (401/500) sin depender del texto del mensaje.
 * Hace falta, por ejemplo, para probar un código escaneado contra más de
 * un endpoint e ir al siguiente solo si el anterior dio 404. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function getToken() {
  return localStorage.getItem("token");
}

/**
 * `body.error` de un 4xx es un string simple (la mayoría de los handlers)
 * o el objeto de `z.SafeParseError.error.flatten()` (mensajes/campos
 * inválidos). Antes esto se mandaba siempre por `JSON.stringify`, así que
 * un string simple le llegaba al usuario CON comillas ("Esta OP ya no está
 * abierta") y cada pantalla tenía que hacer su propio `JSON.parse` para
 * mostrar el mensaje real. Ahora queda ya legible acá, una sola vez.
 */
function formatApiError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const flat = error as { formErrors?: string[]; fieldErrors?: Record<string, string[] | undefined> };
    const messages = [
      ...(flat.formErrors ?? []),
      ...Object.values(flat.fieldErrors ?? {}).flatMap((m) => m ?? []),
    ];
    if (messages.length > 0) return messages.join(" — ");
  }
  return null;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    // El token guardado quedó vencido/inválido (ej. la sesión sigue abierta
    // en el navegador de un día para otro) — sin esto, cada pantalla se
    // queda con los datos vacíos en silencio (cada useQuery falla y no hay
    // nada que muestre el error) y parece que "no carga nada" hasta que
    // alguien cierra sesión a mano y vuelve a entrar. Se limpia la sesión
    // vieja y se manda al login directo. Solo aplica si HABÍA un token (una
    // contraseña incorrecta en el login en sí también da 401, pero ahí
    // nunca se mandó Authorization — no hay que tocar esa pantalla).
    if (res.status === 401 && token) {
      localStorage.removeItem("token");
      localStorage.removeItem("user");
      if (!window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }
    const body = await res.json().catch(() => ({}));
    throw new ApiError(formatApiError(body.error) ?? `Error ${res.status}`, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json();
}

export type ProductionStation = "extrusion" | "impresion" | "sellado" | "precorte";

/** Despacho de un rollo a la bodega de otra estación (ver RollTransfer en
 * server/prisma/schema.prisma). `createdAt`/`receivedAt` son hora del
 * servidor; `clientTimezone`/`receivedTimezone`, la zona horaria del
 * celular que escaneó cada paso. */
export interface RollTransfer {
  id: number;
  rollId: number;
  rollCode: string;
  fromStation: ProductionStation;
  toStation: ProductionStation;
  mode: "entrega" | "retiro";
  carrierName: string;
  registeredBy: { name: string };
  clientTimezone: string;
  clientUtcOffsetMinutes: number;
  notes: string | null;
  createdAt: string;
  /** Saldo del rollo al despachar (lo pone el servidor). Null en despachos viejos. */
  dispatchedKg: string | null;
  status: "en_transito" | "recibido";
  receivedBy: { name: string } | null;
  receivedAt: string | null;
  receivedTimezone: string | null;
  receivedUtcOffsetMinutes: number | null;
  /** Peso que midió la bodega destino al recibir (opcional). */
  receivedKg: string | null;
  roll: {
    id: number;
    station: ProductionStation;
    stationSequence: number;
    weightKg: string;
    productionOrder: { id: number; orderNumber: string; product: { name: string; sku: string } };
  };
}

/** Rollo con saldo en una bodega de planta (ver GET /roll-transfers/inventory). */
export interface WarehouseRoll {
  rollId: number;
  code: string;
  label: string | null;
  weightKg: number;
  remainingKg: number;
  productionOrder: { id: number; orderNumber: string; product: { name: string; sku: string } };
  lastCount: { createdAt: string; newKg: string; createdBy: { name: string } } | null;
  since: string;
  days: number;
  stale: boolean;
  /** Estaciones con OP derivada abierta de su OP que lo están esperando. */
  pendingTo: ProductionStation[];
}

export interface InTransitRoll extends Omit<WarehouseRoll, "days" | "stale" | "pendingTo"> {
  transferId: number;
  fromStation: ProductionStation;
  toStation: ProductionStation;
  carrierName: string;
  hours: number;
  /** Más de staleTransitHours en camino: nadie lo recibió. */
  stale: boolean;
  dispatchedKg: number | null;
}

export interface WarehouseInventory {
  staleDays: number;
  staleTransitHours: number;
  warehouses: {
    station: ProductionStation;
    label: string;
    rollCount: number;
    totalKg: number;
    staleCount: number;
    inTransitCount: number;
    staleTransitCount: number;
    inTransitKg: number;
    items: WarehouseRoll[];
  }[];
  inTransit: InTransitRoll[];
}

export interface RollTransferScan {
  roll: {
    id: number;
    code: string;
    station: ProductionStation;
    stationSequence: number;
    weightKg: string;
    remainingKg: number;
    operatorName: string;
    date: string;
    productionOrder: { id: number; orderNumber: string; product: { name: string; sku: string } };
  };
  destinations: ProductionStation[];
  /** Destinos con OP derivada abierta esperando material de la OP del rollo. */
  expectingStations: ProductionStation[];
  /** "Material para" de la OP del rollo, como estación. */
  materialPara: ProductionStation | null;
  openTransfer: RollTransfer | null;
  lastTransfer: RollTransfer | null;
}

export const api = {
  login: (email: string, password: string, totpToken?: string) =>
    request<{
      token?: string;
      requires2fa?: boolean;
      user?: { id: number; name: string; role: string; email: string; twoFactorEnabled: boolean };
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, totpToken }),
    }),
  getMe: () => request<{ id: number; name: string; email: string; role: string; twoFactorEnabled: boolean }>("/auth/me"),

  forgotPassword: (email: string) =>
    request<{ message: string }>("/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ message: string }>("/auth/reset-password", { method: "POST", body: JSON.stringify({ token, newPassword }) }),

  setup2fa: () => request<{ qrCodeDataUrl: string; secret: string }>("/auth/2fa/setup", { method: "POST" }),
  verify2fa: (token: string) => request<{ ok: boolean }>("/auth/2fa/verify", { method: "POST", body: JSON.stringify({ token }) }),
  disable2fa: (token: string) => request<{ ok: boolean }>("/auth/2fa/disable", { method: "POST", body: JSON.stringify({ token }) }),

  getInventory: (category?: string) => request<any[]>(`/inventory${category ? `?category=${category}` : ""}`),
  getAlerts: () => request<any[]>("/inventory/alerts"),
  getProducts: () => request<any[]>("/inventory/products"),

  /** Catálogo completo (incluye inactivos) para la pantalla de gestión de
   * Productos — distinto de getProducts(), que es el selector filtrado a
   * activos usado como dropdown en Cotizaciones/Facturas/OPs/Pedidos. */
  getAllProducts: () => request<any[]>("/products"),
  createProduct: (data: {
    name: string;
    category: string;
    measure?: string;
    measureUnit?: string;
    talla?: string;
    color?: string;
    densidad?: string;
    medidaRef?: string;
    calibre?: string;
    unit: string;
    minStock: number;
    unitPrice: number;
  }) => request<any>("/products", { method: "POST", body: JSON.stringify(data) }),
  updateProduct: (
    productId: number,
    data: Partial<{
      name: string;
      category: string;
      measure?: string;
      measureUnit?: string;
      talla?: string;
      color?: string;
      densidad?: string;
      medidaRef?: string;
      calibre?: string;
      unit: string;
      minStock: number;
      unitPrice: number;
    }>
  ) => request<any>(`/products/${productId}`, { method: "PATCH", body: JSON.stringify(data) }),
  deactivateProduct: (productId: number) => request<any>(`/products/${productId}`, { method: "DELETE" }),
  reactivateProduct: (productId: number) => request<any>(`/products/${productId}/reactivate`, { method: "POST" }),

  getRawMaterials: () => request<any[]>("/raw-materials"),
  getRawMaterialStock: () => request<any[]>("/raw-materials/stock"),
  getRawMaterialAlerts: () => request<any[]>("/raw-materials/alerts"),
  getRawMaterialMovements: (params?: { rawMaterialId?: number; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params?.rawMaterialId) qs.set("rawMaterialId", String(params.rawMaterialId));
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: any[]; total: number; page: number; pageSize: number }>(`/raw-materials/movements${suffix}`);
  },
  createRawMaterial: (data: { code: string; name?: string; minStock?: number }) =>
    request<any>("/raw-materials", { method: "POST", body: JSON.stringify(data) }),
  updateRawMaterial: (id: number, data: Partial<{ code: string; name: string; minStock: number }>) =>
    request<any>(`/raw-materials/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  deactivateRawMaterial: (id: number) => request<any>(`/raw-materials/${id}`, { method: "DELETE" }),
  reactivateRawMaterial: (id: number) => request<any>(`/raw-materials/${id}/reactivate`, { method: "POST" }),
  adjustRawMaterialStock: (id: number, quantity: number, type: "compra" | "ajuste", notes?: string) =>
    request<any>(`/raw-materials/${id}/adjust`, { method: "POST", body: JSON.stringify({ quantity, type, notes }) }),
  getProductLabel: (productId: number) =>
    request<{ sku: string; name: string; category: string; measure: string | null; unit: string; qrDataUrl: string }>(
      `/products/${productId}/label`
    ),

  getUsers: () => request<any[]>("/users"),
  createUser: (data: { name: string; email: string; password: string; role: string }) =>
    request<any>("/users", { method: "POST", body: JSON.stringify(data) }),
  updateUser: (userId: number, data: Partial<{ name: string; email: string; role: string; password: string }>) =>
    request<any>(`/users/${userId}`, { method: "PATCH", body: JSON.stringify(data) }),
  deactivateUser: (userId: number) => request<any>(`/users/${userId}`, { method: "DELETE" }),
  reactivateUser: (userId: number) => request<any>(`/users/${userId}/reactivate`, { method: "POST" }),

  getClients: () => request<any[]>("/clients"),
  createClient: (name: string) => request<any>("/clients", { method: "POST", body: JSON.stringify({ name }) }),
  updateClient: (clientId: number, data: { name?: string; contactInfo?: Record<string, unknown>; creditLimit?: number }) =>
    request<any>(`/clients/${clientId}`, { method: "PATCH", body: JSON.stringify(data) }),
  uploadClientAvatar: (clientId: number, file: File) => {
    const form = new FormData();
    form.append("avatar", file);
    return request<any>(`/clients/${clientId}/avatar`, { method: "POST", body: form });
  },
  /** Registra una visita a la ficha del cliente (alimenta el filtro "Frecuentes"). */
  recordClientVisit: (clientId: number) =>
    request<{ viewCount: number; lastViewedAt: string; cycleInteractions: number }>(`/clients/${clientId}/visit`, { method: "POST" }),
  deleteClient: (clientId: number) => request<any>(`/clients/${clientId}`, { method: "DELETE" }),
  updateCreditLimit: (clientId: number, creditLimit: number) =>
    request<any>(`/clients/${clientId}/credit-limit`, { method: "PATCH", body: JSON.stringify({ creditLimit }) }),

  getClientContacts: (clientId: number) => request<any[]>(`/clients/${clientId}/contacts`),
  createClientContact: (
    clientId: number,
    data: { name: string; position?: string; phone?: string; email?: string; isPrimary?: boolean }
  ) => request<any>(`/clients/${clientId}/contacts`, { method: "POST", body: JSON.stringify(data) }),
  deleteClientContact: (clientId: number, contactId: number) =>
    request<{ ok: boolean }>(`/clients/${clientId}/contacts/${contactId}`, { method: "DELETE" }),
  updateClientContact: (
    clientId: number,
    contactId: number,
    data: { name: string; position?: string; phone?: string; email?: string; isPrimary?: boolean }
  ) => request<any>(`/clients/${clientId}/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify(data) }),
  /** Lista global de contactos con la empresa relacionada (pantalla CRM "Contactos"). */
  getAllContacts: () => request<any[]>("/clients/contacts"),
  /** Registra una visita a la ficha de un contacto (frecuencia propia del contacto). */
  recordContactVisit: (contactId: number) =>
    request<{ viewCount: number; lastViewedAt: string; cycleInteractions: number }>(
      `/clients/contacts/${contactId}/visit`,
      { method: "POST" }
    ),

  getClientAddresses: (clientId: number) => request<any[]>(`/clients/${clientId}/addresses`),
  createClientAddress: (
    clientId: number,
    data: {
      label: string;
      addressLine: string;
      city?: string;
      region?: string;
      postalCode?: string;
      isPrimary?: boolean;
      notes?: string;
    }
  ) => request<any>(`/clients/${clientId}/addresses`, { method: "POST", body: JSON.stringify(data) }),
  deleteClientAddress: (clientId: number, addressId: number) =>
    request<{ ok: boolean }>(`/clients/${clientId}/addresses/${addressId}`, { method: "DELETE" }),

  getClientInteractions: (clientId: number) => request<any[]>(`/clients/${clientId}/interactions`),
  createClientInteraction: (
    clientId: number,
    data: { type: "llamada" | "email" | "reunion" | "nota"; description: string }
  ) => request<any>(`/clients/${clientId}/interactions`, { method: "POST", body: JSON.stringify(data) }),
  getClientCartera: (clientId: number) =>
    request<{ creditLimit: number; saldoPendiente: number; facturasPendientes: any[] }>(`/clients/${clientId}/cartera`),
  getClientTopProducts: (clientId: number, limit?: number) =>
    request<
      { product: { id: number; sku: string; name: string; unit: string }; measure: string | null; frequency: number; totalQuantity: number }[]
    >(`/clients/${clientId}/top-products${limit ? `?limit=${limit}` : ""}`),
  getClientManualProducts: (clientId: number) =>
    request<
      {
        id: number;
        product: { id: number; sku: string; name: string; unit: string };
        quantity: number | null;
        notes: string | null;
        createdBy: { name: string } | null;
      }[]
    >(`/clients/${clientId}/manual-products`),
  addClientManualProduct: (clientId: number, data: { productId: number; quantity?: number; notes?: string }) =>
    request<any>(`/clients/${clientId}/manual-products`, { method: "POST", body: JSON.stringify(data) }),
  deleteClientManualProduct: (clientId: number, manualProductId: number) =>
    request<void>(`/clients/${clientId}/manual-products/${manualProductId}`, { method: "DELETE" }),

  createProductionEntry: (data: Record<string, unknown>) =>
    request<any>("/production/entries", { method: "POST", body: JSON.stringify(data) }),

  previewImport: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ filename: string; totalRows: number; validRows: number; invalidRows: number; rows: any[] }>(
      "/production/import/preview",
      { method: "POST", body: form }
    );
  },
  confirmImport: (filename: string, rows: any[]) =>
    request<{ processed: number; failed: number }>("/production/import/confirm", {
      method: "POST",
      body: JSON.stringify({ filename, rows }),
    }),

  getDispatches: (params?: { clientId?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.clientId) qs.set("clientId", String(params.clientId));
    if (params?.status) qs.set("status", params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<any[]>(`/dispatches${suffix}`);
  },
  /** Histórico de cuánto se le despachó a cada cliente, agrupado por producto. */
  getDispatchSummaryByClient: () => request<any[]>("/dispatches/summary-by-client"),
  createDispatch: (clientId: number, items: any[]) =>
    request<any>("/dispatches", { method: "POST", body: JSON.stringify({ clientId, items }) }),
  markItemDispatched: (dispatchId: number, itemId: number, quantityDispatched: number, locationId?: number) =>
    request<any>(`/dispatches/${dispatchId}/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ quantityDispatched, locationId }),
    }),
  /** Cancela un despacho — si ya tenía ítems despachados, revierte ese
   * stock (y la ubicación de origen, si se había cargado una). */
  cancelDispatch: (dispatchId: number) => request<{ ok: boolean; reversedTotal: number }>(`/dispatches/${dispatchId}/cancel`, { method: "POST" }),

  getProductionOrders: (params?: { status?: string; station?: string }) => {
    const qs = new URLSearchParams();
    if (params?.status) qs.set("status", params.status);
    if (params?.station) qs.set("station", params.station);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<any[]>(`/production-orders${suffix}`);
  },
  getProductionOrder: (id: number) => request<any>(`/production-orders/${id}`),
  /** Trazabilidad desde un código físico (QR de rollo, etiqueta de bulto o
   * número de OP) — devuelve la OP y el rollo al que pertenece. */
  traceByCode: (code: string) =>
    request<{ kind: "rollo" | "bulto" | "op"; orderId: number; rollId: number | null }>(
      `/production-orders/trace/by-code/${encodeURIComponent(code)}`
    ),
  createProductionOrder: (data: {
    // Opcional: la OP nace sin proceso y se deriva a Extrusión después.
    station?: string;
    productId: number;
    clientId?: number;
    quantityPlanned: number;
    measure?: string;
    specs?: Record<string, unknown>;
    notes?: string;
  }) => request<any>("/production-orders", { method: "POST", body: JSON.stringify(data) }),
  deriveProductionOrder: (
    id: number,
    data: { station: string; quantityPlanned?: number; measure?: string; specs?: Record<string, unknown>; notes?: string }
  ) => request<any>(`/production-orders/${id}/derive`, { method: "POST", body: JSON.stringify(data) }),
  updateProductionOrder: (
    id: number,
    data: {
      specs?: Record<string, unknown>;
      measure?: string | null;
      quantityPlanned?: number;
      clientId?: number | null;
      notes?: string | null;
      alertThresholdKg?: number | null;
    }
  ) => request<any>(`/production-orders/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  updateMaterialPara: (id: number, materialPara: string | null) =>
    request<any>(`/production-orders/${id}/material-para`, { method: "PATCH", body: JSON.stringify({ materialPara }) }),
  getPendingPlanning: () => request<any[]>("/production-orders/pending-planning"),
  getProduccionPorOperario: (params?: { from?: string; to?: string; station?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    if (params?.station) qs.set("station", params.station);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<any[]>(`/production-orders/reports/por-operario${suffix}`);
  },
  createProductionOrderFromPedidoItem: (pedidoVersionItemId: number) =>
    request<any>(`/production-orders/from-pedido-item/${pedidoVersionItemId}`, { method: "POST" }),
  /** `station` es "root" para medida/cantidad al armar la OP en blanco, o el
   * nombre de una estación para las specs de su plantilla (ver GET
   * /production-orders/suggestions). */
  getProductionOrderSuggestions: (clientId: number, productId: number, station: string) =>
    request<{
      manual: { id: number; measure: string | null; quantityPlanned: number | null; specs: Record<string, unknown> | null; notes: string | null } | null;
      frequent: { sampleSize: number; measure?: string | null; quantityPlanned?: number | null; specs?: Record<string, unknown> };
    }>(`/production-orders/suggestions?clientId=${clientId}&productId=${productId}&station=${station}`),
  saveProductionOrderPreset: (data: {
    clientId: number;
    productId: number;
    station: string;
    measure?: string;
    quantityPlanned?: number;
    specs?: Record<string, unknown>;
    notes?: string;
  }) => request<any>("/production-orders/presets", { method: "POST", body: JSON.stringify(data) }),
  deleteProductionOrderPreset: (id: number) => request<void>(`/production-orders/presets/${id}`, { method: "DELETE" }),
  closeProductionOrder: (id: number) => request<any>(`/production-orders/${id}/close`, { method: "POST" }),
  reopenProductionOrder: (id: number) => request<any>(`/production-orders/${id}/reopen`, { method: "POST" }),
  releaseProductionOrder: (id: number) => request<any>(`/production-orders/${id}/release`, { method: "POST" }),
  createProductionRoll: (
    productionOrderId: number,
    data: {
      date?: string;
      operatorName: string;
      machine?: string;
      label?: string;
      weightKg: number;
      wasteKg?: number;
      details?: Record<string, unknown>;
      notes?: string;
      sourceRollId?: number;
      /** Rollos madre escaneados EN ORDEN (Sellado/Precorte): el servidor
       * reparte `weightKg` agotando el primero antes de tocar el siguiente. */
      sourceRollIds?: number[];
      /** Token de posesión física de cada rollo madre escaneado (uno por id
       * de `sourceRollIds`/`sourceRollId`, ver services/rollPossessionToken.ts
       * del servidor) — sin el token correcto, el servidor rechaza consumir
       * ese rollo aunque el id sea válido. */
      sourceRollTokens?: Record<number, string>;
      bultoLabelCode?: string;
    }
  ) => request<any>(`/production-orders/${productionOrderId}/rolls`, { method: "POST", body: JSON.stringify(data) }),
  deleteProductionRoll: (productionOrderId: number, rollId: number) =>
    request<void>(`/production-orders/${productionOrderId}/rolls/${rollId}`, { method: "DELETE" }),
  /** Genera un token de posesión NUEVO para un rollo ya creado e imprime su
   * QR con el código+token embebido — invalida cualquier etiqueta anterior
   * (su token viejo deja de servir). Para etiquetas dañadas/perdidas. */
  reissueProductionRollLabel: (productionOrderId: number, rollId: number) =>
    request<any>(`/production-orders/${productionOrderId}/rolls/${rollId}/reissue-label`, { method: "POST" }),
  /** Resuelve un rollo por el código de su QR (`EXT-9`), para el escaneo de
   * rollo de origen al cargar la OP derivada. `token` es el token de
   * posesión leído del mismo QR (si el rollo lo tiene) — si se manda y no
   * matchea, el servidor responde 403 (feedback inmediato de QR falso; el
   * chequeo real es el de `createProductionRoll`, este es solo para avisar
   * antes de terminar de llenar la fila). */
  getProductionRollByCode: (code: string, token?: string, forStation?: string) => {
    // `forStation`: estación de la OP que lo quiere consumir — el servidor
    // avisa ya al escanear si el rollo está en otra bodega (o en camino).
    const params = new URLSearchParams(Object.entries({ token, forStation }).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return request<any>(`/production-orders/rolls/by-code/${encodeURIComponent(code)}${qs ? `?${qs}` : ""}`);
  },
  // ---- Despacho de rollos entre bodegas internas (Extrusión/Impresión ->
  // Impresión/Sellado/Precorte), ver server/src/routes/rollTransfers.ts ----
  /** Qué rollo se escaneó, a dónde puede ir y si ya hay un despacho en
   * tránsito. Exige el token del QR (403 si no matchea). */
  scanRollForTransfer: (code: string, token: string) =>
    request<RollTransferScan>(`/roll-transfers/scan/${encodeURIComponent(code)}?token=${encodeURIComponent(token)}`),
  getRollTransfers: (filters: { status?: string; toStation?: string; fromStation?: string; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, v]) => v) as [string, string][]);
    const qs = params.toString();
    return request<RollTransfer[]>(`/roll-transfers${qs ? `?${qs}` : ""}`);
  },
  createRollTransfer: (data: {
    code: string;
    token: string;
    toStation: string;
    mode: "entrega" | "retiro";
    carrierName?: string;
    notes?: string;
    clientTimezone: string;
    clientUtcOffsetMinutes: number;
  }) => request<RollTransfer>("/roll-transfers", { method: "POST", body: JSON.stringify(data) }),
  receiveRollTransfer: (
    id: number,
    data: { code: string; token: string; notes?: string; receivedKg?: number; clientTimezone: string; clientUtcOffsetMinutes: number }
  ) => request<RollTransfer>(`/roll-transfers/${id}/receive`, { method: "POST", body: JSON.stringify(data) }),
  /** Nombres de transportistas ya usados, para sugerirlos al despachar. */
  getRollTransferCarriers: () => request<string[]>("/roll-transfers/carriers"),
  /** Último transportista que registró esta cuenta (para precargarlo). */
  getMyLastCarrier: () => request<{ carrierName: string | null }>("/roll-transfers/carriers/last-mine"),
  /** Qué rollos hay hoy en cada bodega de planta, y cuáles están en camino. */
  getWarehouseInventory: () => request<WarehouseInventory>("/roll-transfers/inventory"),
  /** Ajuste por conteo físico (solo Gestión): el saldo pasa a ser `countedKg`. */
  countRoll: (rollId: number, data: { countedKg: number; notes: string }) =>
    request<{ rollId: number; code: string; previousKg: number; newKg: number; deltaKg: number }>(`/roll-transfers/rolls/${rollId}/count`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteRollTransfer: (id: number) => request<void>(`/roll-transfers/${id}`, { method: "DELETE" }),
  // ---- Etiquetas de bulto (Sellado/Precorte): pre-impresas por Gestión,
  // el operario escanea la que le tocó en vez de tipear E. BULTO. ----
  getBultoLabels: (status?: string) => request<any[]>(`/bulto-labels${status ? `?status=${status}` : ""}`),
  generateBultoLabels: (count: number) => request<any[]>("/bulto-labels/generate", { method: "POST", body: JSON.stringify({ count }) }),
  getBultoLabelQr: (id: number) => request<{ code: string; status: string; qrDataUrl: string }>(`/bulto-labels/${id}/qr`),
  getBultoLabelByCode: (code: string) => request<{ id: number; code: string; status: string }>(`/bulto-labels/by-code/${encodeURIComponent(code)}`),
  submitQualityCheck: (id: number, data: { result: "aprobado" | "rechazado"; observations?: string }) =>
    request<any>(`/production-orders/${id}/quality-check`, { method: "POST", body: JSON.stringify(data) }),
  /** Mismo patrón crudo que downloadFacturaPdf (fetch + blob + <a download>). */
  downloadProductionOrderPdf: async (id: number, filename: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/production-orders/${id}/report.pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  },
  getProductionOrderAttachments: (id: number) => request<any[]>(`/production-orders/${id}/attachments`),
  uploadProductionOrderAttachment: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<any>(`/production-orders/${id}/attachments`, { method: "POST", body: form });
  },
  downloadProductionOrderAttachment: async (id: number, attachmentId: number, filename: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/production-orders/${id}/attachments/${attachmentId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
  deleteProductionOrderAttachment: (id: number, attachmentId: number) =>
    request<void>(`/production-orders/${id}/attachments/${attachmentId}`, { method: "DELETE" }),

  getCotizaciones: (clientId?: number) =>
    request<any[]>(`/cotizaciones${clientId ? `?clientId=${clientId}` : ""}`),
  createCotizacion: (data: {
    clientId: number;
    validUntil?: string;
    notes?: string;
    items: { productId: number; quantity: number; unitPrice?: number; measure?: string }[];
  }) => request<any>("/cotizaciones", { method: "POST", body: JSON.stringify(data) }),
  updateCotizacionStatus: (id: number, status: string) =>
    request<any>(`/cotizaciones/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
  convertCotizacionToPedido: (id: number) =>
    request<any>(`/cotizaciones/${id}/convertir-a-pedido`, { method: "POST" }),

  getPedidos: (params?: { clientId?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.clientId) qs.set("clientId", String(params.clientId));
    if (params?.status) qs.set("status", params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<any[]>(`/pedidos${suffix}`);
  },
  createPedido: (data: {
    clientId: number;
    notes?: string;
    items: { productId: number; quantity: number; unitPrice?: number; measure?: string }[];
  }) => request<any>("/pedidos", { method: "POST", body: JSON.stringify(data) }),
  getPedidoVersions: (pedidoId: number) => request<any[]>(`/pedidos/${pedidoId}/versions`),
  updatePedido: (
    pedidoId: number,
    data: {
      status: string;
      notes?: string;
      items: { productId: number; quantity: number; unitPrice?: number; measure?: string }[];
    }
  ) => request<any>(`/pedidos/${pedidoId}`, { method: "PATCH", body: JSON.stringify(data) }),
  duplicatePedido: (pedidoId: number) => request<any>(`/pedidos/${pedidoId}/duplicar`, { method: "POST" }),
  getPedidoAttachments: (pedidoId: number) => request<any[]>(`/pedidos/${pedidoId}/attachments`),
  uploadPedidoAttachment: (pedidoId: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<any>(`/pedidos/${pedidoId}/attachments`, { method: "POST", body: form });
  },
  downloadPedidoAttachment: async (pedidoId: number, attachmentId: number, filename: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/pedidos/${pedidoId}/attachments/${attachmentId}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  getFacturas: (params?: { clientId?: number; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.clientId) qs.set("clientId", String(params.clientId));
    if (params?.status) qs.set("status", params.status);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<any[]>(`/facturas${suffix}`);
  },
  createFactura: (data: {
    clientId: number;
    notes?: string;
    dueDate?: string;
    items: { productId: number; quantity: number; unitPrice?: number; measure?: string }[];
  }) => request<any>("/facturas", { method: "POST", body: JSON.stringify(data) }),
  createFacturaFromPedido: (pedidoId: number) =>
    request<any>(`/facturas/desde-pedido/${pedidoId}`, { method: "POST" }),
  anularFactura: (id: number) => request<any>(`/facturas/${id}/anular`, { method: "PATCH" }),
  getFacturaPayments: (facturaId: number) => request<any[]>(`/facturas/${facturaId}/payments`),
  createPayment: (
    facturaId: number,
    data: { amount: number; method: "efectivo" | "transferencia" | "cheque" | "tarjeta" | "otro"; paidAt?: string; notes?: string }
  ) => request<any>(`/facturas/${facturaId}/payments`, { method: "POST", body: JSON.stringify(data) }),

  getAuditLog: (params?: { tableName?: string; recordId?: number; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params?.tableName) qs.set("tableName", params.tableName);
    if (params?.recordId) qs.set("recordId", String(params.recordId));
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: any[]; total: number; page: number; pageSize: number }>(`/audit-log${suffix}`);
  },
  /** Compara el stock desnormalizado contra la suma real de su propia
   * bitácora de movimientos -- para detectar un descuadre si alguna vez
   * pasa (ver auditoría de inventario). */
  getStockReconciliation: () =>
    request<{
      ok: boolean;
      products: { productId: number; sku: string; name: string; stock: number; movementsSum: number; difference: number }[];
      rawMaterials: { rawMaterialId: number; code: string; stock: number; movementsSum: number; difference: number }[];
    }>("/audit-log/reconciliation"),

  getInventoryMovements: (params?: { productId?: number; movementType?: string; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params?.productId) qs.set("productId", String(params.productId));
    if (params?.movementType) qs.set("movementType", params.movementType);
    if (params?.page) qs.set("page", String(params.page));
    if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{ items: any[]; total: number; page: number; pageSize: number }>(`/inventory/movements${suffix}`);
  },

  getWarehouseLocations: () => request<any[]>("/warehouse/locations"),
  createWarehouseLocation: (data: { code: string; label: string }) =>
    request<any>("/warehouse/locations", { method: "POST", body: JSON.stringify(data) }),
  getWarehouseStock: () => request<any[]>("/warehouse/stock"),
  assignWarehouseStock: (data: { productId: number; toLocationId: number; quantity: number; fromLocationId?: number }) =>
    request<any>("/warehouse/assign", { method: "POST", body: JSON.stringify(data) }),
  getWarehouseLocationQr: (id: number) => request<{ dataUrl: string; url: string }>(`/warehouse/locations/${id}/qr`),
  /** Resuelve el token del QR de ubicación (ya escaneado con la cámara) a un
   * locationId, para autocompletar el AssignForm de Almacén. */
  getWarehouseLocationByToken: (token: string) =>
    request<{ id: number; code: string; label: string }>(`/warehouse/locations/by-token/${token}`),
  /** Sin auth (la ruta del token es pública) — igual pasa por `request()`,
   * el Authorization que agrega si hay sesión no molesta al backend. */
  getPublicLocation: (token: string) =>
    request<{ location: { code: string; label: string }; items: any[] }>(`/public/locations/${token}`),

  getDashboardResumen: (period: "mes" | "trimestre" | "anio" = "mes") =>
    request<{
      period: "mes" | "trimestre" | "anio";
      ventasDelPeriodo: number;
      ventasPeriodoAnterior: number;
      cambioVentasPct: number | null;
      kgProducidosDelPeriodo: number;
      kgProducidosPeriodoAnterior: number;
      ventasUltimos6Meses: { mes: string; total: number; kg: number }[];
      carteraPendiente: number;
      carteraVencida: number;
      facturasConSaldo: number;
      opsEnCurso: number;
      pedidosEnProduccion: number;
      cotizacionesAbiertas: number;
      valorCotizacionesAbiertas: number;
      tasaCierrePct: number | null;
      cotizacionesPorVencerSemana: number;
      alertas: { severity: "critica" | "alta" | "media"; title: string; detail: string }[];
      ordenesEnCurso: {
        id: number;
        orderNumber: string;
        station: string | null;
        status: string;
        productName: string;
        clientName: string | null;
        avancePct: number;
      }[];
      ordenesEnCursoTotal: number;
      topClientesSaldo: { clientId: number; name: string; saldo: number }[];
    }>(`/dashboard/resumen?period=${period}`),

  getNotifications: () => request<any[]>("/notifications"),
  getUnreadNotificationCount: () => request<{ count: number }>("/notifications/unread-count"),
  markNotificationRead: (id: number) => request<any>(`/notifications/${id}/read`, { method: "PATCH" }),
  markAllNotificationsRead: () => request<{ ok: boolean }>("/notifications/read-all", { method: "PATCH" }),

  getDashboardIndicadores: (params?: { from?: string; to?: string }) => {
    const qs = new URLSearchParams();
    if (params?.from) qs.set("from", params.from);
    if (params?.to) qs.set("to", params.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<{
      topProductosDespachados: { productId: number; sku: string; name: string; unit: string; total: number }[];
      calidad: { aprobadas: number; rechazadas: number; pctAprobacion: number | null };
      tiempoPromedioProduccionHoras: number | null;
    }>(`/dashboard/indicadores${suffix}`);
  },

  /** Mismo patrón crudo que downloadPedidoAttachment (fetch + blob + <a
   * download>) — el .xlsx generado no es JSON, no pasa por request(). */
  downloadExport: async (resource: "inventario" | "pedidos" | "facturas" | "clientes") => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/export/${resource}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${resource}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  },

  downloadFacturaPdf: async (id: number, filename: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/facturas/${id}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  },
  downloadCotizacionPdf: async (id: number, filename: string) => {
    const token = getToken();
    const res = await fetch(`${API_BASE}/cotizaciones/${id}/pdf`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`Error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
