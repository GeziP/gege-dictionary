import type { Entry } from '../types/lexnote';

/**
 * Canned model responses for the interactive demo. Keys are the normalized
 * selection (lowercased, collapsed whitespace, stripped trailing punctuation).
 */
export const ENTRIES: Record<string, Entry> = {
  degenerate: {
    id: 'e-degenerate',
    selection: 'degenerates',
    lemma: 'degenerate',
    pos: 'v. 不及物',
    ipaUS: '/dɪˈdʒenəreɪt/',
    ipaUK: '/dɪˈdʒenəreɪt/',
    translation: '退化为；劣化成',
    contextMeaning:
    '此处指系统「退化 / 劣化为」某种更糟的运行状态，是技术写作中的中性描述，不含日常语义里「堕落、道德败坏」的贬义。',
    explanation:
    'degenerate 作动词时强调「从原本正常的形态滑落到一个更低级、更差的形态」，常与 into 搭配引出退化后的结果。在计算机与数学文献中它已经是完全中性的术语动词：一个算法可以 degenerate into 线性扫描，一个协议可以 degenerate into livelock。判断语气的关键是主语——主语是系统、算法、讨论等无生命名词时基本为中性；主语是人或社会时才带道德贬义。',
    senses: [
    { pos: 'v.', gloss: '(a system or situation) to deteriorate into a worse form', translation: '（系统、局面）退化为、劣化成' },
    { pos: 'v.', gloss: 'to decline in moral or physical character', translation: '堕落、衰败（日常与文学语境，含贬义）' },
    { pos: 'adj. /ˈdedʒənərət/', gloss: 'a limiting or trivial case of a general form', translation: '退化的；（数学）退化情形的' }],

    associations: [
    {
      kind: 'root',
      title: 'de-（向下） + gener-（族类，同 genus / genre） + -ate',
      detail: '字面即「脱离原本的族类」，因此核心义是「失去原有性质而下滑」，中性与贬义两条线都由此分岔。'
    },
    {
      kind: 'synonym',
      title: 'degenerate vs. deteriorate vs. devolve',
      detail:
      'deteriorate 只说明「变差」，不强调形态改变；degenerate 强调变成了另一种更低级的形态；devolve into 语气更口语，常用于会议、争论。'
    },
    {
      kind: 'confusable',
      title: '形容词 degenerate 重音与发音不同',
      detail: '动词读 /dɪˈdʒenəreɪt/，形容词/名词读 /dɪˈdʒenərət/，词尾不发 /eɪt/。学术阅读中最容易读错的一组。'
    }],

    examples: [
    {
      en: 'Without back-off, the retry loop degenerates into a busy-wait that saturates the CPU.',
      zh: '若没有退避机制，重试循环会退化成占满 CPU 的忙等待。'
    },
    {
      en: 'For k = 1 the algorithm degenerates to a plain linear scan.',
      zh: '当 k = 1 时，该算法退化为普通的线性扫描。'
    },
    {
      en: 'The design review degenerated into an argument about naming conventions.',
      zh: '这场设计评审最后演变成了一场关于命名规范的争论。'
    }],

    collocations: ['degenerate into chaos', 'degenerate into a shouting match', 'degenerate to a special case', 'rapidly degenerate'],
    register: 'technical',
    kind: 'word'
  },

  livelock: {
    id: 'e-livelock',
    selection: 'livelock',
    lemma: 'livelock',
    pos: 'n. 可数',
    ipaUS: '/ˈlaɪvlɑːk/',
    ipaUK: '/ˈlaɪvlɒk/',
    translation: '活锁',
    contextMeaning:
    '活锁：进程仍在运行、仍在响应，但因为不断互相让步或重试，系统整体没有任何进展（no progress）。',
    explanation:
    '与死锁（deadlock）的区别是本词的全部要点：deadlock 中线程被阻塞、状态静止；livelock 中线程忙碌、状态一直在变，只是永远达不到目标。经典比喻是两个人在走廊迎面相遇，各自不断向同一侧闪避。因为进程看起来「活着」，活锁在监控上极难发现——CPU 使用率正常甚至偏高，健康检查全绿，唯独业务吞吐为零。',
    senses: [
    { pos: 'n.', gloss: 'a state in which processes keep running but make no progress', translation: '活锁：进程持续运行却无进展' },
    { pos: 'v. (rare)', gloss: 'to enter such a state', translation: '陷入活锁（少见的动词用法）' }],

    associations: [
    {
      kind: 'confusable',
      title: 'livelock vs. deadlock vs. starvation',
      detail:
      'deadlock：互相等待，全部阻塞；livelock：互相谦让/重试，全部空转；starvation：系统整体在推进，但某个特定线程始终拿不到资源。三者的判定看「有没有进展」和「谁没有进展」。'
    },
    {
      kind: 'root',
      title: 'live（活的） + lock（锁死）',
      detail: '构词本身就是矛盾修辞：锁住了，却还活着。记住这个矛盾就记住了词义。'
    },
    {
      kind: 'synonym',
      title: '近义表达',
      detail: 'spin without progress、mutual yielding、non-productive retry loop 都可以在论文中替换使用。'
    }],

    examples: [
    {
      en: 'Randomized back-off is the standard cure for livelock in contention-heavy paths.',
      zh: '在高竞争路径上，随机退避是化解活锁的标准手段。'
    },
    {
      en: 'The cluster was not deadlocked; it was in a livelock, and every health check kept returning green.',
      zh: '集群并没有死锁，而是陷入了活锁，所有健康检查依然返回正常。'
    },
    {
      en: 'Two threads politely releasing the lock for each other can livelock indefinitely.',
      zh: '两个线程互相「礼让」释放锁，可能无限期地活锁下去。'
    }],

    collocations: ['enter a livelock', 'livelock-free algorithm', 'break the livelock', 'susceptible to livelock'],
    register: 'technical',
    kind: 'word'
  },

  deadlock: {
    id: 'e-deadlock',
    selection: 'deadlock',
    lemma: 'deadlock',
    pos: 'n. / v.',
    ipaUS: '/ˈdedlɑːk/',
    ipaUK: '/ˈdedlɒk/',
    translation: '死锁；僵局',
    contextMeaning: '此处为技术义：多个进程互相持有对方所需的资源并彼此等待，全部阻塞，状态不再变化。',
    explanation:
    '技术语境下 deadlock 指四个必要条件（互斥、持有并等待、不可抢占、循环等待）同时成立时的完全阻塞。在新闻与商务语境中，deadlock 表示谈判「僵局」，可以说 break the deadlock（打破僵局）。两种用法共享「卡死、动不了」的意象，语气都中性。',
    senses: [
    { pos: 'n.', gloss: 'a state where each process waits for a resource held by another', translation: '死锁（并发）' },
    { pos: 'n.', gloss: 'a situation in which no progress can be made in a dispute', translation: '僵局（谈判、政治）' },
    { pos: 'v.', gloss: 'to bring or come to a standstill', translation: '使陷入僵局' }],

    associations: [
    {
      kind: 'confusable',
      title: 'deadlock 与 livelock 的一句话区别',
      detail: 'deadlock 是「都停下来等」，livelock 是「都在动但没用」。写论文时若线程仍在消耗 CPU，就不该用 deadlock。'
    },
    {
      kind: 'synonym',
      title: 'stalemate / impasse / standoff',
      detail: '这三个用于人事与谈判语境，不能替换技术义的 deadlock。'
    }],

    examples: [
    {
      en: 'Acquiring locks in a fixed global order eliminates this class of deadlock.',
      zh: '按固定的全局顺序获取锁，可以消除这一类死锁。'
    },
    {
      en: 'Negotiations reached a deadlock over the termination clause.',
      zh: '谈判在终止条款上陷入僵局。'
    }],

    collocations: ['break the deadlock', 'deadlock detection', 'reach a deadlock', 'deadlock-free'],
    register: 'neutral',
    kind: 'word'
  },

  adversarial: {
    id: 'e-adversarial',
    selection: 'adversarial',
    lemma: 'adversarial',
    pos: 'adj.',
    ipaUS: '/ˌædvərˈseriəl/',
    ipaUK: '/ˌædvəˈseəriəl/',
    translation: '对抗性的；最坏情况下的',
    contextMeaning:
    '此处不指人际上的「敌对」，而是理论分析中的假设：假想一个刻意与你作对的对手来安排调度顺序，即「最坏情况」。',
    explanation:
    'adversarial 在算法与安全文献中是一个技术形容词，表示输入或调度由一个知道你全部策略的敌手构造，用来给出最坏情况下界。与 worst-case 的差别在于：worst-case 只是统计意义上的最差，adversarial 强调「有智能地针对你」。同源用法还有 adversarial example（对抗样本）、adversarial training（对抗训练）。',
    senses: [
    { pos: 'adj.', gloss: 'involving an intelligent opponent chosen to defeat the system', translation: '对抗性的（理论分析）' },
    { pos: 'adj.', gloss: 'hostile, characterized by conflict', translation: '敌对的、对立的（日常与法律语境）' }],

    associations: [
    {
      kind: 'root',
      title: 'ad-（朝向） + vers-（转，同 reverse / version） + -ary',
      detail: '「转过来面对你的人」即 adversary（对手），加 -ial 变形容词。'
    },
    {
      kind: 'confusable',
      title: 'adversarial vs. adverse',
      detail: 'adverse 指「不利的」（adverse effects 不良反应），没有「对手」的含义，两词常被互换误用。'
    }],

    examples: [
    {
      en: 'Under an adversarial scheduler, the fair-lock guarantee no longer holds.',
      zh: '在对抗性调度器下，公平锁的保证不再成立。'
    },
    {
      en: 'We evaluate the model on adversarial inputs rather than random noise.',
      zh: '我们在对抗性输入而非随机噪声上评估该模型。'
    }],

    collocations: ['adversarial setting', 'adversarial example', 'adversarial scheduling', 'under an adversarial model'],
    register: 'technical',
    kind: 'word'
  },

  quorum: {
    id: 'e-quorum',
    selection: 'quorum',
    lemma: 'quorum',
    pos: 'n. 可数',
    ipaUS: '/ˈkwɔːrəm/',
    ipaUK: '/ˈkwɔːrəm/',
    translation: '法定人数；（分布式系统）多数派',
    contextMeaning: '此处指分布式协议中的「多数派」：达成决议所需的最小副本集合，通常是 ⌊n/2⌋ + 1。',
    explanation:
    '这个词从议会程序借入计算机领域：会议需要法定人数才能表决，副本集合同样需要达到多数才能提交。常见搭配 quorum certificate（多数派证书）、read/write quorum（读写多数派）、lose quorum（失去多数派，集群不可写）。注意它是可数名词，复数 quorums。',
    senses: [
    { pos: 'n.', gloss: 'the minimum number of members required to make a decision valid', translation: '法定人数（会议、组织）' },
    { pos: 'n.', gloss: 'the minimum set of replicas required to commit a decision', translation: '多数派（分布式系统）' }],

    associations: [
    {
      kind: 'root',
      title: '拉丁语 quorum「其中的」',
      detail: '源自英国法庭任命状的固定用语 quorum vos ... unum esse volumus，后来专指「必需到场的那部分人」。'
    },
    {
      kind: 'synonym',
      title: 'majority / threshold',
      detail: 'majority 强调「过半」，quorum 强调「达到门槛即可生效」，门槛不一定是过半。'
    }],

    examples: [
    {
      en: 'A proposal is committed once it collects a quorum certificate from the replicas.',
      zh: '当提案从副本处收集到多数派证书后即被提交。'
    },
    {
      en: 'The cluster lost quorum and rejected all writes for four minutes.',
      zh: '集群失去多数派，在四分钟内拒绝了所有写入。'
    }],

    collocations: ['reach a quorum', 'lose quorum', 'quorum certificate', 'write quorum'],
    register: 'technical',
    kind: 'word'
  },

  interleaving: {
    id: 'e-interleaving',
    selection: 'interleaving',
    lemma: 'interleaving',
    pos: 'n. / v-ing',
    ipaUS: '/ˌɪntərˈliːvɪŋ/',
    ipaUK: '/ˌɪntəˈliːvɪŋ/',
    translation: '交错执行顺序；交织',
    contextMeaning: '此处是名词，指多个线程指令在时间上的一种具体交错顺序——并发缺陷正是由某个特定 interleaving 触发的。',
    explanation:
    '动词 interleave 原指把纸张一张隔一张地插入，引申为「把两组元素交替排列」。并发领域用它指调度器产生的执行序列；一个程序的正确性必须对所有 interleavings 成立。相关词：interleaved memory（交错存储）、interleaving factor。',
    senses: [
    { pos: 'n.', gloss: 'a particular order in which concurrent operations are executed', translation: '（并发）交错执行序列' },
    { pos: 'v-ing', gloss: 'alternating items from two or more sets', translation: '交替排列、穿插' }],

    associations: [
    {
      kind: 'root',
      title: 'inter-（在……之间） + leave（书页，古义 leaf 的动词化）',
      detail: '原义是「在书页之间插入空白页」，因此重点始终是「一个夹一个」的交替结构。'
    },
    {
      kind: 'synonym',
      title: 'schedule / execution order / trace',
      detail: '论文中 trace 更强调可观测的事件序列，interleaving 更强调交错这一结构本身。'
    }],

    examples: [
    {
      en: 'The bug only manifests under one specific interleaving of the two writers.',
      zh: '该缺陷只在两个写线程的某一种特定交错顺序下才会显现。'
    },
    {
      en: 'A model checker explores all possible interleavings up to a bound.',
      zh: '模型检查器会在给定界限内枚举所有可能的交错顺序。'
    }],

    collocations: ['a specific interleaving', 'explore all interleavings', 'interleaving of events'],
    register: 'technical',
    kind: 'word'
  },

  'the protocol degenerates into a livelock under adversarial scheduling': {
    id: 'e-sentence-livelock',
    selection: 'the protocol degenerates into a livelock under adversarial scheduling',
    lemma: 'the protocol degenerates into a livelock under adversarial scheduling',
    pos: '句子',
    ipaUS: '',
    ipaUK: '',
    translation: '在对抗性调度下，该协议会退化为活锁。',
    contextMeaning:
    '整句为「条件 + 结果」结构：under 引导前提条件（最坏情况的调度），主干说明系统在该前提下滑落到的状态（活锁）。',
    explanation:
    '这是学术写作中描述失效模式的标准句式：主语（机制） + degenerate into + 失效状态 + under + 前提条件。它的好处是把「什么变差了」和「在什么条件下变差」分开陈述，读者可以先抓结论再看条件。你自己写作时可以直接套用这个骨架。',
    senses: [],
    associations: [
    {
      kind: 'synonym',
      title: '可替换的同义骨架',
      detail: 'X collapses into Y under Z / X falls back to Y when Z / Under Z, X no longer guarantees W。'
    },
    {
      kind: 'root',
      title: 'under 表示「在……条件下」',
      detail: '与 under load、under contention、under partial synchrony 同类，都是学术写作里高频的条件状语。'
    }],

    examples: [
    {
      en: 'Under heavy contention, the fair queue degenerates into FIFO with unbounded latency.',
      zh: '在高竞争下，公平队列会退化为延迟无界的 FIFO。'
    },
    {
      en: 'The index degenerates into a linked list under adversarial key insertion.',
      zh: '在对抗性的键插入顺序下，该索引会退化成一个链表。'
    }],

    collocations: ['degenerate into', 'under adversarial scheduling', 'failure mode'],
    register: 'technical',
    kind: 'sentence',
    syntax: [
    { part: '主语', note: 'the protocol —— 论文正在讨论的共识协议，定冠词回指前文。' },
    { part: '谓语 + 结果状语', note: 'degenerates into a livelock —— 不及物动词 + into 引出退化后的状态，不能用 degenerate to a livelock。' },
    { part: '条件状语', note: 'under adversarial scheduling —— under 表「在……条件下」，adversarial 是理论分析用语，指最坏情况的对手。' }],

    keyTerms: [
    { term: 'degenerate into', gloss: '退化为（中性技术用法，不含贬义）' },
    { term: 'livelock', gloss: '活锁：仍在运行但没有任何进展' },
    { term: 'adversarial scheduling', gloss: '对抗性调度：由假想敌手安排的最坏执行顺序' }]

  },

  'circle back': {
    id: 'e-circle-back',
    selection: 'circle back',
    lemma: 'circle back',
    pos: 'phr. v.',
    ipaUS: '/ˈsɜːrkl bæk/',
    ipaUK: '/ˈsɜːkl bæk/',
    translation: '回头再聊；稍后再跟进',
    contextMeaning: '职场语境中表示「这件事现在不谈，晚点再回到它」，礼貌地推迟，而不是拒绝。',
    explanation:
    '典型的美式办公室用语，比 discuss later 更委婉、更像口头承诺。注意它在同事间是中性的，但在对外邮件里略显随意——对客户建议改用 follow up on this next week 或 revisit this in our next call。常见结构：circle back on + 话题 / circle back with + 人。',
    senses: [
    { pos: 'phr. v.', gloss: 'to return to a topic or task at a later time', translation: '稍后再回到某话题、再跟进' },
    { pos: 'phr. v.', gloss: 'to physically return to a place by a curved route', translation: '绕回原处（字面义，较少用）' }],

    associations: [
    {
      kind: 'synonym',
      title: 'circle back vs. follow up vs. revisit',
      detail: 'follow up 最中性、书面均可；revisit 更正式，常用于文档与决策；circle back 最口语，仅限内部沟通。'
    },
    {
      kind: 'confusable',
      title: '介词搭配',
      detail: '话题用 on（circle back on pricing），人用 with（I\'ll circle back with Dana），不要说 circle back to you 表示「答复你」。'
    }],

    examples: [
    {
      en: "Let's park the pricing question and circle back on it after the legal review.",
      zh: '定价问题先搁置，等法务审完我们再回来讨论。'
    },
    {
      en: "I'll circle back with the updated numbers by Thursday.",
      zh: '我周四之前把更新后的数据同步给你。'
    },
    {
      en: 'Rather than circling back, we should decide this in the meeting itself.',
      zh: '与其之后再谈，我们应该就在会上把这件事定下来。'
    }],

    collocations: ['circle back on this', 'circle back with you', "let's circle back later"],
    register: 'spoken',
    kind: 'phrase'
  },

  bandwidth: {
    id: 'e-bandwidth',
    selection: 'bandwidth',
    lemma: 'bandwidth',
    pos: 'n. 不可数',
    ipaUS: '/ˈbændwɪdθ/',
    ipaUK: '/ˈbændwɪdθ/',
    translation: '（人的）精力与时间余量',
    contextMeaning: '职场引申义：某人可投入的时间与精力。I don\'t have the bandwidth = 我现在忙不过来。',
    explanation:
    '由通信术语「带宽」引申而来，是英语职场里拒绝任务时最常用的委婉说法之一，比 I\'m too busy 更专业、更不带情绪。不可数，不能说 a bandwidth / bandwidths。常见搭配 have the bandwidth to do sth、free up bandwidth。',
    senses: [
    { pos: 'n.', gloss: 'the capacity of a person or team to take on work', translation: '（人或团队的）承载力、精力余量' },
    { pos: 'n.', gloss: 'the data-carrying capacity of a channel', translation: '带宽（技术本义）' }],

    associations: [
    {
      kind: 'synonym',
      title: 'bandwidth vs. capacity vs. availability',
      detail: 'capacity 偏组织与产能，availability 只说明日程有没有空，bandwidth 同时暗示精力，是最委婉的一个。'
    },
    {
      kind: 'confusable',
      title: '不可数用法',
      detail: '写 enough bandwidth / limited bandwidth，不要写 a bandwidth，这是中文母语者最常见的错误。'
    }],

    examples: [
    {
      en: "I don't have the bandwidth to own this before the release freeze.",
      zh: '在发布冻结前，我没有精力接下这件事。'
    },
    {
      en: 'Can we free up some bandwidth on your side for the migration?',
      zh: '你们那边能腾出一些人力和时间来做迁移吗？'
    }],

    collocations: ['have the bandwidth', 'limited bandwidth', 'free up bandwidth'],
    register: 'spoken',
    kind: 'word'
  },

  'loop in': {
    id: 'e-loop-in',
    selection: 'loop in',
    lemma: 'loop in',
    pos: 'phr. v.',
    ipaUS: '/luːp ɪn/',
    ipaUK: '/luːp ɪn/',
    translation: '把某人拉进来同步信息',
    contextMeaning: '表示把某人加入邮件、会话或讨论，让其知情并参与，语气友好、非正式。',
    explanation:
    '来自 in the loop（在信息圈内）。可分离动词短语：loop someone in、loop in someone 都对，代词必须放中间（loop me in）。邮件里常写 Looping in Dana for visibility. 更正式的替换是 include / copy in / bring sb into the discussion。',
    senses: [{ pos: 'phr. v.', gloss: 'to include someone in a conversation or information flow', translation: '把某人加入讨论、抄送同步' }],
    associations: [
    {
      kind: 'synonym',
      title: 'loop in vs. cc vs. keep sb posted',
      detail: 'cc 只是抄送动作；loop in 暗示希望对方参与；keep sb posted 是持续告知进展。'
    },
    {
      kind: 'root',
      title: 'in the loop / out of the loop',
      detail: '同一意象的一组表达：知情 / 被蒙在鼓里，面试与邮件中都很高频。'
    }],

    examples: [
    {
      en: 'Looping in Dana, who owns the billing service.',
      zh: '把 Dana 拉进来，计费服务由她负责。'
    },
    {
      en: 'Please loop me in before you reply to the vendor.',
      zh: '在回复供应商之前请把我加进来。'
    }],

    collocations: ['loop someone in', 'keep sb in the loop', 'out of the loop'],
    register: 'spoken',
    kind: 'phrase'
  },

  ballpark: {
    id: 'e-ballpark',
    selection: 'ballpark',
    lemma: 'ballpark',
    pos: 'n. / adj.',
    ipaUS: '/ˈbɔːlpɑːrk/',
    ipaUK: '/ˈbɔːlpɑːk/',
    translation: '大致范围；粗略估计的',
    contextMeaning: '此处为形容词用法：a ballpark figure 指「大概的数字」，明确表示不精确、仅供参考。',
    explanation:
    '源自棒球场——只要球落在场内就算「差不多」。做名词时常见 in the ballpark of $50k（在五万美元上下）；做形容词时几乎固定搭配 figure / estimate / number。在需要严谨的合同或财报语境中应改用 approximate / preliminary estimate。',
    senses: [
    { pos: 'adj.', gloss: 'approximate, roughly accurate', translation: '大致的、粗估的' },
    { pos: 'n.', gloss: 'an acceptable range of values', translation: '大致范围' }],

    associations: [
    {
      kind: 'synonym',
      title: 'ballpark vs. rough vs. approximate',
      detail: 'rough 最通用；approximate 最正式；ballpark 带美式口语色彩，适合内部沟通。'
    },
    {
      kind: 'confusable',
      title: 'in the ballpark 的肯定含义',
      detail: 'That\'s in the ballpark 是「差不多对」，不是「差得远」，常被误解为否定。'
    }],

    examples: [
    {
      en: 'Can you give me a ballpark figure before we commit to the scope?',
      zh: '在确定范围之前，你能先给我一个大概的数字吗？'
    },
    {
      en: 'Their quote is in the ballpark of what we budgeted.',
      zh: '他们的报价和我们的预算大致相当。'
    }],

    collocations: ['a ballpark figure', 'in the ballpark of', 'ballpark estimate'],
    register: 'spoken',
    kind: 'word'
  }
};

