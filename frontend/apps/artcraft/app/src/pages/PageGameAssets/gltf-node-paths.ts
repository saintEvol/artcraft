export interface GltfSceneNodes {
  nodes?: { name?: string; children?: number[] }[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

/** Original JSON paths identify parser nodes; runtime names may be sanitized. */
export function scenePaths(document: GltfSceneNodes): Map<string, number> {
  const nodes = document.nodes, scenes = document.scenes;
  if (!nodes?.length || nodes.length > 4096 || scenes?.length !== 1 || document.scene !== undefined && document.scene !== 0 || !scenes[0].nodes?.length) throw new Error("预览要求完整的 scene 0 节点层级。");
  const pending = scenes[0].nodes.map((index) => ({ index, path: [] as string[] }));
  const paths = new Map<string, number>(), seen = new Set<number>();
  while (pending.length) {
    const { index, path } = pending.pop()!;
    const node = nodes[index];
    if (!Number.isSafeInteger(index) || index < 0 || !node || typeof node.name !== "string" || !node.name || seen.has(index) || path.length >= 128) throw new Error("节点缺少名称、存在循环或被多个父节点引用。");
    const next = [...path, node.name], key = JSON.stringify(next);
    if (paths.has(key)) throw new Error("完整节点路径重复，无法唯一绑定。");
    seen.add(index); paths.set(key, index);
    if (node.children !== undefined && (!Array.isArray(node.children) || node.children.length > nodes.length)) throw new Error("子节点索引超出预览预算。");
    for (const child of node.children ?? []) pending.push({ index: child, path: next });
  }
  if (seen.size !== nodes.length) throw new Error("模型含 scene 0 不可达的节点。");
  return paths;
}
