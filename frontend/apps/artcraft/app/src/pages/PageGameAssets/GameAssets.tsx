import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Blocks, Download, FileUp, Loader2, Plus, RefreshCw, Settings2, Eye, Check } from "lucide-react";
import {
  GameAssetsApi,
  GAME_ASSET_KINDS,
  isAnimatedAssetKind,
  ANIMATED_KIND_LABELS,
  gameAssetOperation,
  characterValidationOperation,
  characterCreationV2Operation,
  type GameAssetInfo,
  type GameAssetBriefInfo,
  type GameCreationRun,
  type GameAssetsCapabilities,
  type GameAssetVersionInfo,
  type GameExportInfo,
  type GameProjectInfo,
  type GameProjectProfileInfo,
  type ValidationReportInfo,
} from "@storyteller/api";
import { AssetTagEditor } from "./AssetTagEditor";
import { useProjectTagSuggestions } from "./asset-tags";
import { isKnownAssetKind } from "./profile";
import { ProviderConnectorsDialog } from "./ProviderConnectorsDialog";
import { RiggedCharacterUpload } from "./RiggedCharacterUpload";
import { CharacterMeshLaunch } from "./CharacterMeshLaunch";
import { CharacterTagSuggest } from "./CharacterTagSuggest";
import { ValidationJobs } from "./ValidationJobs";
import { SettingsPanel } from "./SettingsPanel";
import { AssetPreview } from "./AssetPreview";
import { AnimatedAssetPreview } from "./AnimatedAssetPreview";
import { CreationComposer, type CreationProjectChoice, type CreationSeed } from "./CreationComposer";
import { CreationJobs } from "./CreationJobs";
import { assetCandidates, candidateLabel } from "./candidates";
import { AssetThumbnail } from "./AssetThumbnail";
import { CandidateComparison } from "./CandidateComparison";
import { DeliveryDialog, type DeliveryItem } from "./DeliveryDialog";
import { ExportUseDialog } from "./ExportUseDialog";
import { AssetSetComposer, readSetDrafts, type SetDraft, type SetSource } from "./AssetSetComposer";
import { AssetBatchLauncher, pendingBatch } from "./AssetBatchLauncher";
import { AssetBriefEditor } from "./AssetBriefEditor";
import { AssetCollection } from "./AssetCollection";
import { KIND_LABELS, RECOMMENDED_SETTINGS, readSettings, writeSettings, type AssetKind, type OutputSettings } from "./profile";
import "./game-assets.css";
import "./creation.css";

/**
 * Host for the user-facing asset workspace. Settings and previews use
 * real persisted data. Generation and processing retain the same
 * project/asset/version context; an import is never called generation.
 */

const KINDS = GAME_ASSET_KINDS;
const EXPORT_STATUS_LABELS: Record<string, string> = {
  pending: "等待构建", building: "正在构建", succeeded: "可下载，游戏内效果待确认", failed: "构建失败",
};

type GateState = {
  reviewPassed: boolean; validationPassed: boolean; loaded: boolean;
  reviewState: string; validationState: string;
};

type VersionRow = GameAssetVersionInfo & { gate: GateState; validationReport?: ValidationReportInfo; reviewReason?: string };

type AssetRow = GameAssetInfo & { versions: VersionRow[]; brief?: GameAssetBriefInfo; briefOrder?: number };
type ImportOperation = {
  key: string;
  project: string;
  profile: string;
  asset?: string;
  upload?: string;
  uploaded?: boolean;
  sealed?: boolean;
};

