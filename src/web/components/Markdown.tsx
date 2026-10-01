import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

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

function MarkdownImpl({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeUrl} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
