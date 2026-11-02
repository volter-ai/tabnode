/**
 * Engine lookups use the realm's original `Symbol.for`, captured before a guest
 * can replace that function. The symbol registry remains shared with the guest.
 */
export const engineSymbolFor: (key: string) => symbol = Symbol.for.bind(Symbol);
