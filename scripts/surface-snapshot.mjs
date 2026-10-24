// Serialize an object graph, including prototypes, without a depth cutoff.
// Accessors are descriptors: evaluating them can mutate module state. Their
// return types remain explicitly unmeasured in the comparison.
export function snapshot(value) {
  const seen = new Map();
  const nodes = [];
  const objectGetOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
  const objectGetPrototypeOf = Object.getPrototypeOf;
  const ownKeys = Reflect.ownKeys;
  function visit(value) {
    const type = value === null ? 'null' : typeof value;
    if (type !== 'object' && type !== 'function') return { type };
    if (seen.has(value)) return { ref: seen.get(value) };
    const id = nodes.length;
    seen.set(value, id);
    const node = { type, arity: type === 'function' ? value.length : undefined, properties: Object.create(null) };
    nodes.push(node);
    try {
      const descriptors = objectGetOwnPropertyDescriptors(value);
      // Symbol descriptions are structural names, not cross-realm identity.
      const symbolCounts = new Map();
      for (const key of ownKeys(descriptors)) {
        let name = typeof key === 'symbol' ? `[Symbol(${Symbol.keyFor(key) ?? key.description ?? ''})]` : key;
        if (typeof key === 'symbol') {
          const n = symbolCounts.get(name) ?? 0;
          symbolCounts.set(name, n + 1);
          if (n) name += `#${n}`;
        }
        const descriptor = descriptors[key];
        node.properties[name] = 'value' in descriptor ? visit(descriptor.value)
          : { type: 'accessor', get: descriptor.get ? descriptor.get.length : null, set: descriptor.set ? descriptor.set.length : null };
      }
      node.prototype = visit(objectGetPrototypeOf(value));
    } catch (error) { node.error = `${error.code ?? error.name}: ${error.message}`; }
    return { ref: id };
  }
  return { root: visit(value), nodes };
}
