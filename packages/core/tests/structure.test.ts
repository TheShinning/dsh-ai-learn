import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PAGE_TARGET_CHARS,
  buildStructureGraph,
  describeStructure,
  splitTextbookStructure,
} from '../src/textbook/structure.ts'
import { textbookKey } from '../src/textbook/identity.ts'

const KEY = textbookKey({ title: '矛盾论', sourceRef: 'book/017-矛盾论.md' })

const SAMPLE = `# 矛盾论

## 第一节 两种宇宙观

事物的矛盾法则，即对立统一的法则。

这是唯物辩证法的最根本的法则。

## 第二节 矛盾的普遍性

矛盾存在于一切事物的发展过程中。

### 一、矛盾的普遍性

矛盾无处不在。

## 第三节 矛盾的特殊性

各种物质运动形式中的矛盾都带有特殊性。
`

test('章 / 节分层：level ≤2 开章，level ≥3 开节', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  assert.equal(structure.chapterCount, 3, '三个 ## 各成一章')
  assert.equal(structure.sectionCount, 4, '第三节里多一个 ### 小节')
  assert.deepEqual(
    structure.chapters.map((chapter) => chapter.title),
    ['第一节 两种宇宙观', '第二节 矛盾的普遍性', '第三节 矛盾的特殊性'],
  )
  const second = structure.chapters[1]!
  assert.deepEqual(
    second.sections.map((section) => section.title),
    ['本章导语', '一、矛盾的普遍性'],
    '章下既有导语又有 ### 小节时：导语自成一节，其余用 ### 标题',
  )
})

test('顶部的一级标题自成章，且空行 flush 段落', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  assert.ok(
    !structure.chapters.some((chapter) => chapter.title === '矛盾论'),
    '`# 矛盾论` 下面没有正文，整章被剔除（不产生空章）',
  )
  assert.equal(structure.chapters[0]!.title, '第一节 两种宇宙观', '第一张有正文的章成为首章')
  const first = structure.chapters[0]!
  assert.equal(first.sections[0]!.title, '第一节 两种宇宙观', '隐式小节沿用章标题')
  const paragraphs = first.sections[0]!.pages.flatMap((page) => page.paragraphs)
  assert.equal(paragraphs.length, 2, '两段被空行分开')
  assert.equal(paragraphs[0]!.text, '事物的矛盾法则，即对立统一的法则。')
})

test('回归：代码围栏里的 # 不被当成标题', () => {
  const markdown = [
    '# 教程',
    '',
    '## 第一节',
    '',
    '```python',
    '# 这是注释，不是标题',
    'print("hello")',
    '```',
    '',
    '正文结束。',
  ].join('\n')
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown })
  assert.equal(structure.chapterCount, 1, '`# 教程` 无正文被剔除，只剩 `## 第一节` 一章')
  const chapter = structure.chapters[0]!
  assert.equal(chapter.title, '第一节')
  const section = chapter.sections[0]!
  const text = section.pages.flatMap((page) => page.paragraphs).map((p) => p.text).join('\n')
  assert.match(text, /这是注释，不是标题/, '围栏内容被保留为正文')
  assert.ok(!section.title.includes('注释'), '围栏里的 # 没有变成节标题')
})

test('标题前就有正文时，起兜底章与兜底节', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: '开场白。\n\n# 第一章\n\n正文。' })
  assert.equal(structure.chapters[0]!.title, '开篇')
  assert.equal(structure.chapters[0]!.sections[0]!.title, '开篇', '隐式小节沿用兜底章标题')
})

test('空标题有兜底名，且不产生空章空节', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: '#\n\n##\n\n有正文。' })
  const withBody = structure.chapters.filter((chapter) => chapter.sections.length > 0)
  assert.equal(withBody.length, 1)
  assert.ok(withBody[0]!.title.length > 0)
})

test('回归：全空正文返回空结构，而不是伪造兜底内容（原文会假装导入成功）', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: '   \n\n\t\n' })
  assert.equal(structure.chapterCount, 0)
  assert.equal(structure.sectionCount, 0)
  assert.equal(structure.pageCount, 0)
  assert.match(describeStructure(structure), /结构为空/)
})