ENTRIES.provisional = {
  id: 'e-provisional',
  selection: 'provisional',
  lemma: 'provisional',
  pos: 'adj.',
  ipaUS: '/prəˈvɪʒənl/',
  ipaUK: '/prəˈvɪʒənl/',
  translation: '临时的、暂定的',
  contextMeaning: '此处指结论「暂时成立、有待确认」，作者用它为后续可能的修正留出余地。',
  explanation:
  '学术写作中的对冲词（hedging），比 temporary 更强调「等待正式确认」。常见搭配 provisional conclusion / provisional acceptance / provisional patent。中文母语者写论文时容易漏掉这类对冲词，导致语气过于绝对。',
  senses: [
  { pos: 'adj.', gloss: 'arranged for the present, possibly to be changed later', translation: '暂定的、临时的' },
  { pos: 'adj.', gloss: 'granted subject to later confirmation', translation: '（批准、录取）有条件的、待确认的' }],

  associations: [
  {
    kind: 'root',
    title: 'pro-（预先） + vid/vis-（看，同 vision） + -ional',
    detail: '「预先看好、先备下的安排」，因此是「先用着、之后可能改」的东西。'
  },
  {
    kind: 'synonym',
    title: 'provisional vs. temporary vs. interim',
    detail: 'temporary 只说明短期；interim 指过渡期内的正式安排；provisional 强调有待批准或验证。'
  }],

  examples: [
  { en: 'These numbers are provisional and will be revised after the audit.', zh: '这些数字是暂定的，审计后会修订。' },
  { en: 'We draw a provisional conclusion pending replication.', zh: '在复现之前，我们只给出一个暂定的结论。' },
  { en: 'She was given provisional approval to run the pilot.', zh: '她获得了开展试点的临时批准。' }],

  collocations: ['provisional results', 'provisional conclusion', 'on a provisional basis'],
  register: 'formal',
  kind: 'word'
};

/** Inflected alias so selecting “Looping in” in the chat window resolves. */
ENTRIES['looping in'] = { ...ENTRIES['loop in'], selection: 'looping in' };

export function normalizeKey(text: string): string {
  return text.
  trim().
  toLowerCase().
  replace(/\s+/g, ' ').
  replace(/^[^a-z0-9]+|[^a-z0-9)]+$/g, '');
}

/** Simple lemma fallbacks so "degenerates" resolves to "degenerate". */
export function lookupEntry(selection: string): Entry | null {
  const key = normalizeKey(selection);
  if (ENTRIES[key]) return { ...ENTRIES[key], selection: selection.trim() };
  const candidates = [
  key.replace(/ies$/, 'y'),
  key.replace(/(s|es)$/, ''),
  key.replace(/ing$/, ''),
  key.replace(/ing$/, 'e'),
  key.replace(/ed$/, ''),
  key.replace(/ed$/, 'e')];

  for (const candidate of candidates) {
    if (ENTRIES[candidate]) return { ...ENTRIES[candidate], selection: selection.trim() };
  }
  return null;
}