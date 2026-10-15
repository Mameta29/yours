import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import Markdown from "./Markdown";

const render = (text) => renderToStaticMarkup(<Markdown>{text}</Markdown>);
describe("untrusted assistant Markdown", () => {
  it("renders emphasis, nested lists and GFM tables", () => {
    const html = render(
      "1. **商品**\n   - 300 JPYC\n\n| 商品 | 価格 |\n| --- | --- |\n| template | 300 |",
    );
    expect(html).toContain("<strong>商品</strong>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<table>");
    expect(html).toContain('aria-label="回答の表"');
  });
  it("does not execute HTML or javascript links from a tool or model", () => {
    const html = render(
      "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[open](javascript:alert%281%29)",
    );
    expect(html).not.toMatch(/<script|<img|onerror|href=/);
  });
  it("does not fetch images and isolates links from the application", () => {
    const html = render(
      "![tracking](https://example.com/pixel)\n\n[取引](https://amoy.polygonscan.com/tx/123)",
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("pixel");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://amoy.polygonscan.com/tx/123"');
  });
});
