import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GenerationConnectorsApi, type GenerationConnector, type GenerationConnectorCatalog } from "@storyteller/api";
import { ProviderConnectorsDialog } from "./ProviderConnectorsDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.close = vi.fn(function(this: HTMLDialogElement) { this.removeAttribute("open"); });
  vi.spyOn(GenerationConnectorsApi.prototype, "Catalog").mockResolvedValue(catalog());
  vi.spyOn(GenerationConnectorsApi.prototype, "ListAll").mockResolvedValue([]);
  vi.stubGlobal("crypto", { randomUUID: () => "fixture-idempotency-key" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("reuses a create identity after an uncertain result and clears the write-only key after success", async () => {
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const create = vi.spyOn(GenerationConnectorsApi.prototype, "Create").mockRejectedValueOnce(new Error("保存结果尚未确认" )).mockResolvedValueOnce(connector());
  render(<ProviderConnectorsDialog onClose={vi.fn()} />);
  await waitFor(() => expect((screen.getByLabelText("账号名称").closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "项目账号" } });
  fireEvent.change(screen.getByLabelText("API 凭证操作"), { target: { value: "set" } });
  fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "synthetic-ui-secret" } });
  fireEvent.click(screen.getByText("保存连接器"));
  await screen.findByText("保存结果尚未确认");
  fireEvent.click(screen.getByText("保存连接器"));
  await screen.findByText("连接器已保存。账号访问权限和制作质量仍需单独验证。");
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0][0]).toEqual(create.mock.calls[1][0]);
  expect(create.mock.calls[0][0]).toMatchObject({ idempotency_key: "fixture-idempotency-key", credential: { action: "set", api_key: "synthetic-ui-secret" } });
  expect(screen.queryByDisplayValue("synthetic-ui-secret")).toBeNull();
  expect(storage).not.toHaveBeenCalled();
});

it("saves current settings with an explicit keep operation and no configuration version", async () => {
  const item = connector();
  vi.mocked(GenerationConnectorsApi.prototype.ListAll).mockResolvedValue([item]);
  const update = vi.spyOn(GenerationConnectorsApi.prototype, "Update").mockResolvedValue({ ...item, display_name: "新名称" });
  render(<ProviderConnectorsDialog onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /项目账号.*Fal/ }));
  fireEvent.change(screen.getByLabelText("账号名称"), { target: { value: "新名称" } });
  fireEvent.click(screen.getByText("保存连接器"));
  await screen.findByText("连接器已保存。账号访问权限和制作质量仍需单独验证。");
  expect(update).toHaveBeenCalledOnce();
  expect(update.mock.calls[0]).toEqual([item.token, { display_name: "新名称", enabled: true, configuration: { account_type: "api" }, credential: { action: "keep" } }]);
  expect(screen.queryByLabelText("API Key")).toBeNull();
  expect((screen.getByLabelText("供应商") as HTMLSelectElement).disabled).toBe(true);
});

it("discloses deployment and native-adapter limits without hiding provider facts", async () => {
  vi.mocked(GenerationConnectorsApi.prototype.Catalog).mockResolvedValue({ ...catalog(), management_available: false, unavailable_reasons: ["connector_encryption_unavailable"] });
  render(<ProviderConnectorsDialog onClose={vi.fn()} />);
  await screen.findByText("实例尚未配置连接器加密密钥");
  expect(screen.getByText(/静态图像/)).toBeTruthy();
  expect(screen.getByText(/已接通原生执行/)).toBeTruthy();
  expect((screen.getByText("保存连接器") as HTMLButtonElement).disabled).toBe(true);
});

function connector(): GenerationConnector {
  return { token: "connector", provider: "fal", display_name: "项目账号", enabled: true, archived: false, configuration: { account_type: "api" }, has_credential: true, credential_state: "configured" };
}
function catalog(): GenerationConnectorCatalog {
  return { success: true, management_available: true, unavailable_reasons: [], providers: [{ provider: "fal", label: "Fal", fields: [{ name: "account_type", label: "账号类型", control: "enum", secret: false, required: true, choices: ["api"], help: "" }, { name: "api_key", label: "API Key", control: "password", secret: true, required: true, choices: [], help: "" }], operations: [{ operation: "static_image", model_ids: ["flux_1_dev"], implementation_state: "implemented", restrictions: ["不提供原生动画序列"] }] }] };
}
