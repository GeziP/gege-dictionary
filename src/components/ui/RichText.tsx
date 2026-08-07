import React from 'react';
import ReactMarkdown from 'react-markdown';

interface RichTextProps {
  children: string;
  className?: string;
}

export function RichText({ children, className }: RichTextProps) {
  const text = children
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '  ');

  return (
    <div className={className}>
    <ReactMarkdown
      components={{
        p: ({ children }) => (
          <p className="mb-1.5 text-[0.92em] leading-relaxed text-ink-muted last:mb-0">{children}</p>
        ),
        strong: ({ children }) => (
          <strong className="font-bold text-accent">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="font-medium not-italic text-ink">{children}</em>
        ),
        code: ({ children, className: codeClass }) => {
          const isBlock = codeClass?.includes('language-');
          if (isBlock) {
            return (
              <code className="block my-1.5 rounded-md border border-line bg-sunken px-2.5 py-2 font-mono text-[0.85em] leading-relaxed text-ink whitespace-pre-wrap">
                {children}
              </code>
            );
          }
          return (
            <code className="rounded bg-accent-soft px-1 py-0.5 font-mono text-[0.85em] font-medium text-accent">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <>{children}</>,
        ul: ({ children }) => (
          <ul className="mb-1.5 ml-3 list-disc space-y-0.5 text-[0.92em] text-ink-muted last:mb-0">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-1.5 ml-3 list-decimal space-y-0.5 text-[0.92em] text-ink-muted last:mb-0">{children}</ol>
        ),
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        h1: ({ children }) => <h4 className="mb-1 text-[1.05em] font-bold text-ink">{children}</h4>,
        h2: ({ children }) => <h4 className="mb-1 text-[1em] font-bold text-ink">{children}</h4>,
        h3: ({ children }) => <h5 className="mb-0.5 text-[0.95em] font-semibold text-ink">{children}</h5>,
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
    </div>
  );
}
