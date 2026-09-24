/**
 * 材料分类 —— 决定"这份东西该怎么教"的第一步。
 *
 * ## 现状（为什么要新写）
 *
 * `core/src/types.ts` 有 `MaterialType`（6 类）与中文标签，但**全仓库零引用**：
 * 没有分类器，也没有任何按类型分叉的教学行为。导入时命中的 `sourceFormat`
 * 只写进报告文本与记录字段（`plugin-host/src/tools.ts`），不改变教学。
 *
 * ## 判定必须可解释，且**不准时要说不准**
 *
 * 三层降级：**显式指定 > 文件名/标题特征 > 正文特征**。
 * 输出永远带 `confidence` 与 `why`；没有任何特征命中时返回 `textbook` + `unknown`，
 * 由上层决定"问用户"（`strategy.ts` 的 `shouldAskUser()`），而不是硬猜一个类型就往下教。
 *
 * 这一条与 `Metric<T>` 的诚实约束同源：教法建立在错误的类型判断上，
 * 比"问一句这是什么材料"贵得多。
 */

                                                      
                                               
import { MATERIAL_TYPE_LABEL } from '../types.js'

/** 分类置信度。`explicit` 来自用户明确指定，`unknown` 表示没有可用特征。 */
                                                                           

export const MATERIAL_CONFIDENCE_LABEL                                     = {
  explicit: '用户明确指定',
  strong: '特征明显',
  weak: '特征较弱（可被一句改判）',
  unknown: '无可用特征',
}

                                      
                             
                                         
                             
                      
                         
                       
 

                             
                         
                             
                                               
                           
                                         
                                  
 

export function isMaterialType(value         )                        {
  return (
    value === 'article' ||
    value === 'textbook' ||
    value === 'regulation' ||
    value === 'lecture-notes' ||
    value === 'exam' ||
    value === 'answer-analysis'
  )
}

/**
 * 复合 `sourceFormat` 的编码：`<format>|<materialType>|<confidence>`。
 *
 * 为什么放进既有字段：材料类型是**教材属性**（换教材不该丢），而 `textbooks.sourceFormat`
 * 已是 `z.string()`；旧值形如 `pdf` / `markdown`，读取时按 `|` 切分、首段即 `SourceFormat`，
 * 因此**不需要新字段、不需要 migration**。
 */
export function encodeSourceFormat(format        , type              , confidence                    )         {
  return `${format}|${type}|${confidence}`
}

                                   
                          
                                      
                                          
 

/** 解析复合值；旧值（无 `|`）返回只有 `format` 的结果。未知片段一律忽略，不抛错。 */
export function decodeSourceFormat(value                    )                      {
  if (!value) return {}
  const [format, type, confidence] = value.split('|')
  return {
    format: format?.trim() || undefined,
    materialType: isMaterialType(type) ? type : undefined,
    confidence:
      confidence === 'explicit' || confidence === 'strong' || confidence === 'weak' || confidence === 'unknown'
        ? confidence
        : undefined,
  }
}

/** 特征表：strong 权重 2，weak 权重 1。 */
                  
                                    
                                  
 

const SIGNATURES                                  = {
  regulation: {
    strong: [/第[一二三四五六七八九十百千零〇\d]+条/, /本条例|本办法|本规定|本法|本条所?称/, /施行|生效日期|废止/],
    weak: [/应当|不得|可以|由.{0,6}负责/, /款|项|目/, /违反.{0,8}规定/],
  },
  exam: {
    strong: [/[（(]\s*[)）]\s*$|^\s*\d+[.、]\s*/, /【答案】|参考答案|正确答案/, /A[.、．]\s*.{2,}\s*B[.、．]/, /单选题|多选题|判断题|简答题|案例分析题/],
    weak: [/第\s*\d+\s*题/, /考试|测验|模拟|真题|练习/, /[（(]\s*\d+\s*分\s*[)）]/],
  },
  'answer-analysis': {
    strong: [/解析[:：]|【解析】|答案解析/, /本题考点|考点[:：]|易错点/, /故选\s*[A-D]|答案为\s*[A-D]/],
    weak: [/解题思路|第一步|第二步|综上/, /错误选项|干扰项/],
  },
  textbook: {
    strong: [/第[一二三四五六七八九十百千零〇\d]+章/, /第[一二三四五六七八九十百千零〇\d]+节/],
    weak: [/本章|本节|小结|思考题|练习题|概念|定义[:：]/, /^\s*\d+\.\d+/m],
  },
  'lecture-notes': {
    strong: [/本次课|本讲|本节课|课堂小结/, /老师|教师|板书/],
    weak: [/[•·▪]/, /^\s*[-*]\s+/m, /重点[:：]|要点[:：]|注意[:：]/],
  },
  article: {
    strong: [/摘要[:：]|关键词[:：]|参考文献/, /作者|发表于|年\s*第\s*\d+\s*期/],
    weak: [/本文认为|我们认为|笔者认为|由此可见|综上所述/, /研究|调研|访谈|数据显示/],
  },
}

