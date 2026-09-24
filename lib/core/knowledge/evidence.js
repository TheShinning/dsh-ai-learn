                                                                                           

/**
 * 掌握证据模型。
 *
 * 与原系统的对应关系：`desktop/learning_knowledge_graph.go:69-85` 的
 * `LearningMasteryEvidence`。差异在于：
 * - `bloomLevel` 是封闭联合类型，不再是自由字符串；
 * - `kind` 是封闭联合类型，拼错 kind 会在编译期失败；
 * - 幂等键的定义在 `evidenceKey()` 一处，便于"同一张卡连错两次要留两条"这类需求
 *   显式地改 `sourceId`，而不是靠猜。
 */

/** 证据种类。原系统为自由字符串，`learning_knowledge_graph.go:226-232`。 */
                          
                    
                    
                   
          
                
               
                
              
           
                     

export const EVIDENCE_KIND_LABEL                               = {
  'answer-quality': '回答质量',
  'question-asked': '导师追问',
  metacognition: '元认知反思',
  note: '笔记',
  blackboard: '小黑板',
  flashcard: '闪卡',
  'srs-review': '间隔复习',
  'code-lab': '代码实验',
  quote: '原文引用',
  'mastery-confirm': '人工确认',
}

/** 复习三档自评结果。 */
                                                 

                        
                     
                         
                             
                              
                           
                        
                          
                          
                                                                     
                          
                              
                                        
                            
                                           
                                    
                                               
                            
                                  
                                
                                
                                                
                                  
                            
 

/**
 * 证据幂等键。
 *
 * 与 `learning_knowledge_graph.go:207-216` 的语义一致：
 * `(nodeId, kind, sourceId, summary)` 相同即为同一条证据，重复提交是覆盖而非追加。
 * 不含 `detail` / `result` / `mastery` / 时间 —— 这一点必须显式记录，
 * 因为"同一张卡连续两次答错要留两条证据"必须改变 `sourceId`。
 */
export function evidenceKey(input                                                            )         {
  return [input.nodeId, input.kind, input.sourceId, input.summary].join('\u0000')
}

/**
 * 证据 id —— 由**幂等键内容**派生，而不是由它的长度。
 *
 * ## 这是一个真实 bug 的修复（2026-09-23 诊断发现）
 *
 * 原先 id 的写法是 `` `kgev-${evidenceKey(...).length.toString(16)}-${Date.now().toString(36)}` ``：
 * 用**长度**当摘要 + 毫秒时间戳。后果是同一毫秒内写入的两条证据只要幂等键长度相同，
 * id 就完全相同，于是存储层（按 id 建键）**后写覆盖先写**。
 *
 * 实测后果（`plugin-host` 诊断用例）：连续三次"答错"只留下两条证据，
 * 追问深度因此永远到不了 3，"深度 3 才直讲"这条底线在真实运行里失效。
 * 同理，复习证据（`-srs-` 前缀那条路径）在一次会话内多次复习也会互相覆盖。
 *
 * 现在改成分两步：
 * 1. `stableEvidenceDigest()` 对幂等键做 32 位 FNV-1a，得到内容摘要（同键必同摘要，便于识别重复）；
 * 2. {@link EvidenceIdAllocator} 在**同一进程内**保证序号单调递增，避免同毫秒碰撞。
 *
 * 幂等语义没有被削弱：重复提交**相同**幂等键时，调用方仍会覆盖（这正是"重复提交是覆盖而非追加"的定义）。
 * 修掉的是"**不同**键因长度相同而被误判为同一条"。
 */

/** 32 位 FNV-1a：短、稳定、无依赖，足以区分教学场景里的幂等键。 */
export function stableEvidenceDigest(input        )         {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 证据 id 分配器：同毫秒内也保证单调递增（进程内唯一）。 */
export class EvidenceIdAllocator {
          lastStamp = 0
          sequence = 0

  /**
   * @param key 幂等键（{@link evidenceKey} 的结果）。
   * @param at 生成时刻；同一毫秒内多次调用会用递增序号区分。
   */
  next(key        , at       = new Date())         {
    const stamp = at.getTime()
    if (stamp === this.lastStamp) this.sequence += 1
    else {
      this.lastStamp = stamp
      this.sequence = 0
    }
    const suffix = this.sequence === 0 ? '' : `-${this.sequence.toString(36)}`
    return `kgev-${stableEvidenceDigest(key)}-${stamp.toString(36)}${suffix}`
  }
}

/** 证据语气：把一条证据映射为教学回路使用的语气标签。 */
export function evidenceTone(evidence                      )               {
  if (!evidence) return 'unknown'
  if (evidence.mastery === 'confused' || evidence.result === 'clarify') return 'confused'
  if (evidence.mastery === 'mastered' || evidence.result === 'light') return 'mastered'
  if (evidence.mastery === 'partial' || evidence.result === 'consolidate') return 'partial'
  if (evidence.correct === true) return 'partial'
  if (evidence.correct === false) return 'confused'
  return 'unknown'
}

/** 稳定的时间序比较：先按 createdAt，再按 id，保证同毫秒写入也有确定顺序。 */
export function compareEvidence(a          , b          )         {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function orderEvidence(evidence                     )             {
  return [...evidence].sort(compareEvidence)
}

/** 取某节点下某类证据里最新的一条。 */
export function latestEvidence(
  evidence                     ,
  nodeId        ,
  kind              ,
)                       {
  let latest                      
  for (const item of evidence) {
    if (item.nodeId !== nodeId || item.kind !== kind) continue
    if (!latest || compareEvidence(latest, item) < 0) latest = item
  }
  return latest
}
