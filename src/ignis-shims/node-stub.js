// Loud stub factory for Node builtins that must be require()-able in browser
// builds but must never actually run there (the SDK only touches them on
// desktop code paths). require() succeeds and known members exist as throwing
// functions — they may be referenced, wrapped (util.promisify at module init)
// or subclassed, but the moment one is CALLED it throws with an attributable
// message. Members are declared as real own properties because esbuild's
// __toESM/__copyProps enumerates ownKeys: a get-only Proxy would produce an
// empty import namespace.
'use strict';

module.exports = function makeNodeStub(moduleName, memberNames = []) {
  const makeThrower = (property) => {
    const thrower = function stubbed() {
      throw new Error(
        `'${moduleName}.${property}' is not available in the browser build `
        + '(the Claude CLI runs on the bridge host instead)',
      );
    };
    Object.defineProperty(thrower, 'name', { value: property, configurable: true });
    return thrower;
  };
  const stub = {};
  for (const name of memberNames) stub[name] = makeThrower(name);
  const proxy = new Proxy(stub, {
    get(target, property) {
      if (property === '__esModule') return false;
      if (property === 'default') return proxy;
      if (typeof property === 'symbol') return target[property];
      if (property in target) return target[property];
      if (property === 'then') return undefined; // not a thenable
      return makeThrower(String(property));
    },
  });
  return proxy;
};
