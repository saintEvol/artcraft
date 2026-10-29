import { afterEach, expect, it, vi } from "vitest";
import { GenerationConnectorsApi } from "@storyteller/api";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("follows account pages with opaque u64 cursors without truncating or rounding", async () => {
  const cursor = "connector-list.v1:9007199254740999";
  const fetch = vi.fn().mockResolvedValueOnce(response({ success: true, connectors: [{ token: "first" }], next_cursor: cursor, has_more: true }))
    .mockResolvedValueOnce(response({ success: true, connectors: [{ token: "second" }], next_cursor: null, has_more: false }));
  vi.stubGlobal("fetch", fetch);
  expect((await new GenerationConnectorsApi().ListAll()).map((item) => item.token)).toEqual(["first", "second"]);
  expect(String(fetch.mock.calls[1][0])).toContain(encodeURIComponent(cursor));
});

it("refuses duplicate and malformed pages and preserves structured recovery errors", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ success: true, connectors: [{ token: "same" }], next_cursor: "next", has_more: true }))
    .mockResolvedValueOnce(response({ success: true, connectors: [{ token: "same" }], next_cursor: null, has_more: false }));
  vi.stubGlobal("fetch", fetch);
  await expect(new GenerationConnectorsApi().ListAll()).rejects.toMatchObject({ code: "invalid_response" });
  fetch.mockResolvedValueOnce(response({ success: false, error: { code: "connector_disabled", message: "连接器已禁用", retryable: false } }, 409));
  await expect(new GenerationConnectorsApi().Update("account", { display_name: "name", enabled: true, configuration: {}, credential: { action: "keep" } })).rejects.toMatchObject({ status: 409, code: "connector_disabled", retryable: false });
  expect(fetch).toHaveBeenCalledTimes(3);
});

function response(payload: unknown, status = 200) { return { ok: status === 200, status, json: async () => payload }; }
