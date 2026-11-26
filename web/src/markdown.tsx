import { Fragment, useMemo, type ReactNode } from "react";
import {
  findCitations,
  matchWholeCitation,
  parseMarkdown,
  tokenizeInline,
  type Block,
  type CitationSpan,
} from "./markdown-parse";

/**
 * 极简 Markdown 渲染器：只产出 React 元素，**绝不做 HTML 注入**（不碰 innerHTML），
 * 不引入任何 markdown / HTML 依赖。
 *
 * 覆盖：标题、有序/无序列表、引用、代码块、行内代码、粗体/斜体/删除线、表格、分隔线。
 * 链接按「文本（url）」显示成纯文本 —— 不生成 <a>，避免外链跳走与协议注入。
 * 不支持的行内嵌套（粗体里再套斜体）原样输出，不猜。
 */
function citationTitle(span: CitationSpan): string {
  if (span.kind === "path") return `打开文件 ${span.path}`;
  if (span.kind === "locator") return `定位符 ${span.locator}（第 ${span.page} 页）`;
  return `打开来源面板并高亮第 ${span.page} 页`;
}

/** 唯一的引用按钮渲染路径：裸写引用与「整段就是一个引用」的 code span 共用。 */
function renderCitationButton(
  span: CitationSpan,
  key: string,
  onCitation: (span: CitationSpan) => void,
  fromCode = false,
): ReactNode {
  return (
    <button
      type="button"
      className={`md__cite md__cite--${span.kind}${fromCode ? " md__cite--code" : ""}`}
      key={key}
      onClick={() => onCitation(span)}
      title={citationTitle(span)}
    >
      {span.text}
    </button>
  );
}

function renderCitations(
  text: string,
  keyPrefix: string,
  onCitation: (span: CitationSpan) => void,
): ReactNode[] {
  const hits = findCitations(text);
  if (hits.length === 0) return [text];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, index) => {
    if (hit.start > cursor) nodes.push(text.slice(cursor, hit.start));
    nodes.push(renderCitationButton(hit.span, `${keyPrefix}-c${index}`, onCitation));
    cursor = hit.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function renderInline(
  text: string,
  keyPrefix: string,
  onCitation?: (span: CitationSpan) => void,
): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyPrefix}-i${index}`;
    switch (token.type) {
      case "code": {
        // 反引号里整段就是一个引用（locator / page / 白名单 path）才变按钮：
        // - 夹带其它内容（`p.42, 见图`）→ 仍是 <code>
        // - 没有 onCitation（会话视图）→ 仍是 <code>
        // - src/main.ts 这类不在白名单的普通路径 → matchWholeCitation 返回 null，仍是 <code>
        const wholeCitation = onCitation ? matchWholeCitation(token.text) : null;
        if (wholeCitation && onCitation) {
          return renderCitationButton(wholeCitation, key, onCitation, true);
        }
        return (
          <code className="md__code-inline" key={key}>
            {token.text}
          </code>
        );
      }
      case "bold":
        return <strong key={key}>{token.text}</strong>;
      case "strike":
        return <del key={key}>{token.text}</del>;
      case "italic":
        return <em key={key}>{token.text}</em>;
      case "link":
        return (
          <span className="md__link" key={key}>
            {token.text}
            {token.url ? <span className="md__link-url">{token.url}</span> : null}
          </span>
        );
      default:
        // 纯文本里再找引用定位符：只有调用方给了 handler 才变成可点的 button，
        // 否则原样当文本（"只在你真的能解析时才点"）。
        return onCitation ? (
          <Fragment key={key}>{renderCitations(token.text, key, onCitation)}</Fragment>
        ) : (
          token.text
        );
    }
  });
}

function renderBlock(
  block: Block,
  index: number,
  onCitation?: (span: CitationSpan) => void,
): ReactNode {
  const key = `b${index}`;

  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 1, 6)}` as unknown) as "h2";
      return (
        <Tag className={`md__h md__h${block.level}`} key={key}>
          {renderInline(block.text, `${key}-h`, onCitation)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="md__p" key={key}>
          {renderInline(block.text, `${key}-p`, onCitation)}
        </p>
      );
    case "code":
      return (
        <div className="md__codeblock" key={key}>
          {block.lang ? <span className="md__code-lang">{block.lang}</span> : null}
          <pre className="md__pre">
            <code>{block.body}</code>
          </pre>
        </div>
      );
    case "list": {
      const items = block.items.map((item, itemIndex) => (
        <li className={`md__li md__li-i${item.indent}`} key={`${key}-l${itemIndex}`}>
          {renderInline(item.text, `${key}-l${itemIndex}`, onCitation)}
        </li>
      ));
      return block.ordered ? (
        <ol className="md__list" key={key}>
          {items}
        </ol>
      ) : (
        <ul className="md__list" key={key}>
          {items}
        </ul>
      );
    }
    case "quote":
      return (
        <blockquote className="md__quote" key={key}>
          {block.text.split("\n").map((line, lineIndex) => (
            <p className="md__p" key={`${key}-q${lineIndex}`}>
              {renderInline(line, `${key}-q${lineIndex}`, onCitation)}
            </p>
          ))}
        </blockquote>
      );
    case "table":
      return (
        <div className="md__table-wrap" key={key}>
          <table className="md__table">
            <thead>
              <tr>
                {block.head.map((cell, cellIndex) => (
                  <th key={`${key}-th${cellIndex}`}>{renderInline(cell, `${key}-th${cellIndex}`, onCitation)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-tr${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-td${rowIndex}-${cellIndex}`}>
                      {renderInline(cell, `${key}-td${rowIndex}-${cellIndex}`, onCitation)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "hr":
      return <hr className="md__hr" key={key} />;
    default:
      return null;
  }
}

export default function Markdown({
  text,
  onCitation,
}: {
  text: string;
  /** 给了才把引用渲染成可点 button；不给则原样文本。 */
  onCitation?: (span: CitationSpan) => void;
}) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return <p className="md__p md__p--muted">（空文档）</p>;
  return <div className="md">{blocks.map((block, index) => renderBlock(block, index, onCitation))}</div>;
}
