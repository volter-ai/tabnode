// Deterministic partitions of the complete pinned denominator. A shard is
// never a complete measurement; only their checked union can be reported.
export function shardFiles(files, index, count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > files.length
    || !Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error('shard index/count must select a nonempty partition of the pinned denominator');
  }
  return files.filter((_, position) => position % count === index);
}
