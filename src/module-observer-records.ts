// Capture before guest entry. Record construction uses receiver-independent
// native statics directly; evidence calls use captured Reflect.apply with
// frozen null-prototype argument records, never arrays.
const create = Object.create, freeze = Object.freeze;
const descriptor = Object.getOwnPropertyDescriptor, setPrototype = Object.setPrototypeOf;
const define = Reflect.defineProperty, apply = Reflect.apply, hasOwn = Object.hasOwn;
const template = descriptor(create, "name")!;
setPrototype(template, null);
freeze(template);

export function observerRecord<T extends object>(): T { return create(null) as T; }
export function observerWrite(target: object, key: PropertyKey, value: unknown): void {
  // Native descriptors have own writable data fields. Remove their prototype
  // before descriptor conversion, including inherited get/set pollution.
  const field = descriptor(template, "value")!;
  setPrototype(field, null);
  field.value = value;
  define(target, key, field);
}
export function observerFreeze<T extends object>(value: T): Readonly<T> { return freeze(value); }
export function observerCall1(fn: Function, value: unknown): unknown {
  const args = observerRecord<ArrayLike<unknown>>();
  observerWrite(args, "0", value);
  observerWrite(args, "length", 1);
  return apply(fn, undefined, observerFreeze(args));
}
export function observerCall2(fn: Function, first: unknown, second: unknown): unknown {
  const args = observerRecord<ArrayLike<unknown>>();
  observerWrite(args, "0", first);
  observerWrite(args, "1", second);
  observerWrite(args, "length", 2);
  return apply(fn, undefined, observerFreeze(args));
}
export function observerDescriptor(value: object, key: PropertyKey): PropertyDescriptor | undefined {
  return observerCall2(descriptor, value, key) as PropertyDescriptor | undefined;
}
export function observerHasOwn(value: object, key: PropertyKey): boolean {
  return observerCall2(hasOwn, value, key) as boolean;
}
