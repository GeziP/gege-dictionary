import type { ApiProtocol, PromptTemplate, ProviderConfig } from '../types/lexnote';

export interface ProviderPreset {
  id: string;
  name: string;
  protocol: ApiProtocol;
  baseUrl: string;
  model: string;
  hint: string;
  keyUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
{
  id: 'glm',
  name: 'GLM (智谱)',
  protocol: 'anthropic',
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  model: 'GLM-5.2',
  hint: 'Anthropic 兼容协议，国内直连',
  keyUrl: 'open.bigmodel.cn'
},
{
  id: 'openai',
  name: 'OpenAI',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  hint: '结构化输出支持最好，成本适中',
  keyUrl: 'platform.openai.com/api-keys'
},
{
  id: 'deepseek',
  name: 'DeepSeek',
  protocol: 'openai',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  hint: 'V4 Flash，中文释义质量好、响应快',
  keyUrl: 'platform.deepseek.com'
},
{
  id: 'kimi',
  name: 'Kimi',
  protocol: 'openai',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'moonshot-v1-8k',
  hint: '国内直连，长上下文',
  keyUrl: 'platform.moonshot.cn'
},
{
  id: 'anthropic',
  name: 'Anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-20250514',
  hint: 'Claude 原生接口',
  keyUrl: 'console.anthropic.com/settings/keys'
},
{
  id: 'openrouter',
  name: 'OpenRouter',
  protocol: 'openai',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/claude-3.5-haiku',
  hint: '一个 Key 调用多家模型',
  keyUrl: 'openrouter.ai/keys'
},
{
  id: 'local',
  name: '本地网关',
  protocol: 'openai',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5:14b',
  hint: 'Ollama / LM Studio，完全离线',
  keyUrl: '无需 Key'
}];


export const DEFAULT_PROVIDER: ProviderConfig = {
  name: '',
  protocol: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 2000,
  timeoutSeconds: 60
};

