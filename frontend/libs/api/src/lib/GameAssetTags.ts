/** Metadata normalization shared by replacement, filtering and suggestions.
 * Unicode White_Space intentionally excludes JavaScript's extra BOM whitespace.
 */
export function normalizeGameAssetTag(input: unknown): string {
  if (typeof input !== "string" || /[\p{Cc}\p{Surrogate}]/u.test(input)) throw new Error("标签必须是文字，且不能包含控制字符（含换行、制表和 NUL）。");
  const tag = input.normalize("NFC").split(/\p{White_Space}+/u).filter(Boolean).join(" ");
  if (!tag) throw new Error("标签不能为空。");
  if ([...tag].length > 64) throw new Error("每个标签最多 64 个字符。");
  return tag;
}

export function normalizeGameAssetTags(inputs: readonly unknown[]): string[] {
  const tags = [...new Set(inputs.map(normalizeGameAssetTag))];
  if (tags.length > 20) throw new Error("每项资产最多 20 个不同标签。");
  return tags.sort(compareTagScalars);
}

export function compareTagScalars(a: string, b: string): number {
  const left = [...a]; const right = [...b];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0)! - right[i].codePointAt(0)!;
    if (difference) return difference;
  }
  return left.length - right.length;
}
