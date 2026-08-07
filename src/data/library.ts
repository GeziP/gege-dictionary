import type { Entry, SavedWord } from '../types/lexnote';
import { ENTRIES } from './entries';

const daysAgo = (days: number, hours = 0) =>
new Date(Date.now() - days * 86_400_000 - hours * 3_600_000).toISOString();

interface SavedMeta {
  savedAt: string;
  context: string;
  sourceApp: string;
  sourceTitle: string;
  tags: string[];
  mastery: SavedWord['mastery'];
  lookups: number;
  note?: string;
}

function fromEntry(key: string, meta: SavedMeta): SavedWord {
  const entry = ENTRIES[key];
  return { ...entry, ...meta, note: meta.note ?? '' };
}

function custom(entry: Entry, meta: SavedMeta): SavedWord {
  return { ...entry, ...meta, note: meta.note ?? '' };
}

const idempotent: Entry = {
  id: 'e-idempotent',
  selection: 'idempotent',
  lemma: 'idempotent',
  pos: 'adj.',
  ipaUS: '/aɪˈdempətənt/',
  ipaUK: '/ˌɪdemˈpəʊtənt/',
  translation: '幂等的',
  contextMeaning: '指同一个操作执行一次与执行多次的结果完全相同，因此可以安全重试。',
  explanation:
  '接口设计中的核心形容词。注意美英读音差异很大，美式重音在第二音节。名词形式为 idempotence / idempotency，两者都被接受，AWS 文档用 idempotency。',
  senses: [
  { pos: 'adj.', gloss: 'producing the same result however many times it is applied', translation: '幂等的：重复执行结果不变' }],

  associations: [
  { kind: 'root', title: 'idem（同一） + potent（幂、力量）', detail: '拉丁语「同一次方」，数学中 f(f(x)) = f(x)。' },
  { kind: 'synonym', title: 'safe / retryable', detail: 'HTTP 规范里 safe 指不改变状态，idempotent 允许改变状态但重复无副作用，两者不等价。' }],

  examples: [
  { en: 'Make the webhook handler idempotent so redeliveries are harmless.', zh: '把 webhook 处理逻辑做成幂等的，这样重复投递也不会有副作用。' },
  { en: 'PUT is idempotent; POST generally is not.', zh: 'PUT 是幂等的，POST 通常不是。' }],

  collocations: ['idempotent operation', 'idempotency key', 'make sth idempotent'],
  register: 'technical',
  kind: 'word'
};

const indemnify: Entry = {
  id: 'e-indemnify',
  selection: 'indemnify',
  lemma: 'indemnify',
  pos: 'v. 及物',
  ipaUS: '/ɪnˈdemnɪfaɪ/',
  ipaUK: '/ɪnˈdemnɪfaɪ/',
  translation: '赔偿；使免受损失',
  contextMeaning: '合同条款中指一方承诺为另一方因特定事由产生的损失与索赔买单。',
  explanation:
  '法律高频动词，固定搭配 indemnify A against/for B，名词是 indemnity（赔偿责任），条款名为 indemnification clause。签字前必须看清谁 indemnify 谁。',
  senses: [
  { pos: 'v.', gloss: 'to compensate someone for harm or loss', translation: '赔偿某人的损失' },
  { pos: 'v.', gloss: 'to secure someone against legal liability', translation: '使某人免于法律责任' }],

  associations: [
  { kind: 'root', title: 'in-（不） + damn/demn-（损害，同 damage）', detail: '「使不受损害」，与 condemn 同根。' },
  { kind: 'confusable', title: 'indemnify vs. reimburse', detail: 'reimburse 只是报销已付出的钱；indemnify 覆盖更广的赔偿与责任承担。' }],

  examples: [
  { en: 'The vendor shall indemnify the client against third-party IP claims.', zh: '供应商应就第三方知识产权索赔向客户作出赔偿。' },
  { en: 'We are indemnified for any losses arising from the migration.', zh: '因迁移产生的任何损失均由对方赔偿。' }],

  collocations: ['indemnify sb against sth', 'indemnification clause', 'hold harmless and indemnify'],
  register: 'formal',
  kind: 'word'
};