function countHits(text        , patterns                   )         {
  let hits = 0
  for (const pattern of patterns) {
    // 全局匹配需要重置 lastIndex，这里逐次构造避免共享状态
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    const found = text.match(re)
    hits += found ? Math.min(found.length, 5) : 0
  }
  return hits
}

/** 文件名/标题里的关键词权重更高（用户自己的命名通常最可信）。 */
const TITLE_SIGNATURES                                          = {
  regulation: [/条例|办法|规定|法规|法条|规范|标准|章程|细则/],
  exam: [/真题|模拟|试卷|习题|练习|题库|试题|考试/],
  'answer-analysis': [/解析|答案|详解|题解/],
  textbook: [/教材|教程|课本|讲义|手册/],
  'lecture-notes': [/课堂|笔记|听课|讲授|讲义/],
  article: [/论文|文章|综述|研究|报告/],
}

/**
 * 分类一份材料。
 *
 * 判定顺序：`explicit` → 标题/文件名特征 → 正文特征 → 兜底 `textbook` + `unknown`。
 * 短文本（< 200 字符）不会被弱特征判成"明显"，避免"粘贴一句话就被当成条例"。
 */
export function classifyMaterial(input               )                         {
  if (input.explicit && isMaterialType(input.explicit)) {
    return {
      type: input.explicit,
      confidence: 'explicit',
      why: `用户明确指定为「${MATERIAL_TYPE_LABEL[input.explicit]}」`,
      hits: 0,
    }
  }

  const text = input.markdown ?? ''
  const head = [input.title ?? '', input.sourceRef ?? ''].join(' ')
  const score = new Map                      ()

  for (const [type, patterns] of Object.entries(TITLE_SIGNATURES)                                       ) {
    const matched = patterns.filter((pattern) => pattern.test(head))
    if (matched.length > 0) score.set(type, (score.get(type) ?? 0) + 4 * matched.length)
  }

  for (const [type, signature] of Object.entries(SIGNATURES)                               ) {
    const strong = countHits(text, signature.strong)
    const weak = countHits(text, signature.weak)
    if (strong > 0) score.set(type, (score.get(type) ?? 0) + strong * 2)
    if (weak > 0) score.set(type, (score.get(type) ?? 0) + weak)
  }

  const ranked = [...score.entries()].sort((left, right) => (right[1] - left[1]) || (left[0] < right[0] ? -1 : 1))
  const best = ranked[0]

  if (!best || best[1] <= 0) {
    return {
      type: 'textbook',
      confidence: 'unknown',
      why: '正文与标题都没有命中任何材料特征，暂按教材处理；请向用户确认这是什么材料。',
      hits: 0,
    }
  }

  const [type, total] = best
  const fromTitle = TITLE_SIGNATURES[type].filter((pattern) => pattern.test(head))
  // 阈值：标题命中（权重 4）算明显；正文特征需要足够密度，短文本更严格
  const length = Math.max(text.length, 1)
  const strongEnough = fromTitle.length > 0 || total >= 6 || (total >= 4 && length >= 400)
  const confidence                     = strongEnough ? 'strong' : 'weak'
  const whyParts           = []
  if (fromTitle.length > 0) {
    whyParts.push(`标题/文件名含「${MATERIAL_TYPE_LABEL[type]}」相关词（${fromTitle.map((pattern) => pattern.source).join('、')}）`)
  }
  if (total > 0) whyParts.push(`正文命中 ${total} 个特征`)

  return {
    type,
    confidence,
    why: `${whyParts.join('；')}（判别为「${MATERIAL_TYPE_LABEL[type]}」）`,
    hits: total,
  }
}

/**
 * 是否应该先问用户。
 *
 * `weak` 与 `unknown` 都返回 true：教法建立在猜错的类型上代价太大，
 * 而问一句"这是教材、条例还是题？"几乎零成本（学生答一句即可改判）。
 */
export function shouldAskUser(classification                        )          {
  return classification.confidence === 'weak' || classification.confidence === 'unknown'
}

/** 把分类结果渲染成一行（供工具与命令复用）。 */
export function renderClassification(classification                        )         {
  return `材料类型：${MATERIAL_TYPE_LABEL[classification.type]}（${MATERIAL_CONFIDENCE_LABEL[classification.confidence]}）｜${classification.why}`
}
