export interface RiggedCharacterImportV2 {
  idempotency_key: string;
  upload_token: string;
  profile_token: string;
  expected_revision: number;
  maybe_parent_version_token?: string | null;
  /** Exact scene-0 paths; never match joints by their leaf names. */
  semantic_bones: Record<string, string[]>;
  motion_root_path: string[];
}

export interface GameValidationRunV2 {
  success: boolean;
  run_token: string;
  asset_token: string;
  maybe_version_token: string | null;
  supplier_calls: number;
}

export interface GameRunInfoV2 {
  token: string;
  project_token: string;
  status: string;
  recipe: string;
  revision: number;
  cancel_requested: boolean;
  budget_limit: number;
  reserved_cost: number;
  settled_cost: number;
}

export interface GameRunStepV2 {
  token: string;
  maybe_asset_token: string | null;
  kind: string;
  status: string;
  step_key: string;
  maybe_direction: string | null;
  maybe_frame_index: number | null;
  maybe_latest_attempt: {
    token: string;
    execution_token: string;
    status: string;
    submission_phase: string;
    maybe_result: Record<string, unknown> | null;
    maybe_error: Record<string, unknown> | null;
  } | null;
}

export interface GameRunDetailsV2 {
  success: boolean;
  run: GameRunInfoV2;
  steps: GameRunStepV2[];
  steps_next_cursor: string | null;
  steps_has_more: boolean;
}

export interface GameRunControlV2 {
  success: boolean;
  run: GameRunInfoV2;
  supplier_calls: number;
}

/** Keyset traversal includes all directions/frames. Step state may advance
 * during traversal; callers refresh to observe newer results. */
export async function readAllRunStepsV2(
  run: string,
  getPage: (cursor?: string) => Promise<GameRunDetailsV2>,
  cancelled: () => boolean = () => false,
): Promise<GameRunDetailsV2> {
  const first = await getPage();
  const steps: GameRunStepV2[] = [];
  const tokens = new Set<string>(), cursors = new Set<string>();
  let page = first;
  for (;;) {
    if (cancelled()) throw new Error("任务读取已取消。");
    if (!page.success || page.run.token !== run || page.run.project_token !== first.run.project_token || page.run.recipe !== first.run.recipe) {
      throw new Error("步骤分页不属于同一任务，请重新读取。");
    }
    if (page.steps_has_more !== (page.steps_next_cursor !== null) || page.steps.length > 100) {
      throw new Error("任务步骤分页合同不完整。");
    }
    for (const step of page.steps) {
      if (!step.token || tokens.has(step.token)) throw new Error("任务分页包含重复或无效步骤。");
      tokens.add(step.token); steps.push(step);
    }
    if (steps.length > 10000) throw new Error("任务超出自动读取预算，请按页查看步骤。");
    if (!page.steps_has_more) break;
    const cursor = page.steps_next_cursor!;
    if (!cursor || cursors.has(cursor) || page.steps.length === 0) throw new Error("任务步骤分页无法继续，结果尚未完整读取。");
    cursors.add(cursor);
    page = await getPage(cursor);
  }
  // Retain the first projection: a terminal status observed on a later page
  // must not label earlier, still-running step snapshots as complete.
  return { ...first, steps, steps_next_cursor: null, steps_has_more: false };
}