export const DEFAULT_TEMPLATES: PromptTemplate[] = [
{
  id: 'tpl-word',
  name: '单词 / 短语解析（默认）',
  scope: 'word',
  builtIn: true,
  body: `你是一位精通英汉对比的语言学教师，同时拥有跨领域专业知识（计算机、医疗IVD、金融等）。请解析用户选中的英文内容。

选中内容：{{selection}}
所在上下文：{{context}}
用户母语：{{native_lang}}

输出 JSON 对象，包含以下字段：
1. lemma: 词条原形
2. pos: 词性
3. ipaUS: 美式音标
4. ipaUK: 英式音标
5. translation: 准确中文翻译
6. contextMeaning: 结合上下文的精确释义（只给最相关的一个）
7. explanation: 详细说明（可用 **加粗** 标注关键概念，用 \`代码\` 标注技术术语/函数/命令），分两部分——
   a) 语言层面：语气、语域、使用边界、常见误用
   b) 领域知识（重要！根据上下文判断领域后必须给出）：
      - **计算机领域**：技术原理、算法说明、应用场景，务必给出 \`代码示例\` 或伪代码
      - **IVD/医疗领域**：检测原理、临床意义、相关标准（如ISO 15189）
      - **金融领域**：经济学原理、市场机制
      - 其他领域同理，必须有实质性的专业内容
   如果是通用词汇则侧重语言层面
8. senses: 该词最常见的2-3个义项，每个 {"pos": "词性", "gloss": "英文释义", "translation": "中文"}
9. associations: 至少4条，detail 中可以用 **加粗** 标注关键词、用 \`行内代码\` 标注代码/命令/函数名。包括：
   - {"kind": "root", "title": "词根词缀", "detail": "拆解和记忆方法，**关键词缀**加粗"}
   - {"kind": "synonym", "title": "近义辨析", "detail": "区别说明，关键差异**加粗**"}
   - {"kind": "confusable", "title": "易混词", "detail": "对比说明"}
   - 如果是专业术语（计算机/IVD/金融等），务必追加1-2条：
     {"kind": "root", "title": "领域深度", "detail": "该概念在领域内的**深度解释**：原理、流程、应用场景。计算机领域必须给出 \`代码示例\` 或伪代码（如 \`sort(arr, key=lambda x: x.val)\`），IVD领域给出检测原理和临床意义。"}
   - 如果有助于理解，追加流程/架构说明：
     {"kind": "root", "title": "流程图示", "detail": "用文字+箭头描述：**输入** -> **预处理** -> **模型推理** -> **输出**"}
10. examples: 3条例句，与上下文领域一致，每个 {"en": "英文例句", "zh": "中文翻译"}
11. collocations: 5-8个常见搭配（字符串数组）
12. register: 语域（formal/neutral/spoken/technical）

【JSON 输出规则】
- 只输出合法 JSON，不要前缀/后缀文字
- 字符串内换行用 \\n，双引号用 \\"
- 可以在字符串内使用 **加粗** 和 \`行内代码\`（单个反引号），但禁止三个反引号的代码块
- 不要有尾随逗号
- 确保释义和翻译准确，专业术语使用标准译法
- 对专业领域词汇，**必须**给出领域深度知识和代码/图示说明`
},
{
  id: 'tpl-sentence',
  name: '整句解析（默认）',
  scope: 'sentence',
  builtIn: true,
  body: `你是一位英文写作与句法分析教师，同时拥有跨领域专业知识。请解析用户选中的整句。

选中内容：{{selection}}
所在上下文：{{context}}
用户母语：{{native_lang}}

输出 JSON 对象，包含以下字段：
1. lemma: 句子中最核心的关键词或短语
2. pos: "sentence"
3. translation: 忠实通顺的中文翻译，不添加原文没有的内容
4. contextMeaning: 一句话说明这句话在上下文中的意思
5. explanation: 分两部分——
   a) 句式分析：该句式可复用的写作骨架
   b) 领域背景：如果句子涉及特定领域，补充该领域的背景知识（计算机/IVD/金融等领域均可）
6. syntax: 句法拆解数组，每个 {"part": "成分名称", "note": "对应原文及说明"}
7. key_terms: 3个以内值得收藏的表达，每个 {"term": "英文", "gloss": "中文释义和用法"}
8. associations: 如果句子涉及专业领域，补充1-2条领域知识 {"kind": "root", "title": "知识点", "detail": "说明"}
9. examples: 1-2个使用相同句式的例句 {"en": "英文", "zh": "中文"}
10. register: 语域
11. ipaUS: ""
12. ipaUK: ""

【JSON 输出规则】字符串内换行用 \\n，双引号用 \\"，不要 markdown 代码块，不要尾随逗号，只输出 JSON。`
},
{
  id: 'tpl-paragraph',
  name: '段落 / 文章翻译（默认）',
  scope: 'paragraph',
  builtIn: true,
  body: `你是一位专业的英汉翻译。请翻译并深度解析用户选中的段落/文章。

选中内容：{{selection}}
用户母语：{{native_lang}}

输出 JSON，包含以下字段：
1. lemma: 取段落前几个关键词作为标题（不超过4个词）
2. pos: "paragraph"
3. translation: 完整的中文翻译（整段，保持段落结构）
4. contextMeaning: 一句话概括本段主旨
5. translationPairs: 【最重要的字段！】逐句对照翻译数组。将原文按句子拆分，每句配一个翻译，严格保持 1:1 对应，格式为：
   [{"en": "原文第1句。", "zh": "第1句的翻译。"}, {"en": "原文第2句。", "zh": "第2句的翻译。"}, ...]
   规则：
   - 按原文标点（.!?）拆句，不要合并、不要拆分、不要遗漏任何句子
   - zh 为该句的忠实翻译，不添加自己的理解，不缩写不省略
   - en 必须与原文完全一致（逐字复制），不要修改原文
6. explanation: 领域知识深度补充。可用 **加粗** 标注关键词，\`行内代码\` 标注代码/命令。根据文本所属专业领域提供深度知识扩展：
   - 计算机/软件领域：补充技术原理，给出 \`代码示例\` 或伪代码，描述架构关系
   - IVD(体外诊断)/医疗/生物领域：补充**检测原理**、**临床意义**、相关法规标准
   - 金融/经济领域：补充经济学原理、市场背景
   - 其他领域同理
7. senses: []
8. associations: 领域延伸知识数组，每个元素 {"kind": "root", "title": "知识点标题", "detail": "详细说明"}，至少2-3条
9. examples: 段落中2-3个值得学习的专业表达，每个 {"en": "原文短语/句式", "zh": "含义和用法说明"}
10. collocations: 5-8个专业术语或高级表达（字符串数组）
11. register: 语域（formal/neutral/spoken/technical）
12. key_terms: 3-5个关键专业术语，每个 {"term": "英文术语", "gloss": "标准中文译名 + 简要定义"}
13. ipaUS: ""
14. ipaUK: ""

【JSON 输出规则 - 必须严格遵守】
- 只输出一个合法 JSON 对象，不要任何前缀/后缀文字
- 所有字符串值必须用双引号包裹
- 字符串内的换行必须写成 \\n，双引号必须写成 \\"
- 可以在字符串内使用 **加粗** 和 \`行内代码\`（单个反引号），但禁止三个反引号的代码块
- 不要有尾随逗号`
},
{
  id: 'tpl-tech',
  name: '技术论文强化版（我的）',
  scope: 'all',
  builtIn: false,
  body: `Act as a CS-literate lexicographer. Explain {{selection}} as used in {{context}}.
Always contrast the term with its nearest confusable technical neighbour, and draw all
example sentences from systems / distributed computing writing. Answer in JSON, Chinese glosses.`
}];
