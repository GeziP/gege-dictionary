import React from 'react';
import { DEMO_TERMS } from '../../data/scenes';

const PATTERN = new RegExp(`(${DEMO_TERMS.join('|')})`, 'gi');

/** Underlines the terms that ship with full offline model output in this prototype. */
export function MarkedText({ text }: {text: string;}) {
  const parts = text.split(PATTERN);
  return (
    <>
      {parts.map((part, index) =>
      DEMO_TERMS.some((term) => term.toLowerCase() === part.toLowerCase()) ?
      <span key={index} className="border-b border-dashed border-accent-line">
            {part}
          </span> :

      <React.Fragment key={index}>{part}</React.Fragment>

      )}
    </>);

}