import React from 'react';

/**
 * An example sentence with the word it is an example of picked out: the word itself, and what
 * is added to it (run → running), but only where a word begins, so that the "run" in "prune"
 * is not taken for it.
 */
export function HighlightWord({ text, word }: { text: string; word: string }) {
  if (!word) return <>{text}</>;
  // The group makes `split` keep what matched, at the odd places.
  const regex = new RegExp(`(?<!\\w)(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded bg-highlight px-0.5 font-medium">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}
