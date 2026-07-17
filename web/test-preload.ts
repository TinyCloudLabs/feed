// The browser SDK registers custom elements while its module is evaluated.
// Unit tests exercise auth orchestration without a browser, so provide only
// the registration surface needed to import it; no DOM or network is started.
if (!("HTMLElement" in globalThis)) {
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: class HTMLElement {},
  });
}

if (!("customElements" in globalThis)) {
  const definitions = new Map<string, CustomElementConstructor>();
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    value: {
      define(name: string, constructor: CustomElementConstructor): void {
        definitions.set(name, constructor);
      },
      get(name: string): CustomElementConstructor | undefined {
        return definitions.get(name);
      },
    },
  });
}
