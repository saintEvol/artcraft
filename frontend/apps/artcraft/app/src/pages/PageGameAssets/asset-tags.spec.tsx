import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApi, GameAssetsApiError, normalizeGameAssetTag, normalizeGameAssetTags, type GameAssetInfo } from "@storyteller/api";
import { AssetTagEditor } from "./AssetTagEditor";
import { DeliveryDialog } from "./DeliveryDialog";
import { groupAssetsByTag, uniqueAssets } from "./asset-tags";
import { isKnownAssetKind } from "./profile";

const ASSET: GameAssetInfo = { token: "asset", project_token: "project", stable_key: "key", kind: "icon_2d", tags: ["物品"], revision: 1,
  maybe_current_version_token: null, maybe_archived_at: null, created_at: "2026-10-28", updated_at: "2026-10-28" };

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("tag contract", () => {
  it("normalizes NFC and Unicode whitespace; counts scalars and preserves case/order", () => {
    expect(normalizeGameAssetTags([" e\u0301 ", "é", "物品\u00a0\u3000技能", "Item", "item"])).toEqual(["Item", "item", "é", "物品 技能"]);
    expect(normalizeGameAssetTag("😀".repeat(64))).toHaveLength(128);
    expect(normalizeGameAssetTags(["😀", "\ue000"])).toEqual(["\ue000", "😀"]);
    expect(normalizeGameAssetTag("\ufeff物品")).toBe("\ufeff物品");
    for (const invalid of ["", "\u3000", "\n物品", "物\t品", "\u0085", "\u007f", "\0", "😀".repeat(65), 3, "\ud800"]) expect(() => normalizeGameAssetTag(invalid)).toThrow();
    expect(normalizeGameAssetTags(Array(30).fill("物品"))).toEqual(["物品"]);
    expect(() => normalizeGameAssetTags(Array.from({ length: 21 }, (_, i) => String(i)))).toThrow();
  });

  it("groups multiple tags without duplicating asset identity or untagged members", () => {
    const assets = [{ token: "a", tags: ["物品", "技能"] }, { token: "b", tags: [] }, { token: "a", tags: ["物品", "技能"] }];
    const groups = groupAssetsByTag(assets);
    expect(groups.map((group) => [group.tag, group.assets.length])).toEqual([["物品", 1], ["技能", 1], [null, 1]]);
    expect(uniqueAssets(groups.flatMap((group) => group.assets))).toHaveLength(2);
    expect(isKnownAssetKind("anim_3d")).toBe(false);
  });
});

describe("API compatibility and serialization", () => {
  it("discloses an uncertain mutation result after a server/proxy error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));
    await expect(new GameAssetsApi().ReplaceGameAssetTags("asset", ["物品"], 1, "retry-key"))
      .rejects.toMatchObject({ status: 500, message: expect.stringContaining("请求结果暂未确认") });
  });

  it("retains paging, kind and archive options with normalized exact tag filtering", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [{ ...ASSET, tags: undefined }], next_cursor: null, has_more: false })));
    vi.stubGlobal("fetch", fetch);
    const page = await new GameAssetsApi().ListGameAssets("project", { maybe_cursor: "100,asset", maybe_limit: 2, maybe_kind: "icon_2d", maybe_include_archived: false, maybe_tag: " e\u0301 " });
    const url = new URL(fetch.mock.calls[0][0]);
    expect(Object.fromEntries(url.searchParams)).toEqual({ maybe_cursor: "100,asset", maybe_limit: "2", maybe_kind: "icon_2d", maybe_include_archived: "false", maybe_tag: "é" });
    expect(page.items[0].tags).toEqual([]);
  });

  it("sends explicit clearing and the caller's revision and retry key", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ asset: ASSET })));
    vi.stubGlobal("fetch", fetch);
    await new GameAssetsApi().ReplaceGameAssetTags("asset", [], 4, "retry-key");
    expect(fetch.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ tags: [], expected_revision: 4, maybe_idempotency_key: "retry-key" });
  });
});

