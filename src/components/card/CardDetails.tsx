import React from 'react';
import { motion } from 'framer-motion';
import { GitBranchIcon, ShuffleIcon, AlertTriangleIcon } from 'lucide-react';
import type { Entry } from '../../types/lexnote';
import { Skeleton } from '../ui/Skeleton';
import { SpeakButton } from './SpeakButton';
import { splitOnTerm } from '../../utils/format';

const ASSOCIATION_ICON = {
  root: GitBranchIcon,
  synonym: ShuffleIcon,
  confusable: AlertTriangleIcon
};

const ASSOCIATION_LABEL = {
  root: '词根词缀',
  synonym: '近义辨析',
  confusable: '易混词'
};

function SectionTitle({ children }: {children: React.ReactNode;}) {
  return (
    <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-subtle">
      {children}
    </h3>);

}

function Section({ children, index }: {children: React.ReactNode;index: number;}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.01 }}
      className="border-t border-line px-4 py-3">
      
      {children}
    </motion.section>);

}

interface CardDetailsProps {
  entry: Entry;
  revealed: number;
  streaming: boolean;
}

export function CardDetails({ entry, revealed, streaming }: CardDetailsProps) {
  const isSentence = entry.kind === 'sentence';

  return (
    <div>
      {revealed >= 2 ?
      <Section index={0}>
          <SectionTitle>{isSentence ? '写作骨架' : '详细解释'}</SectionTitle>
          <p className="text-[13px] leading-[1.75] text-ink-muted">{entry.explanation}</p>
        </Section> :
      null}

      {revealed >= 3 && isSentence && entry.syntax ?
      <Section index={1}>
          <SectionTitle>句法拆解</SectionTitle>
          <ul className="space-y-2">
            {entry.syntax.map((part) =>
          <li key={part.part} className="flex gap-2.5 text-[13px] leading-relaxed">
                <span className="mt-[3px] shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 text-[10px] text-ink-muted">
                  {part.part}
                </span>
                <span className="text-ink-muted">{part.note}</span>
              </li>
          )}
          </ul>
        </Section> :
      null}

      {revealed >= 3 && !isSentence && entry.senses.length > 0 ?
      <Section index={1}>
          <SectionTitle>常见义项</SectionTitle>
          <ol className="space-y-2">
            {entry.senses.map((sense, index) =>
          <li key={sense.gloss} className="flex gap-2.5 text-[13px] leading-relaxed">
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-sunken text-center text-[10px] leading-4 text-ink-subtle">
                  {index + 1}
                </span>
                <span>
                  <span className="mr-1.5 font-ipa text-[12px] text-ink-subtle">{sense.pos}</span>
                  <span className="text-ink">{sense.translation}</span>
                  <span className="mt-0.5 block text-[12px] italic text-ink-subtle">{sense.gloss}</span>
                </span>
              </li>
          )}
          </ol>
        </Section> :
      null}

      {revealed >= 4 ?
      <Section index={2}>
          <SectionTitle>例句</SectionTitle>
          <ul className="space-y-2.5">
            {entry.examples.map((example) =>
          <li key={example.en} className="group flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-[14px] leading-relaxed text-ink">
                    {(isSentence ?
                [{ chunk: example.en, hit: false }] :
                splitOnTerm(example.en, entry.lemma)).
                map((part, i) =>
                part.hit ?
                <mark
                  key={i}
                  className="rounded bg-highlight px-0.5 text-ink"
                  style={{ backgroundColor: 'var(--highlight)' }}>
                  
                          {part.chunk}
                        </mark> :

                <React.Fragment key={i}>{part.chunk}</React.Fragment>

                )}
                  </p>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-ink-subtle">{example.zh}</p>
                </div>
                <SpeakButton text={example.en} label="朗读例句" size={13} className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
              </li>
          )}
          </ul>
        </Section> :
      null}

      {revealed >= 5 && isSentence && entry.keyTerms ?
      <Section index={3}>
          <SectionTitle>值得收藏的表达</SectionTitle>
          <ul className="space-y-1.5">
            {entry.keyTerms.map((term) =>
          <li key={term.term} className="text-[13px] leading-relaxed">
                <span className="font-serif font-bold text-ink">{term.term}</span>
                <span className="text-ink-subtle"> — {term.gloss}</span>
              </li>
          )}
          </ul>
        </Section> :
      null}

      {revealed >= 5 && entry.associations.length > 0 ?
      <Section index={3}>
          <SectionTitle>联想</SectionTitle>
          <ul className="space-y-2.5">
            {entry.associations.map((association) => {
            const Icon = ASSOCIATION_ICON[association.kind];
            return (
              <li key={association.title} className="flex gap-2.5">
                  <Icon size={13} className="mt-1 shrink-0 text-accent" />
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium leading-snug text-ink">
                      <span className="mr-1.5 text-[10px] uppercase tracking-wider text-ink-subtle">
                        {ASSOCIATION_LABEL[association.kind]}
                      </span>
                      {association.title}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{association.detail}</p>
                  </div>
                </li>);

          })}
          </ul>
        </Section> :
      null}

      {revealed >= 6 ?
      <Section index={4}>
          <SectionTitle>常见搭配</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {entry.collocations.map((collocation) =>
          <span
            key={collocation}
            className="rounded border border-line bg-raised px-1.5 py-0.5 font-serif text-[12px] text-ink-muted">
            
                {collocation}
              </span>
          )}
          </div>
        </Section> :
      null}

      {streaming ?
      <div className="space-y-2 border-t border-line px-4 py-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-2/3" />
        </div> :
      null}
    </div>);

}