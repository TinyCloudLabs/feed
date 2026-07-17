import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  App,
  SignInScreen,
  type AppAuthDependencies,
} from "./App.tsx";
import {
  FeedReconnectRequiredError,
  MISSING_PARENT_RECONNECT_MESSAGE,
} from "./authPolicy.ts";
import type { FeedHostDelegationPolicy, FeedHostSetupStatus } from "./delegation.ts";
import type { FeedV1HostClient } from "./feedV1HostClient.ts";

const POLICY: FeedHostDelegationPolicy = {
  delegateDID: "did:key:zFeedHost",
  resources: [],
};

class TestNode {
  parentNode: TestNode | null = null;
  childNodes: TestNode[] = [];
  ownerDocument!: TestDocument;

  appendChild(child: TestNode): TestNode {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    if (!before) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) throw new Error("Reference child was not found");
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child: TestNode): TestNode {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("Child was not found");
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): TestNode | null {
    return this.childNodes.at(-1) ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.childNodes.forEach((child) => { child.parentNode = null; });
    this.childNodes = [];
    if (value) this.appendChild(this.ownerDocument.createTextNode(value));
  }
}

class TestText extends TestNode {
  readonly nodeType = 3;
  readonly nodeName = "#text";

  constructor(public nodeValue: string, ownerDocument: TestDocument) {
    super();
    this.ownerDocument = ownerDocument;
  }

  override get textContent(): string {
    return this.nodeValue;
  }

  override set textContent(value: string) {
    this.nodeValue = value;
  }
}

class TestElement extends TestNode {
  readonly nodeType = 1;
  readonly nodeName: string;
  readonly tagName: string;
  readonly namespaceURI: string;
  readonly style: Record<string, unknown> & { setProperty: (name: string, value: string) => void };
  private readonly attributes = new Map<string, string>();

