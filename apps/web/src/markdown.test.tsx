import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, splitBlocks } from "./markdown.tsx";

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

const reply = `## Plan

Change **two** files, then run \`bun test\`:

1. Parse the reply
   - nested under it
2. Render it

| File | Lines |
| :--- | ---: |
| a.ts | 12 |

\`\`\`ts
const a = 1;

const b = a_b_c;
\`\`\`

See [the docs](https://en.wikipedia.org/wiki/Markdown_(language)) or https://example.com/x.`;

test("a reply with headings, a list, a table and fenced code renders as Markdown", () => {
  const html = render(reply);
  expect(html).toContain("<h2>Plan</h2>");
  expect(html).toContain("<p>Change <strong>two</strong> files, then run <code>bun test</code>:</p>");
  expect(html).toContain("<ol><li><p>Parse the reply</p><ul><li><p>nested under it</p></li></ul></li><li><p>Render it</p></li></ol>");
  expect(html).toContain('<th style="text-align:left">File</th><th style="text-align:right">Lines</th>');
  expect(html).toContain('<td style="text-align:left">a.ts</td><td style="text-align:right">12</td>');
  // The blank line stays inside the code, and snake_case inside it is left alone.
  expect(html).toContain('<pre><code data-language="ts">const a = 1;\n\nconst b = a_b_c;</code></pre>');
  expect(html).toContain(
    '<a href="https://en.wikipedia.org/wiki/Markdown_(language)" target="_blank" rel="noopener noreferrer">the docs</a>',
  );
  expect(html).toContain('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
});

test("raw HTML, remote images and script links in a reply are shown as text, never rendered", () => {
  const html = render(
    "<script>alert(1)</script>\n\n<img src=https://evil.example/a.png>\n\n![logo](https://evil.example/logo.png)\n\n[click](javascript:alert(1))",
  );
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript');
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(html).toContain("[image: logo] https://evil.example/logo.png");
});

test("a streaming reply keeps its finished blocks unchanged and shows an unclosed fence as code", () => {
  const partial = reply.slice(0, reply.indexOf("const b"));
  const done = splitBlocks(partial).slice(0, -1);
  expect(splitBlocks(reply).slice(0, done.length)).toEqual(done);
  expect(render(partial)).toContain('<pre><code data-language="ts">const a = 1;\n\n</code></pre>');
});