describe("editing and delivery", () => {
  it("rejects a pasted newline without silently stripping it", async () => {
    const api = new GameAssetsApi();
    vi.spyOn(api, "GetGameAsset").mockResolvedValue({ asset: ASSET });
    vi.spyOn(api, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
    const replace = vi.spyOn(api, "ReplaceGameAssetTags");
    render(<AssetTagEditor api={api} asset={ASSET} name="药水" onSaved={() => {}} onClose={() => {}} />);
    await screen.findByRole("button", { name: "移除标签：物品" });
    fireEvent.change(screen.getByLabelText("自定义资产标签"), { target: { value: "非法\n标签" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it("does not permit writes to an archived project", async () => {
    const api = new GameAssetsApi();
    vi.spyOn(api, "GetGameAsset").mockResolvedValue({ asset: ASSET });
    vi.spyOn(api, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
    const replace = vi.spyOn(api, "ReplaceGameAssetTags");
    render(<AssetTagEditor projectArchived api={api} asset={ASSET} name="药水" onSaved={() => {}} onClose={() => {}} />);
    await screen.findByText("请先恢复归档项目或资产，再修改标签。");
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("retains a conflict draft and submits only after explicit confirmation with a fresh key/revision", async () => {
    const api = new GameAssetsApi();
    const get = vi.spyOn(api, "GetGameAsset").mockResolvedValueOnce({ asset: ASSET }).mockResolvedValue({ asset: { ...ASSET, revision: 2, tags: ["另一窗口"] } });
    vi.spyOn(api, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
    const replace = vi.spyOn(api, "ReplaceGameAssetTags").mockRejectedValueOnce(new GameAssetsApiError("conflict", 409)).mockResolvedValue({ success: true, asset: { ...ASSET, revision: 3 } });
    const saved = vi.fn();
    render(<AssetTagEditor api={api} asset={ASSET} name="药水" onSaved={saved} onClose={() => {}} />);
    await screen.findByRole("button", { name: "移除标签：物品" });
    fireEvent.change(screen.getByLabelText("自定义资产标签"), { target: { value: "我的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await screen.findByText("最新标签：另一窗口");
    expect(screen.getByText("你的草稿：我的草稿、物品")).toBeTruthy();
    expect(replace).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "核对后重新保存草稿" }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(replace.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(replace.mock.calls[1][3]).not.toBe(replace.mock.calls[0][3]);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("reuses the request body and key after a lost response", async () => {
    const api = new GameAssetsApi();
    vi.spyOn(api, "GetGameAsset").mockResolvedValue({ asset: ASSET });
    vi.spyOn(api, "ListProjectAssetTags").mockResolvedValue({ items: [], next_cursor: null, has_more: false });
    const replace = vi.spyOn(api, "ReplaceGameAssetTags").mockRejectedValueOnce(new GameAssetsApiError("连接中断", 0)).mockResolvedValue({ success: true, asset: ASSET });
    render(<AssetTagEditor api={api} asset={ASSET} name="药水" onSaved={() => {}} onClose={() => {}} />);
    await screen.findByRole("button", { name: "移除标签：物品" });
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await screen.findByText("连接中断");
    fireEvent.click(screen.getByRole("button", { name: "保存标签" }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(2));
    expect(replace.mock.calls[0]).toEqual(replace.mock.calls[1]);
  });

  it("keeps hidden selections in the export after filtering", async () => {
    const build = vi.fn().mockResolvedValue(undefined);
    render(<DeliveryDialog supportsTags items={[
      { asset: "a", name: "药水", kind: "图标", candidate: "候选", version: "va", tags: ["物品"] },
      { asset: "b", name: "火球", kind: "图标", candidate: "候选", version: "vb", tags: ["技能"] },
    ]} target="generic" onTarget={() => {}} onBuild={build} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("交付清单标签过滤"), { target: { value: "物品" } });
    expect(screen.queryByLabelText("本次交付：火球")).toBeNull();
    expect(screen.getByText("可见已选 1 项 / 隐藏已选 1 项 / 导出总数 2 项")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("我已核对本次资产、版本、交付目标与未包含项"));
    fireEvent.click(screen.getByRole("button", { name: "构建这份交付清单" }));
    await waitFor(() => expect(build).toHaveBeenCalled());
    expect(build.mock.calls[0][0]).toEqual([{ asset_token: "a", version_token: "va" }, { asset_token: "b", version_token: "vb" }]);
  });
});