  constructor(tagName: string, ownerDocument: TestDocument, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super();
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.namespaceURI = namespaceURI;
    this.style = {
      setProperty: (name, value) => { this.style[name] = value; },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  setAttributeNS(_namespace: string | null, name: string, value: string): void {
    this.setAttribute(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

class TestDocument extends TestNode {
  readonly nodeType = 9;
  readonly nodeName = "#document";
  readonly documentElement: TestElement;
  readonly body: TestElement;
  defaultView!: typeof globalThis;
  activeElement: TestElement | null;

  constructor() {
    super();
    this.ownerDocument = this;
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.documentElement.appendChild(this.body);
    this.appendChild(this.documentElement);
    this.activeElement = this.body;
  }

  createElement(tagName: string): TestElement {
    return new TestElement(tagName, this);
  }

  createElementNS(namespaceURI: string, tagName: string): TestElement {
    return new TestElement(tagName, this, namespaceURI);
  }

  createTextNode(value: string): TestText {
    return new TestText(value, this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let testDocument: TestDocument;

function installGlobal(name: string, value: unknown): void {
  if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

beforeAll(() => {
  testDocument = new TestDocument();
  const testWindow = {
    document: testDocument,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout,
    clearTimeout,
    innerHeight: 800,
    scrollY: 0,
    scrollTo: () => undefined,
    HTMLIFrameElement: class HTMLIFrameElement {},
  };
  testDocument.defaultView = testWindow as unknown as typeof globalThis;
  installGlobal("window", testWindow);
  installGlobal("document", testDocument);
  installGlobal("Element", TestElement);
  installGlobal("HTMLElement", TestElement);
  installGlobal("Node", TestNode);
  installGlobal("Text", TestText);
  installGlobal("location", { hash: "" });
  installGlobal("history", { scrollRestoration: "auto", back: () => undefined });
  installGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0));
  installGlobal("cancelAnimationFrame", (handle: number) => clearTimeout(handle));
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterAll(() => {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
}

function authDependencies(overrides: Partial<AppAuthDependencies> = {}): AppAuthDependencies {
  return {
    attachReceivedInputAuthority: async () => undefined,
    restoreSession: async () => ({ address: "0xfeed", readerDid: "did:key:zReader" }),
    signIn: async () => ({ address: "0xfeed", readerDid: "did:key:zReader" }),
    signOut: async () => undefined,
    submitFeedHostDelegations: async () => [],
    ...overrides,
  };
}

function hostClient(overrides: Partial<FeedV1HostClient> = {}): FeedV1HostClient {
  return {
    getDelegationPolicy: async () => POLICY,
    listFeed: async () => { throw new Error("Feed is not readable yet"); },
    setTraceId: () => undefined,
    ...overrides,
  } as unknown as FeedV1HostClient;
}

async function renderApp(
  auth: AppAuthDependencies,
  client: FeedV1HostClient,
): Promise<{ container: TestElement; root: Root }> {
  const container = testDocument.createElement("div");
  testDocument.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const createClient = () => client;
  await act(async () => {
    root.render(<App auth={auth} createClient={createClient} />);
  });
  await settle();
  return { container, root };
}

async function unmount(root: Root): Promise<void> {
  await act(async () => root.unmount());
}

async function clickButton(container: TestElement, label: string): Promise<void> {
  const pending = [...container.childNodes];
  let button: TestElement | undefined;
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node instanceof TestElement && node.tagName === "BUTTON" && node.textContent === label) {
      button = node;
      break;
    }
    pending.push(...node.childNodes);
  }
  if (!button) throw new Error(`Button was not found: ${label}`);
  const propsKey = Object.getOwnPropertyNames(button).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (button as unknown as Record<string, { onClick?: () => void }>)[propsKey] : undefined;
  if (!props?.onClick) throw new Error(`Button has no click handler: ${label}`);
  await act(async () => props.onClick?.());
  await settle();
}

describe("sign-in recovery UI", () => {
  test("labels only diagnosed stale sessions as reconnects", () => {
    const genericFailure = renderToStaticMarkup(
      <SignInScreen error="The policy request failed." reconnectRequired={false} onSignIn={() => undefined} />,
    );
    const missingParent = renderToStaticMarkup(
      <SignInScreen
        error={MISSING_PARENT_RECONNECT_MESSAGE}
        reconnectRequired
        onSignIn={() => undefined}
      />,
    );

    expect(genericFailure).toContain("Sign in with OpenKey");
    expect(genericFailure).not.toContain("Sign in to reconnect");
    expect(missingParent).toContain("Sign in to reconnect");
  });

  test("a recovery-exhausted missing parent drives App into reconnect UI", async () => {
    let signOuts = 0;
    let submissions = 0;
    const secondMissingParent = new FeedReconnectRequiredError(
      new Error("Failed to activate delegation with host: Cannot find parent delegation"),
      MISSING_PARENT_RECONNECT_MESSAGE,
    );
    const auth = authDependencies({
      signOut: async () => { signOuts += 1; },
      submitFeedHostDelegations: async () => {
        submissions += 1;
        throw secondMissingParent;
      },
    });
    const { container, root } = await renderApp(auth, hostClient());

    expect(submissions).toBe(1);
    expect(signOuts).toBe(1);
    expect(container.textContent).toContain(MISSING_PARENT_RECONNECT_MESSAGE);
    expect(container.textContent).toContain("Sign in to reconnect");

    await unmount(root);
  });

  test("setup polling reports typed missing-parent recovery before reconnecting", async () => {
    const previousFetch = globalThis.fetch;
    const events: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") events.push(JSON.parse(init.body) as Record<string, unknown>);
      return new Response(undefined, { status: 204 });
    }) as typeof fetch;

    const failedSetup: FeedHostSetupStatus = {
      state: "failed",
      phase: "failed",
      attempt: 1,
      startedAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:01.000Z",
      error: {
        code: "preparation_failed",
        message: "Cannot find parent delegation",
      },
    };
    let feedLoads = 0;
    const client = hostClient({
      getDelegationStatus: async () => ({
        actorId: "did:key:zReader",
        delegateDID: POLICY.delegateDID,
        policyHash: "policy",
        currentPolicyHash: "policy",
        state: "active",
        complete: true,
        resources: [],
        setup: failedSetup,
      }),
      listFeed: async () => {
        feedLoads += 1;
        if (feedLoads === 1) throw new Error("restored host session is gone");
        return { items: [] };
      },
    });
    const auth = authDependencies({
      submitFeedHostDelegations: async () => [{
        accepted: true,
        actorId: "did:key:zReader",
        resources: [],
        status: "preparing",
        setup: { ...failedSetup, state: "preparing", phase: "bootstrap", error: undefined },
      }],
    });

    try {
      const { container, root } = await renderApp(auth, client);
      const recovery = events.find((event) => event.event === "missing_parent_recovery");

      expect(recovery).toMatchObject({
        event: "missing_parent_recovery",
        session_mode: "restored",
        stage: "activate",
        outcome: "reconnect_required",
      });
      expect(container.textContent).toContain("Sign in to reconnect");
      await unmount(root);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("a stale setup poll cannot clear a newly signed-in session", async () => {
    let resolveOldSetup!: (value: Awaited<ReturnType<FeedV1HostClient["getDelegationStatus"]>>) => void;
    const oldSetup = new Promise<Awaited<ReturnType<FeedV1HostClient["getDelegationStatus"]>>>((resolve) => {
      resolveOldSetup = resolve;
    });
    let statusCalls = 0;
    let signOuts = 0;
    const client = hostClient({
      disconnectFeed: async () => undefined,
      getDelegationStatus: async () => {
        statusCalls += 1;
        if (statusCalls === 1) return oldSetup;
        return {
          actorId: "did:key:zReader",
          delegateDID: POLICY.delegateDID,
          policyHash: "policy",
          currentPolicyHash: "policy",
          state: "active",
          complete: true,
          resources: [],
          setup: {
            state: "ready",
            phase: "ready",
            attempt: 1,
            startedAt: "2026-07-16T00:00:00.000Z",
            updatedAt: "2026-07-16T00:00:01.000Z",
          },
        };
      },
      getFeedEvents: async () => ({ text: "" }),
      listFeed: async () => {
        if (statusCalls === 0) throw new Error("restored host session is gone");
        return { items: [] };
      },
    });
    const auth = authDependencies({
      signOut: async () => { signOuts += 1; },
      submitFeedHostDelegations: async () => [{
        accepted: true,
        actorId: "did:key:zReader",
        resources: [],
        status: "preparing",
      }],
    });
    const { container, root } = await renderApp(auth, client);

    expect(container.textContent).toContain("Menu");
    await clickButton(container, "Menu");
    await clickButton(container, "Sign out");
    await clickButton(container, "Sign in with OpenKey");
    expect(container.textContent).toContain("Menu");

    resolveOldSetup({
      actorId: "did:key:zReader",
      delegateDID: POLICY.delegateDID,
      policyHash: "policy",
      currentPolicyHash: "policy",
      state: "active",
      complete: true,
      resources: [],
      setup: {
        state: "failed",
        phase: "failed",
        attempt: 1,
        startedAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:02.000Z",
        error: { code: "preparation_failed", message: "Cannot find parent delegation" },
      },
    });
    await settle();

    expect(signOuts).toBe(1);
    expect(container.textContent).toContain("Menu");
    expect(container.textContent).not.toContain("Sign in to reconnect");
    await unmount(root);
  });
});
