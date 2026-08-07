import React from 'react';
import { FileTextIcon } from 'lucide-react';
import { PAPER } from '../../data/scenes';
import { MockWindowChrome } from './MockWindowChrome';
import { MarkedText } from './MarkedText';

interface PaperWindowProps {
  active: boolean;
  onFocus: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export function PaperWindow({ active, onFocus, className, style }: PaperWindowProps) {
  return (
    <MockWindowChrome
      title={PAPER.title}
      subtitle={PAPER.app}
      icon={<FileTextIcon size={13} />}
      active={active}
      onFocus={onFocus}
      className={className}
      style={style}>
      
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-sunken p-5">
        <article
          data-selectable
          className="selection-demo mx-auto max-w-[560px] rounded-sm bg-white px-9 py-8 shadow-panel">
          
          {PAPER.blocks.map((block, index) => {
            if (block.kind === 'title') {
              return (
                <h1 key={index} className="font-serif text-[19px] font-bold leading-snug text-[#141310]">
                  {block.text}
                </h1>);

            }
            if (block.kind === 'meta') {
              return (
                <p key={index} className="mt-1.5 font-serif text-[11px] italic text-[#6b6659]">
                  {block.text}
                </p>);

            }
            if (block.kind === 'heading') {
              return (
                <h2 key={index} className="mt-6 font-serif text-[14px] font-bold text-[#141310]">
                  {block.text}
                </h2>);

            }
            if (block.kind === 'caption') {
              return (
                <figure key={index} className="my-5">
                  <img
                    src={PAPER.figure}
                    alt="共识协议在对抗性调度下的状态转移图，虚线环标出活锁"
                    className="mx-auto w-[74%] rounded-sm border border-[#e6e3dc]" />
                  
                  <figcaption className="mt-2 text-center font-serif text-[11px] text-[#6b6659]">
                    <MarkedText text={block.text} />
                  </figcaption>
                </figure>);

            }
            return (
              <p
                key={index}
                className="mt-3 text-justify font-serif text-[13.5px] leading-[1.85] text-[#211f1a]">
                
                <MarkedText text={block.text} />
              </p>);

          })}
        </article>
      </div>
    </MockWindowChrome>);

}