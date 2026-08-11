import { launchBrowser, BROWSER_USER_AGENT } from "./article-discovery-browser";

export const AGENT3_MAX_ACTIVE_CONTEXTS = 2;
export const AGENT3_MAX_ACTIVE_PAGES = 1;

export type Agent3BrowserSessionLaunchResult = Awaited<ReturnType<typeof launchBrowser>>;

export class Agent3BrowserSessionError extends Error {
  constructor(
    public readonly reason: "browser_runtime_unavailable" | "time_budget_exhausted" | "session_closed",
    message: string,
    public readonly domainKey: string | null = null,
  ) {
    super(message);
    this.name = "Agent3BrowserSessionError";
  }
}

type Clock = () => number;

type ContextEntry = {
  domainKey: string;
  context: any;
  navigationCount: number;
  lastUsedAt: number;
  retired: boolean;
};

export type Agent3BrowserPageLease = {
  page: any;
  domainKey: string;
  close: (options?: { retireContext?: boolean }) => Promise<void>;
};

export type Agent3BrowserSessionOptions = {
  deadlineAt?: number;
  maxActiveContexts?: number;
  maxNavigationsPerContext?: number;
  now?: Clock;
  launch?: () => Promise<Agent3BrowserSessionLaunchResult>;
};

export function normalizeAgent3DomainKey(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Invocation-local browser ownership. It never stores state outside this instance. */
export class Agent3BrowserSession {
  private readonly deadlineAt: number | undefined;
  private readonly maxActiveContexts: number;
  private readonly maxNavigationsPerContext: number;
  private readonly now: Clock;
  private readonly launch: () => Promise<Agent3BrowserSessionLaunchResult>;
  private readonly contexts = new Map<string, ContextEntry>();
  private launchPromise: Promise<void> | null = null;
  private browser: any | null = null;
  private viewport: { width: number; height: number } | null = null;
  private launchState: "not_started" | "available" | "unavailable" | "closed" = "not_started";
  private activePage = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: Agent3BrowserSessionOptions = {}) {
    this.deadlineAt = options.deadlineAt;
    this.maxActiveContexts = Math.max(1, Math.min(AGENT3_MAX_ACTIVE_CONTEXTS, Math.floor(options.maxActiveContexts ?? AGENT3_MAX_ACTIVE_CONTEXTS)));
    this.maxNavigationsPerContext = Math.max(1, Math.min(10, Math.floor(options.maxNavigationsPerContext ?? 3)));
    this.now = options.now ?? (() => Date.now());
    this.launch = options.launch ?? launchBrowser;
  }

  get activeContextCount(): number {
    return this.contexts.size;
  }

  get browserLaunchCount(): number {
    return this.launchState === "not_started" ? 0 : 1;
  }

  get remainingMs(): number | null {
    return this.deadlineAt == null ? null : this.deadlineAt - this.now();
  }

  assertCanStart(url: string): void {
    const domainKey = normalizeAgent3DomainKey(url);
    if (!domainKey) throw new Agent3BrowserSessionError("session_closed", "Invalid browser article URL.");
    this.assertOpenAndWithinBudget(domainKey);
  }

  async openPage(url: string): Promise<Agent3BrowserPageLease> {
    const domainKey = normalizeAgent3DomainKey(url);
    if (!domainKey) throw new Agent3BrowserSessionError("session_closed", "Invalid browser article URL.");
    this.assertOpenAndWithinBudget(domainKey);
    if (this.activePage) throw new Error("Agent 3 browser session permits only one active page.");
    await this.ensureBrowser(domainKey);

    let entry = this.contexts.get(domainKey);
    if (entry?.retired || (entry && entry.navigationCount >= this.maxNavigationsPerContext)) {
      await this.retireDomain(domainKey);
      entry = undefined;
    }
    if (!entry) {
      await this.evictIfNeeded();
      entry = await this.createContext(domainKey);
      this.contexts.set(domainKey, entry);
    }

    let page: any;
    try {
      page = await entry.context.newPage();
      entry.navigationCount += 1;
      entry.lastUsedAt = this.now();
      this.activePage = true;
    } catch (error) {
      await this.retireDomain(domainKey);
      throw error;
    }

    let closed = false;
    return {
      page,
      domainKey,
      close: async (options = {}) => {
        if (closed) return;
        closed = true;
        try {
          await page.close?.();
        } finally {
          this.activePage = false;
          if (options.retireContext) await this.retireDomain(domainKey);
        }
      },
    };
  }

  async retireDomain(domainKey: string): Promise<void> {
    const entry = this.contexts.get(domainKey);
    if (!entry) return;
    this.contexts.delete(domainKey);
    entry.retired = true;
    await Promise.resolve(entry.context.close?.()).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.launchState = "closed";
      const entries = [...this.contexts.values()];
      this.contexts.clear();
      for (const entry of entries) {
        entry.retired = true;
        await Promise.resolve(entry.context.close?.()).catch(() => {});
      }
      const browser = this.browser;
      this.browser = null;
      await Promise.resolve(browser?.close?.()).catch(() => {});
    })();
    return this.closePromise;
  }

  private assertOpenAndWithinBudget(domainKey: string): void {
    if (this.launchState === "closed") {
      throw new Agent3BrowserSessionError("session_closed", "Agent 3 browser session is closed.", domainKey);
    }
    const remaining = this.remainingMs;
    if (remaining != null && remaining <= 5_000) {
      throw new Agent3BrowserSessionError("time_budget_exhausted", "Agent 3 browser batch budget exhausted.", domainKey);
    }
  }

  private async ensureBrowser(domainKey: string): Promise<void> {
    if (this.launchState === "available") return;
    if (this.launchState === "unavailable") {
      throw new Agent3BrowserSessionError("browser_runtime_unavailable", "Browser runtime unavailable.", domainKey);
    }
    if (!this.launchPromise) {
      this.launchPromise = (async () => {
        const result = await this.launch();
        if (!result.browser) {
          this.launchState = "unavailable";
          throw new Agent3BrowserSessionError(
            "browser_runtime_unavailable",
            result.blockedReason || "Browser runtime unavailable.",
            domainKey,
          );
        }
        this.browser = result.browser;
        this.viewport = result.viewport ?? null;
        this.launchState = "available";
      })();
    }
    try {
      await this.launchPromise;
    } catch (error) {
      if (error instanceof Agent3BrowserSessionError) throw error;
      this.launchState = "unavailable";
      throw new Agent3BrowserSessionError("browser_runtime_unavailable", String(error), domainKey);
    }
  }

  private async createContext(domainKey: string): Promise<ContextEntry> {
    const context = await this.browser.newContext({
      userAgent: BROWSER_USER_AGENT,
      ...(this.viewport ? { viewport: this.viewport } : {}),
    });
    return {
      domainKey,
      context,
      navigationCount: 0,
      lastUsedAt: this.now(),
      retired: false,
    };
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.contexts.size < this.maxActiveContexts) return;
    const oldest = [...this.contexts.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
    if (oldest) await this.retireDomain(oldest.domainKey);
  }
}

export function createAgent3BrowserSession(options: Agent3BrowserSessionOptions = {}): Agent3BrowserSession {
  return new Agent3BrowserSession(options);
}
