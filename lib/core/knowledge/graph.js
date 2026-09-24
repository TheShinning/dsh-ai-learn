/**
 * 知识图谱：结构、路线推荐、结构重建。
 *
 * 三处对原系统的修复：
 *
 * 1. **节点级 bloomLevel 可被赋值**。原系统
 *    `desktop/learning_knowledge_graph.go:41` 声明了 `BloomLevel` 字段，
 *    但全仓 Go 代码**从未给它赋过值**（只有证据级 `:731` 会写），
 *    于是它永远是空串 + omitempty。这里把它作为 node 的一等字段，
 *    并提供 `nodeBloomLevel()` 从证据聚合出可靠值。
 *
 * 2. **路线打分只有一份实现**。原系统有两份：
 *    `learning.routeContext.ts:40-71`（含先修 −50 门控）
 *    与 `LearningKnowledgeGraphWindow.tsx:193-200` 的 `routeScore`（**缺**先修门控），
 *    两处会给出不同的"下一处推荐"。这里只保留 {@link routeScore}。
 *
 * 3. **结构重建保留学习状态**。原系统
 *    `LearningRebuildKnowledgeGraphFromTextbooks`（`:960-982`）从
 *    `emptyLearningKnowledgeGraph()` 重建，**证据、掌握度、手工语义边、宫殿坐标全部丢失**，
 *    而任务书阶段 F 第 2 条明确要求"先确认全量重建不清空手工摆位"。
 *    这里 `rebuildStructure()` 只重建结构节点与 contains/prerequisite 边，
 *    用户状态按 key 原样带过去。
 */

                                          
import { MASTERY_RANK } from '../types.js'
                                             
import { masteryFromEvidence } from './mastery.js'

/** 节点类型。原系统只有 textbook/chapter/section/page 四种，且**没有建节点 API**。 */
                                                                              

/** 边关系。原系统 `learning_knowledge_graph.go:591-598,832-834`。 */
                                                                                                     

export const EDGE_RELATION_LABEL                               = {
  contains: '包含',
  prerequisite: '先修',
  contrasts: '对照',
  'confused-with': '易混',
  'example-of': '实例',
}

                             
                     
                         
                        
                               
                             
                             
                          
                         
                          
 

                             
                     
                       
                     
                                 
                             
 

                              
                                          
                                          
                                        
 

/** 节点 → 掌握度缓存。由证据重算，不是独立真相源。 */
                                                            

export function buildMasteryIndex(graph                , nodeIds                    )               {
  const byNode = new Map                    ()
  for (const item of graph.evidence) {
    const list = byNode.get(item.nodeId)
    if (list) list.push(item)
    else byNode.set(item.nodeId, [item])
  }
  const index                          = {}
  const targets = nodeIds ?? graph.nodes.map((node) => node.id)
  for (const id of targets) {
    index[id] = masteryFromEvidence(byNode.get(id) ?? [])
  }
  return index
}

/**
 * 节点布鲁姆层级 = 其证据里出现过的**最高**层级。
 *
 * 这解决"节点级 bloomLevel 永远是空"的问题，且不需要新的写入路径：
 * 层级信息本来就随证据进来。
 */
export function nodeBloomLevel(graph                , nodeId        )                     {
  const order = ['remember', 'understand', 'apply', 'analyze', 'evaluate', 'create']
  let best                    
  for (const item of graph.evidence) {
    if (item.nodeId !== nodeId || !item.bloomLevel) continue
    if (!best || order.indexOf(item.bloomLevel) > order.indexOf(best)) best = item.bloomLevel
  }
  return best
}

                         
                              
                           
                                
                        
                         
                              
                                                     
 

/** 先修未点亮时的固定降权分值。原系统 `learning.routeContext.ts:53`。 */
export const PREREQUISITE_PENALTY = 50

/**
 * 单站打分 —— 全系统唯一实现。
 *
 * 基线分值对齐原系统：confused 100 / unknown+有证据 80 / unknown 62 /
 * partial 42 / mastered 8；先修未点亮统一 −50（多源只扣一次）。
 */
export function routeScore(input   
                     
                  
                       
                                                                     
 )            {
  const unresolved = input.prerequisites.filter((item) => item.mastery !== 'mastered')
  const penalty = unresolved.length > 0 ? PREREQUISITE_PENALTY : 0
  const penaltyNote = penalty > 0 ? '（先修未点亮，已降权）' : ''

  let base        
  let reason        
  switch (input.mastery) {
    case 'confused':
      base = 100 + input.evidenceCount
      reason = '困惑点优先澄清'
      break
    case 'unknown':
      base = input.evidenceCount > 0 ? 80 + input.evidenceCount : 62
      reason = input.evidenceCount > 0 ? '已有证据但尚未点亮' : '尚未点亮'
      break
    case 'partial':
      base = 42 + input.evidenceCount
      reason = '半掌握，需要巩固迁移'
      break
    default:
      // 已掌握：不再降权（原系统 `:70` 这一支故意不扣先修罚分，此处保持一致）
      return {
        node: input.node,
        mastery: input.mastery,
        evidenceCount: input.evidenceCount,
        score: 8 + input.evidenceCount,
        reason: '已掌握，仅低频复盘',
        unresolvedPrerequisites: [],
      }
  }

  return {
    node: input.node,
    mastery: input.mastery,
    evidenceCount: input.evidenceCount,
    score: base - penalty,
    reason: `${reason}${penaltyNote}`,
    unresolvedPrerequisites: unresolved.map((item) => item.node.title),
  }
}

