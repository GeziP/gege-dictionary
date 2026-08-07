import React from 'react';
import { motion } from 'framer-motion';
import type { Entry } from '../../types/lexnote';
import { Skeleton } from '../ui/Skeleton';
import { SpeakButton } from './SpeakButton';

const REGISTER_LABEL: Record<string, string> = {
  formal: '正式',
  neutral: '中性',
  spoken: '口语',
  slang: '俚语',
  technical: '技术'
};

interface CardPrimaryProps {
  entry: Entry | null;
  revealed: number;
  large: boolean;
}

export function CardPrimary({ entry, revealed, large }: CardPrimaryProps) {
  if (!entry || revealed < 1) {
    return (
      <div className="space-y-3 px-4 pb-4 pt-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-12" />
        </div>
        <Skeleton className="h-3.5 w-44" />
        <div className="space-y-2 rounded-lg border border-line bg-raised p-3">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      </div>);

  }

  const isSentence = entry.kind === 'sentence';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="px-4 pb-4 pt-3">
      
      {isSentence ?
      <p className="font-serif text-[15px] italic leading-relaxed text-ink-muted">{entry.lemma}</p> :

      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <h2
          className={`font-serif font-bold leading-tight text-ink ${large ? 'text-[32px]' : 'text-[26px]'}`}>
          
            {entry.lemma}
          </h2>
          <span className="rounded border border-line bg-raised px-1.5 py-0.5 text-[11px] text-ink-muted">
            {entry.pos}
          </span>
          <span className="rounded border border-accent-line bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">
            {REGISTER_LABEL[entry.register] ?? entry.register}
          </span>
          {entry.selection.toLowerCase() !== entry.lemma.toLowerCase() ?
        <span className="text-[11px] text-ink-subtle">原形还原自 “{entry.selection}”</span> :
        null}
        </div>
      }

      {!isSentence && entry.ipaUS ?
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">US</span>
            <span className="font-ipa text-[15px] text-ink-muted">{entry.ipaUS}</span>
            <SpeakButton text={entry.lemma} label={`朗读 ${entry.lemma}（美式）`} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">UK</span>
            <span className="font-ipa text-[15px] text-ink-muted">{entry.ipaUK}</span>
          </div>
        </div> :
      null}

      <div className="mt-3 border-l-2 border-accent bg-accent-soft py-2 pl-3 pr-2">
        <p className={`font-medium leading-relaxed text-ink ${large ? 'text-[17px]' : 'text-[15px]'}`}>
          {isSentence ? entry.translation : entry.contextMeaning}
        </p>
        {!isSentence ?
        <p className="mt-1 text-xs text-ink-muted">词典义：{entry.translation}</p> :

        <p className="mt-1 text-xs text-ink-muted">{entry.contextMeaning}</p>
        }
      </div>
    </motion.div>);

}