/** Server accepts image/png and model/gltf-binary (verified by magic bytes). */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 4 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    return "model/gltf-binary";
  }
  return null;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function GameAssets() {
  const api = useMemo(() => new GameAssetsApi(), []);
  const [capabilities, setCapabilities] = useState<GameAssetsCapabilities | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [projects, setProjects] = useState<GameProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const detailRequestRef = useRef(0);
  const clearSelectionRef = useRef<{ signature: string; key: string } | undefined>(undefined);
  const importKeyRef = useRef<string | null>(null);
  const importOperationRef = useRef<ImportOperation | null>(null);
  const viewEpochRef = useRef(0);
  const importDetailsRef = useRef<HTMLDetailsElement>(null);
  const validationDetailsRef = useRef<HTMLDetailsElement>(null);
  const exportHistoryRef = useRef<HTMLDetailsElement>(null);
  const creationMenuRef = useRef<HTMLDetailsElement>(null);

  // Detail view state.
  const [project, setProject] = useState<GameProjectInfo | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [exportsList, setExportsList] = useState<GameExportInfo[]>([]);
  const [exportUse, setExportUse] = useState<GameExportInfo | undefined>(undefined);
  const [detailBusy, setDetailBusy] = useState<string | null>(null);
  const [projectRead, setProjectRead] = useState<{ status: "idle" | "loading" | "ready" | "failed"; hasSnapshot: boolean }>({ status: "idle", hasSnapshot: false });
  const [profile, setProfile] = useState<GameProjectProfileInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rigUploadOpen, setRigUploadOpen] = useState(false);
  const [meshLaunchSeed, setMeshLaunchSeed] = useState<{ asset: string; version?: string }>();
  const [validationRefresh, setValidationRefresh] = useState(0);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [providerConnectorsOpen, setProviderConnectorsOpen] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<{ asset: string; version: string } | null>(null);
  const [readyVersion, setReadyVersion] = useState<string | null>(null);
  const [exportTarget, setExportTarget] = useState("generic");
  const [deliveryOpen, setDeliveryOpen] = useState(false);
  const [deliveryFilter, setDeliveryFilter] = useState<string[] | null>(null);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [collectionGroup, setCollectionGroup] = useState("");
  const [setIntent, setSetIntent] = useState<{ source?: SetSource; initial?: SetDraft }>();
  const [briefEditor, setBriefEditor] = useState<GameAssetBriefInfo>();
  const [launchItems, setLaunchItems] = useState<GameAssetBriefInfo[]>();
  const [creationRuns, setCreationRuns] = useState<GameCreationRun[]>([]);
  const [exportPollError, setExportPollError] = useState<string | null>(null);
  const [creationOpen, setCreationOpen] = useState(false);
  const [hasCreationDraft,setHasCreationDraft]=useState(false);
  const [draftProject,setDraftProject]=useState<string>();
  const [creationSeed, setCreationSeed] = useState<CreationSeed>({ key: crypto.randomUUID(), operation: "generate" });
  const [creationRefresh, setCreationRefresh] = useState(0);
  const [compareToken, setCompareToken] = useState<string | null>(null);
  const [showWorkingFiles, setShowWorkingFiles] = useState(false);
  const autoProject = useRef<{ keys: Map<string, string>; project?: GameProjectInfo }>({ keys: new Map() });
  const initialProfileKeys = useRef(new Map<string, string>());
  const currentProjectToken = useRef(project?.token); currentProjectToken.current = project?.token;
  const onPreviewReady = useCallback((token: string, ready: boolean) => {
    setReadyVersion((old) => ready ? token : old === token ? null : old);
  }, []);

  const archiveRangeRef = useRef(false);
  const [tagEditor, setTagEditor] = useState<GameAssetInfo>();
  const [tagRevision, setTagRevision] = useState(0);
  const [browseKind, setBrowseKind] = useState("");
  const [browseTag, setBrowseTag] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filteredTokens, setFilteredTokens] = useState<Set<string> | null>(null);
  const [filterError, setFilterError] = useState("");
  const [filterBusy, setFilterBusy] = useState(false);
  const canOperate = (assetKind: string, operation: string) => gameAssetOperation(capabilities, assetKind, operation).enabled;
  const tagsEnabled = capabilities?.organization?.supports_asset_tags === true;
  const tagSuggestions = useProjectTagSuggestions(api, project?.token ?? "", tagsEnabled && !!project, tagRevision);

  // Add-asset form.
  const [stableKey, setStableKey] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("icon_2d");
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [addProgress, setAddProgress] = useState<string | null>(null);

  const [problemDrafts, setProblemDrafts] = useState<Record<string, string>>({});
  const rejectReason = previewVersion ? problemDrafts[previewVersion.version] ?? "" : "";
  const setRejectReason = (value: string) => {
    const token = previewVersion?.version;
    if (token) setProblemDrafts((old) => ({ ...old, [token]: value }));
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      for (const ref of [exportHistoryRef, creationMenuRef]) {
        const menu = ref.current;
        if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") for (const ref of [exportHistoryRef, creationMenuRef]) if (ref.current) ref.current.open = false; };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => { document.removeEventListener("pointerdown", closeOutside, true); document.removeEventListener("keydown", closeOnEscape); };
  }, []);
  useEffect(() => { if ((exportUse || deliveryOpen) && exportHistoryRef.current) exportHistoryRef.current.open = false; }, [exportUse, deliveryOpen]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await allPages((cursor) => api.ListProjects({ maybe_limit: 100, maybe_cursor: cursor }));
      setProjects(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    api
      .GetCapabilities()
      .then((caps: GameAssetsCapabilities) => {
        if (!cancelled) setCapabilities(caps);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const status =
          typeof e === "object" && e !== null && "status" in e
            ? Number((e as { status?: number }).status)
            : NaN;
        if (status === 404 || status === 405) {
          setUnsupported(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (capabilities) void refresh();
  }, [capabilities, refresh]);

  const loadProjectDetail = useCallback(
    async (projectToken: string, refreshedCapabilities?: GameAssetsCapabilities) => {
      const caps = refreshedCapabilities ?? capabilities;
      const requestId = ++detailRequestRef.current;
      setProjectRead((old) => ({ ...old, status: "loading" }));
      setDetailBusy("加载项目…");
      setError(null);
      try {
        const [projectResponse, projectAssets, exportsResponse, briefItems] = await Promise.all([
          api.GetGameProject(projectToken),
          allPages((cursor) => api.ListGameAssets(projectToken, { maybe_cursor: cursor, maybe_include_archived: includeArchived })),
          api.ListProjectExports(projectToken),
          caps?.creation?.supports_asset_briefs ? allPages((cursor) => api.ListAssetBriefs(projectToken, cursor)) : Promise.resolve([] as GameAssetBriefInfo[]),
        ]);
        const current = projectResponse.project;
        const currentProfile = current.maybe_current_profile_token
          ? (await api.GetGameProjectProfile(current.maybe_current_profile_token)).profile : null;
        const loaded: AssetRow[] = [];
        for (const asset of projectAssets) {
          if (requestId !== detailRequestRef.current) return;
          const versions = (isKnownAssetKind(asset.kind) || isAnimatedAssetKind(asset.kind)) ? await allPages((cursor) => api.ListGameAssetVersions(asset.token, cursor)) : [];
          const rows: VersionRow[] = [];
          for (const version of versions) {
            if (isAnimatedAssetKind(asset.kind)) {
              rows.push({ ...version, gate: { loaded: false, reviewPassed: false, validationPassed: false, reviewState: "not_checked", validationState: "needs_recheck" } });
              continue;
            }
            const [reviews, validations] = await Promise.allSettled([
              api.ListReviews(version.token),
              api.ListValidations(version.token),
            ]);
            const reviewState = reviews.status === "fulfilled" ? reviews.value.events[0]?.decision ?? "not_checked" : "unavailable";
            const validationReport = validations.status === "fulfilled" ? validations.value.items[0] : undefined;
            const validationState = validations.status !== "fulfilled" ? "unavailable" : !validationReport ? "not_checked"
              : validationReport.validator_version !== caps?.validation_version ? "needs_recheck" : validationReport.status;
            rows.push({
              ...version,
              validationReport,
              reviewReason: reviews.status === "fulfilled" ? reviews.value.events[0]?.maybe_reason ?? undefined : undefined,
              gate: {
                loaded: reviews.status === "fulfilled" && validations.status === "fulfilled",
                reviewPassed: reviewState === "passed",
                validationPassed: validationState === "passed",
                reviewState, validationState,
              },
            });
          }
          loaded.push({ ...asset, versions: rows, brief: briefItems.find((brief) => brief.asset_token === asset.token), briefOrder: briefItems.findIndex((brief) => brief.asset_token === asset.token) });
        }
        if (requestId === detailRequestRef.current) {
          setProject(current);
          setProfile(currentProfile);
          setAssets(loaded); setPreviewRefresh((value) => value + 1);
          setExportsList(exportsResponse.items);
          setProjectRead({ status: "ready", hasSnapshot: true });
        }
      } catch (e) {
        if (requestId === detailRequestRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setProjectRead((old) => ({ ...old, status: "failed" }));
        }
      } finally {
        if (requestId === detailRequestRef.current) setDetailBusy(null);
      }
    },
    [api, capabilities?.validation_version, capabilities?.creation?.supports_asset_briefs, includeArchived],
  );

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setFilterError("");
    if (!browseKind && (!tagsEnabled || !browseTag)) { setFilteredTokens(null); setFilterBusy(false); return; }
    setFilteredTokens(new Set()); setFilterBusy(true);
    void allPages((cursor) => api.ListGameAssets(project.token, {
      maybe_cursor: cursor, maybe_kind: browseKind || undefined,
      maybe_tag: tagsEnabled ? browseTag || undefined : undefined, maybe_include_archived: includeArchived,
    })).then((items) => { if (!cancelled) setFilteredTokens(new Set(items.map((item) => item.token))); })
      .catch((problem) => { if (!cancelled) setFilterError(problem.message); })
      .finally(() => { if (!cancelled) setFilterBusy(false); });
    return () => { cancelled = true; };
  }, [api, project?.token, assets, browseKind, browseTag, includeArchived, tagsEnabled, tagRevision]);

  useEffect(() => {
    if (archiveRangeRef.current !== includeArchived && project) void loadProjectDetail(project.token);
    archiveRangeRef.current = includeArchived;
  }, [includeArchived, project?.token, loadProjectDetail]);

  const refreshProject = async (token: string) => {
    const epoch = viewEpochRef.current;
    setDetailBusy("读取服务能力与项目…"); setError(null);
    try {
      const caps = await api.GetCapabilities();
      if (epoch !== viewEpochRef.current) return;
      setCapabilities(caps);
      await loadProjectDetail(token, caps);
    } catch (problem) {
      if (epoch === viewEpochRef.current) { setDetailBusy(null); setError(problem instanceof Error ? problem.message : "服务能力暂时无法读取，请重试。"); }
    }
  };

  const setArchive = async (asset: GameAssetInfo, archived: boolean) => {
    const token = asset.project_token; const epoch = viewEpochRef.current;
    setDetailBusy(archived ? "正在归档资产…" : "正在恢复资产…");
    try { await api.ArchiveGameAsset(asset, archived); if (epoch !== viewEpochRef.current) return; setTagRevision((value) => value + 1); await loadProjectDetail(token); }
    catch (problem) { if (epoch === viewEpochRef.current) { setError(problem instanceof Error ? problem.message : "归档状态尚未确认，请刷新后重试。"); setDetailBusy(null); } }
  };

  const openProject = async (target: GameProjectInfo) => {
    setRenaming(false); setCreationRuns([]); setCollectionGroup(""); setBrowseKind(""); setBrowseTag(""); setFilteredTokens(null); setTagEditor(undefined);
    viewEpochRef.current++;
    setProjectRead({ status: "loading", hasSnapshot: false });
    setAssets([]);
    setExportsList([]);
    setExportUse(undefined);
    setProfile(null);
    setPreviewVersion(null);
    setCompareToken(null);
    setReadyVersion(null);
    setNotice(null);
    setError(null);
    setAddProgress(null);
    setExportPollError(null);
    importKeyRef.current = null;
    importOperationRef.current = null;
    setExportTarget("generic");
    setProject(target);
    await loadProjectDetail(target.token);
  };

  const renameProject = async () => {
    if (!project || detailBusy || !projectNameDraft.trim()) return;
    const captured = project; const epoch = viewEpochRef.current; const name = projectNameDraft.trim();
    setDetailBusy("保存项目名称…"); setError(null);
    try {
      const fresh = (await api.GetGameProject(captured.token)).project;
      if (fresh.name === name) {
        if (epoch === viewEpochRef.current) { setProject(fresh); setRenaming(false); }
        return;
      }
      if (fresh.revision !== captured.revision) {
        if (epoch === viewEpochRef.current) setProject(fresh);
        throw new Error("项目已在另一处更新。已读取最新状态，请核对名称后再次保存。");
      }
      const result = await api.RenameGameProject(captured.token, name, captured.revision);
      if (epoch === viewEpochRef.current) { setProject(result.project); setRenaming(false); }
    } catch (problem) { if (epoch === viewEpochRef.current) setError(problem instanceof Error ? problem.message : "名称尚未确认保存，请重试。"); }
    finally { if (epoch === viewEpochRef.current) setDetailBusy(null); }
  };

  const createProject = async () => {
    if (creatingProject) return;
    const epoch = viewEpochRef.current;
    const name = newName.trim();
    if (!name) return;
    setError(null);
    setCreatingProject(true);
    if (!createKeyRef.current) {
      createKeyRef.current = crypto.randomUUID();
    }
    try {
      const created = await api.CreateGameProject({ name, maybe_idempotency_key: createKeyRef.current });
      if (epoch !== viewEpochRef.current) return;
      createKeyRef.current = null;
      setNewName("");
      await refresh();
      await openProject(created.project);
    } catch (e) {
      if (epoch === viewEpochRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingProject(false);
    }
  };

  const saveSettings = async (settings: OutputSettings, idempotencyKey: string, animationSpecs?: Record<string, unknown>) => {
    if (!project) throw new Error("请先选择一个项目。");
    const next = writeSettings(settings, profile?.profile_json);
    if (animationSpecs) next.specs = { ...(next.specs as Record<string, unknown>), ...animationSpecs };
    await api.PublishGameProjectProfile(project.token, {
      schema_version: animationSpecs && Object.keys(animationSpecs).length ? 2 : profile?.schema_version ?? 1,
      profile_json: next,
      references: settings.referenceTokens.map((token) => ({ game_artifact_token: token, reference_role: "style" })),
      maybe_expected_revision: project.revision,
      maybe_idempotency_key: idempotencyKey,
    });
    setNotice("项目设置已保存。已有版本保留原设置，后续制作使用新设置。");
    await loadProjectDetail(project.token);
  };

  const ensureCreationProject = async (choice?: CreationProjectChoice) => {
    const epoch = viewEpochRef.current;
    let target = project;
    if (!target) {
      if (!choice) throw new Error("请先选择要保存到的项目，或输入新项目名称。");
      if (choice.mode === "existing") {
        target = (await api.GetGameProject(choice.token)).project;
      } else {
        const name = choice.name.trim();
        if (!name) throw new Error("请输入新项目名称。");
        let key = autoProject.current.keys.get(name);
        if (!key) { key = crypto.randomUUID(); autoProject.current.keys.set(name, key); }
        const created = await api.CreateGameProject({ name, maybe_idempotency_key: key });
        autoProject.current.project = created.project;
        target = created.project;
      }
    }
    let fresh = (await api.GetGameProject(target.token)).project;
    let currentProfile: GameProjectProfileInfo;
    if (fresh.maybe_current_profile_token) currentProfile = (await api.GetGameProjectProfile(fresh.maybe_current_profile_token)).profile;
    else {
      let key = initialProfileKeys.current.get(fresh.token);
      if (!key) { key = crypto.randomUUID(); initialProfileKeys.current.set(fresh.token, key); }
      const saved = await api.PublishGameProjectProfile(fresh.token, {
        schema_version: 1, profile_json: writeSettings(RECOMMENDED_SETTINGS), references: [],
        maybe_expected_revision: fresh.revision, maybe_idempotency_key: key,
      });
      currentProfile = saved.profile;
      fresh = (await api.GetGameProject(fresh.token)).project;
    }
    if (epoch === viewEpochRef.current) {
      setProject(fresh); setProfile(currentProfile);
      if (!project) {
        setProjectRead({ status: "loading", hasSnapshot: false });
        void loadProjectDetail(fresh.token);
      }
    }
    return { project: fresh, profile: currentProfile };
  };
  const beginCreation = (operation: CreationSeed["operation"] = "generate", source?: CreationSeed["source"], useAsStyle = false, change?: string) => {
    const recorded = source ? assets.find((asset) => asset.token === source.version.asset_token)?.versions.find((version) => version.token === source.version.token)?.reviewReason : undefined;
    setCreationSeed({ key: crypto.randomUUID(), operation, source, useAsStyle, initialChange: ["edit", "inpaint"].includes(operation) ? change || rejectReason || recorded || undefined : undefined });
    setCreationOpen(true);
  };
  const continueCreationDraft=async()=>{
    if(draftProject&&draftProject!==project?.token){const target=(await api.GetGameProject(draftProject)).project;await openProject(target);}
    if(!draftProject&&project){detailRequestRef.current++;viewEpochRef.current++;setProject(null);setProfile(null);}
    setCreationOpen(true);
  };

  const addAsset = async () => {
    if (!project || !file) return;
    const availability = gameAssetOperation(capabilities, kind, "import");
    if (!availability.enabled) { setError(availability.reason ?? "当前实例不能导入此类型。"); return; }
    const epoch = viewEpochRef.current;
    const stillHere = () => epoch === viewEpochRef.current;
    const progress = (label: string) => { if (stillHere()) setAddProgress(label); };
    const key = stableKey.trim();
    if (!key || key.length > 100) {
      setError("请填写 1–100 个字符的资产名称。");
      return;
    }
    if (!project.maybe_current_profile_token) {
      setError("请先保存项目制作设置。");
      return;
    }
    // Capture the operation before file/hash awaits. A late result must
    // never take over the refs belonging to a newly opened project.
    if (!importKeyRef.current) importKeyRef.current = crypto.randomUUID();
    const importKey = importKeyRef.current;
    if (!importOperationRef.current || importOperationRef.current.key !== importKey) {
      importOperationRef.current = { key: importKey, project: project.token, profile: project.maybe_current_profile_token };
    }
    const operation = importOperationRef.current;
    if (operation.profile !== project.maybe_current_profile_token) {
      setNotice("继续上次未完成的导入，保留它开始时的设置。完成后可再重新加工。");
    }
    setError(null);
    try {
      progress("读取文件…");
      const bytes = await file.arrayBuffer();
      const mime = sniffMime(new Uint8Array(bytes.slice(0, 12)));
      if (!mime) {
        throw new Error("仅支持 PNG（2D）与 GLB（3D）文件");
      }
      const expectedKind = mime === "image/png" ? "image/png" : "model/gltf-binary";
      if ((expectedKind === "image/png" && kind === "prop_3d") || (expectedKind !== "image/png" && kind !== "prop_3d")) {
        throw new Error(`文件类型与资产类型不匹配：${kind} 需要 ${kind === "prop_3d" ? "GLB" : "PNG"}`);
      }
      progress("校验文件内容…");
      const sha = await sha256Hex(bytes);
      progress("准备私有上传…");
      if (!operation.upload) {
        const upload = await api.CreateGameUpload(operation.project, {
          expected_size: bytes.byteLength, expected_sha256_hex: sha, expected_mime: expectedKind,
          maybe_idempotency_key: operation.key,
        });
        operation.upload = upload.upload.token;
      }
      if (!operation.uploaded) {
        progress("上传文件…");
        await api.PutGameUploadContent(`/v1/game_assets/uploads/${operation.upload}/content`, bytes);
        operation.uploaded = true;
      }
      if (!operation.sealed) {
        progress("封存并校验…");
        await api.CompleteGameUpload(operation.upload);
        operation.sealed = true;
      }
      if (!operation.asset) {
        progress("创建资产…");
        const created = await api.CreateGameAsset(operation.project, {
          stable_key: `asset_${importKey.replaceAll("-", "").slice(0, 24)}`, kind, maybe_idempotency_key: importKey,
        });
        operation.asset = created.asset.token;
      }
      progress("保存新版本…");
      const savedVersion = await api.CreateGameAssetVersionFromUpload(operation.asset, {
        game_upload_token: operation.upload,
        maybe_display_name: key,
        maybe_profile_token: operation.profile,
        maybe_idempotency_key: operation.key,
      });
      if (!stillHere()) return;
      importKeyRef.current = null;
      importOperationRef.current = null;
      setReadyVersion(null);
      setPreviewVersion({ asset: operation.asset, version: savedVersion.version.token });
      if (importDetailsRef.current) importDetailsRef.current.open = false;
      setStableKey("");
      setFile(null);
      setFileInputKey((n) => n + 1);
      setAddProgress(null);
      setNotice(`资产 ${key} 已创建（版本 1）`);
      await loadProjectDetail(project.token);
    } catch (e) {
      if (stillHere()) {
        setAddProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const runValidation = async (version: VersionRow) => {
    if (!project) return;
    const epoch = viewEpochRef.current;
    const name = assets.find((asset) => asset.token === version.asset_token);
    setDetailBusy(`正在检查${name ? `“${assetName(name)}”` : "素材"}第 ${version.version} 版…`);
    setError(null);
    try {
      const result = await api.CreateValidation(version.token, {
        maybe_idempotency_key: crypto.randomUUID(),
      });
      if (epoch !== viewEpochRef.current) return;
      if (result.report.status !== "passed") {
        const problem = `${name ? assetName(name) : "素材"} · 第 ${version.version} 版：${reportProblems(result.report)}`;
        setNotice(null);
        await loadProjectDetail(project.token);
        if (epoch === viewEpochRef.current) setError(problem);
        return;
      }
      setNotice(`${name ? assetName(name) : "素材"} · 第 ${version.version} 版文件检查完成，请在预览中确认视觉效果与实际用途。`);
      await loadProjectDetail(project.token);
    } catch (e) {
      if (epoch === viewEpochRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch === viewEpochRef.current) setDetailBusy(null);
    }
  };

  const review = async (version: VersionRow, decision: "passed" | "rejected", reason?: string, onSuccess?: () => void) => {
    if (!project) return;
    const epoch = viewEpochRef.current;
    const concept = version.spec_json.stage === "concept";
    setDetailBusy(decision === "passed" ? concept ? "正在保存概念确认…" : "正在保存交付版本选择…" : "正在记录需要修改的问题…");
    setError(null);
    try {
      if (decision === "passed" && readyVersion !== version.token) {
        throw new Error("请先打开并查看这个版本的预览，再选择交付版本。");
      }
      if (decision === "passed" && !concept) {
        const validation = await api.CreateValidation(version.token, { maybe_idempotency_key: crypto.randomUUID() });
        if (validation.report.status !== "passed") {
          await loadProjectDetail(project.token);
          throw new Error(reportProblems(validation.report));
        }
      }
      await api.SubmitReview(version.token, {
        decision,
        ...(decision === "rejected"
          ? { maybe_rejection_kind: "other", maybe_reason: reason || "未填写原因" }
          : {}),
        maybe_idempotency_key: crypto.randomUUID(),
      });
      if (decision === "passed" && !concept) {
        const asset = assets.find((entry) => entry.token === version.asset_token);
        if (!asset) throw new Error("资产状态已变化，请刷新后重试。");
        await api.AdoptGameAssetVersion(asset, version.token);
        if (epoch !== viewEpochRef.current) return;
        setNotice(`已选定“${assetName(asset)}”第 ${version.version} 版用于交付。引擎中的实际效果仍需导入后确认。`);
      }
      if (epoch !== viewEpochRef.current) return;
      if (concept && decision === "passed") setNotice("已确认这个概念；模型仍需单独查看费用后才能开始制作。");
      setRejectReason("");
      await loadProjectDetail(project.token);
      if (epoch === viewEpochRef.current) onSuccess?.();
    } catch (e) {
      if (epoch === viewEpochRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch === viewEpochRef.current) setDetailBusy(null);
    }
  };

  const clearSelection = async (asset: AssetRow) => {
    if (!project || detailBusy || !asset.maybe_current_version_token) return;
    const epoch = viewEpochRef.current;
    const signature = JSON.stringify([asset.token, asset.revision, asset.maybe_current_version_token]);
    if (clearSelectionRef.current?.signature !== signature) clearSelectionRef.current = { signature, key: crypto.randomUUID() };
    setDetailBusy("正在撤回这个资产的交付选择…"); setError(null);
    try {
      await api.ClearGameAssetSelection(asset, clearSelectionRef.current.key);
      clearSelectionRef.current = undefined;
      if (epoch !== viewEpochRef.current) return;
      setNotice(`已撤回“${assetName(asset)}”的交付选择。可继续修改候选，或重新选入交付。`);
      await loadProjectDetail(project.token);
    } catch (problem) {
      if (epoch === viewEpochRef.current) setError(problem instanceof Error ? problem.message : "撤回结果尚未确认，请刷新当前选择或重试同一次操作。");
    } finally { if (epoch === viewEpochRef.current) setDetailBusy(null); }
  };

  const createExport = async (selections: { asset_token: string; version_token: string }[], key: string) => {
    if (!project) return;
    const epoch = viewEpochRef.current;
    if (selections.length === 0) {
      setError("尚未选定可交付版本。请先预览素材、处理文件检查问题，再点击“选入交付”。");
      return;
    }
    setDetailBusy("正在准备选定版本的交付包…");
    setError(null);
    try {
      const created = await api.CreateGameExport(project.token, {
        selections,
        export_kinds: [exportTarget],
        maybe_idempotency_key: key,
      });
      if (epoch !== viewEpochRef.current) return;
      setExportsList((old) => [...created.exports, ...old.filter((entry) => !created.exports.some((next) => next.token === entry.token))]);
      setNotice("已开始构建选定版本，完成后可下载。离开后仍可在这个项目中查看结果。");
      setExportUse(created.exports[0]);
    } catch (e) {
      if (epoch === viewEpochRef.current) setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      if (epoch === viewEpochRef.current) setDetailBusy(null);
    }
  };

  const prepareExportV2 = async (selections: { asset_token: string; version_token: string }[], key: string) => {
    if (!project) throw new Error("项目尚未读取。");
    const epoch = viewEpochRef.current;
    setDetailBusy("正在解析交付闭包…");
    setError(null);
    try {
      return await api.PrepareGameExportV2(project.token, { idempotency_key: key, selections });
    } catch (problem) {
      if (epoch === viewEpochRef.current) setError(problem instanceof Error ? problem.message : "解析结果尚未确认，请重试同一清单。");
      throw problem;
    } finally { if (epoch === viewEpochRef.current) setDetailBusy(null); }
  };

  const createExportV2 = async (preparation: Awaited<ReturnType<typeof api.PrepareGameExportV2>>, target: string, key: string) => {
    if (!project) return;
    const epoch = viewEpochRef.current;
    setDetailBusy("正在准备选定版本的交付包…");
    setError(null);
    try {
      const created = await api.CreateGameExportV2(project.token, {
        idempotency_key: key,
        preparation_token: preparation.preparation_token,
        export_kinds: [target],
      });
      if (epoch !== viewEpochRef.current) return;
      setExportsList((old) => [...created.exports, ...old.filter((entry) => !created.exports.some((next) => next.token === entry.token))]);
      setNotice("已按解析好的交付闭包开始构建，完成后可下载。离开后仍可在这个项目中查看结果。");
      setExportUse(created.exports[0]);
    } catch (problem) {
      if (epoch === viewEpochRef.current) setError(problem instanceof Error ? problem.message : "构建结果尚未确认，请刷新后重试。");
      throw problem;
    } finally { if (epoch === viewEpochRef.current) setDetailBusy(null); }
  };

  // Poll unfinished exports; the worker flips pending → building → terminal.
  const hasUnfinished = exportsList.some((e) => e.status === "pending" || e.status === "building");
  const exportTokens = exportsList.map((e) => e.token).join("|");
  useEffect(() => {
    if (!project || !hasUnfinished) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const updated = await Promise.all(
          exportsList.map((e) => api.GetGameExport(e.token).then((r) => r.export)),
        );
        if (!cancelled) {
          const byToken = new Map(updated.map((entry) => [entry.token, entry]));
          setExportsList((old) => old.map((entry) => byToken.get(entry.token) ?? entry));
          setExportPollError(null);
        }
      } catch {
        if (!cancelled) setExportPollError("交付状态暂时无法刷新，正在重试。已经提交的构建不会因此重新开始。");
      }
    }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, project?.token, hasUnfinished, exportTokens]);

  const downloadExport = async (exportToken: string) => {
    const epoch = viewEpochRef.current;
    const name = project?.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") ?? "游戏资产";
    const target = exportsList.find((entry) => entry.token === exportToken)?.export_kind ?? "资源";
    setDetailBusy("下载 ZIP…");
    try {
      const blob = await api.DownloadGameExport(exportToken);
      downloadBlob(blob, `${name}-${target}.zip`);
    } catch (e) {
      if (epoch === viewEpochRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch === viewEpochRef.current) setDetailBusy(null);
    }
  };

  const retryCapabilities = async () => {
    setLoading(true); setError(null); setUnsupported(false);
    try {
      setCapabilities(await api.GetCapabilities());
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "服务暂时无法读取，请稍后重试。");
    } finally { setLoading(false); }
  };

  if (unsupported) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md rounded-lg border border-ui-controls-border bg-ui-controls p-6 text-center">
          <h2 className="mb-2 text-lg font-semibold">Game Assets 不可用</h2>
          <p className="text-sm text-base-fg/70">
            当前连接的服务器还不支持游戏资产工作台。请升级 artcraft-services 后重试。
          </p>
          <button type="button" className="ga-action" onClick={() => void retryCapabilities()}>重新检查服务</button>
        </div>
      </div>
    );
  }

  const previewAsset = assets.find((asset) => asset.token === previewVersion?.asset);
  const selectedVersion = previewAsset?.versions.find((version) => version.token === previewVersion?.version);
  const candidates = assetCandidates(previewAsset?.versions ?? []);
  const currentCandidate = candidates.find((candidate) => candidate.files.some((version) => version.token === selectedVersion?.token));

  const creationDialog = <CreationComposer key="creation-composer" api={api} open={creationOpen} seed={creationSeed}
    capabilities={capabilities} project={project} profile={profile} projects={projects} ensureProject={ensureCreationProject} onDraftChanged={(active,token)=>{setHasCreationDraft(active);setDraftProject(token);}}
    onClose={() => setCreationOpen(false)} onUnconfirmed={(token) => { if (currentProjectToken.current === token) setCreationRefresh((old) => old + 1); }}
    onStarted={(token) => { if (currentProjectToken.current === token) { setCreationRefresh((old) => old + 1); void loadProjectDetail(token); } }} />;
  const creationSource = previewAsset && isKnownAssetKind(previewAsset.kind) && selectedVersion ? { version: selectedVersion, kind: previewAsset.kind as AssetKind, name: assetName(previewAsset) } : undefined;
  const conceptSource = previewAsset && selectedVersion ? findConceptSource(previewAsset, selectedVersion) : undefined;
  const problemSource = previewAsset?.kind === "prop_3d" && selectedVersion?.spec_json.stage !== "concept" ? conceptSource ? { version: conceptSource, kind: "prop_3d" as AssetKind, name: assetName(previewAsset) } : undefined : creationSource;
  const compareVersion = previewAsset?.versions.find((version) => version.token === compareToken);
  const styleSources = assets.filter((asset) => isKnownAssetKind(asset.kind) && !asset.maybe_archived_at).flatMap((asset) => asset.kind === "prop_3d"
    ? asset.versions.filter((version) => version.spec_json.stage === "concept").map((version) => ({ version, kind: asset.kind as AssetKind, name: `${String(version.spec_json.display_name ?? assetName(asset))} · 概念第 ${version.version} 版` }))
    : assetCandidates(asset.versions).map((candidate) => ({ version: candidate.version, kind: asset.kind as AssetKind, name: `${String(candidate.version.spec_json.display_name ?? assetName(asset))} · ${candidateLabel(candidate)}` })));
  const sourceFor = (token: string) => styleSources.find((source) => source.version.token === token);
  const initialDetailsUnknown = !projectRead.hasSnapshot && projectRead.status !== "idle";
  const initialReadFailed = initialDetailsUnknown && projectRead.status === "failed";
  const afterCreation = (token: string) => { if (currentProjectToken.current === token) { setCreationRefresh((value) => value + 1); void loadProjectDetail(token); } };
  const openBrief = (brief: GameAssetBriefInfo) => { setLaunchItems([brief]); };

  const deliveryItems: DeliveryItem[] = assets.map((asset) => {
    const selected = asset.versions.find((version) => version.token === asset.maybe_current_version_token);
    const ready = isKnownAssetKind(asset.kind) && !asset.maybe_archived_at && selected?.gate.reviewPassed && selected.gate.validationPassed;
    const candidate = selected ? assetCandidates(asset.versions).find((candidate) => candidate.files.some((version) => version.token === selected.token)) : undefined;
    return { asset: asset.token, kindKey: asset.kind, tags: asset.tags ?? [], name: typeof selected?.spec_json.display_name === "string" ? selected.spec_json.display_name : assetName(asset), kind: KIND_LABELS[asset.kind as AssetKind] ?? "资产",
      candidate: candidate ? candidateLabel(candidate) : "选定文件",
      version: ready ? selected?.token : undefined, fileVersion: selected?.version,
      problem: !isKnownAssetKind(asset.kind) ? "请升级客户端以交付此类型。" : asset.maybe_archived_at ? "资产已归档，请先恢复；本次不包含" : ready ? asset.brief && typeof selected?.spec_json.brief_revision === "number" && selected.spec_json.brief_revision !== asset.brief.revision ? "需求已更新；本次清单仍使用以前选定的版本，请核对是否适合。" : undefined : selected ? `选定版本仍需处理：${gateLabel(selected.gate.validationState)}` : "还没有选定版本，本次不包含" };
  });

  const visibleAssets = assets.filter((asset) => (includeArchived || !asset.maybe_archived_at) && (!filteredTokens || filteredTokens.has(asset.token)));

  const providerConnectorsDialog = providerConnectorsOpen && <ProviderConnectorsDialog onClose={() => setProviderConnectorsOpen(false)} />;

  if (!project) {
    return (<> {creationDialog}{providerConnectorsDialog}
      <div className="flex h-full flex-col p-6">
        <header className="mb-4 flex items-center gap-3">
          <Blocks className="h-6 w-6" />
          <h1 className="text-xl font-semibold">Game Assets</h1>
          <button type="button" className="ga-action" onClick={() => setProviderConnectorsOpen(true)}>Provider 连接器</button>
          {capabilities && (
            <span className="rounded border border-ui-controls-border px-2 py-0.5 text-xs text-base-fg/60">
              图标 · 2D 场景物件 · 3D 静态道具
            </span>
          )}
          <button
            className="ml-auto flex items-center gap-1 rounded border border-ui-controls-border px-2 py-1 text-sm hover:bg-white/5"
            onClick={() => void retryCapabilities()}
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            刷新
          </button>
        </header>

        <section className="ga-start-here"><h2>从游戏需求开始制作</h2><p>描述一个对象和它的用途，先比较样板，再完成同一风格的资产组。</p>
          <button type="button" className="ga-action ga-primary" disabled={!capabilities} onClick={() => beginCreation()}>制作新资产</button>
          {hasCreationDraft&&<button type="button" className="ga-action" onClick={()=>void continueCreationDraft()}>继续未提交草稿</button>}
          <p className="ga-help">2D 图标与场景物件直接生成图片；3D 静态道具先确认概念图，再生成模型。每项资产都属于一个项目；制作确认时选择已有项目或新建。</p>
        </section>
        <section aria-label="建立项目">
          <p className="ga-help">先建立项目（可选）：适合提前规划整组资产，也可以在制作确认时再建。</p>
          <div className="mb-4 flex gap-2">
          <input
            className="flex-1 rounded border border-ui-controls-border bg-ui-controls px-3 py-2 text-sm outline-none focus:border-white/40"
            placeholder="新项目名称，例如：森林驿站"
            value={newName}
            disabled={creatingProject}
            onChange={(e) => {
              setNewName(e.target.value);
              createKeyRef.current = null;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createProject();
            }}
          />
          <button
            className="flex items-center gap-1 rounded bg-white/10 px-3 py-2 text-sm hover:bg-white/20 disabled:opacity-50"
            onClick={() => void createProject()}
            disabled={!newName.trim() || !capabilities || creatingProject}
          >
            <Plus className="h-4 w-4" />
            {creatingProject ? "正在创建…" : "创建项目"}
          </button>
        </div>
        </section>

        {error && (
          <div className="mb-3 rounded border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {projects.length === 0 && !loading && (
            <p className="py-10 text-center text-sm text-base-fg/50">
              点击上方“制作新资产”开始；已有项目可从这里继续。
            </p>
          )}
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {projects.map((p) => (
              <li key={p.token}>
                <button
                  className="w-full rounded-lg border border-ui-controls-border bg-ui-controls p-4 text-left transition hover:border-white/30"
                  onClick={() => void openProject(p)}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="truncate font-medium">{p.name}</span>
                    {p.maybe_archived_at && (
                      <span className="rounded border border-white/20 px-1 text-xs text-base-fg/50">
                        已归档
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-base-fg/50">
                    {p.maybe_current_profile_token ? "已保存制作设置" : "待选择制作设置"} · 创建于{" "}
                    {new Date(p.created_at).toLocaleString()}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div></>
    );
  }

  // The current version and its actions share one stage; asset navigation
  // scrolls independently so adding a preview cannot hide the next action.
  return (<> {creationDialog}{providerConnectorsDialog}
    {deliveryOpen && <DeliveryDialog items={deliveryFilter ? deliveryItems.filter((item) => deliveryFilter.includes(item.asset)) : deliveryItems} supportsTags={tagsEnabled} capabilities={capabilities} target={exportTarget} onTarget={setExportTarget} onBuild={createExport} onPrepareV2={prepareExportV2} onCreateV2={createExportV2} onClose={() => setDeliveryOpen(false)} />}
    {setIntent && <AssetSetComposer api={api} capabilities={capabilities} project={project.token} settings={profile ? readSettings(profile.profile_json) : RECOMMENDED_SETTINGS} source={setIntent.source} initial={setIntent.initial}
      onClose={() => setSetIntent(undefined)} onSettings={() => setSettingsOpen(true)} onSaved={(token, group) => { if (currentProjectToken.current === token) { setCollectionGroup(group); setCollectionOpen(true); void loadProjectDetail(token); } }} />}
    {briefEditor && <AssetBriefEditor api={api} item={briefEditor} sources={styleSources} onSaved={(token) => { if (currentProjectToken.current === token) void loadProjectDetail(token); }} onClose={() => setBriefEditor(undefined)} />}
    {collectionOpen && <AssetCollection api={api} capabilities={capabilities} project={project.token} assets={assets.filter((asset) => !asset.maybe_archived_at)} supportsTags={tagsEnabled} onTags={setTagEditor} runs={creationRuns} loading={!!detailBusy} group={collectionGroup} onGroup={setCollectionGroup}
      onClose={() => setCollectionOpen(false)} onChanged={afterCreation} onNew={() => setSetIntent({})} onEdit={setBriefEditor} onMake={openBrief} onBatch={setLaunchItems}
      onView={(asset, version) => { setCollectionOpen(false); setError(null); setNotice(null); setCompareToken(null); if (previewVersion?.version !== version) { setReadyVersion(null); setPreviewVersion({ asset, version }); } }}
      onDeliver={(ids) => { setDeliveryFilter(ids); setDeliveryOpen(true); }} />}
    {tagEditor && <AssetTagEditor key={tagEditor.token} api={api} asset={tagEditor} projectArchived={!!project.maybe_archived_at} name={assetName(assets.find((asset) => asset.token === tagEditor.token) ?? { ...tagEditor, versions: [] })}
      onClose={() => setTagEditor(undefined)} onSaved={(updated) => { setAssets((old) => old.map((asset) => asset.token === updated.token ? { ...asset, ...updated } : asset)); setTagRevision((value) => value + 1); }} />}
    {launchItems && <AssetBatchLauncher api={api} capabilities={capabilities} project={project.token} items={launchItems} sourceFor={sourceFor} onStarted={afterCreation} onClose={() => setLaunchItems(undefined)} />}
    <div className="ga-workspace">
      <header className="ga-workspace-heading">
        <button type="button" className="ga-action" onClick={() => {
          detailRequestRef.current++; viewEpochRef.current++;
          setProject(null); setProfile(null); setPreviewVersion(null); setReadyVersion(null);
          setDetailBusy(null); setAddProgress(null); setAssets([]); setExportsList([]);
          setProjectRead({ status: "idle", hasSnapshot: false });
          void refresh();
        }}><ArrowLeft size={15} />项目</button>
        <div className="ga-workspace-title">{renaming ? <form className="ga-project-name-form" onSubmit={(event) => { event.preventDefault(); void renameProject(); }}>
          <input autoFocus aria-label="项目名称" maxLength={200} value={projectNameDraft} disabled={!!detailBusy} onChange={(event) => setProjectNameDraft(event.target.value)} />
          <button type="submit" className="ga-action" disabled={!!detailBusy || !projectNameDraft.trim()}>保存名称</button>
          <button type="button" className="ga-action" disabled={!!detailBusy} onClick={() => setRenaming(false)}>取消</button>
        </form> : <h1>{project.name}<button type="button" className="ga-rename-project" disabled={!!detailBusy} onClick={() => { setProjectNameDraft(project.name); setRenaming(true); }}>重命名</button></h1>}
          <p>{initialDetailsUnknown ? initialReadFailed ? "项目内容尚未读取，请重试" : "正在读取项目…" : profile ? `制作设置第 ${profile.version} 版 · 可随时修改` : "先选择制作设置，已有素材也可以继续加工"}</p></div>
        <button type="button" className="ga-action" onClick={() => setSettingsOpen(true)}
          disabled={initialDetailsUnknown || !!detailBusy || (!!project.maybe_current_profile_token && !profile)}>
          <Settings2 size={15} />项目风格与输出设置{profile ? ` · 第 ${profile.version} 版` : ""}
        </button>
        <button type="button" className="ga-action" onClick={() => setProviderConnectorsOpen(true)}>Provider 连接器</button>
        {capabilities?.creation?.supports_asset_briefs && <button type="button" className="ga-action" disabled={initialDetailsUnknown} onClick={() => setCollectionOpen(true)}>资产清单与整体评估</button>}
        <button type="button" className="ga-icon-button" aria-label="刷新项目" disabled={!!detailBusy}
          onClick={() => void refreshProject(project.token)}><RefreshCw size={17} /></button>
      </header>
      {settingsOpen && <SettingsPanel initial={profile ? readSettings(profile.profile_json) : RECOMMENDED_SETTINGS}
        version={profile?.version} legacy={!!profile && profile.profile_json.workflow_schema_version !== 1}
        initialAnimationSpecs={Object.fromEntries(Object.entries((profile?.profile_json.specs ?? {}) as Record<string, unknown>).filter(([key]) => ["character_3d", "anim_2d", "anim_3d"].includes(key)))}
        onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
      {rigUploadOpen && <RiggedCharacterUpload key={project.token} api={api} project={project.token} profile={profile} assets={assets}
        onRun={() => { setValidationRefresh((value) => value + 1); if (validationDetailsRef.current) validationDetailsRef.current.open = true; }} onClose={() => { setRigUploadOpen(false); void loadProjectDetail(project.token); }} />}
      {meshLaunchSeed && <CharacterMeshLaunch key={`${project.token}:${meshLaunchSeed.asset}`} api={api} project={project.token} profile={profile} capabilities={capabilities} assets={assets}
        initialAsset={meshLaunchSeed.asset} initialVersion={meshLaunchSeed.version}
        onStarted={(token) => { if (currentProjectToken.current === token) { setValidationRefresh((value) => value + 1); if (validationDetailsRef.current) validationDetailsRef.current.open = true; void loadProjectDetail(token); } }}
        onClose={() => { setMeshLaunchSeed(undefined); }} />}
      {(error || notice || detailBusy || addProgress || exportPollError) && <div className="ga-workspace-messages" aria-live="polite">
        {error && <p role="alert" className="ga-error">{error}</p>}
        {notice && !error && <p className="ga-success">{notice}</p>}
        {(detailBusy || addProgress) && <p className="ga-progress"><Loader2 size={15} className="animate-spin" />{detailBusy ?? addProgress}</p>}
        {exportPollError && <p className="ga-help">{exportPollError}</p>}
      </div>}
      <CreationJobs api={api} project={project.token} refreshKey={creationRefresh}
        onRuns={(token, runs) => { if (currentProjectToken.current === token) setCreationRuns(runs); }}
        onRevise={(run)=>{if (!isKnownAssetKind(run.kind)) { setNotice("请升级客户端以操作此类型的制作任务。"); return; } void (async()=>{try{const parent=run.making?.maybe_parent_version_token;const source=parent?(await api.GetGameAssetVersion(parent)).version:undefined;setCreationSeed({key:crypto.randomUUID(),operation:run.operation,restore:run,source:source?{version:source,kind:run.kind as AssetKind,name:run.display_name}:undefined});setCreationOpen(true);}catch(problem){setError(problem instanceof Error?problem.message:"原始需求暂时无法读取。");}})();}}
        onVersions={(token) => { if (currentProjectToken.current === token) void loadProjectDetail(token); }}
        onPreview={(asset, version) => { setReadyVersion(null); setCompareToken(null); setPreviewVersion({ asset, version }); }} />
      <main className="ga-editor-layout">
        <aside className="ga-asset-sidebar" aria-label="素材列表">
          <div className="ga-sidebar-heading"><h2>素材</h2><span>{initialDetailsUnknown ? initialReadFailed ? "尚未读取" : "读取中…" : filterBusy ? "筛选中…" : filteredTokens ? `${visibleAssets.length} / ${assets.length} 项` : `${assets.length} 项`}</span></div>
          <button type="button" className="ga-action ga-primary ga-new-asset" disabled={initialDetailsUnknown || !!detailBusy} onClick={() => beginCreation()}>制作新资产</button>
          {hasCreationDraft&&draftProject===project.token&&<button type="button" className="ga-action ga-new-asset" disabled={initialDetailsUnknown} onClick={()=>void continueCreationDraft()}>继续未提交草稿</button>}
          {capabilities?.creation?.supports_asset_briefs && <><button type="button" className="ga-action ga-new-asset" disabled={initialDetailsUnknown} onClick={() => setSetIntent({})}>建立一组需求</button>
            {readSetDrafts(project.token)[0] && <button type="button" className="ga-action ga-new-asset" disabled={initialDetailsUnknown} onClick={() => setSetIntent({ initial: readSetDrafts(project.token)[0] })}>继续未保存的清单草稿</button>}
            {pendingBatch(project.token) && <button type="button" className="ga-action ga-new-asset" disabled={initialDetailsUnknown} onClick={() => setLaunchItems(pendingBatch(project.token)!.items)}>确认上次整组提交</button>}</>}
          <details ref={importDetailsRef} className="ga-import-tools" open={false}>
            <summary><FileUp size={14} />导入已有素材</summary>
            <button type="button" className="ga-action" disabled={initialDetailsUnknown || !!detailBusy || !characterValidationOperation(capabilities, "import_rigged_v2").enabled}
              title={characterValidationOperation(capabilities, "import_rigged_v2").reason} onClick={() => setRigUploadOpen(true)}>上传已绑骨角色</button>
            {!characterValidationOperation(capabilities, "import_rigged_v2").enabled && <p className="ga-help">{characterValidationOperation(capabilities, "import_rigged_v2").reason}</p>}
            {initialDetailsUnknown ? <p className="ga-help">{initialReadFailed ? "项目内容读取失败，请先重试。" : "正在读取项目设置与已有素材…"}</p> : !project.maybe_current_profile_token ? <p className="ga-help">先打开上方设置，确认用途和输出条件。导入文件不等于生成新资产。</p>
              : <div className="ga-import-fields">
                <label className="ga-field">资产名称<input placeholder="资产名称，例如：治疗药水" value={stableKey} maxLength={100}
                  disabled={!!addProgress || !!detailBusy} onChange={(e) => { setStableKey(e.target.value); importKeyRef.current = null; }} /></label>
                <label className="ga-field">素材用途<select aria-label="素材用途" value={kind} disabled={!!addProgress || !!detailBusy}
                  onChange={(e) => { setKind(e.target.value as (typeof KINDS)[number]); importKeyRef.current = null; }}>
                  {!capabilities?.asset_kinds.includes(kind) && <option value={kind} disabled>{KIND_LABELS[kind]} · 当前服务未交付</option>}
                  {KINDS.filter((k) => capabilities?.asset_kinds.includes(k)).map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select></label>
                <label className="ga-field">选择源文件<input key={fileInputKey} type="file" accept=".png,.glb"
                  aria-label="选择需要改造的素材文件" disabled={!!addProgress || !!detailBusy}
                  onChange={(e) => { setFile(e.target.files?.[0] ?? null); importKeyRef.current = null; }} />
                  <small>2D 为 PNG，3D 为 GLB；文件保存在项目私有区域。</small></label>
                <button type="button" className="ga-action ga-primary" title={gameAssetOperation(capabilities, kind, "import").reason} disabled={!stableKey.trim() || !file || !!addProgress || !!detailBusy || !canOperate(kind, "import")}
                  onClick={() => void addAsset()}><Plus size={14} />{addProgress ? "正在导入…" : "导入并保存版本"}</button>
                {!canOperate(kind, "import") && <p className="ga-help">{gameAssetOperation(capabilities, kind, "import").reason}</p>}
              </div>}
          </details>
          {capabilities?.reading?.supports_run_details_v2 && <details ref={validationDetailsRef} className="ga-import-tools"><summary>角色免费检查与任务</summary><ValidationJobs key={project.token} api={api} project={project.token} refreshKey={validationRefresh} supportsRuns version={previewAsset?.kind === "character_3d" && selectedVersion?.spec_json.stage === "rigged" ? selectedVersion.token : undefined} canStart={characterValidationOperation(capabilities, "validate_rig_v2").enabled}
            onVersions={() => void loadProjectDetail(project.token)} onPreview={(asset, version) => setPreviewVersion({ asset, version })} /></details>}
          <div className="ga-browse-filters">
            <label className="ga-field">筛选类别<select aria-label="筛选资产类别" value={browseKind} onChange={(event) => setBrowseKind(event.target.value)}><option value="">全部类别</option>{Object.entries({ ...KIND_LABELS, ...ANIMATED_KIND_LABELS }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            {tagsEnabled && <><label className="ga-field">筛选标签<select aria-label="筛选资产标签" value={browseTag} onChange={(event) => setBrowseTag(event.target.value)}><option value="">全部标签</option>{[...new Set([...(browseTag ? [browseTag] : []), ...tagSuggestions.tags])].map((tag) => <option key={tag} value={tag}>{tag}</option>)}</select></label>
              {(tagSuggestions.hasMore || tagSuggestions.error) && <button type="button" className="ga-view-button" disabled={tagSuggestions.busy} onClick={() => void tagSuggestions.loadMore()}>{tagSuggestions.error ? "重试项目标签" : "更多项目标签"}</button>}</>}
            <label className="ga-check"><input type="checkbox" checked={includeArchived} onChange={(event) => { const include = event.target.checked; setIncludeArchived(include); }} />包含归档资产</label>
            {(browseTag || browseKind) && <button type="button" className="ga-view-button" onClick={() => { setBrowseKind(""); setBrowseTag(""); }}>清除筛选</button>}
            {filterBusy && <p role="status">正在筛选…</p>}{filterError && <p role="alert" className="ga-error">{filterError}</p>}
          </div>
          <div className="ga-asset-list">
            {assets.length === 0 && !initialDetailsUnknown && <p className="ga-help">还没有素材。点击“制作新资产”描述需求，或导入已有素材继续加工。</p>}
            {visibleAssets.map((asset) => <div key={asset.token} className="ga-asset-entry"><button key={asset.token} type="button" className="ga-asset-item"
              aria-pressed={previewAsset?.token === asset.token}
              onClick={() => {
                const next = asset.versions.find((v) => v.token === asset.maybe_current_version_token) ?? assetCandidates(asset.versions)[0]?.version;
                if (!next) { if (asset.brief || !isKnownAssetKind(asset.kind)) { setCompareToken(null); setPreviewVersion({ asset: asset.token, version: "" }); } else setNotice("这个资产正在等待文件版本，可在上方查看制作进度。"); return; }
                if (previewVersion?.version !== next.token) { setError(null); setNotice(null); setReadyVersion(null); setCompareToken(null); setPreviewVersion({ asset: asset.token, version: next.token }); }
              }}>
              <AssetThumbnail api={api} project={project.token} version={isKnownAssetKind(asset.kind) ? thumbnailVersion(asset) : undefined} name={assetName(asset)} mesh={asset.kind === "prop_3d"} />
              <span><strong>{assetName(asset)}</strong><small>{KIND_LABELS[asset.kind as AssetKind] ?? (isAnimatedAssetKind(asset.kind) ? ANIMATED_KIND_LABELS[asset.kind] : asset.kind)} · {assetCandidates(asset.versions).length} 个候选{asset.maybe_archived_at ? " · 已归档" : ""}</small>
                {asset.maybe_current_version_token && <small className="ga-selected-label">有选定的交付版本</small>}</span>
            </button><div className="ga-asset-metadata"><div className="ga-tag-chips">{asset.tags?.map((tag) => <span className="ga-tag-chip" key={tag}>{tag}</span>)}</div>
              {tagsEnabled && (isKnownAssetKind(asset.kind) || isAnimatedAssetKind(asset.kind)) && <button type="button" className="ga-view-button" aria-label={`编辑标签：${assetName(asset)}`} onClick={() => setTagEditor(asset)}>编辑标签</button>}
              {isKnownAssetKind(asset.kind) && <button type="button" className="ga-view-button" disabled={!!detailBusy} onClick={() => void setArchive(asset, !asset.maybe_archived_at)}>{asset.maybe_archived_at ? "恢复资产" : "归档资产"}</button>}</div></div>)}
            {!filterBusy && !visibleAssets.length && assets.length > 0 && <p className="ga-help">没有匹配当前筛选的资产。</p>}
          </div>
        </aside>
        <section className="ga-stage" aria-label="预览与版本选择">
          {previewAsset && isAnimatedAssetKind(previewAsset.kind) ? <section>
            <h2>{assetName(previewAsset)} · {ANIMATED_KIND_LABELS[previewAsset.kind]}</h2>
            <p>角色上传可运行免费文件与骨架检查；完整制作、审核与交付仍需完成对应验证。</p>
            {previewAsset.kind === "character_3d" && characterCreationV2Operation(capabilities, "prepare_mesh_v2").enabled && <button type="button" className="ga-action"
              onClick={() => setMeshLaunchSeed({ asset: previewAsset.token, version: selectedVersion?.spec_json.stage === "concept" ? selectedVersion.token : undefined })}>按已审核概念制作模型（收费）</button>}
            {previewAsset.kind === "character_3d" && tagsEnabled && <CharacterTagSuggest key={previewAsset.token} api={api} asset={previewAsset} name={assetName(previewAsset)} projectArchived={!!project.maybe_archived_at}
              onSaved={(updated) => { setAssets((old) => old.map((asset) => asset.token === updated.token ? { ...asset, ...updated } : asset)); setTagRevision((value) => value + 1); }} />}
            {selectedVersion ? <><label>固定版本 <select aria-label="角色与动画版本" value={selectedVersion.token} onChange={(event) => { setReadyVersion(null); setPreviewVersion({ asset: previewAsset.token, version: event.target.value }); }}>
              {previewAsset.versions.map((version) => <option key={version.token} value={version.token}>第 {version.version} 版 · {String(version.spec_json.stage)}</option>)}
            </select></label><AnimatedAssetPreview api={api} project={project.token} version={selectedVersion} kind={previewAsset.kind} refreshKey={previewRefresh} onChanged={() => void loadProjectDetail(project.token)} supportsReviewV2={capabilities?.kind_capabilities?.[previewAsset.kind]?.operations?.reviews_v2?.enabled === true} supportsSelectionV2={capabilities?.kind_capabilities?.[previewAsset.kind]?.operations?.selection_v2?.enabled === true} supportsDetailsV2={capabilities?.reading?.supports_version_details_v2 === true && capabilities.reading.version_details_v2_kinds?.includes(previewAsset.kind)} /></> : <p>此资产尚无完整候选版本。</p>}
          </section> : previewAsset && !isKnownAssetKind(previewAsset.kind) ? <div className="ga-stage-empty"><h2>{previewAsset.stable_key}</h2><p>类型：{previewAsset.kind} · 标识：{previewAsset.token}</p><p>请升级客户端以查看和操作此类型的资产。</p></div> : previewAsset && selectedVersion ? <>
            <div className="ga-stage-heading"><div><h2>{assetName(previewAsset)}</h2>
              <p>{selectedVersion.spec_json.stage === "concept" ? "先确认造型；满意后生成可旋转的 3D 模型。" : "查看实际效果，再决定采用哪个候选。"}</p></div>
              <label>候选 <select aria-label="选择预览候选" value={currentCandidate?.version.token ?? selectedVersion.token} onChange={(e) => {
                if (e.target.value !== previewVersion?.version) { setError(null); setNotice(null); setReadyVersion(null); setCompareToken(null); setPreviewVersion({ asset: previewAsset.token, version: e.target.value }); }
              }}>{candidates.map((candidate) => <option key={candidate.key} value={candidate.version.token}>
                {candidateLabel(candidate)}{previewAsset.maybe_current_version_token === candidate.version.token ? " · 已选入交付" : ""}
              </option>)}</select></label>
            </div>
            {previewAsset.brief && typeof selectedVersion.spec_json.brief_revision === "number" && selectedVersion.spec_json.brief_revision !== previewAsset.brief.revision && <p className="ga-info">需求已更新到第 {previewAsset.brief.revision} 版；当前候选来自第 {selectedVersion.spec_json.brief_revision} 版需求。请在修改与制作菜单查看当前需求，再决定采用或重做。</p>}
            <details className="ga-working-files" open={showWorkingFiles} onToggle={(event) => setShowWorkingFiles(event.currentTarget.open)}>
              <summary>来源与加工文件 · {versionStage(selectedVersion)}</summary>
              <label>查看此候选的文件 <select aria-label="查看候选来源与加工文件" value={selectedVersion.token} onChange={(event) => {
                setReadyVersion(null); setCompareToken(null); setPreviewVersion({ asset: previewAsset.token, version: event.target.value });
              }}>{currentCandidate?.files.map((version) => <option key={version.token} value={version.token}>第 {version.version} 版 · {versionStage(version)}</option>)}</select></label>
            </details>
            {compareVersion ? <CandidateComparison api={api} project={project.token} name={assetName(previewAsset)} kind={previewAsset.kind as AssetKind} comparison={compareVersion} current={selectedVersion} onReady={onPreviewReady} /> : <div className="ga-single-preview">
              <div><AssetPreview api={api} projectToken={project.token} version={selectedVersion}
                name={assetName(previewAsset)} kind={previewAsset.kind as AssetKind} onReady={onPreviewReady} /></div>
            </div>}
            <div className="ga-stage-tool-row"><details ref={creationMenuRef} className="ga-creation-menu"><summary>修改、加工与继续制作</summary><div className="ga-creation-actions">
              {previewAsset.kind !== "prop_3d" && <><button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "edit").reason} disabled={readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "edit")} onClick={() => beginCreation("edit", creationSource)}>修改外观</button>
                {(!selectedVersion.spec_json.stage || selectedVersion.spec_json.stage === "asset") && <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "inpaint").reason} disabled={readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "inpaint")} onClick={() => beginCreation("inpaint", creationSource)}>框选局部修改</button>}
                <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "cutout").reason} disabled={!canOperate(previewAsset.kind, "cutout")} onClick={() => beginCreation("cutout", creationSource)}>去背</button>{(capabilities?.kind_capabilities !== undefined || capabilities?.creation?.supports_mask_erase) && <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "erase").reason} disabled={readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "erase")} onClick={() => beginCreation("erase", creationSource)}>清除多余背景与镂空</button>}</>}
              {previewAsset.kind === "prop_3d" && selectedVersion.spec_json.stage === "concept" && <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "edit").reason} disabled={!canOperate(previewAsset.kind, "edit")} onClick={() => beginCreation("edit", creationSource)}>修改概念</button>}
              {previewAsset.kind === "prop_3d" && selectedVersion.spec_json.stage === "concept" && (capabilities?.kind_capabilities !== undefined || capabilities?.creation?.supports_concept_masking) && <><button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "inpaint").reason} disabled={readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "inpaint")} onClick={() => beginCreation("inpaint", creationSource)}>框选修改概念细节</button><button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "erase").reason} disabled={readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "erase")} onClick={() => beginCreation("erase", creationSource)}>清除概念图的多余背景</button></>}
              {previewAsset.kind === "prop_3d" && selectedVersion.spec_json.stage !== "concept" && conceptSource && <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "edit").reason} disabled={!canOperate(previewAsset.kind, "edit")} onClick={() => beginCreation("edit", { version: conceptSource, kind: "prop_3d", name: assetName(previewAsset) })}>从原概念修改造型</button>}
              {selectedVersion.spec_json.stage !== "concept" && <button type="button" className="ga-action" title={gameAssetOperation(capabilities, previewAsset.kind, "reprocess").reason} disabled={!canOperate(previewAsset.kind, "reprocess")} onClick={() => beginCreation("reprocess", creationSource)}>调整尺寸与重新加工</button>}
              <button type="button" className="ga-action" disabled={!canOperate(previewAsset.kind, "generate") || previewAsset.kind === "prop_3d" && selectedVersion.spec_json.stage !== "concept"} onClick={() => beginCreation("generate", creationSource, true)}>按此风格制作一个资产</button>
              {capabilities?.creation?.supports_asset_briefs && <button type="button" className="ga-action ga-primary" onClick={() => setSetIntent({ source: previewAsset.kind === "prop_3d" && selectedVersion.spec_json.stage !== "concept" ? conceptSource ? { version: conceptSource, kind: "prop_3d", name: assetName(previewAsset) } : undefined : creationSource })}>按此风格做一组</button>}
              {previewAsset.brief && <button type="button" className="ga-action" onClick={() => setBriefEditor(previewAsset.brief)}>查看或编辑这项需求</button>}
            </div></details>
              <label>比较候选 <select aria-label="选择对比候选" value={compareToken ?? ""} onChange={(event) => setCompareToken(event.target.value || null)}><option value="">不比较</option>{candidates.filter((candidate) => candidate.version.token !== selectedVersion.token).map((candidate) => <option key={candidate.key} value={candidate.version.token}>{candidateLabel(candidate)}</option>)}</select></label></div>
            <div className="ga-stage-actions"><div><p>{selectedVersion.spec_json.stage === "concept" ? selectedVersion.gate.reviewPassed ? "概念已确认，尚未生成模型" : "概念图已保存，尚未生成模型" : `文件检查：${gateLabel(selectedVersion.gate.validationState)}`}</p>
              <small>{selectedVersion.spec_json.stage === "concept" ? "下一步单独查看模型制作条件与费用，再决定开始。" : readyVersion !== selectedVersion.token ? "预览加载完成后可选择交付版本。" : "选定后仍需在目标游戏中确认实际用途和效果。"}</small>{selectedVersion.spec_json.stage === "concept" && selectedVersion.gate.reviewState === "rejected" && <p className="ga-error">这个概念已记录需修改的问题：{selectedVersion.reviewReason ?? "请先修改概念，或在改变判断后重新确认。"} 重新确认只保存判断，不会开始模型生成。</p>}</div>
              {selectedVersion.spec_json.stage === "concept" ? <><button type="button" className="ga-action ga-primary" disabled={readyVersion !== selectedVersion.token || !!detailBusy} onClick={() => selectedVersion.gate.reviewState === "rejected" ? beginCreation("edit", creationSource, false, selectedVersion.reviewReason) : selectedVersion.gate.reviewPassed ? beginCreation("mesh", creationSource) : void review(selectedVersion, "passed", undefined, () => beginCreation("mesh", creationSource))}>{selectedVersion.gate.reviewState === "rejected" ? "按问题修改概念" : selectedVersion.gate.reviewPassed ? "查看模型费用" : "确认概念，查看模型费用"}</button>{selectedVersion.gate.reviewState === "rejected" && <button type="button" className="ga-action" disabled={readyVersion !== selectedVersion.token || !!detailBusy} onClick={() => void review(selectedVersion, "passed")}>重新确认这个概念</button>}</>
                : ["source", "cutout", "input"].includes(String(selectedVersion.spec_json.stage)) ? <button type="button" className="ga-action ga-primary" disabled={readyVersion !== selectedVersion.token || !!detailBusy || !canOperate(previewAsset.kind, "reprocess")} onClick={() => beginCreation("reprocess", creationSource)}>调整参数并完成加工</button>
                : <><button type="button" className="ga-action" disabled={!!detailBusy} onClick={() => void runValidation(selectedVersion)}>检查文件</button>
              <button type="button" className="ga-action ga-primary"
                disabled={!!detailBusy || ["source", "cutout", "concept", "input"].includes(String(selectedVersion.spec_json.stage)) || readyVersion !== selectedVersion.token || (previewAsset.maybe_current_version_token === selectedVersion.token && selectedVersion.gate.reviewPassed)}
                onClick={() => void review(selectedVersion, "passed")}>
                <Check size={15} />{previewAsset.maybe_current_version_token === selectedVersion.token && selectedVersion.gate.reviewPassed ? "已选入交付" : "选入交付"}
              </button>{capabilities?.creation?.supports_delivery_unselect && previewAsset.maybe_current_version_token === selectedVersion.token && <button type="button" className="ga-action" disabled={!!detailBusy} onClick={() => void clearSelection(previewAsset)}>撤回交付选择</button>}</>}
            </div>
            <details className="ga-problem-tools"><summary>记录这个版本希望修改的问题</summary>
              <div><input aria-label="需要修改的问题" placeholder="希望保留什么、修改哪里" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
                <button type="button" className="ga-action" disabled={!rejectReason.trim() || !!detailBusy}
                  onClick={() => void review(selectedVersion, "rejected", rejectReason)}>保存问题</button></div>
              <p className="ga-help">问题记录会保留在版本历史中；它本身不会自动修改或重新生成素材。</p>
              {problemSource && (rejectReason.trim() || selectedVersion.reviewReason) && <button type="button" className="ga-action" disabled={!!detailBusy || readyVersion !== selectedVersion.token || !canOperate(previewAsset.kind, "edit")} onClick={() => beginCreation("edit", problemSource, false, rejectReason || selectedVersion.reviewReason)}>按此问题修改</button>}
            </details>
            {selectedVersion.validationReport && <details className="ga-problem-tools"><summary>文件检查详情</summary>
              <p className="ga-help">{reportProblems(selectedVersion.validationReport)}</p>
              <details><summary>技术诊断</summary><pre className="ga-diagnostics">{JSON.stringify(selectedVersion.validationReport.report, null, 2)}</pre></details>
            </details>}
          </> : previewAsset?.brief ? <div className="ga-stage-empty"><h2>{assetName(previewAsset)} · 已保存需求</h2><p>{previewAsset.brief.brief.description}</p><p>用途：{previewAsset.brief.brief.use_case}</p><p>需求第 {previewAsset.brief.revision} 版 · 还没有可预览的候选。制作说明与费用将在开始前逐项确认。</p><div className="ga-inline-controls"><button type="button" className="ga-action" onClick={() => setBriefEditor(previewAsset.brief)}>编辑需求与输出条件</button><button type="button" className="ga-action ga-primary" disabled={!!detailBusy} onClick={() => openBrief(previewAsset.brief!)}>制作这一项并报价</button><button type="button" className="ga-action" onClick={() => setCollectionOpen(true)}>返回资产清单</button></div></div>
            : <div className="ga-stage-empty">{initialDetailsUnknown ? initialReadFailed ? <>
              <Eye size={34} /><h2>项目内容尚未读取</h2>
              <p>暂时无法确认已有素材和制作设置。请重试读取项目。</p>
              <button type="button" className="ga-action ga-primary" onClick={() => void loadProjectDetail(project.token)}>重试读取项目</button>
            </> : <>
              <Loader2 size={34} className="animate-spin" />
              <h2>正在读取项目内容…</h2>
              <p>正在读取素材、候选和制作设置，完成后即可预览和比较。</p>
            </> : <>
              <Eye size={34} /><h2>{assets.length ? "选择左侧素材，开始预览" : "让素材先看得见，再作判断"}</h2>
              <p>这里会显示图片的真实大小和背景效果，或可旋转的 3D 模型。先查看和比较，再选择准确的交付版本。</p>
              {!profile && <button type="button" className="ga-action ga-primary" onClick={() => setSettingsOpen(true)}>查看并调整制作设置</button>}
            </>}</div>}
        </section>
      </main>
      {exportUse && <ExportUseDialog key={exportUse.token} api={api} item={exportUse} exports={exportsList} onDownload={downloadExport} onClose={() => setExportUse(undefined)} />}
      <footer className="ga-delivery-panel" aria-label="交付选定版本">
        <div className="ga-delivery-controls"><div><h2>交付选定版本</h2>
          <p>{initialDetailsUnknown ? initialReadFailed ? "交付选择尚未读取，请重试" : "正在读取项目内容…" : `${deliveryItems.filter((item) => item.version).length} / ${assets.length} 项已选定 · 游戏使用记录见各交付包`}</p></div>
          <select aria-label="交付目标" value={exportTarget} onChange={(e) => setExportTarget(e.target.value)}>
            <option value="generic">下载通用文件</option><option value="godot">导入 Godot</option><option value="bevy">用于 Bevy 项目</option><option value="cocos">导入 Cocos Creator</option>
          </select>
          <button type="button" className="ga-action" disabled={!!detailBusy || !assets.some((a) => a.versions.some((v) => v.token === a.maybe_current_version_token && v.gate.reviewPassed && v.gate.validationPassed))} onClick={() => { setDeliveryFilter(null); setDeliveryOpen(true); }}>
            <Download size={15} />查看交付清单
          </button>
        </div>
        {exportsList.length > 0 && <details ref={exportHistoryRef} className="ga-export-history"><summary>已构建交付包 · {exportsList.length} 项</summary><ul className="ga-export-list">{exportsList.map((exp) => <li key={exp.token}>
          <span>{exp.export_kind === "godot" ? "Godot 资源包" : exp.export_kind === "bevy" ? "Bevy 资源包" : exp.export_kind === "cocos" ? "Cocos 资源包" : "通用资源包"}</span>
          <time dateTime={exp.created_at}>{new Date(exp.created_at).toLocaleString()}</time>
          <span>{EXPORT_STATUS_LABELS[exp.status] ?? exp.status}</span>
          {exp.status === "succeeded" && <button type="button" className="ga-action" onClick={() => void downloadExport(exp.token)}>下载 ZIP</button>}
          <button type="button" className="ga-action" onClick={() => setExportUse(exp)}>查看内容、导入与更新</button>
          {exp.status === "failed" && <span className="ga-help">构建未完成，可重试；此前的交付版本仍保留。</span>}
        </li>)}</ul></details>}
      </footer>
    </div></>
  );
}

