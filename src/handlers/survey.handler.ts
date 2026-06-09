// handlers/survey.handler.ts

import { Pool } from "pg";
import { saveSurveyResponse } from "../services/response.service.js";
import { completeSession, updateSessionProgress } from "../services/session.service.js";
import { getSurveyResponsesBySession } from "../services/response.service.js";


type HandleSurveyMessageParams = {
  db: Pool;
  message: any;
  session: any;
  phone: string;
  contactName?: string | null;

  sendMessage: (to: string, msg: string) => Promise<void>;

  sendQuestion: (
    to: string,
    question: any,
    session: any
  ) => Promise<void>;
};

/**
 * Find the next question index to send, starting from `fromIndex`,
 * skipping any whose `showIf` condition isn't met by current answers.
 * Returns `questions.length` when no more questions remain.
 */
function findNextVisibleQuestion(
  questions: any[],
  fromIndex: number,
  answers: Record<string, string>,
): number {
  for (let i = fromIndex; i < questions.length; i++) {
    const q = questions[i];
    if (!q.showIf) return i; // always visible
    const depAnswer = (answers[q.showIf.dependsOn] ?? '').toLowerCase().trim();
    const expected = (q.showIf.equals ?? '').toLowerCase().trim();
    if (depAnswer === expected) return i; // condition met
    // else skip
  }
  return questions.length; // all remaining questions skipped â†’ survey done
}

/**
 * Build an answers map { questionId: responseText } from previously saved responses.
 * Uses the question's semantic `id` field if available, falling back to positional index.
 */
async function buildAnswersMap(
  db: Pool,
  sessionId: string,
  questions: any[],
  currentIndex: number,
  currentAnswer: string,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};

  try {
    const saved = await getSurveyResponsesBySession(db, sessionId);
    for (const resp of saved) {
      // question_id format: {sessionId}_q{n}
      const match = resp.question_id?.match(/_q(\d+)$/);
      if (match) {
        const qIdx = parseInt(match[1], 10) - 1;
        const q = questions[qIdx];
        if (q?.id) answers[q.id] = resp.response_text;
      }
    }
  } catch {}

  // Include current answer (just saved to DB, may not appear in above query yet)
  const currentQ = questions[currentIndex];
  if (currentQ?.id) {
    answers[currentQ.id] = currentAnswer;
  }

  return answers;
}


