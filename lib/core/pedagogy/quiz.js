/**
 * 问答 → 证据 的映射，以及"该出哪种题"的判定。
 *
 * ## 这个模块存在的唯一理由：不让"判分口径"出现第二套
 *
 * 原系统最贵的病是**同一份数据两个结论**：写入路径对 `flashcard / code-lab / note / blackboard`
 * 不校验 `correct` / `result` 即计正向（`learning_knowledge_graph.go:388-393`），
 * 而重放路径用严格的 `isPositiveEvidence`（`:313-327`）。苏格拉底模式会新增大量作答写入，
 * 如果这里自定义一套"答得不错就算对"，就会原样重现那个病。
 *
 * 所以本模块只做三件事，且每一件都复用既有唯一判定：
 * 1. `answerToEvidence()` —— 把一次作答翻译成 `Evidence` 字段，`correct` 三态由**是否作答/是否判对**决定，
 *    正向与否交给 `isPositiveEvidence()` 判（不在这里判）；
 * 2. `quizIntent()` / `quizDirective()` —— 由掌握度与布鲁姆层级决定"现在该问什么"，
 *    而不是让模型随机抽卡或一直问同一类；
 * 3. `retellEvidence()` —— 复述是一种显式的作答类型（`result: 'retell'`），
 *    与普通回答分开记账，这样步骤机才能区分"答错"和"复述未通过"。
 */

                                                                               
import { BLOOM_LABEL, bloomAtLeast } from '../types.js'
                                                                   
                                                  
import { CARD_KIND_LABEL } from '../review/cards.js'

/** 这一步要学生做什么。 */
                                                          

export const QUIZ_INTENT_LABEL                             = {
  'explain-in-own-words': '用自己的话讲一遍',
  ...CARD_KIND_LABEL,
}

/** 作答的性质：普通回答 / 复述 / 卡片自评。 */
                                                     

                           
                         
                           
                                
                         
                            
                                          
                            
                                      
                                 
                                  
                                     
                                
                           
                     
 

/** 摘要长度上限：证据里存的是线索，不是学生全文。 */
export const ANSWER_SUMMARY_LIMIT = 60

