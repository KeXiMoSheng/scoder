import { useState } from 'react'
import { Check, MessageCircleQuestion } from 'lucide-react'
import type { AiQuestion, AiQuestionAnswer, AiQuestionOption } from '@shared/ai/types'
import { cn } from '../../lib/utils'
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious
} from '../ui/pagination'
import type { AiQuestionCardProps } from './types'

/** 一个问题的作答草稿：勾选的选项标签与自由输入 */
interface QuestionDraft {
  selected: string[]
  custom: string
}

/** 主按钮：与 MessageDialog 的确认按钮同一套主题样式 */
const PRIMARY_CLASS =
  'ml-auto shrink-0 cursor-pointer rounded-[3px] border border-accent-hover bg-accent-hover px-3 py-1 font-[inherit] text-[12px] text-[#fff] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-40'

/** 「推荐」后缀：模型按约定写在选项标签末尾，展示时拆成徽标，回答值仍保留原文 */
const RECOMMENDED_SUFFIX = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i

/**
 * 询问卡片：模型调用 ask_user_question 后，用这张卡把问题、选项与自由输入摆出来，
 * 用户提交后主进程才让工具返回，本轮对话继续。
 *
 * 卡片只消费工具消息里的卡片数据（questions / answers），
 * 因此实时事件与历史重放显示完全一致；未收到结果、且本轮仍在执行时才可以作答。
 * 分页切换不受作答状态限制：等待回答、本轮已停止或已经作答时都能逐题翻看。
 */
