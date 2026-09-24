import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyMaterial,
  decodeSourceFormat,
  encodeSourceFormat,
  isMaterialType,
  renderClassification,
  shouldAskUser,
} from '../src/pedagogy/material.ts'

const REGULATION = [
  '# 建设工程质量管理条例',
  '',
  '第一条 为了加强对建设工程质量的管理，制定本条例。',
  '',
  '第二条 凡在中华人民共和国境内从事建设工程的新建、扩建、改建等有关活动，应当遵守本条例。',
  '',
  '第三条 建设单位应当将工程发包给具有相应资质等级的单位。',
  '',
  '第五条 违反本条例规定，建设单位将工程发包给不具有相应资质等级的单位的，责令改正。',
  '',
  '第六十条 本条例自公布之日起施行。',
].join('\n')

const EXAM = [
  '# 2025 年模拟试题',
  '',
  '一、单项选择题',
  '',
  '1. 关于实践与认识的关系，下列说法正确的是（ ）',
  '',
  'A. 认识决定实践  B. 实践是认识的来源  C. 二者互不相干  D. 认识先于实践',
  '',
  '【答案】B',
  '',
  '二、简答题',
  '',
  '2. 简述实践对认识的决定作用。',
].join('\n')

const ANALYSIS = [
  '# 答案解析',
  '',
  '解析：本题考查实践与认识的关系。',
  '',
  '本题考点：实践是认识的来源。',
  '',
  '解题思路：第一步先判断选项表述是否绝对化，第二步排除互不相干的选项。',
  '',
  '错误选项：A 项混淆了决定关系，属于干扰项。',
  '',
  '综上，故选 B。',
].join('\n')

const TEXTBOOK = [
  '# 马克思主义基本原理',
  '',
  '## 第一章 世界的物质性',
  '',
  '### 第一节 物质及其存在方式',
  '',
  '本章讨论物质概念的定义与基本属性。物质是不依赖于人的意识而存在的客观实在。',
  '',
  '小结：本节给出了物质的定义。思考题：如何理解物质的唯一特性？',
].join('\n')

const ARTICLE = [
  '# 数字化学习的实证研究',
  '',
  '摘要：本文基于 300 份样本，研究数字化学习的效果。',
  '',
  '关键词：数字化学习；学习效果',
  '',
  '本文认为，学习效果与反馈频率显著相关。我们认为这一结论对教学实践有直接意义。',
  '',
  '研究采用访谈与问卷两种方法。数据显示，反馈频率每提升一档，成绩提升约 5%。',
  '',
  '参考文献：[1] 张三. 数字化学习研究[J]. 教育研究, 2024(3).',
].join('\n')

const LECTURE = [
  '# 第 3 讲 课堂笔记',
  '',
  '本次课我们讲三个要点。',
  '',
  '- 要点一：物质概念',
  '- 要点二：运动与静止',
  '- 要点三：时空观',
  '',
  '重点：运动是物质的根本属性。注意：不要把静止理解为绝对不动。',
  '',
  '课堂小结：本次课的主线是"物质在运动"。',
].join('\n')

test('显式指定具有最高优先级，且不再猜测', () => {
  const result = classifyMaterial({ markdown: EXAM, explicit: 'regulation' })
  assert.equal(result.type, 'regulation')
  assert.equal(result.confidence, 'explicit')
  assert.equal(shouldAskUser(result), false)
  assert.match(result.why, /用户明确指定/)
})

test('条例：条/款特征明显 → regulation + strong', () => {
  const result = classifyMaterial({ title: '建设工程质量管理条例', markdown: REGULATION })
  assert.equal(result.type, 'regulation')
  assert.equal(result.confidence, 'strong')
  assert.equal(shouldAskUser(result), false)
  assert.match(result.why, /条例/)
})

test('刷题材料：题干与选项结构 → exam + strong', () => {
  const result = classifyMaterial({ sourceRef: '2025模拟题.md', markdown: EXAM })
  assert.equal(result.type, 'exam')
  assert.equal(result.confidence, 'strong')
})

test('答案解析：解析/考点/故选 → answer-analysis + strong', () => {
  const result = classifyMaterial({ title: '答案解析', markdown: ANALYSIS })
  assert.equal(result.type, 'answer-analysis')
  assert.equal(result.confidence, 'strong')
})

test('教材：章/节结构 + 小结思考题 → textbook + strong', () => {
  const result = classifyMaterial({ markdown: TEXTBOOK })
  assert.equal(result.type, 'textbook')
  assert.equal(result.confidence, 'strong')
})

test('文章：摘要/关键词/参考文献 → article + strong', () => {
  const result = classifyMaterial({ markdown: ARTICLE })
  assert.equal(result.type, 'article')
  assert.equal(result.confidence, 'strong')
})

test('讲义：本次课/要点列表/课堂小结 → lecture-notes + strong', () => {
  const result = classifyMaterial({ markdown: LECTURE })
  assert.equal(result.type, 'lecture-notes')
  assert.equal(result.confidence, 'strong')
})

test('回归：没有任何特征时不硬猜 —— 兜底 textbook + unknown，并要求问用户', () => {
  const result = classifyMaterial({ markdown: '今天天气不错，随便记两句话。' })
  assert.equal(result.confidence, 'unknown')
  assert.equal(result.type, 'textbook', '兜底按教材处理，但置信度必须是 unknown')
  assert.equal(shouldAskUser(result), true)
  assert.match(result.why, /确认/)
})

test('回归：短文本不会被弱特征判成"明显"（避免粘贴一句话就当成条例）', () => {
  const short = classifyMaterial({ markdown: '第三条 应当遵守本条例。' })
  assert.ok(short.confidence === 'weak' || short.confidence === 'unknown')
  assert.equal(shouldAskUser(short), true, '短文本必须回落为"问用户"')
})

test('标题关键词权重更高：文件名含"真题"即可判 strong', () => {
  const result = classifyMaterial({ sourceRef: 'D:/materials/真题汇编.md', markdown: '一些题目文本，没有别的特征。' })
  assert.equal(result.type, 'exam')
  assert.equal(result.confidence, 'strong')
})

test('类型守卫与渲染', () => {
  assert.equal(isMaterialType('exam'), true)
  assert.equal(isMaterialType('pptx'), false)
  const line = renderClassification(classifyMaterial({ title: '条例', markdown: REGULATION }))
  assert.match(line, /材料类型：法条\/规范|材料类型：条例/)
  assert.match(line, /特征明显/)
})

test('复合 sourceFormat：编码后能解回，旧值（无 |）仍可读', () => {
  const encoded = encodeSourceFormat('pdf', 'regulation', 'strong')
  assert.equal(encoded, 'pdf|regulation|strong')
  assert.deepEqual(decodeSourceFormat(encoded), { format: 'pdf', materialType: 'regulation', confidence: 'strong' })

  // 旧数据形态：只有格式
  assert.deepEqual(decodeSourceFormat('markdown'), { format: 'markdown', materialType: undefined, confidence: undefined })
  assert.deepEqual(decodeSourceFormat(undefined), {})

  // 脏值不穿透
  const dirty = decodeSourceFormat('pdf|pptx|sure')
  assert.equal(dirty.format, 'pdf')
  assert.equal(dirty.materialType, undefined)
  assert.equal(dirty.confidence, undefined)
})
