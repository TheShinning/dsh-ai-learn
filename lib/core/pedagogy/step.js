/**
 * 苏格拉底教学步骤机 —— 一节课的六个环节，以及"下一步做什么"的唯一判定。
 *
 * ## 为什么要有这个模块（而不是把流程写进提示词）
 *
 * 原系统与本仓库的伴学模式都把教学流程写在协议文字里，靠模型自觉遵守。
 * 结果是"先问后讲""深度 3 才直讲"这类规则**无法被验证**：
 * 只能事后看对话像不像，不能事前判定这一步该不该给答案。
 *
 * 这里把流程变成**证据的函数**：
 * - 输入只有真实数据（`mastery` 由 `masteryFromEvidence()` 算出、`probeState` 由
 *   `deriveProbeState()` 数出来、`cards` / `quizResult` 来自存储）；
 * - 输出是结构化动作（`action` / `mayRevealAnswer` / `mustRetell` / `questionBudget`），
 *   模型照做即可，偏离时用户可见地偏离。
 *
 * 于是四条跨模式底线都有了可执行的落点：
 * 1. 一次只问一个问题 → `questionBudget` 恒为 1；
 * 2. 先问后讲 → 只有 `probeDepth === 3` 或连续两次困惑才 `mayRevealAnswer`；
 * 3. 直讲之后必须复述 → `explain-and-retell` 之后 `mustRetell === true`，且**复述不通过时
 *    深度不归零**（回退到 `retell-again`，而不是回到起点把学生重新问一遍）；
 * 4. 降阶优先于加压 → 困惑阶梯固定为 example → binary，不由模型即兴选择。
 *
 * ## 与 `probe.ts` 的分工
 *
 * `probe.ts` 负责"深度是多少、这一档该怎么说话"（教学语气）；
 * 本模块负责"下一步是哪个动作"（教学流程）。两者都不含任何自然语言生成。
 */

                                                           
                                                        
import { orderEvidence } from '../knowledge/evidence.js'
                                            
import { depthDirective, toneDirective } from './probe.js'

/** 一节课的环节。值一律是稳定的 ASCII 标识，中文只在 `*_LABEL` 里。 */
                          
              
           
              
                        
          
            

export const SOCRATIC_STEP_LABEL                               = {
  diagnose: '定向',
  probe: '追问',
  scaffold: '降阶',
  'explain-and-retell': '直讲与复述',
  quiz: '测试',
  wrapup: '收束与复习',
}

/** 环节的稳定顺序（用于判定"是否回退"与渲染轨迹）。 */
export const SOCRATIC_STEP_ORDER                          = [
  'diagnose',
  'probe',
  'scaffold',
  'explain-and-retell',
  'quiz',
  'wrapup',
]

/** 下一步动作。比环节更细：同一环节里的一次具体动作。 */
                            
                     
         
            
                  
                  
                         
                  
          
            
             

export const SOCRATIC_ACTION_LABEL                                 = {
  'import-material': '先锁定一份材料',
  ask: '问一个关键问题',
  narrow: '缩小范围再问',
  'give-example': '给一个例子再问',
  'offer-binary': '换成二选一',
  'explain-then-retell': '讲最小正确模型并要求复述',
  'retell-again': '再复述一次（不回退深度）',
  quiz: '出一道题验收',
  review: '插入到期复习',
  advance: '推进到下一处',
}

/** 一次测试的结果。`retell` 用于复述验收，其余三档与 SRS 同源。 */
                                                                                 

                            
                             
                                 
                          
                                 
                                           
                            
                             
                                            
                          
                            
                       
                              
                          
                                   
                     
                               
 

/** 该节点下一张到期卡（省略 `due` 字段视为到期，与 `review/srs.ts` 的 `isDue` 同语义）。 */
                        
                     
                          
                        
 

                                 
                          
                                                         
                                            
                                 
                                   
                                         
                  
                                      
                                
                                 
 

/** 复述与测验的既有结果，从证据里数出来（不靠调用方传"我记得学生复述过了"）。 */
function priorOutcomes(evidence                                 )   
                          
                                
                              
                              
  {
  if (!evidence?.length) return { retold: false, retellFailed: false, quizPassed: false, quizFailed: false }
  let retold = false
  let retellFailed = false
  let quizPassed = false
  let quizFailed = false
  for (const item of orderEvidence(evidence)) {
    if (item.kind === 'answer-quality' && item.result === 'retell') {
      if (item.correct === false) retellFailed = true
      else retold = true
    }
    if (item.kind === 'flashcard' || item.kind === 'srs-review') {
      if (item.correct === true || item.srsResult === 'good') quizPassed = true
      if (item.correct === false || item.srsResult === 'again') quizFailed = true
    }
  }
  return { retold, retellFailed, quizPassed, quizFailed }
}

