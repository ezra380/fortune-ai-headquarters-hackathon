import vm from 'node:vm';
import { TABS } from '../src/departments.ts';
import { PAGE_HTML } from '../src/page.ts';

// The page, drawn for real against a tiny fake of the browser: the page's own script runs in a sandbox with a fake document,
// and the text it drew comes back. Shared by the console tests.

class FakeEl {
  children: FakeEl[] = [];
  className = '';
  tabIndex = 0;
  own = '';
  private readonly attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  set textContent(v: string) {
    this.own = String(v);
    this.children = [];
  }
  get textContent(): string {
    return [this.own, ...this.children.map((c) => c.textContent)].filter((x) => x !== '').join('\n');
  }
  appendChild(c: FakeEl): FakeEl {
    this.children.push(c);
    return c;
  }
  replaceChildren(...items: FakeEl[]): void {
    this.own = '';
    this.children = items.flatMap((i) => (i.tag === '#fragment' ? i.children : [i]));
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  addEventListener(): void {}
  focus(): void {}
}

/** Runs the page's own script with a fake document, the way the browser would, and returns the text it drew. */
export async function drawTab(id: string, payload: unknown): Promise<string> {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1] ?? '';
  const tabs = TABS.map((d) => {
    const el = new FakeEl('button');
    el.setAttribute('data-id', d.id);
    return el;
  });
  const panel = new FakeEl('main');
  const byId: Record<string, FakeEl> = { panel, updated: new FakeEl('span'), foot: new FakeEl('footer') };
  const sandbox = {
    document: {
      querySelectorAll: () => tabs,
      getElementById: (k: string) => byId[k],
      createElement: (t: string) => new FakeEl(t),
      createTextNode: (t: string) => {
        const e = new FakeEl('#text');
        e.textContent = t;
        return e;
      },
      createDocumentFragment: () => new FakeEl('#fragment'),
      addEventListener: () => {},
      hidden: false,
    },
    location: { hash: `#${id}` },
    history: { replaceState: () => {} },
    fetch: async () => ({ ok: true, json: async () => payload }),
    setInterval: () => 0,
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return panel.textContent;
}
