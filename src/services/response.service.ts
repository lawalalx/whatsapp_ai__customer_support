// services/response.service.ts

import { SaveSurveyResponseParams } from "../flow.types";

export async function saveSurveyResponse({
  db,
  session,
  phone,
  responseText,
  responseId
}: SaveSurveyResponseParams) {
  const questionIndex = session.current_question;
  const question = session.questions_data[questionIndex];

  const id = `resp_${Date.now()}`;

  await db.none(
    `INSERT INTO survey_responses (
      id,
      survey_id,
      session_id,
      customer_phone,
      question_text,
      question_id,
      response_text,
      response_id,
      created_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      session.survey_id,
      session.id,
      phone,
      question.question,
      `${session.id}_q${questionIndex + 1}`,
      responseText,
      responseId,
      new Date().toISOString()
    ]
  );
}
