import { FetchProxy } from "@storyteller/tauri-utils";
import { ApiManager, buildSessionHeaders } from "./ApiManager.js";

export interface GenerationConnector {
  token: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  archived: boolean;
  configuration: Record<string, unknown>;
  has_credential: boolean;
  credential_state: "missing" | "unreadable" | "configured" | (string & {});
}

export interface GenerationProviderSchema {
  provider: string;
  label: string;
  fields: Array<{
    name: string; label: string; control: string; secret: boolean;
    required: boolean; choices: string[]; help: string;
  }>;
  operations: Array<{
    operation: string; model_ids: string[];
    implementation_state: string; restrictions: string[];
  }>;
}

export interface GenerationConnectorCatalog {
  success: true;
  management_available: boolean;
  unavailable_reasons: string[];
  providers: GenerationProviderSchema[];
}

export type ConnectorCredentialUpdate = { action: "keep" } | { action: "clear" } | { action: "set"; api_key: string };

export interface ConnectorMutation {
  display_name: string;
  enabled: boolean;
  configuration: Record<string, unknown>;
  credential: ConnectorCredentialUpdate;
}

export interface GenerationConnectorUse {
  execution_token: string;
  prepared_at: string;
}

export class GenerationConnectorsApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly retryable = false) { super(message); }
}

export class GenerationConnectorsApi extends ApiManager {
  public async Catalog(): Promise<GenerationConnectorCatalog> {
    try { return await this.request("/catalog"); }
    catch (error) {
      if (error instanceof GenerationConnectorsApiError && error.status === 404) throw new GenerationConnectorsApiError("此实例尚未提供 Provider 连接器管理，请升级服务。", 404, "connector_management_unsupported");
      throw error;
    }
  }

  public async ListAll(): Promise<GenerationConnector[]> {
    const connectors: GenerationConnector[] = [];
    const identities = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const page: { success: true; connectors: GenerationConnector[]; next_cursor: string | null; has_more: boolean } = await this.request(`?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      if (!Array.isArray(page.connectors) || page.connectors.length > 100 || page.has_more !== (page.next_cursor !== null)
        || page.has_more && page.connectors.length === 0) throw this.invalidResponse();
      for (const item of page.connectors) {
        if (!item.token || identities.has(item.token)) throw this.invalidResponse();
        identities.add(item.token); connectors.push(item);
      }
      if (!page.has_more) return connectors;
      if (typeof page.next_cursor !== "string" || !page.next_cursor || cursors.has(page.next_cursor) || connectors.length >= 10_000) throw this.invalidResponse();
      cursors.add(page.next_cursor); cursor = page.next_cursor;
    }
  }

  public async Create(input: ConnectorMutation & { provider: string; idempotency_key: string }): Promise<GenerationConnector> {
    return (await this.request<{ success: true; connector: GenerationConnector }>("", "POST", input)).connector;
  }

  public async Update(token: string, input: ConnectorMutation): Promise<GenerationConnector> {
    return (await this.request<{ success: true; connector: GenerationConnector }>(`/${encodeURIComponent(token)}`, "PUT", input)).connector;
  }

  public async Archive(connector: GenerationConnector): Promise<GenerationConnector> {
    return (await this.request<{ success: true; connector: GenerationConnector }>(`/${encodeURIComponent(connector.token)}/archive`, "POST")).connector;
  }

  public Uses(token: string, cursor?: string): Promise<{ success: true; connector_token: string; executions: GenerationConnectorUse[]; next_cursor: string | null; has_more: boolean }> {
    return this.request(`/${encodeURIComponent(token)}/uses?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  }

  private async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await FetchProxy(`${this.getApiSchemeAndHost()}/v1/generation_connectors${path}`, {
        method, credentials: "include", headers: buildSessionHeaders({ Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new GenerationConnectorsApiError(method === "GET" ? "连接器服务暂时无法连接。" : "保存结果尚未确认，可使用当前请求重试。", 0, "connection_failed", true);
    }
    let payload: Record<string, unknown>;
    try { payload = await response.json(); } catch { throw this.invalidResponse(response.status); }
    if (!response.ok) {
      const detail = payload?.error && typeof payload.error === "object" ? payload.error as Record<string, unknown> : {};
      throw new GenerationConnectorsApiError(typeof detail.message === "string" ? detail.message : `连接器请求未完成（HTTP ${response.status}）。`, response.status,
        typeof detail.code === "string" ? detail.code : "request_failed", detail.retryable === true);
    }
    if (!payload || payload.success !== true) throw this.invalidResponse(response.status);
    return payload as T;
  }

  private invalidResponse(status = 200): GenerationConnectorsApiError {
    return new GenerationConnectorsApiError("连接器响应不完整，请刷新状态或重试当前请求。", status, "invalid_response");
  }
}