/** 排序键：章节序 → 节序 → 页序 → 标题 → id，保证同分时顺序确定。 */
function nodeSortKey(node               )         {
  const typeRank = node.type === 'chapter' ? '1' : node.type === 'section' ? '2' : node.type === 'page' ? '3' : '4'
  return [typeRank, node.chapterId ?? '', node.sectionId ?? '', node.pageId ?? '', node.title, node.id].join('/')
}

/** 容器型节点：可以用来组织层级，但不是可推进的"学习单元"。 */
const CONTAINER_NODE_TYPES                        = new Set          (['textbook', 'chapter'])

/**
 * 路线推荐：按分数降序，同分按教材顺序，取前 `limit` 站。
 *
 * **只推荐可学习单元**：默认排除 `textbook` / `chapter` 这类容器节点。
 * 原系统只排除了 `textbook`（`learning.routeContext.ts:91`），于是"第一章"
 * 会作为候选与自己的小节竞争——把章节标题推给学生是不可执行的建议。
 *
 * @param graph 教材范围内的图谱。
 * @param masteryIndex {@link buildMasteryIndex} 的结果。
 * @param options `limit` 默认 6（与原系统一致）；`includeContainers` 打开后可看到层级节点。
 */
export function buildRouteStops(
  graph                ,
  masteryIndex              ,
  options                                                                        = {},
)              {
  const nodes = graph.nodes.filter((node) => {
    if (options.textbookKey !== undefined && node.textbookKey !== options.textbookKey) return false
    if (options.includeContainers) return true
    return !CONTAINER_NODE_TYPES.has(node.type)
  })
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const evidenceCount = new Map                ()
  for (const item of graph.evidence) {
    evidenceCount.set(item.nodeId, (evidenceCount.get(item.nodeId) ?? 0) + 1)
  }

  const stops = nodes.map((node) => {
    const prerequisites = graph.edges
      .filter((edge) => edge.to === node.id && edge.relation === 'prerequisite')
      .map((edge) => byId.get(edge.from))
      .filter((candidate)                             => candidate !== undefined)
      .map((candidate) => ({ node: candidate, mastery: masteryIndex[candidate.id] ?? 'unknown' }))
    return routeScore({
      node,
      mastery: masteryIndex[node.id] ?? 'unknown',
      evidenceCount: evidenceCount.get(node.id) ?? 0,
      prerequisites,
    })
  })

  return stops
    .sort((a, b) => b.score - a.score || nodeSortKey(a.node).localeCompare(nodeSortKey(b.node)))
    .slice(0, options.limit ?? 6)
}

/**
 * 重建结构：只重建节点与结构边，**学习状态原样保留**。
 *
 * @param structure 本次重建出的结构节点（来自教材解析）。
 * @param existing 既有图谱（提供要保留的证据与手工边）。
 */
export function rebuildStructure(structure   
                                 
                                 
 , existing                )                 {
  // 证据全部保留：掌握度是证据的纯函数，所以掌握度自动跟着保留
  const preservedEvidence = existing.evidence.filter((item) =>
    structure.nodes.some((node) => node.id === item.nodeId),
  )
  // 手工语义边保留（contains/prerequisite 由结构重建产生，其余是用户/模型添加的）
  const manualEdges = existing.edges.filter(
    (edge) => edge.relation !== 'contains' && edge.relation !== 'prerequisite',
  )
  const structureNodeIds = new Set(structure.nodes.map((node) => node.id))
  const survivorEdges = manualEdges.filter(
    (edge) => structureNodeIds.has(edge.from) && structureNodeIds.has(edge.to),
  )
  return {
    nodes: structure.nodes,
    edges: [...structure.edges, ...survivorEdges],
    evidence: preservedEvidence,
  }
}

/** 掌握度统计（去 textbook 节点，`active = mastered + partial`）。 */
export function masteryStats(graph                , masteryIndex              )   
               
                  
                 
                  
                 
                
  {
  let mastered = 0
  let partial = 0
  let confused = 0
  let unknown = 0
  for (const node of graph.nodes) {
    if (node.type === 'textbook') continue
    const mastery = masteryIndex[node.id] ?? 'unknown'
    if (mastery === 'mastered') mastered += 1
    else if (mastery === 'partial') partial += 1
    else if (mastery === 'confused') confused += 1
    else unknown += 1
  }
  const total = mastered + partial + confused + unknown
  return { total, mastered, partial, confused, unknown, active: mastered + partial }
}

/** 判断某节点是否先修已就绪（可用于硬门控，而不仅是降权）。 */
export function prerequisitesReady(graph                , masteryIndex              , nodeId        )          {
  return graph.edges
    .filter((edge) => edge.to === nodeId && edge.relation === 'prerequisite')
    .every((edge) => MASTERY_RANK[masteryIndex[edge.from] ?? 'unknown'] >= MASTERY_RANK.mastered)
}
