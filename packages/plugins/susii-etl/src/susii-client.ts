import { SUSII_API_BASE } from "./constants.js";

export interface SusiiSale {
  id: number;
  number: number;
  date: string;
  due_date: string | null;
  business: number;
  user: number | null;
  currency_code: string;
  exchange_rate: string;
  discount: string;
  discount_percent: string;
  discount_type: number | null;
  rounding: string;
  tax: string;
  is_active: boolean;
  is_paid: boolean;
  details: string | null;
  note: string | null;
  observations: string | null;
  prepaid_amount: string;
  other_charges: string;
  service_charge: string;
  service_charge_multiplier_factor: string;
  amount_in_letters: string | null;
  uuid: string | null;
  created_at: string;
  // null for anonymous walk-in sales (no customer recorded).
  client: SusiiClient | null;
  items: SusiiSaleItem[];
  payments: SusiiPayment[];
  document_set: SusiiDocument[];
  // Allow forward-compat fields (chef_observations, delivery, order_reference, ...).
  [key: string]: unknown;
}

export interface SusiiClient {
  id: number;
  name: string | null;
  alias: string | null;
  // Susii returns string (e.g. "A" for anonymous walk-in) or numeric DNI/RUC code.
  document_type: number | string | null;
  document_number: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  gender: string | null;
  type: number | null;
  business: number;
  is_active: boolean;
  created_at: string | null;
  [key: string]: unknown;
}

export interface SusiiSaleItem {
  id: number;
  product: number | null;
  name: string | null;
  code: string | null;
  quantity: string;
  price: string;
  tax: string;
  tax_reference: number | null;
  isc_percent: string;
  icbper_base: string;
  discount: string;
  discount_type: number | null;
  discount_percent: string;
  discount_with_tax: string;
  observations: string | null;
  group_id: string | null;
  created_at: string | null;
  [key: string]: unknown;
}

export interface SusiiPayment {
  id: number;
  date: string | null;
  business_payment_method: number | null;
  currency_code: string;
  amount: string;
  is_paid: boolean;
  is_active: boolean;
  user: number | null;
  observations: string | null;
  type: number | null;
  [key: string]: unknown;
}

export interface SusiiDocument {
  id: number;
  serial: number | null;
  document_name: string | null;
  type: string | null;
  igv: string | null;
  isc: string;
  icbper: string;
  total: string | null;
  payable: string | null;
  currency: string;
  is_active: boolean;
  payment_form: string | null;
  document_state: string | null;
  rounding: string;
  service_charge: string;
  global_allowance: string;
  client_name: string | null;
  // "A" for anonymous walk-in, otherwise int DNI/RUC code.
  client_document_type: number | string | null;
  client_document_number: string | null;
  digest_value: string | null;
  pdf_file: string | null;
  issue_date: string | null;
  amount_in_letters: string | null;
  [key: string]: unknown;
}

interface SusiiSalesPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: SusiiSale[];
}

export interface SusiiClientOptions {
  username: string;
  password: string;
  businessId: number;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Minimal Susii REST client for the ETL plugin.
 *
 * Auth: DRF token (NOT bearer). Token re-fetched from username/password on
 * 401 — never stored to disk. The token is the only mutable state on the client.
 *
 * Pagination: caller drives via async iterator over `listSalesPaginated`.
 */
export class SusiiClient {
  private token: string | null = null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: (msg: string, meta?: Record<string, unknown>) => void;

  constructor(private readonly opts: SusiiClientOptions) {
    this.baseUrl = opts.baseUrl ?? SUSII_API_BASE;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.log = opts.log ?? (() => {});
  }

  /** Force re-auth on next request. Used when token rotates. */
  clearToken(): void {
    this.token = null;
  }

  private async ensureToken(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.fetchImpl(`${this.baseUrl}/auth/login/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.opts.username, password: this.opts.password }),
    });
    if (!res.ok) {
      throw new Error(`susii auth failed: ${res.status} ${await safeText(res)}`);
    }
    const body = (await res.json()) as { key?: string };
    if (!body.key || body.key.length < 20) {
      throw new Error("susii auth response missing key");
    }
    this.token = body.key;
    this.log("susii.auth.ok", { tokenSuffix: body.key.slice(-6) });
    return this.token;
  }

  private async authedFetch(url: string): Promise<Response> {
    const token = await this.ensureToken();
    let res = await this.fetchImpl(url, {
      headers: { Authorization: `Token ${token}` },
    });
    if (res.status === 401) {
      this.log("susii.auth.rotated", {});
      this.clearToken();
      const fresh = await this.ensureToken();
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Token ${fresh}` },
      });
    }
    return res;
  }

  /**
   * Walk paginated `/v1/sales/sales/` filtered by modified_after.
   * Yields one sale per iteration. Caller decides when to stop.
   *
   * `pageSize` is hinted to the server; default 100 balances latency and
   * throughput (one page typically returns in <1s).
   */
  async *listSalesPaginated(opts: {
    /**
     * Receipt-date floor passed to the Susii API as `date__gte=YYYY-MM-DD`.
     *
     * Empirically discovered 2026-05-10: Susii's `modified_after`,
     * `updated_after`, `id__gt`, `number__gt`, and `ordering` params are all
     * silently ignored. Only `date__gte` (Django REST framework's `gte`
     * lookup on `sale.date`) actually filters. Plugin used to call with
     * `modified_after` → server returned all 3,440 rows on every run.
     *
     * Caller passes a YYYY-MM-DD date (or full ISO; server truncates to date).
     */
    dateGteIsoDay: string;
    pageSize?: number;
    maxPages?: number;
  }): AsyncGenerator<SusiiSale, void, void> {
    const pageSize = opts.pageSize ?? 100;
    const maxPages = opts.maxPages ?? Number.MAX_SAFE_INTEGER;
    let url: string | null =
      `${this.baseUrl}/v1/sales/sales/?business=${this.opts.businessId}` +
      `&date__gte=${encodeURIComponent(opts.dateGteIsoDay)}` +
      `&page_size=${pageSize}`;
    let pages = 0;
    while (url && pages < maxPages) {
      const res = await this.authedFetch(url);
      if (!res.ok) {
        throw new Error(`susii list failed: ${res.status} ${await safeText(res)} url=${url}`);
      }
      const page = (await res.json()) as SusiiSalesPage;
      for (const sale of page.results) yield sale;
      url = page.next;
      pages += 1;
      this.log("susii.page.fetched", { pages, count: page.results.length, hasNext: !!page.next });
    }
  }

  /** Convenience: count total sales whose `sale.date` >= the given ISO day. */
  async countSalesSince(dateGteIsoDay: string): Promise<number> {
    const url =
      `${this.baseUrl}/v1/sales/sales/?business=${this.opts.businessId}` +
      `&date__gte=${encodeURIComponent(dateGteIsoDay)}` +
      `&page_size=1`;
    const res = await this.authedFetch(url);
    if (!res.ok) throw new Error(`susii count failed: ${res.status} ${await safeText(res)}`);
    const page = (await res.json()) as SusiiSalesPage;
    return page.count;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<unreadable>";
  }
}
