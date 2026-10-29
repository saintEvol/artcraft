import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GameAssetsApi, GameAssetsApiError, type GameAssetInfo } from "@storyteller/api";
import { CharacterTagSuggest, characterTagNameSuggestions } from "./CharacterTagSuggest";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("derives deterministic name suggestions without repeating existing tags", () => {
  expect(characterTagNameSuggestions({ stable_key: "hero_knight", tags: ["角色"] })).toEqual(["hero", "knight"]);
  expect(characterTagNameSuggestions({ stable_key: "hero_knight", tags: ["hero"] })[0]).toBe("角色");
});

it("shows a failed save inline and stays usable without blocking the surrounding page", async () => {
  const api = new GameAssetsApi();
  const saved = { ...asset(), tags: ["hero"] };
  const save = vi.spyOn(api, "ReplaceGameAssetTags")
    .mockRejectedValueOnce(new GameAssetsApiError("标签保存冲突，请核对最新标签。", 409, "revision_conflict"))
    .mockResolvedValueOnce({ success: true, asset: saved });
  const read = vi.spyOn(api, "GetGameAsset").mockResolvedValue({ asset: saved });
  const onSaved = vi.fn();
  render(<CharacterTagSuggest api={api} asset={asset()} name="Hero Knight" projectArchived={false} onSaved={onSaved} />);
  fireEvent.click(screen.getByRole("button", { name: "+ hero" }));
  fireEvent.click(screen.getByRole("button", { name: "保存所选标签" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "标签保存冲突，请核对最新标签。");
  // The failure is contained in this section: the same chips and save stay usable.
  expect((screen.getByRole("button", { name: "hero ✓" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "保存所选标签" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved));
  expect(save).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledWith("asset");
  expect(screen.queryByRole("alert")).toBeNull();
});

function asset(): GameAssetInfo {
  return { token: "asset", project_token: "project", stable_key: "hero_knight", kind: "character_3d", tags: [],
    maybe_current_version_token: null, revision: 3, maybe_archived_at: null, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };
}
