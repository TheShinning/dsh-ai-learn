/**
 * 伴学共享词汇表。
 *
 * 设计约束（来自原系统审计的教训）：
 * 1. 所有枚举值都是**稳定的 ASCII 标识**，中文只作为展示标签存在于 `*_LABEL` 表里。
 *    原系统 `learning.masteryEvaluator.ts:230/233/236` 把 `"\\u8bb0\\u5fc6"` 这样的
 *    转义文本当成 bloomLevel 落库，导致"达应用级才上移提问层级"永远不成立。
 *    把"值"和"标签"分开是杜绝该类错误的结构性手段：写库的永远是标识，展示才查表。
 * 2. 所有取值都经过 `normalize*` 收敛，未知输入不会静默穿透到持久层。
 */

/** 知识点掌握度。未知输入一律收敛为 `unknown`。 */
                                                                     

export const MASTERY_VALUES                     = ['unknown', 'partial', 'confused', 'mastered']

/** 掌握度用于排序/统计时的权重（值越大表示越"亮"）。 */
export const MASTERY_RANK                          = {
  unknown: 0,
  confused: 1,
  partial: 2,
  mastered: 3,
}

export const MASTERY_LABEL                          = {
  unknown: '未点亮',
  confused: '困惑',
  partial: '半掌握',
  mastered: '已点亮',
}

export function isMastery(value         )                   {
  return typeof value === 'string' && (MASTERY_VALUES                     ).includes(value)
}

export function normalizeMastery(value         , fallback          = 'unknown')          {
  return isMastery(value) ? value : fallback
}

/** 是否达到"已点亮"。 */
export function isLit(mastery         )          {
  return mastery === 'mastered'
}

/**
 * 布鲁姆认知层级。
 *
 * 原系统把 bloomLevel 当自由字符串，节点级从未赋值、证据级写入的是转义文本，
 * 于是整个"层级递进"机制是空的。这里的取值是封闭联合类型，
 * 任何越界写法在 `tsc` 阶段就会被拒绝。
 */
                                                                                                

export const BLOOM_LEVELS                        = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
]

export const BLOOM_LABEL                             = {
  remember: '记忆',
  understand: '理解',
  apply: '应用',
  analyze: '分析',
  evaluate: '评价',
  create: '创造',
}

export function isBloomLevel(value         )                      {
  return typeof value === 'string' && (BLOOM_LEVELS                     ).includes(value)
}

/**
 * 把任意输入收敛为合法 `BloomLevel`。
 *
 * 为了兼容历史数据，这里额外接受中文标签与常见的 `\uXXXX` 转义字面量
 * （原系统真的把 `\u8bb0\u5fc6` 这种 12 字符文本写进过库），
 * 但**输出永远是 ASCII 标识**。
 */
export function normalizeBloomLevel(value         , fallback             = 'remember')             {
  if (isBloomLevel(value)) return value
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback

  // 历史脏数据：字面量 "\u8bb0\u5fc6"（反斜杠 + u + 十六进制），需要先解码再比对。
  const decoded = /^(?:\\u[0-9a-fA-F]{4})+$/.test(trimmed) ? decodeUnicodeEscapes(trimmed) : trimmed

  // trim 之后可能已经是合法标识（例如 "  apply  "）
  if (isBloomLevel(decoded)) return decoded

  for (const level of BLOOM_LEVELS) {
    if (BLOOM_LABEL[level] === decoded) return level
  }
  // 常见别名容错
  const alias                             = {
    记忆: 'remember',
    理解: 'understand',
    应用: 'apply',
    分析: 'analyze',
    评价: 'evaluate',
    创造: 'create',
    knowledge: 'remember',
    comprehension: 'understand',
    application: 'apply',
  }
  return alias[decoded] ?? fallback
}

function decodeUnicodeEscapes(text        )         {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex        ) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/** 层级比较：`level` 是否达到或超过 `floor`。 */
export function bloomAtLeast(level            , floor            )          {
  return BLOOM_LEVELS.indexOf(level) >= BLOOM_LEVELS.indexOf(floor)
}

/** 学习活动模式。 */
                                                                          

export const ACTIVITY_MODE_LABEL                               = {
  teaching: '教学',
  'peer-exchange': '学伴交流',
  'guided-reading': '伴读',
}

/** 教材读物类型（决定教学法）。 */
                          
             
              
                
                   
          
                     

export const MATERIAL_TYPE_LABEL                               = {
  article: '文章',
  textbook: '教材',
  regulation: '法条/规范',
  'lecture-notes': '讲义',
  exam: '真题/模拟题',
  'answer-analysis': '答案解析',
}

/** 教学情景（教材情景分类器的输出）。 */
                              
             
                
         
                    
                   
            

export const TEACHING_SCENARIO_LABEL                                   = {
  general: '通用',
  regulation: '条例学习',
  law: '法律学习',
  'course-concept': '概念学习',
  'code-practice': '代码实操',
  review: '复习巩固',
}

/** 错误类型（追问策略的输入）。 */
                       
                              
                
                      
                             
               

export const ERROR_TYPE_LABEL                            = {
  'concept-misunderstanding': '概念混淆',
  forgetting: '记忆遗忘',
  'transfer-failure': '应用迁移失败',
  'comprehension-deviation': '审题理解偏差',
  'no-answer': '未作答',
}

/** 追问深度状态。 */
                                      

export const PROBE_DEPTH_MAX             = 3

/** 最近一条证据的语气。 */
                                                                          
