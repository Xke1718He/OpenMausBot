import { t } from "./i18n";
import type { HostedApp, HostedConnections } from "./hosted-mcp-apps";

export type AppsFilter = "all" | "connected" | "mcp";

export function hostedShown(app: HostedApp, search: string, filter: AppsFilter, connected: HostedConnections | null): boolean {
  const matches = !search || `${app.label} ${app.keywords} ${t(app.description)}`.toLowerCase().includes(search.toLowerCase().trim());
  return matches && (filter === "all" || (filter === "connected" && connected?.[app.id] !== false));
}