export default function AiQuestionCard({
  message,
  active,
  onAnswer
}: AiQuestionCardProps): React.JSX.Element | null {
  const card = message.card?.kind === 'question' ? message.card : undefined
  const questions = card?.questions ?? []
  const answers = card?.answers
  const [drafts, setDrafts] = useState<QuestionDraft[]>(() =>
    questions.map(() => ({ selected: [], custom: '' }))
  )
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (questions.length === 0) {
    return null
  }

  // 一次只展示一题：问题多时用分页切换，不把整组问题平铺出来
  const index = Math.min(current, questions.length - 1)
  const question = questions[index]
  const settled = answers !== undefined && answers.length === questions.length
  const waiting = !settled && message.status === 'running'
  const interactive = waiting && active && !busy
  const complete = drafts.every((draft) => answeredDraft(draft))
  const answeredCount = drafts.filter((draft) => answeredDraft(draft)).length

  const updateDraft = (index: number, update: (draft: QuestionDraft) => QuestionDraft): void => {
    setDrafts((previous) =>
      previous.map((draft, draftIndex) => (draftIndex === index ? update(draft) : draft))
    )
    setError(null)
  }

  const choose = (index: number, question: AiQuestion, label: string): void => {
    updateDraft(index, (draft) => {
      if (question.multiSelect === true) {
        return {
          ...draft,
          selected: draft.selected.includes(label)
            ? draft.selected.filter((item) => item !== label)
            : [...draft.selected, label]
        }
      }
      return { selected: [label], custom: '' }
    })
    // 单选选完直接翻到下一题，多选留在本页继续勾
    if (question.multiSelect !== true && index < questions.length - 1) {
      setCurrent(index + 1)
    }
  }

  const typeCustom = (index: number, question: AiQuestion, value: string): void => {
    updateDraft(index, (draft) => ({
      // 单选下自由输入即答案：已选中的选项让位，避免提交出两个互相矛盾的答案
      selected: question.multiSelect === true ? draft.selected : [],
      custom: value
    }))
  }

  const submit = (): void => {
    if (!interactive || !complete) {
      return
    }
    setBusy(true)
    setError(null)
    onAnswer(buildAnswers(questions, drafts)).catch((cause: unknown) => {
      setBusy(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
  }

  return (
    <div
      className="mb-3 overflow-hidden rounded-md border border-line bg-elevated"
      data-question-state={settled ? 'answered' : waiting ? 'waiting' : 'closed'}
    >
      <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-1.5 text-[12px] text-dim">
        <MessageCircleQuestion className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{settled ? '你的回答' : 'AI 需要你的确认'}</span>
        {questions.length > 1 ? (
          <span className="shrink-0 font-mono text-[10px] text-dim/80">
            {index + 1}/{questions.length}
          </span>
        ) : null}
        <span className={cn('shrink-0 text-[11px]', !settled && !waiting && 'text-dim/80')}>
          {settled
            ? '已回答'
            : waiting
              ? active
                ? '等待你的回复'
                : '本轮已结束'
              : message.status === 'stopped'
                ? '已停止，未回答'
                : '未回答'}
        </span>
      </div>
      <div className="px-2.5 py-2">
        {settled ? (
          <AnswerBlock question={question} answer={answers[index]} />
        ) : (
          <QuestionBlock
            key={question.id}
            question={question}
            draft={drafts[index] ?? { selected: [], custom: '' }}
            interactive={interactive}
            onChoose={(label) => choose(index, question, label)}
            onTypeCustom={(value) => typeCustom(index, question, value)}
          />
        )}
      </div>
      <div className="border-t border-line px-2.5 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {questions.length > 1 ? (
            <Pagination className="mx-0 w-auto justify-start" aria-label="问题分页">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    text="上一题"
                    disabled={index === 0}
                    onClick={() => setCurrent(Math.max(0, index - 1))}
                  />
                </PaginationItem>
                {questions.map((item, itemIndex) => (
                  <PaginationItem key={item.id}>
                    <PaginationLink
                      isActive={itemIndex === index}
                      aria-label={`第 ${itemIndex + 1} 题`}
                      onClick={() => setCurrent(itemIndex)}
                    >
                      {itemIndex + 1}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    text="下一题"
                    disabled={index === questions.length - 1}
                    onClick={() => setCurrent(Math.min(questions.length - 1, index + 1))}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          ) : null}
          {settled ? null : (
            <button
              type="button"
              className={PRIMARY_CLASS}
              disabled={!interactive || !complete}
              onClick={submit}
            >
              {busy ? '正在发送…' : '发送回答'}
            </button>
          )}
        </div>
        <p
          className={cn(
            'm-0 mt-1 text-[11px] leading-[1.5] break-words',
            error === null ? 'text-dim' : 'text-danger'
          )}
        >
          {error ??
            (settled
              ? `已回答全部 ${questions.length} 个问题`
              : complete
                ? '回答后 AI 会继续执行'
                : `还有 ${questions.length - answeredCount} 个问题未回答`)}
        </p>
      </div>
    </div>
  )
}

/** 单个问题：标题、正文、选项与自由输入 */
function QuestionBlock({
  question,
  draft,
  interactive,
  onChoose,
  onTypeCustom
}: {
  question: AiQuestion
  draft: QuestionDraft
  interactive: boolean
  onChoose: (label: string) => void
  onTypeCustom: (value: string) => void
}): React.JSX.Element {
  const options = question.options ?? []
  return (
    <div>
      {question.header !== undefined ? (
        <p className="m-0 mb-0.5 text-[10px] tracking-wide text-dim/80">{question.header}</p>
      ) : null}
      <p className="m-0 text-[13px] leading-[1.6] break-words text-fg">{question.question}</p>
      {options.length > 0 ? (
        <div
          className="mt-1.5 flex flex-col gap-1"
          role={question.multiSelect === true ? 'group' : 'radiogroup'}
        >
          {options.map((option, optionIndex) => (
            <OptionButton
              key={option.label}
              option={option}
              index={optionIndex}
              multiSelect={question.multiSelect === true}
              selected={draft.selected.includes(option.label)}
              interactive={interactive}
              onClick={() => onChoose(option.label)}
            />
          ))}
        </div>
      ) : null}
      <textarea
        value={draft.custom}
        rows={options.length > 0 ? 1 : 2}
        disabled={!interactive}
        placeholder={options.length > 0 ? '其他回答（可选）' : '输入你的回答…'}
        className="mt-1.5 w-full resize-none rounded-[3px] border border-line bg-base px-2 py-1 text-[12px] leading-[1.6] text-fg outline-none placeholder:text-dim/70 focus:border-accent-hover disabled:cursor-default disabled:opacity-60"
        onChange={(event) => onTypeCustom(event.target.value)}
      />
    </div>
  )
}

/** 一个选项：单选显示序号，多选显示勾选框 */
function OptionButton({
  option,
  index,
  multiSelect,
  selected,
  interactive,
  onClick
}: {
  option: AiQuestionOption
  index: number
  multiSelect: boolean
  selected: boolean
  interactive: boolean
  onClick: () => void
}): React.JSX.Element {
  const display = parseRecommendedLabel(option.label)
  return (
    <button
      type="button"
      role={multiSelect ? 'checkbox' : 'radio'}
      aria-checked={selected}
      disabled={!interactive}
      className={cn(
        'flex w-full items-start gap-1.5 rounded-[3px] border px-1.5 py-1 text-left transition-colors',
        selected ? 'border-selection bg-selection' : 'border-line bg-base',
        interactive ? 'cursor-pointer' : 'cursor-default',
        !selected && interactive ? 'hover:bg-hover/60' : null
      )}
      onClick={onClick}
    >
      <span
        aria-hidden
        className={cn(
          'mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border text-[9px] leading-none',
          selected ? 'border-line bg-selection text-fg' : 'border-line text-dim'
        )}
      >
        {selected ? <Check className="size-2.5" /> : multiSelect ? null : index + 1}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="text-[12px] leading-[1.6] break-words text-fg">{display.label}</span>
          {display.recommended ? (
            <span className="rounded-sm bg-hover px-1 text-[9px] leading-4 text-dim">推荐</span>
          ) : null}
        </span>
        {option.description !== undefined ? (
          <span className="mt-0.5 block text-[11px] leading-[1.5] break-words text-dim">
            {option.description}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** 已回复的一题：问题 + 用户给出的答案，随分页逐题回看 */
function AnswerBlock({
  question,
  answer
}: {
  question: AiQuestion
  answer: AiQuestionAnswer | undefined
}): React.JSX.Element {
  const values = answerValues(answer)
  return (
    <div>
      {question.header !== undefined ? (
        <p className="m-0 mb-0.5 text-[10px] tracking-wide text-dim/80">{question.header}</p>
      ) : null}
      <p className="m-0 text-[12px] leading-[1.6] break-words text-dim">{question.question}</p>
      <div className="mt-1 flex flex-wrap gap-1">
        {values.length > 0 ? (
          values.map((value) => (
            <span
              key={value}
              className="rounded-sm border border-line bg-base px-1.5 py-0.5 text-[11px] leading-[1.6] text-fg"
            >
              {value}
            </span>
          ))
        ) : (
          <span className="text-[11px] text-dim">（未回答）</span>
        )}
      </div>
    </div>
  )
}

/** 从草稿生成提交给主进程的答案；单选填了自由文本时以文本为准 */
function buildAnswers(
  questions: readonly AiQuestion[],
  drafts: readonly QuestionDraft[]
): AiQuestionAnswer[] {
  return questions.map((question, index) => {
    const draft = drafts[index] ?? { selected: [], custom: '' }
    const custom = draft.custom.trim()
    const selected = custom.length > 0 && question.multiSelect !== true ? [] : [...draft.selected]
    return {
      id: question.id,
      selected,
      ...(custom.length > 0 ? { custom } : {})
    }
  })
}

/** 草稿是否算已作答：勾了选项或写了非空文本 */
function answeredDraft(draft: QuestionDraft): boolean {
  return draft.selected.length > 0 || draft.custom.trim().length > 0
}

/** 一条回答的展示值：选中的标签在前，自由输入在后 */
function answerValues(answer: AiQuestionAnswer | undefined): string[] {
  if (answer === undefined) {
    return []
  }
  const custom = answer.custom?.trim() ?? ''
  return custom.length > 0 ? [...answer.selected, custom] : [...answer.selected]
}

/** 拆出「（推荐）」后缀：返回值仍是原始标签，展示时去掉后缀并加徽标 */
function parseRecommendedLabel(label: string): {
  label: string
  recommended: boolean
} {
  return RECOMMENDED_SUFFIX.test(label)
    ? { label: label.replace(RECOMMENDED_SUFFIX, ''), recommended: true }
    : { label, recommended: false }
}