const escalate: Entry = {
  id: 'e-escalate',
  selection: 'escalate',
  lemma: 'escalate',
  pos: 'v.',
  ipaUS: '/ˈeskəleɪt/',
  ipaUK: '/ˈeskəleɪt/',
  translation: '升级上报；（问题）恶化',
  contextMeaning: '职场语境为中性的「上报给更高层级处理」，不带「把事情闹大」的负面含义。',
  explanation:
  '同一个词有两条语气线：escalate an issue to sb（流程性上报，中性）与 the conflict escalated（局势升级，负面）。写邮件时加上 to 与对象可以避免被误读为施压。',
  senses: [
  { pos: 'v.', gloss: 'to refer a matter to a higher level of authority', translation: '上报、升级处理' },
  { pos: 'v.', gloss: 'to become more serious or intense', translation: '（冲突、成本）升级、加剧' }],

  associations: [
  { kind: 'root', title: 'escalator（自动扶梯）的动词化', detail: '「一级一级往上送」，因此核心是「层级上移」。' },
  { kind: 'synonym', title: 'escalate vs. flag vs. raise', detail: 'flag 只是提醒注意；raise 是提出；escalate 明确带有「越过当前层级」的含义。' }],

  examples: [
  { en: 'If the vendor misses the SLA again, we will escalate to their account director.', zh: '如果供应商再次未达 SLA，我们会上报给他们的客户总监。' },
  { en: 'Costs escalated quickly once the scope changed.', zh: '范围一变，成本迅速上升。' }],

  collocations: ['escalate an issue', 'escalate to management', 'escalation path'],
  register: 'neutral',
  kind: 'word'
};

const inLieuOf: Entry = {
  id: 'e-in-lieu-of',
  selection: 'in lieu of',
  lemma: 'in lieu of',
  pos: 'prep. phr.',
  ipaUS: '/ɪn ˈluː əv/',
  ipaUK: '/ɪn ˈljuː əv/',
  translation: '代替；用……取代',
  contextMeaning: '正式书面语，表示「以 A 替代 B」，合同与 HR 文件中极常见。',
  explanation:
  'lieu 来自法语「地点」，注意读音不是 /laɪ/。日常口语几乎不用这个短语，用 instead of 即可；但在合同、通知、休假政策中它是标准表达（payment in lieu of notice 代通知金）。',
  senses: [{ pos: 'prep. phr.', gloss: 'instead of, in place of', translation: '代替、取而代之' }],
  associations: [
  { kind: 'confusable', title: '发音陷阱', detail: '读作 /luː/ 或 /ljuː/，不读 /laɪ.uː/；中文母语者常读错。' },
  { kind: 'synonym', title: 'in lieu of vs. instead of', detail: '语义相同，语域不同：前者正式书面，后者通用。' }],

  examples: [
  { en: 'Employees may take time off in lieu of overtime pay.', zh: '员工可以用调休代替加班费。' },
  { en: 'We accepted equity in lieu of a cash bonus.', zh: '我们接受以股权代替现金奖金。' }],

  collocations: ['in lieu of notice', 'time off in lieu', 'in lieu of payment'],
  register: 'formal',
  kind: 'phrase'
};