function clip(text        , limit = ANSWER_SUMMARY_LIMIT)         {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

/**
 * 作答 → 证据字段。
 *
 * **诚实约束**：这里不产出"正向/负向"结论，只产出客观字段（`correct` / `result` / `mastery`）。
 * 谁是正向证据由 `knowledge/mastery.ts` 的 `isPositiveEvidence()` 唯一决定。
 *
 * `mastery` 只在两种情况下写入：明确答错（`confused`）与复述未通过（`confused`）。
 * "答对"**不**直接写 `mastered` —— 一次答对只是半掌握，点亮需要多元证据（跨模式底线）。
 */
export function answerToEvidence(input             )       
           
                                                                                                                          
  {
  const kind             = input.kind ?? 'answer'
  const tone = toneOf(input)
  const summary = input.summary ?? defaultSummary(input, kind)
  const result = resultOf(input, kind, tone)
  const correct = correctOf(input)

  return {
    nodeId: input.nodeId,
    kind: kind === 'card' ? 'flashcard' : 'answer-quality',
    sourceId: input.sourceId,
    summary,
    result,
    correct,
    mastery: tone === 'confused' ? 'confused' : undefined,
    bloomLevel: input.bloomLevel,
    errorType: input.errorType ?? inferErrorType(input),
    createdAt: (input.now ?? new Date()).toISOString(),
  }
}

/** 复述证据：与普通回答同类（`answer-quality`），但 `result` 显式为 `retell`，便于步骤机区分。 */
export function retellEvidence(
  input                                                          ,
)                                      {
  return answerToEvidence({ ...input, kind: 'retell', correct: input.passed })
}

function correctOf(input             )                      {
  if (!input.answer.trim()) return undefined
  if (typeof input.correct === 'boolean') return input.correct
  if (input.selfReport) return input.selfReport !== 'again'
  return undefined
}

function toneOf(input             )               {
  if (!input.answer.trim()) return 'unknown'
  if (input.correct === false) return 'confused'
  if (input.selfReport === 'again') return 'confused'
  if (input.selfReport === 'hard') return 'partial'
  if (input.correct === true || input.selfReport === 'good') return 'partial'
  return 'unknown'
}

/**
 * `result` 是既有约定的字符串（`light` / `consolidate` / `clarify` / `retell`）。
 *
 * - 复述：`retell`（通过与否由 `correct` 表达）；
 * - 未作答：`clarify`（提示需要澄清，而不是判错 —— 未作答与答错是两件事）；
 * - 答错：`clarify`；答对：`light`（可迁移）或 `consolidate`（需巩固）。
 */
function resultOf(input             , kind            , tone              )         {
  if (kind === 'retell') return 'retell'
  if (!input.answer.trim()) return 'clarify'
  if (tone === 'confused') return 'clarify'
  if (input.selfReport === 'hard') return 'consolidate'
  return 'light'
}

/**
 * 错误类型推断。
 *
 * **这是启发式**：命中不了就返回 `undefined`（而不是硬猜一个），
 * 并允许调用方显式传入 `errorType` 覆盖。理由与 `Metric<T>` 的诚实约束一致 ——
 * 错误类型是教学决策的输入，猜错比不知道更糟。
 */
export function inferErrorType(input                                                        )                        {
  const text = input.answer.trim()
  if (!text) return 'no-answer'
  if (input.correct === true || input.selfReport === 'good') return undefined
  if (/不知道|不会|没学过|想不起来|忘了|记不清/.test(text)) return 'forgetting'
  if (/看错|读错|没看清|题意|问的是什么/.test(text)) return 'comprehension-deviation'
  if (/搞混|混淆|分不清|混了|弄混/.test(text)) return 'concept-misunderstanding'
  // 有作答、判错但没有任何自述信号：迁移失败是最常见的形态，但仍是启发式
  return 'transfer-failure'
}

function defaultSummary(input             , kind            )         {
  const label = kind === 'retell' ? '复述' : kind === 'card' ? '卡片作答' : '回答'
  const head = input.answer.trim() ? clip(input.answer) : '（未作答）'
  return `${label}：${head}`
}

/**
 * 现在该用哪种方式验收。
 *
 * 判定依据只有两个真实输入：当前掌握度与已达布鲁姆层级。
 * - 未达 `understand`：先要求**用自己的话讲一遍**（讲不清楚就不必出题）；
 * - 达 `understand`：可以用填空/选择这类"有唯一答案"的形态；
 * - 达 `apply`：优先给**简答题**（需要迁移），而不是继续做记忆型选择。
 *
 * @param input.hasCard 该节点是否已有卡片：没有卡时返回"讲一遍"（并提示先去建卡）。
 */
export function quizIntent(input   
                           
                            
                           
 )             {
  if (!input.hasCard) return 'explain-in-own-words'
  if (bloomAtLeast(input.bloom, 'apply')) return 'short-answer'
  if (bloomAtLeast(input.bloom, 'understand')) return input.mastery === 'confused' ? 'choice' : 'cloze'
  return 'explain-in-own-words'
}

export function quizDirective(intent            , mastery         )         {
  switch (intent) {
    case 'explain-in-own-words':
      return '先让学生用自己的话讲一遍（不要求术语）。讲不清楚就不要出题——出题只会掩盖没理解。'
    case 'choice':
      return '出一道选择题，选项里包含学生最容易混的那个概念；答错当场辨析，不要只报对错。'
    case 'cloze':
      return '出一道填空题，只挖一个关键要件；填错说明是记忆问题，回到复习而不是继续追问。'
    case 'short-answer':
      return '出一道简答题，要求迁移到新情境；这是"应用级"证据，答对才算第二种正向证据。'
    case 'mnemonic':
      return mastery === 'confused'
        ? '给一句口诀帮助区分易混点，并让学生复述口诀与其对应的场景。'
        : '可以补一句口诀巩固，但必须经过学生确认或修改后才写入卡片。'
  }
}

/** 把"该出什么题"渲染成一行状态，供工具与命令复用。 */
export function renderQuizIntent(intent            , mastery         )         {
  return `验收方式：${QUIZ_INTENT_LABEL[intent]}｜${quizDirective(intent, mastery)}`
}

/** 布鲁姆层级的展示标签（把中文标签集中在 core，宿主不再自己查表）。 */
export function bloomLabel(level            )         {
  return BLOOM_LABEL[level]
}