/**
 * 判定下一步动作。
 *
 * 判定顺序（每一条都可由输入解释）：
 * 1. 没有节点（无教材或空图谱）→ `import-material`（零起点路径，不报错、不返回空对象）；
 * 2. 已点亮 → 有到期卡先 `review`，有卡且未通过测验则 `quiz`，否则 `advance`；
 * 3. 刚复述通过 → 有卡先 `quiz`，否则 `review`/`advance`；
 * 4. 复述不通过（或证据里有过失败复述）→ `retell-again`（**深度不归零**）；
 * 5. 连续两次困惑（`probeDepth >= 3`）→ `explain-then-retell`（允许直讲）；
 * 6. 困惑一次 → `give-example`；困惑两次 → `offer-binary`（阶梯固定，不由模型选）；
 * 7. 半掌握且深度 ≥ 2 → `narrow`；半掌握 → `explain-then-retell`（允许直讲并复述）；
 * 8. 其余 → `ask`（一次一个关键问题）。
 */
export function nextSocraticMove(input                   )               {
  const base = {
    questionBudget: 1         ,
    scaffoldLadder: []                     ,
  }

  // 1. 零起点：没有任何教材/节点时，第一步是锁定材料，而不是报错。
  if (!input.nodeId) {
    return {
      ...base,
      step: 'diagnose',
      action: 'import-material',
      probeDepth: 0,
      directive:
        '还没有可推进的知识点。先与用户锁定**一份**材料：可以导入文件（Markdown / txt / html / PDF / Word / odt / epub）、' +
        '粘贴正文，或直接说一个想学的知识点。锁定之前不要开始提问。',
      mustRetell: false,
      mayRevealAnswer: false,
    }
  }

  const nodeId = input.nodeId
  const depth = input.probeState.probeDepth
  const tone               = input.mastery
  const cards = input.cards ?? []
  const dueCard = cards.find((card) => card.due !== false)
  const outcomes = priorOutcomes(input.evidence)
  const justFailedRetell = input.lastQuiz === 'retell-fail' || outcomes.retellFailed
  const justPassedRetell = input.lastQuiz === 'retell-ok' || outcomes.retold

  // 2. 已点亮：复习优先，其次验收，最后推进。
  if (tone === 'mastered') {
    if (dueCard) {
      return {
        ...base,
        step: 'wrapup',
        action: 'review',
        nodeId,
        probeDepth: depth,
        focusNodeId: nodeId,
        directive:
          `该知识点已点亮，但有到期卡（${dueCard.id}）。插入一次复习：先让学生作答，再用 study_submit_review 记录结果，` +
          '答错会把掌握度信号带回来，不要手动改掌握度。',
        mustRetell: false,
        mayRevealAnswer: false,
      }
    }
    if (cards.length > 0 && !outcomes.quizPassed && input.lastQuiz !== 'good' && input.lastQuiz !== 'hard') {
      return {
        ...base,
        step: 'quiz',
        action: 'quiz',
        nodeId,
        probeDepth: depth,
        focusNodeId: nodeId,
        directive: '已点亮但还没有一次通过测验的记录。出一道小题（选择/填空/简答/口诀均可）来验收，而不是继续讲解。',
        mustRetell: false,
        mayRevealAnswer: false,
      }
    }
    return {
      ...base,
      step: 'wrapup',
      action: 'advance',
      nodeId,
      probeDepth: 0,
      focusNodeId: nodeId,
      directive: '该知识点已达标。收束本点（一句话总结），再进入下一处推荐；不要在同一节点继续加题。',
      mustRetell: false,
      mayRevealAnswer: false,
    }
  }

  // 3. 刚复述通过：转入验收（有卡）或收束。
  if (justPassedRetell && !justFailedRetell) {
    if (cards.length > 0) {
      return {
        ...base,
        step: 'quiz',
        action: 'quiz',
        nodeId,
        probeDepth: 0,
        focusNodeId: nodeId,
        directive: '学生已用自己的话复述通过。现在出一道题验收（这张卡是多元证据的第二路），做完再决定是否收束。',
        mustRetell: false,
        mayRevealAnswer: false,
      }
    }
    return {
      ...base,
      step: 'wrapup',
      action: 'review',
      nodeId,
      probeDepth: 0,
      focusNodeId: nodeId,
      directive:
        '学生已复述通过，但该知识点还没有卡片。先提议建一张卡（征得同意），再收束；没有第二路证据就不要宣布"已掌握"。',
      mustRetell: false,
      mayRevealAnswer: false,
    }
  }

  // 4. 复述不通过：回退到复述环节，**深度不归零**（避免把学生重新问一遍）。
  if (justFailedRetell) {
    return {
      ...base,
      step: 'explain-and-retell',
      action: 'retell-again',
      nodeId,
      probeDepth: depth,
      focusNodeId: nodeId,
      scaffoldLadder: [
        '把刚才的最小模型拆成两句，让学生只复述第一句',
        '给一个填空式的复述框架（"它的作用是……，所以当……时用它"）',
        '允许学生用生活例子替代术语',
      ],
      directive:
        '复述未通过。**不要**回到最初的问题重新问一遍，也不要重复整段讲解：' +
        '按阶梯缩小复述范围（先复述一句），再让他用自己的话接上第二句。追问深度保持不变。',
      mustRetell: true,
      mayRevealAnswer: true,
    }
  }

  // 5. 连续两次困惑（深度到 3）：直讲最小正确模型并要求复述。
  if (depth >= 3) {
    return {
      ...base,
      step: 'explain-and-retell',
      action: 'explain-then-retell',
      nodeId,
      probeDepth: depth,
      focusNodeId: nodeId,
      scaffoldLadder: ['先讲最小正确模型', '再要求用自己的话复述', '复述通过后才出题验收'],
      directive: `${depthDirective(3)} ${toneDirective(tone)} 讲完后必须要求复述，复述不通过就停在这里，不要出题、不要推进。`,
      mustRetell: true,
      mayRevealAnswer: true,
    }
  }

  // 5b. 半掌握且深度到 2：允许直讲并复述（不继续抽象追问）。
  if (tone === 'partial' && depth >= 2) {
    return {
      ...base,
      step: 'explain-and-retell',
      action: 'explain-then-retell',
      nodeId,
      probeDepth: depth,
      focusNodeId: nodeId,
      scaffoldLadder: ['讲最小正确模型', '要求复述', '再出题验收'],
      directive:
        '学生已半掌握但连续追问没有进展。停止加压：直接讲最小正确模型，然后要求复述确认，再往验收走。',
      mustRetell: true,
      mayRevealAnswer: true,
    }
  }

  // 6. 困惑阶梯：第 1 次给例子，第 2 次换二选一（固定阶梯，不由模型选）。
  if (tone === 'confused') {
    const second = depth >= 2 || input.probeState.streak >= 2
    if (second) {
      return {
        ...base,
        step: 'scaffold',
        action: 'offer-binary',
        nodeId,
        probeDepth: depth,
        focusNodeId: nodeId,
        scaffoldLadder: ['把问题收成二选一（A 还是 B）', '只问判断，不要求解释', '判断对了再问"为什么"'],
        directive:
          '学生连续困惑（降阶第 2 级）：不要再追问抽象问题，把它收成一个二选一，只要求学生判断；判断正确后再问理由。',
        mustRetell: false,
        mayRevealAnswer: false,
      }
    }
    return {
      ...base,
      step: 'scaffold',
      action: 'give-example',
      nodeId,
      probeDepth: depth,
      focusNodeId: nodeId,
      scaffoldLadder: ['换一个生活化的具体例子', '再问同一件事', '仍然不问定义'],
      directive:
        '学生表现出困惑（降阶第 1 级）：先给一个具体例子或反例，再问同一件事；不要重复原来的抽象问法，也不要直接给答案。',
      mustRetell: false,
      mayRevealAnswer: false,
    }
  }

  // 7. 半掌握且追问深度到 2：缩小范围。
  if (depth >= 2) {
    return {
      ...base,
      step: 'scaffold',
      action: 'narrow',
      nodeId,
      probeDepth: depth,
      focusNodeId: nodeId,
      scaffoldLadder: ['把范围缩到一个小场景', '只问这一个场景里的判断', '学生答对后再放回原问题'],
      directive: '追问深度已到 2：把问题范围缩小到一个具体小场景，仍然是问，不要给答案。',
      mustRetell: false,
      mayRevealAnswer: false,
    }
  }

  // 8. 默认：一次一个关键问题（含最初的诊断）。
  const first = input.evidence === undefined || input.evidence.length === 0
  return {
    ...base,
    step: first ? 'diagnose' : 'probe',
    action: 'ask',
    nodeId,
    probeDepth: depth,
    focusNodeId: nodeId,
    directive: first
      ? `${depthDirective(0)} 先用一个关键问题确认学生现在理解到哪一步，不要先讲教材内容。`
      : `${depthDirective(depth)} ${toneDirective(tone)} 一次只问一个问题。`,
    mustRetell: false,
    mayRevealAnswer: false,
  }
}

/**
 * 把动作渲染成一行可读状态（供 `study_steps` 与 `/socratic` 复用）。
 *
 * 刻意把 `mayRevealAnswer` 与 `mustRetell` 也写出来：模型与用户都能看见"这一步能不能给答案"。
 */
export function renderMove(move              )         {
  const parts = [
    `环节：${SOCRATIC_STEP_LABEL[move.step]}`,
    `动作：${SOCRATIC_ACTION_LABEL[move.action]}`,
    `一次一问：${move.questionBudget} 个问题`,
    `可以给答案：${move.mayRevealAnswer ? '可以（深度已到）' : '不可以'}`,
  ]
  if (move.mustRetell) parts.push('必须让学生复述后才能推进')
  return parts.join('｜')
}

/**
 * 记录一步（供课堂记录的留痕使用；纯函数，不读时钟之外的任何外部状态）。
 */
export function appendStep(
  steps                                                                                                  ,
  move              ,
  at      ,
)                                                                                                   {
  return [...steps, { step: move.step, at: at.toISOString(), action: move.action }]
}
