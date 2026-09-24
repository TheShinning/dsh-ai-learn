/**
 * 教材类型 → 教学模式 → 具体策略。
 *
 * ## 这张表是数据，不是散文
 *
 * 原系统与本仓库的伴学协议把教法写在提示词里（"降阶优先于加压""一次一个点"），
 * 那是**跨模式的底线**，不该按材料变。真正按材料变的是四件事：
 * **问什么**（`questionBias`）、**优先看哪个节点**（`focusBias`）、
 * **出什么题**（`cardBias`）、**怎么降阶**（`scaffoldLadder`），以及**收束时检查什么**（`wrapUpChecklist`）。
 *
 * 把它们做成 `TeachingStrategy` 而不是提示词段落，好处是：
 * 1. 可用测试逐字段 diff（`strategy.test.ts` 断言五种模式确实不同）；
 * 2. 模式只能改这四个字段 —— 无法影响"先问后讲 / 一次一问 / 深度 3 才直讲 / ≥2 种正证才点亮"
 *    这四条跨模式底线（{@link TEACHING_MODE_INVARIANTS} 明文列出，测试会盯住）。
 */

                                                  
                                               
import { MATERIAL_TYPE_LABEL } from '../types.js'

/** 教学模式。值一律 ASCII 标识，中文只在 `TEACHING_MODE_LABEL`。 */
                          
                    
                   
                  
                     
                  

export const TEACHING_MODE_LABEL                               = {
  'concept-driven': '概念驱动（概念 → 机制 → 迁移）',
  'clause-driven': '条文驱动（适用条件 → 例外 → 后果）',
  'drill-driven': '刷题驱动（先自答 → 判分 → 归因）',
  'argument-driven': '论证驱动（主张 → 理由 → 证据 → 反驳）',
  'exam-debrief': '解析复盘（反推出题意图）',
}

/**
 * 跨模式底线：**任何**教学模式都不得改变这四条。
 *
 * 用常量而不是注释，是为了让测试能直接断言"策略没有覆盖它们"
 * （苏格拉底模式最容易退化的形态，就是某个模式偷偷把"直接给答案"变成常态）。
 */
export const TEACHING_MODE_INVARIANTS                    = [
  '一次只问一个问题',
  '先问后讲：只有追问深度到 3（或半掌握且深度 ≥2）才直讲',
  '直讲之后必须让学生复述，复述不通过不推进',
  '点亮需要 ≥2 种不同的正向证据；学生说"懂了"不算证据',
]

                                
                             
                                                                      
                                       
               
                                          
                 
                                        
                           
                                            
                   
                                             
 

/** 材料类型 → 教学模式（封闭映射，未知输入不穿透）。 */
export function teachingModeOf(type              )               {
  switch (type) {
    case 'regulation':
      return 'clause-driven'
    case 'textbook':
    case 'lecture-notes':
      return 'concept-driven'
    case 'exam':
      return 'drill-driven'
    case 'article':
      return 'argument-driven'
    case 'answer-analysis':
      return 'exam-debrief'
  }
}