const eventualConsistency: Entry = {
  id: 'e-eventual-consistency',
  selection: 'eventual consistency',
  lemma: 'eventual consistency',
  pos: 'n. phr.',
  ipaUS: '/ɪˈventʃuəl kənˈsɪstənsi/',
  ipaUK: '/ɪˈventʃuəl kənˈsɪstənsi/',
  translation: '最终一致性',
  contextMeaning: '指副本在没有新写入后终将收敛到一致状态，但不承诺何时收敛。',
  explanation:
  '注意 eventual 是「最终的」而不是「可能的」——这是中文母语者最容易误读的形容词之一。与 strong consistency 相对，中间还有 causal / read-your-writes 等更强的模型。',
  senses: [
  { pos: 'n.', gloss: 'a model where replicas converge given no new updates', translation: '最终一致性（分布式存储）' }],

  associations: [
  { kind: 'confusable', title: 'eventual ≠ 可能的', detail: 'eventual 表示「最终会发生」，eventually 同理；表示「可能」应该用 possible。' },
  { kind: 'synonym', title: 'convergence / BASE', detail: 'BASE（Basically Available, Soft state, Eventual consistency）是与 ACID 相对的一组特性。' }],

  examples: [
  { en: 'The cache offers eventual consistency, so stale reads are expected.', zh: '该缓存提供最终一致性，因此读到旧数据是预期之内的。' },
  { en: 'Users rarely tolerate eventual consistency in a balance display.', zh: '用户很难接受余额显示上的最终一致性。' }],

  collocations: ['eventual consistency model', 'converge eventually', 'stale read'],
  register: 'technical',
  kind: 'phrase'
};

const bringToTheTable: Entry = {
  id: 'e-bring-to-the-table',
  selection: 'bring to the table',
  lemma: 'bring sth to the table',
  pos: 'idiom',
  ipaUS: '/brɪŋ tə ðə ˈteɪbl/',
  ipaUK: '/brɪŋ tə ðə ˈteɪbl/',
  translation: '带来（价值、资源、能力）',
  contextMeaning: '指某人或某方在合作中能贡献什么，常用于介绍团队优势或评估合作方。',
  explanation:
  '源自谈判桌的意象，语气积极且非正式，适合内部讨论与面试自我介绍。更正式的替换是 contribute / offer。',
  senses: [{ pos: 'idiom', gloss: 'to provide something of value to a discussion or partnership', translation: '带来价值、做出贡献' }],
  associations: [
  { kind: 'synonym', title: 'bring to the table vs. add value', detail: 'add value 更商务化且略空泛；bring to the table 更具体，常接可数的能力或资源。' },
  { kind: 'root', title: '谈判桌意象', detail: '同源表达 come to the table（坐下来谈）、a seat at the table（有话语权）。' }],

  examples: [
  { en: 'What does this vendor actually bring to the table beyond price?', zh: '除了价格，这家供应商到底还能带来什么？' },
  { en: 'She brings ten years of compliance experience to the table.', zh: '她带来了十年的合规经验。' }],

  collocations: ['a seat at the table', 'come to the table', 'bring experience to the table'],
  register: 'spoken',
  kind: 'phrase'
};

