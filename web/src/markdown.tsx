import { useMemo, type ReactNode } from "react";
import { parseMarkdown, tokenizeInline, type Block } from "./markdown-parse";

/**
 * 极简 Markdown 渲染器：只产出 React 元素，**绝不做 HTML 注入**（不碰 innerHTML），
 * 不引入任何 markdown / HTML 依赖。
 *
 * 覆盖：标题、有序/无序列表、引用、代码块、行内代码、粗体/斜体/删除线、表格、分隔线。
 * 链接按「文本（url）」显示成纯文本 —— 不生成 <a>，避免外链跳走与协议注入。
 * 不支持的行内嵌套（粗体里再套斜体）原样输出，不猜。
 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return tokenizeInline(text).map((token, index) => {
    const key = `${keyPrefix}-i${index}`;
    switch (token.type) {
      case "code":
        return (
          <code className="md__code-inline" key={key}>
            {token.text}
          </code>
        );
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
        return token.text;
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  const key = `b${index}`;

  switch (block.type) {
    case "heading": {
      const Tag = (`h${Math.min(block.level + 1, 6)}` as unknown) as "h2";
      return (
        <Tag className={`md__h md__h${block.level}`} key={key}>
          {renderInline(block.text, `${key}-h`)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className="md__p" key={key}>
          {renderInline(block.text, `${key}-p`)}
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
          {renderInline(item.text, `${key}-l${itemIndex}`)}
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
              {renderInline(line, `${key}-q${lineIndex}`)}
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
                  <th key={`${key}-th${cellIndex}`}>{renderInline(cell, `${key}-th${cellIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={`${key}-tr${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${key}-td${rowIndex}-${cellIndex}`}>
                      {renderInline(cell, `${key}-td${rowIndex}-${cellIndex}`)}
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

export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  if (blocks.length === 0) return <p className="md__p md__p--muted">（空文档）</p>;
  return <div className="md">{blocks.map(renderBlock)}</div>;
}