test('分页：按约 1600 字符切，锚点 P<n> 全篇连续，段落不被切断', () => {
  const paragraph = '甲'.repeat(600)
  const markdown = `# 书\n\n## 节\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n`
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown })
  const pages = structure.chapters[0]!.sections[0]!.pages
  assert.equal(DEFAULT_PAGE_TARGET_CHARS, 1600)
  assert.equal(pages.length, 2, '600+600 = 1200 同页；再加 600 会到 1800 故换页')
  assert.deepEqual(pages.map((page) => page.number), [1, 2])
  assert.deepEqual(pages.map((page) => page.anchor), ['P1', 'P2'])
  assert.equal(pages[0]!.paragraphs.length, 2, '同页装得下两段')
  assert.equal(pages[1]!.paragraphs.length, 1)
  assert.equal(pages[0]!.paragraphs[0]!.text.length, 600, '段落未被切断')
})

test('分页：单段超过目标字数时独占一页，绝不切断段落', () => {
  const huge = '乙'.repeat(2500)
  const markdown = `# 书\n\n## 节\n\n${huge}\n\n短段。\n`
  const pages = splitTextbookStructure({ textbookKey: KEY, markdown }).chapters[0]!.sections[0]!.pages
  assert.equal(pages.length, 2)
  assert.equal(pages[0]!.paragraphs[0]!.text.length, 2500, '超长段落完整保留在一页里')
  assert.equal(pages[1]!.paragraphs[0]!.text, '短段。')
})

test('跨节页号连续，段落锚点跟随所在页', () => {
  const markdown = `# 书\n\n## A\n\n${'甲'.repeat(2000)}\n\n## B\n\n乙\n`
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown })
  // 注意：`##` 开的是**章**，所以 A 与 B 是两个章，各自带一个节
  assert.equal(structure.chapterCount, 2)
  const a = structure.chapters[0]!.sections[0]!
  const b = structure.chapters[1]!.sections[0]!
  assert.equal(a.pages[0]!.anchor, 'P1')
  assert.equal(b.pages[0]!.anchor, 'P2', '页号跨章连续，不从 1 重新开始')
  assert.equal(b.pages[0]!.paragraphs[0]!.anchor, 'P2')
})

test('节点 id 由稳定教材 key 派生（改正文不变）', () => {
  const revised = SAMPLE.replace('最根本', '最根本（修订）')
  const before = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  const after = splitTextbookStructure({ textbookKey: KEY, markdown: revised })
  const ids = (s: typeof before) => s.chapters.flatMap((c) => c.sections.map((sec) => sec.id))
  assert.deepEqual(ids(before), ids(after), '原地改字不改变小节 id，因此证据不会失联')
  assert.match(before.chapters[1]!.sections[0]!.id, /#ch002-sec001$/)
})

test('派生图谱：层级 contains 边齐全', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  const { nodes, edges } = buildStructureGraph({ textbookKey: KEY, title: '矛盾论', structure })

  const bookId = `${KEY}#book`
  assert.equal(nodes.filter((node) => node.type === 'textbook').length, 1, '只有一本教材节点')
  assert.equal(nodes.filter((node) => node.type === 'chapter').length, 3)
  assert.equal(nodes.filter((node) => node.type === 'section').length, 4)

  const contains = edges.filter((edge) => edge.relation === 'contains')
  // 每章 1 条来自教材 + 每节 1 条来自章 + 每页 1 条来自节
  const pageCount = nodes.filter((node) => node.type === 'page').length
  assert.equal(contains.length, 3 + 4 + pageCount)
  assert.ok(contains.some((edge) => edge.from === bookId && edge.to === `${KEY}#ch001`))
  assert.ok(contains.every((edge) => nodes.some((node) => node.id === edge.from)))
  assert.ok(contains.every((edge) => nodes.some((node) => node.id === edge.to)), '没有指向不存在节点的边')
})

test('派生图谱：先修边只在章内相邻小节之间，不跨章', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  const { edges } = buildStructureGraph({ textbookKey: KEY, title: '矛盾论', structure })
  const prerequisites = edges.filter((edge) => edge.relation === 'prerequisite')

  // 章内小节数分别是 1 / 2 / 1 → 先修边只在第二章内部产生 1 条
  assert.equal(prerequisites.length, 1)
  const edge = prerequisites[0]!
  assert.equal(edge.confidence, 0.8)
  assert.ok(edge.from.startsWith(`${KEY}#ch002-sec001`), `先修边应在同一章内，实际 ${edge.from}`)
  assert.ok(edge.to.startsWith(`${KEY}#ch002-sec002`))
  assert.ok(!prerequisites.some((item) => item.from.includes('#ch001') && item.to.includes('#ch002')), '不存在跨章先修边')
})

test('结构摘要可读', () => {
  const structure = splitTextbookStructure({ textbookKey: KEY, markdown: SAMPLE })
  assert.match(describeStructure(structure), /^\d+ 章 \/ \d+ 节 \/ \d+ 页 \/ \d+ 段$/)
})