export const INITIAL_WORDS: SavedWord[] = [
fromEntry('degenerate', {
  savedAt: daysAgo(3, 2),
  context:
  'In the presence of partial synchrony, the protocol degenerates into a livelock under adversarial scheduling: every replica remains responsive, yet no proposal ever attains a quorum certificate.',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'consensus-under-adversarial-scheduling.pdf',
  tags: ['distributed-systems', 'paper-reading'],
  mastery: 'familiar',
  lookups: 4,
  note: '组会分享时用「劣化为」翻译更自然。'
}),
fromEntry('livelock', {
  savedAt: daysAgo(3, 2),
  context: 'the protocol degenerates into a livelock under adversarial scheduling',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'consensus-under-adversarial-scheduling.pdf',
  tags: ['distributed-systems', 'paper-reading'],
  mastery: 'new',
  lookups: 6
}),
fromEntry('adversarial', {
  savedAt: daysAgo(3, 1),
  context: 'under adversarial scheduling, the fair-lock guarantee no longer holds',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'consensus-under-adversarial-scheduling.pdf',
  tags: ['distributed-systems'],
  mastery: 'familiar',
  lookups: 2
}),
fromEntry('quorum', {
  savedAt: daysAgo(4),
  context: 'no proposal ever attains a quorum certificate',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'consensus-under-adversarial-scheduling.pdf',
  tags: ['distributed-systems', 'paper-reading'],
  mastery: 'mastered',
  lookups: 1
}),
custom(idempotent, {
  savedAt: daysAgo(6),
  context: '// the handler must be idempotent: redelivery is at-least-once',
  sourceApp: 'Visual Studio Code',
  sourceTitle: 'webhooks/handler.ts',
  tags: ['distributed-systems', 'api'],
  mastery: 'mastered',
  lookups: 3
}),
custom(eventualConsistency, {
  savedAt: daysAgo(8),
  context: 'The store guarantees only eventual consistency across regions.',
  sourceApp: 'Chrome',
  sourceTitle: 'Designing Data-Intensive Applications — Chapter 5',
  tags: ['distributed-systems'],
  mastery: 'familiar',
  lookups: 2
}),
fromEntry('circle back', {
  savedAt: daysAgo(1, 5),
  context: "Let's park the pricing question and circle back on it after the legal review.",
  sourceApp: 'Slack',
  sourceTitle: '#proj-atlas',
  tags: ['meeting'],
  mastery: 'new',
  lookups: 2,
  note: '内部沟通用没问题，对客户改用 follow up。'
}),
fromEntry('bandwidth', {
  savedAt: daysAgo(1, 4),
  context: "I don't have the bandwidth to own this before the release freeze.",
  sourceApp: 'Slack',
  sourceTitle: '#proj-atlas',
  tags: ['meeting'],
  mastery: 'familiar',
  lookups: 5
}),
fromEntry('loop in', {
  savedAt: daysAgo(2),
  context: 'Looping in Dana, who owns the billing service.',
  sourceApp: 'Outlook',
  sourceTitle: 'RE: Atlas migration — sequencing',
  tags: ['meeting', 'email'],
  mastery: 'mastered',
  lookups: 1
}),
fromEntry('ballpark', {
  savedAt: daysAgo(5),
  context: 'Can you give me a ballpark figure before we commit to the scope?',
  sourceApp: 'Slack',
  sourceTitle: '#proj-atlas',
  tags: ['meeting'],
  mastery: 'new',
  lookups: 1
}),
custom(escalate, {
  savedAt: daysAgo(7),
  context: 'If the vendor misses the SLA again we will escalate to their account director.',
  sourceApp: 'Outlook',
  sourceTitle: 'Vendor review — Q3',
  tags: ['email', 'meeting'],
  mastery: 'familiar',
  lookups: 2
}),
custom(indemnify, {
  savedAt: daysAgo(9),
  context: 'The vendor shall indemnify the client against third-party IP claims.',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'MSA-2026-atlas-v3.pdf',
  tags: ['contract'],
  mastery: 'new',
  lookups: 3
}),
custom(inLieuOf, {
  savedAt: daysAgo(9, 1),
  context: 'Employees may take time off in lieu of overtime pay.',
  sourceApp: 'Acrobat Reader',
  sourceTitle: 'MSA-2026-atlas-v3.pdf',
  tags: ['contract'],
  mastery: 'new',
  lookups: 1
}),
fromEntry('provisional', {
  savedAt: daysAgo(12),
  context: 'These numbers are provisional and will be revised after the audit.',
  sourceApp: 'Chrome',
  sourceTitle: 'arXiv:2604.10233 — Preliminary results',
  tags: ['paper-reading'],
  mastery: 'familiar',
  lookups: 1
}),
custom(bringToTheTable, {
  savedAt: daysAgo(14),
  context: 'What does this vendor actually bring to the table beyond price?',
  sourceApp: 'WeChat',
  sourceTitle: 'Atlas 项目群',
  tags: ['meeting'],
  mastery: 'familiar',
  lookups: 2
})];


export const ALL_TAGS = ['distributed-systems', 'paper-reading', 'meeting', 'contract', 'email', 'api'];