export async function handleSurveyMessage({
  db,
  message,
  session,
  phone,
  contactName,
  sendMessage,
  sendQuestion,
}: HandleSurveyMessageParams) {
  // Helper: normalize text for matching (lowercase, remove emojis/punctuation)
  const normalizeForMatch = (s: any) => {
    try {
      return String(s || '')
        .toLowerCase()
        .normalize('NFKD')
        // remove anything that's not a letter, number or whitespace (removes emoji/punctuation)
        .replace(/[^^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    } catch (e) {
      return String(s || '').toLowerCase().trim();
    }
  }
  const buttonReply = message?.interactive?.button_reply;
  const listReply = message?.interactive?.list_reply;
  const textBody = typeof message?.text?.body === 'string' ? message.text.body : '';

  const rawAnswer = buttonReply?.title || listReply?.title || buttonReply?.id || listReply?.id || textBody;
  if (!rawAnswer) return;

  // ðŸšª EXIT FLOW (allow user to type exit anytime)
  const exitAnswer = String(textBody || '').trim().toLowerCase();
  if (['exit', 'quit', 'stop', 'end'].includes(exitAnswer)) {
    await completeSession(db, session.id)

    await sendMessage(
      phone,
      "ðŸšª You have exited the survey. Your responses have been saved."
    )
    return
  }

  const currentIndex = session.current_question
  if (currentIndex === -1) {
    const proceedPressed = normalizeForMatch(rawAnswer) === 'proceed' || normalizeForMatch(buttonReply?.title || listReply?.title) === 'proceed';
    if (!proceedPressed) {
      await sendMessage(phone, 'Please tap Proceed to start the survey.')
      return
    }

    let questions = session.questions_data
    if (typeof questions === 'string') {
      try {
        questions = JSON.parse(questions)
      } catch (e) {
        // keep original; downstream checks will handle invalid shape
      }
    }

    // Find the first visible question (no showIf conditions can block Q0 in practice,
    // but be safe)
    const firstIndex = findNextVisibleQuestion(Array.isArray(questions) ? questions : [], 0, {});
    if (!Array.isArray(questions) || firstIndex >= questions.length) {
      await completeSession(db, session.id)
      await sendMessage(phone, 'ðŸŽ‰ Thanks! Survey completed.')
      return
    }

    await updateSessionProgress(db, session.id, firstIndex)
    session.current_question = firstIndex
    await sendQuestion(phone, questions[firstIndex], session)
    return
  }

  // Normalize questions_data (DB may return JSON string or JSONB)
  let questions = session.questions_data
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions)
    } catch (e) {
      // keep original; downstream checks will handle invalid shape
    }
  }
  const currentQuestion = Array.isArray(questions) ? questions[currentIndex] : undefined

  console.log(
    `ðŸ“ Answer received for Q${currentIndex + 1}:`,
    rawAnswer,
    { buttonReply, listReply, textBody }
  )

  // Debugging: show current question shape so we can trace validation issues
  console.log('currentQuestion debug:', {
    index: currentIndex,
    type: currentQuestion?.type,
    question: currentQuestion?.question,
    options: currentQuestion?.options,
    showIf: currentQuestion?.showIf,
  })

  // â”€â”€â”€ 1. VALIDATION (ONLY FOR BUTTON/LIST) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let responseTextToSave = rawAnswer;
  let responseIdToSave = message.id;

  // Treat a question with `options` but no explicit `type` as interactive
  const isInteractiveQuestion = (currentQuestion?.type === 'button' || currentQuestion?.type === 'list' || (currentQuestion?.options?.length && !currentQuestion?.type));
  if (isInteractiveQuestion && currentQuestion.options?.length) {
    // Normalize available options (strip emoji/punctuation so "Likely ðŸŸ¢" matches "likely")
    const normalizedOptions = currentQuestion.options.map((opt: string) => normalizeForMatch(opt));

    // If reply came as an id (we set ids when sending options), map it back to option text
    const replyId = buttonReply?.id || listReply?.id;
    if (replyId && typeof replyId === 'string' && replyId.includes(session.id)) {
      // Expect format: {sessionId}_q{n}_opt{m}
      const m = replyId.match(/_opt(\d+)$/);
      if (m) {
        const idx = parseInt(m[1], 10) - 1;
        if (currentQuestion.options[idx]) {
          responseTextToSave = currentQuestion.options[idx];
          responseIdToSave = replyId;
        }
      }
    } else {
      // otherwise match by title/text
      const normalizedAnswer = normalizeForMatch(rawAnswer || '');
      console.log('normalizedOptions:', normalizedOptions, 'normalizedAnswer:', normalizedAnswer)
      if (!normalizedOptions.includes(normalizedAnswer)) {
        console.log("âŒ Invalid option provided - resending question")
        await sendMessage(phone, "ðŸ™‚ Please select from the available options below")
        // Re-send SAME question (do NOT move forward)
        return sendQuestion(phone, currentQuestion, session)
      }
      // map normalized answer back to original option (preserve formatting)
      const matchedIndex = normalizedOptions.indexOf(normalizedAnswer);
      if (matchedIndex >= 0) responseTextToSave = currentQuestion.options[matchedIndex];
    }
  }

  // â”€â”€â”€ 2. SAVE RESPONSE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await saveSurveyResponse({
    db,
    session,
    phone,
    responseText: responseTextToSave,
    responseId: responseIdToSave,
  })

  // â”€â”€â”€ 3. BUILD ANSWERS MAP (for showIf evaluation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const answers = await buildAnswersMap(db, session.id, questions, currentIndex, responseTextToSave);

  // â”€â”€â”€ 4. FIND NEXT VISIBLE QUESTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const nextIndex = findNextVisibleQuestion(questions, currentIndex + 1, answers);

  // â”€â”€â”€ 5. CHECK IF DONE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (nextIndex >= questions.length) {
    await completeSession(db, session.id)

    const responses = await getSurveyResponsesBySession(db, session.id)
    const recapLines = responses.length > 0
      ? responses.map((response, index) => {
        const questionLabel = response.question_text || `Question ${index + 1}`;
        const answerLabel = response.response_text || 'No response recorded';
        return `*${questionLabel}*\n${answerLabel}`;
      }).join('\n\n')
      : 'No responses were recorded.';

    await sendMessage(
      phone,
      `ðŸŽ‰ Thanks! Survey completed.\n\nThis is what we received:\n\n${recapLines}`
    )
    return
  }

  // â”€â”€â”€ 6. UPDATE SESSION & SEND NEXT QUESTION â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await updateSessionProgress(db, session.id, nextIndex)
  session.current_question = nextIndex

  const nextQuestion = questions[nextIndex]
  await sendQuestion(phone, nextQuestion, session)
}
