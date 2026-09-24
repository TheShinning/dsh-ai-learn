/**
 * 伴学教学协议 —— 作为**系统提示的一个节**交付。
 *
 * ## 为什么这里和原系统完全不同（本次迁移最重要的一处修复）
 *
 * 原系统把教学协议做成"发送时往用户文本前面塞 `/learn ` + 若干 `[XXX]` 文本块"
 * （`learning.systemProcess.ts:140-163`）。审计发现该投递方式在生产链路上被内核改写：
 *
 * 1. `internal/control/controller.go:1093` 的 `submit()` 用**注入后的文本**做命令识别
 *    （`trimmed := strings.TrimSpace(input)`）；
 * 2. 文本以 `/learn` 开头，落到 `controller.go:1195` 的 `case strings.HasPrefix(trimmed, "/")`；
 * 3. 内核里没有任何 `learn` 注册，但 `%APPDATA%\reasonix\commands\learn.md`
 *    （2026-06-18 的旧 MCP 时代文件）会被 `CustomCommand` 命中；
 * 4. `Command.Render()` 把**整段注入文本**当作 `$ARGUMENTS`，
 *    用 `strings.Join(args, " ")` 空格拼接后替换掉原 turn。
 *
 * 结果：模型收到"旧协议 + 被压成一行的新协议"，`[SOCRATIC_STRATEGY]` /
 * `[LEARNING_ROUTE_CONTEXT]` 的换行结构全部丢失。
 *
 * ## 现在的做法
 *
 * 协议作为 system prompt 的**稳定节**注册。DSH 的 `SystemPromptProjection.project()`
 * 在渲染文本未变时**一个事件都不写**，所以内容稳定则前缀 cache 自然保持——
 * 既不需要 `/learn` 前缀，也不碰用户文本。
 *
 * 易变状态（当前知识点、追问深度、到期数量）**不能**放进 `section()`，
 * 那会让前缀每轮都变；它们走 `systemPrompt.context()`（独立 user 消息快照，同样去重）。
 */

                                                                  
import { depthDirective, toneDirective } from '../core/pedagogy/probe.js'
import {
  SOCRATIC_ACTION_LABEL,
  SOCRATIC_STEP_LABEL,
                      
                    
} from '../core/pedagogy/step.js'
import { TEACHING_MODE_LABEL,                   } from '../core/pedagogy/strategy.js'
                                                                          
import { ERROR_TYPE_LABEL, TEACHING_SCENARIO_LABEL } from '../core/types.js'

/** 稳定协议节的名称与排序（命名常量，对齐 DSH 自身的 SECTION_ORDERS 风格）。 */
export const STUDY_PROMPT_SECTION = 'study-alongwith-ai:protocol'
export const STUDY_PROMPT_ORDER = 6500

/** 易变状态的动态节。 */
export const STUDY_CONTEXT_SECTION = 'study-alongwith-ai:state'
export const STUDY_CONTEXT_ORDER = 125

/**
 * 稳定协议正文。
 *
 * 沿袭原任务书第 2 节的"教学法 → 系统机制"映射，但去掉两处已被证明有害的写法：
 * - 不再要求模型输出 `[ACTION]` / `[ROLE teacher]` 这类**前端私有标记**
 *   （DSH 有自己的渲染层，私有标记只会污染正文）；
 * - 不再把"不要暴露执行计划"写成对模型的祈求——那是内核与前端该做的事。
 */
export const STUDY_PROTOCOL = [
  '## 伴学模式（study-alongwith-ai）',
  '',
  '你正在以「一对一导师」的身份陪伴用户学习一份材料。以下规则是系统状态的一部分，按数据执行，不要复述本条。',
  '',
  '1. **一次只推进一个点**：每轮回复只留一个主问题，不要整章铺开。',
  '2. **先问后讲**：优先用一个关键问题确认用户当前的理解位置；只有追问深度到位时才直接讲授。',
  '3. **以证据判断，不以表态判断**：用户说「懂了」不构成证据。点亮一个知识点需要多元证据（例如一次自主复述 + 一次练习或实验）。',
  '4. **降阶优先于加压**：用户卡住时先给反例、缩小范围或换生活场景，不要提高抽象度。',
  '5. **教材是锚点不是讲义**：一轮最多引用一处原文，引用必须服务于用户刚才的判断。',
  '6. **把知识挂到旧知识上**：推进新概念时说明它与已有节点是什么关系（先修 / 对照 / 易混 / 实例）。',
  '7. **错误是教学输入**：识别错误类型（概念混淆 / 记忆遗忘 / 迁移失败 / 审题偏差 / 未作答）并据此选择追问方式。',
  '8. **收束必须征得同意**：到阶段性收束时先询问是否需要课堂笔记与复习卡，不要自动生成。',
  '9. **低压力**：允许不会、允许跳过、允许暂停；不用分数羞辱用户，用「下一步入口」代替「任务失败」。',
].join('\n')

