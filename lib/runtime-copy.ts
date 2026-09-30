import { expect, type Page } from '@playwright/test';
import { englishBody, localeBody } from './locales';

interface RuntimeCopyInputs {
  /** Test-owned input data; the picker clears input.files after delivery. */
  filenames?: readonly string[];
}

/** Check the rendered interface, leaving file contents and code samples alone. */
export async function expectLocalizedCopy(
  page: Page, slug: string, locale: string, inputs: RuntimeCopyInputs = {},
): Promise<void> {
  await expect(page.locator('#boot-warning'), `${locale}/${slug} did not finish its entry module`)
    .toHaveCount(0, { timeout: 30_000 });
  const translated = localeBody(locale, slug);
  expect(translated, `${locale}/${slug} has no translated source`).not.toBeNull();
  const faults = await page.evaluate(({ english, local, filenames }) => {
    const normal = (text: string) => text.replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
    const parse = (html: string) => {
      const template = document.createElement('template');
      template.innerHTML = html;
      return template.content;
    };
    const en = parse(english), own = parse(local);
    const phrases = (root: ParentNode) => new Map(Array.from(root.querySelectorAll('[data-phrase]'))
      .map((node) => [node.getAttribute('data-phrase')!, normal(node.textContent ?? '')]));
    const source = phrases(en), target = phrases(own);
    const keys = new Set([...source.keys(), ...target.keys()]);
    const namespaces = new Set([...keys].map((key) => key.split('.')[0]));
    const dotted = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+\b/g;
    // Literal technical terms, example addresses and filenames in the prose
    // are not phrase lookups. User-provided filenames are also valid output.
    const allowed = new Set<string>();
    const fileTokens = new Set(filenames.flatMap((name) => name.match(dotted) ?? []));
    // Export names are data too. Their download attribute is independent of
    // the text/accessible label being checked and exists after input reset.
    for (const link of Array.from(document.querySelectorAll('a[download]'))) {
      for (const token of (link.getAttribute('download') ?? '').match(dotted) ?? []) fileTokens.add(token);
    }
    const sourceHosts = new Set(location.hostname.match(dotted) ?? []);
    const rememberAddress = (value: string) => {
      for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/g)) {
        try {
          for (const token of new URL(match[0]).hostname.match(dotted) ?? []) sourceHosts.add(token);
        } catch { /* not an address the source declares */ }
      }
    };
    for (const root of [en, own]) {
      root.querySelectorAll('#phrases, #frame-phrases').forEach((node) => node.remove());
      for (const token of (root.textContent ?? '').match(dotted) ?? []) allowed.add(token);
      for (const element of Array.from(root.querySelectorAll('[aria-label], [title], [placeholder]'))) {
        for (const attribute of ['aria-label', 'title', 'placeholder']) {
          for (const token of (element.getAttribute(attribute) ?? '').match(dotted) ?? []) allowed.add(token);
        }
      }
      // Hostnames may be rendered from a URL-valued input rather than as the
      // original complete URL. Do not exempt arbitrary domain-shaped words.
      for (const element of Array.from(root.querySelectorAll('[href], [src], [value], [placeholder]'))) {
        for (const attribute of ['href', 'src', 'value', 'placeholder']) {
          rememberAddress(element.getAttribute(attribute) ?? '');
        }
      }
    }
    const visible = (el: Element) => el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden';
    const entries: Array<{ text: string; attribute: boolean }> = [];
    const main = document.querySelector('#main')!;
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('script, style, pre, code, textarea, #phrases, #frame-phrases')) continue;
      const text = normal(node.textContent ?? '');
      if (text) entries.push({ text, attribute: false });
    }
    for (const el of Array.from(main.querySelectorAll('[aria-label], [title], [placeholder]'))) {
      if (!visible(el)) continue;
      for (const attribute of ['aria-label', 'title', 'placeholder']) {
        const text = normal(el.getAttribute(attribute) ?? '');
        if (text) entries.push({ text, attribute: true });
      }
    }
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const englishOnly = [...source].filter(([key, value]) => target.has(key) && target.get(key) !== value)
      // A format such as "{day} {month} {year}" has no English words in it;
      // turning it into three wildcards would match every translated sentence.
      .filter(([, value]) => !/\{\w+\}/.test(value)
        || (value.replace(/\{\w+\}/g, '').match(/[a-zA-Z]/g) ?? []).length >= 4)
      .map(([key, value]) => ({ key, value, pattern: new RegExp(`^${value.split(/\{\w+\}/).map(escape).join('.+?')}$`) }));
    const failures: string[] = [];
    for (const { text, attribute } of entries) {
      if (/\{[a-zA-Z_]\w*\}/.test(text)) failures.push(`unfilled placeholder: ${text}`);
      const addresses = new Set([...text.matchAll(/https?:\/\/[^\s<]+/g)]
        .flatMap((match) => match[0].match(dotted) ?? []));
      for (const token of text.match(dotted) ?? []) {
        const filename = /\.(?:png|apng|jpe?g|gif|webp|avif|hei[cf]|bmp|tiff?|ico|icns|cur|svgz?|pdf|[ct]sv|txt|json|ya?ml|xml|wav|mp[34]|webm|mov|m[4k][av]|ogg|flac|aac|zip|dcm|bin|patch|css|html|md|sha(?:1|256|512)|md5)$/i.test(token);
        const explicitData = allowed.has(token) || fileTokens.has(token)
          || sourceHosts.has(token) || addresses.has(token);
        // A typo in an existing namespace must still fail even when its
        // suffix resembles an extension (for example an unknown format.png).
        // Numeric dates and codec labels such as H.264 do not match dotted.
        const fileShaped = filename && !namespaces.has(token.split('.')[0]);
        if (keys.has(token) || (!explicitData && !fileShaped)) {
          failures.push(`phrase-like token: ${token} in ${text}`);
        }
      }
      for (const candidate of englishOnly) {
        // Short translated words can coincide with ordinary prose. In an
        // accessible label, however, an exact old English label is evidence.
        if ((attribute || candidate.value.length >= 18) && candidate.pattern.test(text)) {
          failures.push(`English ${candidate.key}: ${text}`);
        }
      }
    }
    return [...new Set(failures)];
  }, { english: englishBody(slug), local: translated!, filenames: [...(inputs.filenames ?? [])] });
  expect(faults, `${locale}/${slug}:\n${faults.join('\n')}`).toEqual([]);
}

/** Assert a specific label against the independent translated markup. */
export async function phraseText(page: Page, key: string): Promise<string> {
  const node = page.locator(`#phrases [data-phrase="${key}"]`);
  await expect(node, `the page omits ${key}`).toHaveCount(1);
  return ((await node.textContent()) ?? '').replace(/\s+/g, ' ').trim();
}