const STRATEGIES                                         = {
  regulation: {
    mode: 'clause-driven',
    focusBias: ['要件', '条件', '例外', '适用范围'],
    questionBias: [
      '这一条的**适用条件**是什么',
      '**什么情况下不适用**（例外情形）',
      '如果不满足条件会有什么后果',
    ],
    cardBias: ['cloze', 'mnemonic'],
    scaffoldLadder: ['给条文原文', '把条文拆成要件', '给一个不满足条件的反例'],
    wrapUpChecklist: ['复述适用条件一次', '复述例外情形一次', '确认口诀与场景对应'],
  },
  textbook: {
    mode: 'concept-driven',
    focusBias: ['概念', '机制', '原理'],
    questionBias: ['这个概念解决什么问题', '与它最容易混的是哪一个', '换个场景还成立吗'],
    cardBias: ['short-answer', 'choice'],
    scaffoldLadder: ['给定义', '给对比表', '给一个边界例子'],
    wrapUpChecklist: ['用自己的话讲清一个机制', '给出一个反例', '确认与已有节点是什么关系'],
  },
  'lecture-notes': {
    mode: 'concept-driven',
    focusBias: ['概念', '结构', '关系'],
    questionBias: [
      '这几个概念之间是什么关系（先修 / 对照 / 易混 / 实例）',
      '本次课的知识地图由哪几块组成',
      '哪一块是承重的（后面都靠它）',
    ],
    cardBias: ['short-answer', 'mnemonic'],
    scaffoldLadder: ['给目录', '给一句话纲要', '给一个概念对照'],
    wrapUpChecklist: ['补齐图谱里缺的语义边', '确认本次课的主线一句话'],
  },
  exam: {
    mode: 'drill-driven',
    focusBias: ['错题', '易错', '未通过'],
    questionBias: [
      '你先说答案和理由',
      '错在哪一步：概念 / 记忆 / 迁移 / 审题',
      '换个数或换个问法还成立吗',
    ],
    cardBias: ['choice', 'cloze'],
    scaffoldLadder: ['给"题眼"（这道题在考什么）', '给第一步', '给一道同类更小的题'],
    wrapUpChecklist: ['列出本轮错题的 errorType 分布', '给出重做清单（不是重讲一遍）'],
  },
  article: {
    mode: 'argument-driven',
    focusBias: ['主张', '结论', '论证'],
    questionBias: ['作者凭什么这么断言', '这个证据支持到哪一步', '哪里最弱（最容易被反驳的地方）'],
    cardBias: ['short-answer'],
    scaffoldLadder: ['标出主张句', '标出理由句', '给一个反驳方向'],
    wrapUpChecklist: ['用自己的话重述论证链', '指出一处证据不足'],
  },
  'answer-analysis': {
    mode: 'exam-debrief',
    focusBias: ['考点', '关键步骤', '易错点'],
    questionBias: ['出题人想考哪一个判断', '这一步为什么必须这么做', '换个数还成立吗'],
    cardBias: ['choice', 'short-answer'],
    scaffoldLadder: ['指出考点', '指出关键步骤', '给一个变式'],
    wrapUpChecklist: ['归纳本条解析对应的考点', '确认是否已能独立复现关键步骤'],
  },
}

export function strategyFor(type              )                   {
  return STRATEGIES[type]
}

/** 未识别材料的兜底策略：按教材教，但必须**先问用户**确认类型（见 `shouldAskUser()`）。 */
export const FALLBACK_STRATEGY                   = STRATEGIES.textbook

/** 模式指令：进 context 节的"该怎么教"一段（只讲策略，不讲底线）。 */
export function modeDirective(mode              )         {
  switch (mode) {
    case 'clause-driven':
      return '按条文走：每条先问**适用条件**，再问**例外情形**，最后问**后果**；不满足条件的反例是最好的检验。'
    case 'concept-driven':
      return '按概念走：先问"它解决什么问题"，再问"最容易混的是哪个"，最后给一个**边界例子**检验是否真的理解。'
    case 'drill-driven':
      return '按题走：**先让学生自答**（不要先给答案），再判对错，再把错误归因到概念 / 记忆 / 迁移 / 审题，最后给一道同类小题。'
    case 'argument-driven':
      return '按论证走：先让学生找出**主张句**，再找**理由与证据**，然后问"证据支持到哪一步"，最后给一个反驳方向。'
    case 'exam-debrief':
      return '按复盘走：不重讲知识点，而是问"出题人想考什么"、"这一步为什么必须这么做"，再用一个变式确认可迁移。'
  }
}

/** 策略 → 可读摘要（供 `study_progress` / `/socratic` / 课堂记录复用）。 */
export function renderStrategy(strategy                  )         {
  const cards = strategy.cardBias.join(' / ')
  return [
    `教学模式：${TEACHING_MODE_LABEL[strategy.mode]}`,
    `追问重点：${strategy.questionBias.join('；')}`,
    `出题偏好：${cards}`,
    `降阶阶梯：${strategy.scaffoldLadder.join(' → ')}`,
    `收束检查：${strategy.wrapUpChecklist.join('；')}`,
  ].join('\n')
}

/**
 * 材料类型 → 一行"该怎么教"（把 `classifyMaterial()` 的结果直接接到教学动作上）。
 *
 * 这是计划里 `formatDirective()` 的正式形态：不再维护第二套"格式→教法"映射，
 * 只由 `MaterialType` 与 `strategyFor()` 决定。
 */
export function materialDirective(type              )         {
  const strategy = strategyFor(type)
  return `${MATERIAL_TYPE_LABEL[type]}：${modeDirective(strategy.mode)}`
}
