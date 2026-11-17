/* Reading skills — ported from zotero-ai-reader. Each skill injects method-
 * specific guidance into the system prompt and swaps the quick-chip presets.
 * Sources: deer-flow academic-paper-review / systematic-literature-review and
 * Keshav's "How to Read a Paper" three-pass. COMMON_PRESETS stay across skills. */

export interface Preset { label: string; q: string; broad?: boolean; autoApply?: boolean; annos?: boolean; withFigures?: boolean; }
export interface Skill { id: string; label: string; desc: string; inject: string; agentInject?: string; presets: Preset[]; }

export const SKILLS: Skill[] = [
  { id: "deep-read", label: "精读理解", desc: "结构化精读（默认）",
    inject: "按结构化精读：先抓研究问题与动机，再方法、主要发现（给出关键数字并 [B] 溯源）、结论与意义、局限；论断都要能回指原文。",
    presets: [
      { label: "总结全文", q: "请分【研究问题 / 方法 / 主要发现 / 结论与意义 / 局限】五部分，结构化总结这篇文档。最后额外用一个 ```svg 图直观呈现整体脉络（问题→方法→发现→结论）。", broad: true },
      { label: "三行摘要", q: "用三行中文给出这篇文档的极简摘要：问题、方法、结论各一行。", broad: true },
      { label: "关键词", q: "列出本文 6-10 个关键术语，每个一句话解释，并用 [B<id>] 标注来源。", broad: true },
      { label: "核心贡献", q: "这篇文档的核心贡献是什么？最后额外用一个 ```svg 图把各项贡献及其关系直观呈现出来。", broad: false },
      { label: "方法", q: "它用了什么方法？简要说明。", broad: false },
      { label: "主要结论", q: "主要结论或实验结果是什么？最后额外用一个 ```svg 图直观呈现关键结论之间的关系。", broad: false },
      { label: "局限", q: "有哪些局限或未来工作？", broad: false },
    ] },
  { id: "peer-review", label: "同行评审", desc: "顶会审稿人视角",
    inject: "以顶会（NeurIPS/ICML/ACL）审稿人的标准写评审，客观、具体、可操作，每条意见指向具体章节/图表并用 [B] 溯源：贡献小结；优点 S1/S2…；缺点 W1/W2…；方法评分（各 1–5）Soundness、Novelty、Reproducibility、Experimental design、Statistical rigor、Scalability；给作者的问题；总体 Accept / Weak Accept / Borderline / Weak Reject / Reject + 置信度(高/中/低)。只依据文档证据，不臆测。",
    agentInject: "以审稿视角标注：优先标出贡献句、方法关键决策、支撑或存疑的实验结果、以及局限与过度声明。",
    presets: [
      { label: "评审总览", q: "按同行评审格式给出完整评审：贡献小结、优点(S)、缺点(W)、方法评分表、给作者的问题、总体结论与置信度。", broad: true },
      { label: "主要贡献", q: "这篇文档声称的主要贡献有哪些？逐条列出并用 [B] 溯源，评估其新颖性。", broad: true },
      { label: "优点 (S)", q: "列出这篇文档的主要优点 S1/S2/S3…，每条指明在何处、为何重要。", broad: true },
      { label: "缺点 (W)", q: "列出主要缺点/隐患 W1/W2/W3…，每条指明在何处、为何是问题、如何改进。", broad: true },
      { label: "方法评分", q: "对方法按 Soundness / Novelty / Reproducibility / Experimental design / Statistical rigor / Scalability 各打 1–5 分并简述理由。", broad: true },
      { label: "给作者的问题", q: "列出 3-6 个最该向作者澄清的问题。", broad: false },
      { label: "是否接收", q: "给出总体建议（Accept / Weak Accept / Borderline / Weak Reject / Reject）与置信度，并说明关键依据。", broad: true },
    ] },
  { id: "three-pass", label: "三遍速读", desc: "Keshav 三遍法",
    inject: "用 Keshav《How to Read a Paper》三遍法：第一遍只鸟瞰（题目/摘要/引言/各节标题/结论），判断 5C（类型、背景、正确性/假设是否成立、贡献、清晰度）；第二遍抓要点、仔细看图表（坐标轴是否标注、有无误差棒、结论是否统计显著）；第三遍挑战每个假设，相当于在脑中复刻。按用户要求的那一遍作答。",
    presets: [
      { label: "第一遍鸟瞰", q: "用 Keshav 第一遍法鸟瞰本文：给出 5C（类型/背景/正确性/贡献/清晰度）的快速判断。", broad: true },
      { label: "第二遍要点", q: "用 Keshav 第二遍法：抓住主旨与证据，并逐一点评关键图表（坐标轴/误差棒/是否统计显著），用 [B] 溯源。", broad: true, withFigures: true },
      { label: "第三遍质疑", q: "用 Keshav 第三遍法：挑战文中每个关键假设，指出哪些未被证据支撑、若要复刻还缺什么。", broad: true },
      { label: "图表体检", q: "逐一检查本文主要图表：坐标轴是否清楚、是否有误差棒/置信区间、呈现是否误导。", broad: true, withFigures: true },
    ] },
  { id: "survey", label: "领域综述", desc: "放到领域里看（联网更佳）",
    inject: "把这篇文档放到研究领域里看：主动用 web_search 找近年相关工作与 SOTA、用 web_fetch 读关键页面，沿参考文献找反复出现的关键论文与作者。说明本文相对已有工作的定位、改进与尚存空白；外部信息要给出处/链接。",
    presets: [
      { label: "相关工作", q: "这篇文档属于哪条研究脉络？联网检索并列出最相关的几篇工作及其关系。", broad: true },
      { label: "与 SOTA 对比", q: "与当前 SOTA 相比，本文处在什么位置？联网核对后给出对比。", broad: true },
      { label: "本文定位", q: "用一段话说清本文相对已有工作的独特定位与增量贡献。", broad: true },
      { label: "后续方向", q: "基于本文与领域现状，有哪些值得做的后续方向？", broad: false },
    ] },
  { id: "reproduce", label: "可复现复刻", desc: "能不能复现",
    inject: "从复现角度读：逐项核对复现所需信息——数据集与预处理、模型结构与超参、训练设置与算力、评测协议与指标、代码/权重可得性。明确指出哪些齐全、哪些缺失，给出若要复刻的大致步骤与风险点；信息都要 [B] 溯源。",
    presets: [
      { label: "复现清单", q: "列一张复现清单：数据、预处理、模型与超参、训练设置与算力、评测与指标、代码可得性，逐项说明文档是否给出并 [B] 溯源。", broad: true },
      { label: "缺失信息", q: "要复现本文，还缺哪些关键信息或资源？", broad: true },
      { label: "动手步骤", q: "给出复刻本文核心结果的大致步骤与所需条件。", broad: true },
      { label: "风险点", q: "复现中最可能踩坑或结果对不上的地方有哪些？", broad: false },
    ] },
  { id: "redteam", label: "批判红队", desc: "专挑漏洞",
    inject: "当红队：专挑方法与实验的漏洞——未控制的混淆变量、不公平对比、cherry-picking、过度声明、结论强于证据之处、可能的反例或失败情形。区分“有依据的质疑”和“吹毛求疵”，每条用 [B] 指向原文。",
    presets: [
      { label: "找漏洞", q: "从方法与实验里找出最站不住脚的地方，逐条说明问题所在并 [B] 溯源。", broad: true },
      { label: "挑战假设", q: "文中有哪些被默认成立、其实需要验证的关键假设？", broad: true },
      { label: "可能反例", q: "在什么情形/数据下本文方法可能失效或结论不成立？", broad: true },
      { label: "过度声明", q: "哪些结论强于其证据支撑？指出被夸大的声明。", broad: true },
    ] },
  { id: "tutor", label: "导师讲解", desc: "讲给新手",
    inject: "像导师给初学者讲：先讲清背景与为什么要做这件事，再用直觉/类比解释核心想法，少堆术语；出现的关键术语要解释；多举具体例子；耐心、循序渐进。",
    presets: [
      { label: "讲背景", q: "用通俗的话讲清这篇文档的背景、它想解决的问题、为什么重要。", broad: true },
      { label: "讲直觉", q: "用直觉或类比解释本文的核心想法，尽量不用公式术语。", broad: true },
      { label: "术语表", q: "列出理解本文需要先懂的关键术语，每个用一句话通俗解释。", broad: true },
      { label: "举例说明", q: "用一个具体例子走一遍本文方法是怎么工作的。", broad: false },
    ] },
  { id: "quick", label: "速览", desc: "极简要点",
    inject: "只给最关键的要点，极简、不展开、不客套。",
    presets: [
      { label: "三句话", q: "用三句话说清这篇文档：问题、做法、结论。", broad: true },
      { label: "一张图", q: "用一个 ```svg 图概括这篇文档的整体脉络。", broad: true },
      { label: "关键数字", q: "列出本文最重要的几个数字/结果，并 [B] 溯源。", broad: true },
      { label: "一句话结论", q: "用一句话给出本文最核心的结论。", broad: false },
    ] },
];

