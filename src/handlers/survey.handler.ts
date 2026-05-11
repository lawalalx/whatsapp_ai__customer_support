// handlers/survey.handler.ts

import { Pool } from "pg";
import { saveSurveyResponse } from "../services/response.service";
import { completeSession, updateSessionProgress } from "../services/session.service";


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

  // 🚪 EXIT FLOW (allow user to type exit anytime)
  const exitAnswer = String(textBody || '').trim().toLowerCase();
  if (['exit', 'quit', 'stop', 'end'].includes(exitAnswer)) {
    await completeSession(db, session.id)

    await sendMessage(
      phone,
      "🚪 You have exited the survey. Your responses have been saved."
    )
    return
  }

  const currentIndex = session.current_question
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
    `📝 Answer received for Q${currentIndex + 1}:`,
    rawAnswer,
    { buttonReply, listReply, textBody }
  )

  // Debugging: show current question shape so we can trace validation issues
  console.log('currentQuestion debug:', {
    index: currentIndex,
    type: currentQuestion?.type,
    question: currentQuestion?.question,
    options: currentQuestion?.options,
  })

  // ─── 1. VALIDATION (ONLY FOR BUTTON/LIST) ─────────────────────
  let responseTextToSave = rawAnswer;
  let responseIdToSave = message.id;

  // Treat a question with `options` but no explicit `type` as interactive
  const isInteractiveQuestion = (currentQuestion?.type === 'button' || currentQuestion?.type === 'list' || (currentQuestion?.options?.length && !currentQuestion?.type));
  if (isInteractiveQuestion && currentQuestion.options?.length) {
    // Normalize available options (strip emoji/punctuation so "Likely 🟢" matches "likely")
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
        console.log("❌ Invalid option provided - resending question")
        await sendMessage(phone, "🙂 Please select from the available options above.")
        // Re-send SAME question (do NOT move forward)
        return sendQuestion(phone, currentQuestion, session)
      }
      // map normalized answer back to original option (preserve formatting)
      const matchedIndex = normalizedOptions.indexOf(normalizedAnswer);
      if (matchedIndex >= 0) responseTextToSave = currentQuestion.options[matchedIndex];
    }
  }

  // ─── 2. SAVE RESPONSE ─────────────────────────────────────────
  await saveSurveyResponse({
    db,
    session,
    phone,
    responseText: responseTextToSave,
    responseId: responseIdToSave,
  })

  const nextIndex = currentIndex + 1

  // ─── 3. CHECK IF DONE ─────────────────────────────────────────
  if (nextIndex >= questions.length) {
    await completeSession(db, session.id)

    await sendMessage(phone, "🎉 Thanks! Survey completed.")
    return
  }

  // ─── 4. UPDATE SESSION ────────────────────────────────────────
  await updateSessionProgress(db, session.id, nextIndex)

  // ✅ IMPORTANT: keep in sync with DB
  session.current_question = nextIndex

  const nextQuestion = questions[nextIndex]

  // ─── 5. SEND NEXT QUESTION ────────────────────────────────────
  await sendQuestion(phone, nextQuestion, session)
}
