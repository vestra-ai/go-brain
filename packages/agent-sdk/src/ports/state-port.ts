/**
 * StatePort — per-session runtime state the engine reads (task-stop signal,
 * granted capabilities, connected external apps). Host-backed; the SDK ships
 * an in-memory default.
 */
export interface StatePort {
  isTaskStopping(taskId: string): boolean;
  grantedCapabilities(): string[];
  connectedAppsSnapshot(): Set<string>;
  refreshConnectedApps(): Promise<void>;
}

export class InMemoryStatePort implements StatePort {
  private readonly stopping = new Set<string>();
  private caps: string[] = [];
  private apps = new Set<string>();

  isTaskStopping(taskId: string): boolean {
    return this.stopping.has(taskId);
  }
  grantedCapabilities(): string[] {
    return [...this.caps];
  }
  connectedAppsSnapshot(): Set<string> {
    return new Set(this.apps);
  }
  async refreshConnectedApps(): Promise<void> {
    /* no-op default */
  }

  // ── test/host seeding helpers ──
  setStopping(taskId: string): void {
    this.stopping.add(taskId);
  }
  setCapabilities(caps: string[]): void {
    this.caps = [...caps];
  }
  setConnectedApps(apps: string[]): void {
    this.apps = new Set(apps);
  }
}