// Always-on chips (figure/annotation abilities) appended after any skill's chips.
export const COMMON_PRESETS: Preset[] = [
  { label: "总结(含图表)", q: "结合正文与图表，分【研究问题 / 方法 / 主要发现(含关键图表) / 结论与意义 / 局限】结构化总结这篇文档。最后额外用一个 ```svg 图直观呈现整体脉络与关键发现。", broad: true, withFigures: true },
  { label: "自动高亮", q: "从全文挑选 6-10 个最关键的句子，对每一句用 [[hl:<id>]] 标出；可附 [[note:<id>|一句话理由]]。逐条给出指令并简要说明理由。", broad: true, autoApply: true },
  { label: "总结我的高亮", q: "请总结我在这篇笔记里高亮和批注的内容，并说明它们之间的联系与整体脉络。", broad: false, annos: true },
  { label: "基于我的批注", q: "基于我在笔记里的高亮和批注回答：它们共同说明了什么？我可能在关注哪些问题？有没有遗漏的要点？", broad: false, annos: true },
];

export function skillById(id: string): Skill {
  return SKILLS.find((s) => s.id === (id || "").trim()) || SKILLS[0];
}
export function skillDirective(id: string): string {
  const s = skillById(id);
  return s.inject ? "\n\n【阅读技能：" + s.label + "】\n" + s.inject : "";
}
export function chipsFor(id: string): Preset[] {
  return skillById(id).presets.concat(COMMON_PRESETS);
}
