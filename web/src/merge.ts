import type { Entry } from "./types";

function sameEntry(a: Entry, b: Entry): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * delta.entries 的合并策略（CONTRACT §3 / §6：增量追加不重排已渲染内容）。
 *
 * - 服务端只说「entries 出现即表示有新增条目」，所以默认是 append；
 * - 但同一份快照也可能整份重发，此时 incoming 是 prev 的前缀扩展 —— 直接替换，
 *   避免重复条目，同时保持既有顺序（key 由下标给出，DOM 不会重排/重挂）。
 * - 任何不是前缀扩展的批处理一律 append：宁可多显示一条，也不打乱已渲染内容。
 */
export function mergeEntries(prev: Entry[], incoming: Entry[]): Entry[] {
  if (incoming.length === 0) return prev;
  const isPrefixExtension =
    incoming.length >= prev.length && prev.every((entry, index) => sameEntry(entry, incoming[index]));
  if (isPrefixExtension) return prev.length === incoming.length ? prev : incoming;
  return [...prev, ...incoming];
}
