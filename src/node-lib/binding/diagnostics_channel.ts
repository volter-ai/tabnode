/** Node24.21's native channel links, owned by one builtin/process graph.
 * JS publish/subscribe stays in the unchanged upstream library. Engine-origin
 * channels use getChannel/publish; no browser GC/CPU events are synthesized. */
interface Channel { publish(message: unknown): void }
export function createDiagnosticsChannelBinding() {
  let callback: ((name: string, index: number) => Channel) | undefined;
  const indices = new Map<string, number>();
  const channels = new Map<string, Channel>();
  const binding = {
    subscribers: new Uint32Array(1024),
    linkNativeChannel(link: (name: string, index: number) => Channel): void {
      callback = link;
      for (const [name, index] of indices) channels.set(name, link(name, index));
    },
    getChannel(name: string): { hasSubscribers(): boolean; publish(message: unknown): void } {
      let index = indices.get(name);
      if (index === undefined) {
        index = indices.size;
        if (index === binding.subscribers.length) {
          const grown = new Uint32Array(binding.subscribers.length * 2);
          grown.set(binding.subscribers);
          binding.subscribers = grown;
        }
        indices.set(name, index);
      }
      if (callback && !channels.has(name)) channels.set(name, callback(name, index));
      const heldIndex = index;
      return {
        hasSubscribers: () => binding.subscribers[heldIndex] > 0,
        publish(message) {
          if (binding.subscribers[heldIndex] > 0) channels.get(name)?.publish(message);
        },
      };
    },
  };
  return binding;
}