function versionStage(version: GameAssetVersionInfo): string {
  const labels: Record<string, string> = { concept: "概念图，待确认模型", source: "生成源图，待加工", cutout: "去背源图", asset: "已加工候选", input: "输入素材" };
  return labels[String(version.spec_json.stage)] ?? "已导入素材";
}
function thumbnailVersion(asset: AssetRow): GameAssetVersionInfo | undefined {
  const candidate = asset.versions.find((version) => version.token === asset.maybe_current_version_token) ?? assetCandidates(asset.versions)[0]?.version;
  return asset.kind === "prop_3d" && candidate ? findConceptSource(asset, candidate) ?? (candidate.spec_json.stage === "concept" ? candidate : undefined) : candidate;
}
function findConceptSource(asset: AssetRow, version: GameAssetVersionInfo): GameAssetVersionInfo | undefined {
  const seen = new Set<string>(); let current: GameAssetVersionInfo | undefined = version;
  while (current && !seen.has(current.token)) {
    seen.add(current.token); if (current.spec_json.stage === "concept") return current;
    const parent: string | null = current.maybe_parent_version_token;
    current = parent ? asset.versions.find((candidate) => candidate.token === parent) : undefined;
  }
  return undefined;
}

async function allPages<T>(load: (cursor?: string) => Promise<{ items: T[]; next_cursor: string | null }>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await load(cursor);
    items.push(...page.items);
    cursor = page.next_cursor ?? undefined;
    if (cursor) {
      if (seen.has(cursor)) throw new Error("列表分页没有继续前进，请重试。");
      seen.add(cursor);
    }
  } while (cursor);
  return items;
}

function assetName(asset: AssetRow): string {
  const name = asset.brief?.brief.display_name ?? asset.versions.find((v) => v.token === asset.maybe_current_version_token)?.spec_json.display_name
    ?? asset.versions[0]?.spec_json.display_name;
  return typeof name === "string" ? name : asset.stable_key;
}

function gateLabel(state: string): string {
  const names: Record<string, string> = { passed: "检查通过", failed: "发现问题", not_checked: "尚未检查", unavailable: "服务暂时不可用", needs_recheck: "规则已更新，请重新检查" };
  return names[state] ?? state;
}

function reportProblems(report: ValidationReportInfo): string {
  const problems = report.report.problems;
  if (Array.isArray(problems) && problems.length) return problems.filter((p): p is string => typeof p === "string").join("；");
  const warnings = report.report.warnings;
  if (Array.isArray(warnings) && warnings.length) return warnings.filter((p): p is string => typeof p === "string").join("；");
  return report.status === "passed" ? "已完成此规则版本的文件检查，视觉与游戏用途仍需要确认。" : "文件检查未通过，请查看诊断并处理后再保存后继版本。";
}
