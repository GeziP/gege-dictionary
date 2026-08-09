import React, { useState } from 'react';
import {
  CheckIcon,
  ClipboardIcon,
  CpuIcon,
  FlaskConicalIcon,
} from 'lucide-react';
import type {
  CodeExample,
  DomainAnalysis as DomainAnalysisData,
  DomainWorkflow,
} from '../../types/lexnote';
import * as bridge from '../../lib/tauri-bridge';
import { RichText } from '../ui/RichText';

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h4 className="text-[11px] font-semibold text-ink">{children}</h4>;
}

function safeStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())) : [];
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function BulletList({ items }: { items?: string[] }) {
  if (!items?.length) return null;
  return (
    <ul className="mt-1 space-y-1">
      {items.map((item, index) => (
        <li key={`${index}-${item}`} className="flex gap-2 text-[11px] leading-relaxed text-ink-muted">
          <span className="mt-[0.45em] h-1 w-1 shrink-0 rounded-full bg-accent" />
          <RichText>{item}</RichText>
        </li>
      ))}
    </ul>
  );
}

export function Workflow({ workflow }: { workflow?: DomainWorkflow }) {
  const steps = Array.isArray(workflow?.steps)
    ? workflow.steps.filter((step) => step && typeof step.label === 'string' && Boolean(step.label.trim()))
    : [];
  if (!steps.length) return null;
  return (
    <div>
      <SectionHeading>{workflow.title || '流程'}</SectionHeading>
      <ol className="mt-1.5 space-y-0">
        {steps.map((step, index) => (
          <li key={`${index}-${step.label}`} className="relative flex gap-2.5 pb-2 last:pb-0">
            {index + 1 < steps.length ? (
              <span className="absolute left-[9px] top-5 h-[calc(100%-12px)] w-px bg-accent-line" />
            ) : null}
            <span className="relative z-[1] flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-soft text-[9px] font-semibold text-accent">
              {index + 1}
            </span>
            <div className="min-w-0 pt-px">
              <p className="text-[11px] font-medium leading-snug text-ink">{step.label}</p>
              {step.description ? (
                <div className="mt-0.5 text-[10px] leading-relaxed text-ink-muted">
                  <RichText>{step.description}</RichText>
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CodeCard({ example }: { example: CodeExample }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (bridge.isTauri()) {
      await bridge.copyText(example.code);
    } else {
      await navigator.clipboard.writeText(example.code);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="overflow-hidden rounded-md border border-line bg-sunken">
      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium text-ink">{example.title || '示例'}</span>
        <span className="rounded bg-raised px-1.5 py-0.5 font-mono text-[9px] text-ink-subtle">
          {example.language || 'text'}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex items-center gap-1 text-[9px] text-ink-subtle hover:text-accent"
          aria-label={`复制${example.title || '代码'}`}
        >
          {copied ? <CheckIcon size={10} /> : <ClipboardIcon size={10} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="thin-scroll overflow-x-auto p-2.5 text-[10px] leading-relaxed text-ink">
        <code className="font-mono whitespace-pre">{example.code}</code>
      </pre>
      {example.explanation ? (
        <div className="border-t border-line bg-raised px-2.5 py-1.5 text-[10px] text-ink-muted">
          <RichText>{example.explanation}</RichText>
        </div>
      ) : null}
    </div>
  );
}

function ComputingAnalysis({ analysis }: { analysis: Extract<DomainAnalysisData, { domain: 'computing' }> }) {
  const algorithm = analysis.algorithm && typeof analysis.algorithm === 'object' ? analysis.algorithm : undefined;
  const codeExamples = Array.isArray(analysis.codeExamples)
    ? analysis.codeExamples.filter((example) => example && typeof example.code === 'string' && Boolean(example.code.trim()))
    : [];
  if (algorithm?.pseudocode) {
    codeExamples.unshift({
      title: algorithm.name ? `${algorithm.name} · 伪代码` : '算法伪代码',
      language: 'pseudocode',
      code: algorithm.pseudocode,
      explanation: algorithm.summary,
    });
  }
  return (
    <div className="space-y-3">
      <div className="text-[11px] leading-relaxed text-ink-muted"><RichText>{analysis.overview}</RichText></div>
      {safeStrings(analysis.mechanism).length ? (
        <div><SectionHeading>核心机制</SectionHeading><BulletList items={safeStrings(analysis.mechanism)} /></div>
      ) : null}
      <Workflow workflow={analysis.workflow} />
      {algorithm ? (
        <div className="rounded-md border border-line bg-raised p-2.5">
          <SectionHeading>{algorithm.name || '算法拆解'}</SectionHeading>
          {algorithm.summary ? <div className="mt-1 text-[10px] text-ink-muted"><RichText>{algorithm.summary}</RichText></div> : null}
          <BulletList items={safeStrings(algorithm.steps)} />
          {algorithm.timeComplexity || algorithm.spaceComplexity ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {algorithm.timeComplexity ? <span className="rounded bg-accent-soft px-2 py-1 font-mono text-[9px] text-accent">时间 {algorithm.timeComplexity}</span> : null}
              {algorithm.spaceComplexity ? <span className="rounded bg-accent-soft px-2 py-1 font-mono text-[9px] text-accent">空间 {algorithm.spaceComplexity}</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {codeExamples.length ? (
        <div className="space-y-2">
          <SectionHeading>代码与伪代码</SectionHeading>
          {codeExamples.map((example, index) => <CodeCard key={`${index}-${example.title}`} example={example} />)}
        </div>
      ) : null}
      {safeStrings(analysis.tradeoffs).length ? (
        <div><SectionHeading>工程边界与权衡</SectionHeading><BulletList items={safeStrings(analysis.tradeoffs)} /></div>
      ) : null}
    </div>
  );
}

function IvdAnalysis({ analysis }: { analysis: Extract<DomainAnalysisData, { domain: 'medical_ivd' }> }) {
  const specimens = safeStrings(analysis.specimen);
  const metrics = Array.isArray(analysis.performanceMetrics)
    ? analysis.performanceMetrics.filter((metric) => metric && typeof metric.name === 'string' && typeof metric.meaning === 'string')
    : [];
  const analyte = safeString(analysis.analyte);
  const facts = [
    analyte ? ['分析物', analyte] : null,
    specimens.length ? ['样本', specimens.join('、')] : null,
  ].filter(Boolean) as string[][];
  return (
    <div className="space-y-3">
      <div className="text-[11px] leading-relaxed text-ink-muted"><RichText>{analysis.overview}</RichText></div>
      {facts.length ? (
        <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="rounded-md border border-line bg-raised px-2.5 py-2">
              <dt className="text-[9px] font-semibold text-ink-subtle">{label}</dt>
              <dd className="mt-0.5 text-[11px] text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {analysis.principle ? <div><SectionHeading>检测原理</SectionHeading><div className="mt-1 text-[11px] text-ink-muted"><RichText>{analysis.principle}</RichText></div></div> : null}
      <Workflow workflow={analysis.workflow} />
      {analysis.clinicalMeaning ? <div><SectionHeading>结果与临床意义</SectionHeading><div className="mt-1 text-[11px] text-ink-muted"><RichText>{analysis.clinicalMeaning}</RichText></div></div> : null}
      {metrics.length ? (
        <div>
          <SectionHeading>性能指标</SectionHeading>
          <div className="mt-1 grid gap-1.5 sm:grid-cols-2">
            {metrics.map((metric) => (
              <div key={metric.name} className="rounded border border-line bg-raised px-2 py-1.5">
                <p className="text-[10px] font-medium text-accent">{metric.name}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-ink-muted">{metric.meaning}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {safeStrings(analysis.interferences).length ? <div><SectionHeading>干扰因素</SectionHeading><BulletList items={safeStrings(analysis.interferences)} /></div> : null}
      {safeStrings(analysis.qualityControl).length ? <div><SectionHeading>质量控制</SectionHeading><BulletList items={safeStrings(analysis.qualityControl)} /></div> : null}
      {safeStrings(analysis.limitations).length ? <div><SectionHeading>适用边界</SectionHeading><BulletList items={safeStrings(analysis.limitations)} /></div> : null}
      {safeStrings(analysis.standards).length ? <div><SectionHeading>标准与口径</SectionHeading><BulletList items={safeStrings(analysis.standards)} /></div> : null}
      <p className="rounded border border-line bg-raised px-2.5 py-1.5 text-[9px] leading-relaxed text-ink-subtle">
        仅用于术语与检测知识解释，不构成个体诊断、治疗或医学决策建议。
      </p>
    </div>
  );
}

export function DomainAnalysis({ analysis }: { analysis?: DomainAnalysisData }) {
  if (typeof analysis?.overview !== 'string' || !analysis.overview.trim() || !['computing', 'medical_ivd'].includes(analysis.domain)) return null;
  const computing = analysis.domain === 'computing';
  const Icon = computing ? CpuIcon : FlaskConicalIcon;
  return (
    <section className="overflow-hidden rounded-md border border-accent-line bg-accent-soft/30">
      <div className="flex items-center gap-2 border-b border-accent-line bg-accent-soft px-2.5 py-2">
        <Icon size={13} className="text-accent" />
        <h3 className="text-[11px] font-semibold text-ink">{computing ? '计算机领域深化' : 'IVD 领域深化'}</h3>
        <span className="ml-auto text-[9px] text-ink-subtle">结构化专业解析</span>
      </div>
      <div className="p-2.5">
        {computing
          ? <ComputingAnalysis analysis={analysis} />
          : <IvdAnalysis analysis={analysis} />}
      </div>
    </section>
  );
}
