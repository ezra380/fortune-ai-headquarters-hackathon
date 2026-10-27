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
  private readonly handlers = new Map<string, (() => void)[]>();
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
  addEventListener(type: string, fn: () => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  dispatch(type: string): void {
    for (const fn of this.handlers.get(type) ?? []) fn();
  }
  focus(): void {}
  /** This element and everything under it. */
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
}

export type DrawOptions = {
  /** The address's query string, such as "?division=finance" (a head's own page). */
  search?: string;
  /** A head's page has no tab buttons at all. */
  noTabs?: boolean;
};

export type DrawnPage = {
  /** Everything drawn into the panel, as text. */
  text: () => string;
  /** The addresses the page asked the server for, in order. */
  fetched: string[];
  /** Every link drawn into the panel. */
  links: () => { text: string; href: string }[];
  /** Presses the button with this label and returns the text drawn after. */
  click: (label: string) => Promise<string>;
  /** The last hash the page set in the address bar. */
  hash: () => string;
  /** Every button label drawn into the panel. */
  buttons: () => string[];
  /** The style class of every button drawn into the panel. */
  buttonClasses: () => string[];
};

/** Runs the page's own script with a fake document, the way the browser would. */
export async function drawPage(id: string, payload: unknown, options: DrawOptions = {}): Promise<DrawnPage> {
  const script = /<script>([\s\S]*?)<\/script>/.exec(PAGE_HTML)?.[1] ?? '';
  const tabs = options.noTabs
    ? []
    : TABS.map((d) => {
        const el = new FakeEl('button');
        el.setAttribute('data-id', d.id);
        return el;
      });
  const panel = new FakeEl('main');
  const byId: Record<string, FakeEl> = { panel, updated: new FakeEl('span'), foot: new FakeEl('footer') };
  const fetched: string[] = [];
  let hash = `#${id}`;
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
    location: { hash: `#${id}`, search: options.search ?? '' },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { hash = url; } },
    fetch: async (url: string) => {
      fetched.push(String(url));
      return { ok: true, json: async () => payload };
    },
    setInterval: () => 0,
    encodeURIComponent,
  };
  vm.runInNewContext(script, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return {
    text: () => panel.textContent,
    fetched,
    links: () => panel.all().filter((e) => e.tag === 'a').map((e) => ({ text: e.textContent, href: e.getAttribute('href') ?? '' })),
    click: async (label) => {
      const target = panel.all().find((e) => e.tag === 'button' && e.textContent === label);
      if (!target) throw new Error(`no button labelled "${label}" is drawn`);
      target.dispatch('click');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return panel.textContent;
    },
    hash: () => hash,
    buttons: () => panel.all().filter((e) => e.tag === 'button').map((e) => e.textContent),
    buttonClasses: () => panel.all().filter((e) => e.tag === 'button').map((e) => e.className),
  };
}

/** Runs the page's own script with a fake document, the way the browser would, and returns the text it drew. */
export async function drawTab(id: string, payload: unknown): Promise<string> {
  return (await drawPage(id, payload)).text();
}