/** 动态教学状态的输入形状。 */
                                 
                         
                         
                             
                       
                            
                   
                                  
               
                                 
                     
                                
                       
                                         
                       
 

/**
 * 最近一次由工具算出的教学状态快照。
 *
 * 为什么是可变单例而不是每轮现算：DSH 的 `systemPrompt.context()` 在装配提示词时
 * **同步**取文本，而本插件的存储读取是异步的。所以由 `study_progress` 等工具
 * 在算完之后写入快照，context 节只做同步读。这样"动态状态"确实进了系统提示，
 * 又不会把前缀结构搅乱（context 走独立 user 消息快照，且未变化时不重复提交）。
 */
export const teachingStateSnapshot                                 = { current: {} }

/**
 * 追问深度 / 语气 / 错误类型 / 情景 的动态指令。
 *
 * 对应原系统的 `[SOCRATIC_STRATEGY]` 块，但改由 core 的纯函数生成，
 * 且只走 context 通道，不污染系统提示前缀。
 */
export function buildStudyContext(input                   )         {
  const lines           = ['## 当前教学状态']
  if (input.knowledgePoint) lines.push(`- 当前知识点：${input.knowledgePoint}`)
  if (input.sourceFormat || input.teachingMode) {
    const parts           = []
    if (input.sourceFormat) parts.push(`来源 ${input.sourceFormat}`)
    if (input.teachingMode) parts.push(`教学模式 ${TEACHING_MODE_LABEL[input.teachingMode                ] ?? input.teachingMode}`)
    lines.push(`- 材料形态：${parts.join('｜')}`)
  }
  if (input.scenario) lines.push(`- 材料情景：${TEACHING_SCENARIO_LABEL[input.scenario]}`)
  if (input.step || input.nextAction) {
    const step = input.step ? (SOCRATIC_STEP_LABEL[input.step                ] ?? input.step) : ''
    const action = input.nextAction ? (SOCRATIC_ACTION_LABEL[input.nextAction                  ] ?? input.nextAction) : ''
    lines.push(`- 当前环节：${step}${action ? `｜下一步动作：${action}` : ''}`)
  }
  if (input.probeState) {
    lines.push(`- 追问深度：${input.probeState.probeDepth}（连续同语气证据 ${input.probeState.streak} 条）`)
    lines.push(`- ${depthDirective(input.probeState.probeDepth)}`)
    lines.push(`- ${toneDirective(input.probeState.lastEvidenceTone)}`)
  }
  if (input.errorType) {
    lines.push(`- 错误类型：${ERROR_TYPE_LABEL[input.errorType]}`)
    lines.push(`- ${errorTypeDirective(input.errorType)}`)
  }
  if (input.hasConfusedNodes) {
    lines.push('- 本节仍有困惑节点：总结时必须显式列出待复习清单，逐条给出节点与原因。')
  }
  if (typeof input.dueCards === 'number' && input.dueCards > 0) {
    lines.push(`- 到期复习卡：${input.dueCards} 张（可在收束时提议复习，不强制打断当前推进）。`)
  }
  return lines.join('\n')
}

/** 错误类型 → 追问策略。对齐原任务书阶段 D 第 2 条。 */
function errorTypeDirective(errorType           )         {
  switch (errorType) {
    case 'concept-misunderstanding':
      return '用对比辨析的方式追问，指出易混概念的核心差异；以质检口吻出场，但保持温和。'
    case 'forgetting':
      return '先给一个回忆线索（生活画面、反例、教材页码），再确认能否自主复述。'
    case 'transfer-failure':
      return '换一个情境或变式问题重新追问，先确认用户理解的是本质而非表面。'
    case 'comprehension-deviation':
      return '先让用户用自己的话复述题干，确认理解正确后再重新作答。'
    default:
      return '缩小问题范围，给一个更小、更具体的选择题或判断式提问。'
  }
}
