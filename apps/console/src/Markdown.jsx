import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./markdown.css";

// Model output is untrusted content. Never interpret HTML or load its images.
const components = {
  a({ href, children }) {
    if (!href || !/^(https?:\/\/|\/(?!\/)|#)/i.test(href))
      return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({ alt }) {
    return alt ? <span>{alt}</span> : null;
  },
  table({ children }) {
    return (
      <div
        className="markdown-table"
        tabIndex={0}
        role="region"
        aria-label="回答の表"
      >
        <table>{children}</table>
      </div>
    );
  },
};

export default function Markdown({ children }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {children ?? ""}
      </ReactMarkdown>
    </div>
  );
}
