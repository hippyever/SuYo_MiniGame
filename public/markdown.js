(() => {
  "use strict";

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function safeHref(value) {
    const href = String(value || "").replace(/&amp;/g, "&").trim();
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return "";
    return href;
  }

  function renderInline(value) {
    const tokens = [];
    const keep = (html) => {
      const token = `@@SUYO_MARKDOWN_${tokens.length}@@`;
      tokens.push(html);
      return token;
    };
    let text = escapeHtml(value);
    text = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
      const href = safeHref(url);
      return href ? keep(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${label}</a>`) : match;
    });
    text = text.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
    text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
    text = text.replace(/(^|[^\\\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^\\\w])_([^_\n]+)_/g, "$1<em>$2</em>");
    return text.replace(/@@SUYO_MARKDOWN_(\d+)@@/g, (_, index) => tokens[Number(index)] || "");
  }

  function render(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;

    const isBlockStart = (line) => /^(#{1,6}\s+|```|>\s?|\s*[-+*]\s+|\s*\d+[.)]\s+|\s*([-*_])(?:\s*\1){2,}\s*$)/.test(line);

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^```[^`]*$/);
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !/^```\s*$/.test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        blocks.push("<hr />");
        index += 1;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/, ""));
        blocks.push(`<blockquote>${render(quote.join("\n"))}</blockquote>`);
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const pattern = unordered ? /^\s*[-+*]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(pattern);
          if (!match) break;
          items.push(`<li>${renderInline(match[1])}</li>`);
          index += 1;
        }
        blocks.push(unordered ? `<ul>${items.join("")}</ul>` : `<ol>${items.join("")}</ol>`);
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++]);
      blocks.push(`<p>${paragraph.map(renderInline).join("<br />")}</p>`);
    }
    return blocks.join("");
  }

  window.SuyoMarkdown = Object.freeze({ render, escapeHtml });
})();
