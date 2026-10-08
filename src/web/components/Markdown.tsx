import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Allow only http, https, and mailto links; everything else becomes inert. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://invalid.local/");
    if (parsed.origin === "https://invalid.local") return "";
    return SAFE_SCHEMES.has(parsed.protocol) ? url : "";
  } catch {
    return "";
  }
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  // Remote images are off: show the alt text and the URL instead of loading it.
  img: ({ alt, src }) => (
    <span className="md-image" title={typeof src === "string" ? src : undefined}>
      [image{alt ? `: ${alt}` : ""}]
    </span>
  ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
};

interface Hast {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: Hast[];
}

const hastText = (node: Hast | undefined): string => (node ? (node.value ?? "") + (node.children ?? []).map(hastText).join("") : "");

/** Code blocks with Copy, and Run on one-line shell blocks when `allowRun` (a finished answer). */
function withCode(allowRun: boolean): Components {
  return {
    ...components,
    pre: ({ node, children }) => {
      const code = (node as Hast | undefined)?.children?.find((c) => c.tagName === "code");
      const classes = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
      const lang = classes.find((c) => c.startsWith("language-"))?.slice(9) ?? null;
      return (
        <CodeBlock lang={lang} code={hastText(code)} allowRun={allowRun}>
          {children}
        </CodeBlock>
      );
    },
  };
}

function MarkdownImpl({ text, allowRun = false }: { text: string; allowRun?: boolean }) {
  const parts = useMemo(() => withCode(allowRun), [allowRun]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={parts}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
