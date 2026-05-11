import "dotenv/config";

import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { surveyTemplates } from '../../surveyTemplates'
import { normalizePhone } from "../../utils/format_phone";
import { sendSurveyQuestion } from "../../utils/survey.sender";

// ─── Step 1: Generate survey content using the Survey Agent ──────────────────

const generateSurveyContent = createStep({
  id: 'generate-survey-content',
  description: 'Generate one or more survey questions from a topic using the Survey Agent',
  inputSchema: z.object({ 
    topic: z.string(),
    surveyId: z.string().optional(),
    context: z.string().optional(),
    mode: z.enum(['ai', 'manual']).optional(),
  }),
  outputSchema: z.object({
    questions: z.array(z.object({
      question: z.string(),
      options: z.array(z.string()),
      type: z.enum(['button', 'list', 'text']).optional(),
      text: z.string().optional(),
      sectionTitle: z.string().optional(),
      placeholder: z.string().optional(),
    })),
  }),
  execute: async ({ inputData, mastra }) => {
    // Route by mode: manual = use local template, ai = generate
    if (inputData.mode === 'manual') {
      // Prefer data/<surveyId>.json if present (created via admin endpoint),
      // otherwise fall back to compiled `surveyTemplates`.
      try {
        const fs = await import('fs/promises');
        const p = `${process.cwd()}/data/${inputData.surveyId}.json`;
        const raw = await fs.readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.questions)) {
          return {
            questions: parsed.questions.map((q: any) => ({
              question: q.text,
              options: q.options || [],
              type: q.type,
              text: q.text,
              sectionTitle: q.sectionTitle,
              placeholder: q.placeholder,
            })),
          }
        }
      } catch (e) {
        // ignore and fallback to built-in templates
      }

      const demo = surveyTemplates.find(s => s.id === inputData.surveyId)
      if (demo) {
        return {
          questions: demo.questions.map(q => ({
            question: q.text,
            options: q.options || [],
            type: q.type,
            text: q.text,
            sectionTitle: q.sectionTitle,
            placeholder: q.placeholder,
          })),
        }
      } else {
        throw new Error('Manual mode: survey template not found')
      }
    }

    const agent = mastra?.getAgent('surveyAgent')
    if (!agent) throw new Error('Survey agent not found')

    // Compose prompt with context if provided
    let prompt = `Generate a detailed multi-question survey about: ${inputData.topic}`;
    if (inputData.context) {
      prompt += `\nContext: ${inputData.context}`;
    }

    // Try multi-question format first
    const response = await agent.generate(
      [{ role: 'user', content: prompt }],
      {
        structuredOutput: {
          schema: z.object({
            questions: z.array(z.object({
              question: z.string(),
              options: z.array(z.string()),
            })).optional(),
            question: z.string().optional(),
            options: z.array(z.string()).optional(),
          }),
        },
        memory: {
          thread: `survey_thread_${Date.now()}`,
          resource: `survey_${inputData.surveyId || 'default'}`,
        },
      }
    )

    if (!response.object) throw new Error('Failed to generate survey content')

    // Normalize: handle both single-question and multi-question responses
    const obj = response.object
    if (obj.questions && obj.questions.length > 0) {
      return { questions: obj.questions }
    } else if (obj.question && obj.options) {
      return { questions: [{ question: obj.question, options: obj.options }] }
    }

    throw new Error('Invalid survey content structure from agent')
  },
})

// ─── Step 2: Send all survey questions sequentially via WhatsApp ─────────────
const sendSurveyQuestions = createStep({
  id: 'send-survey-questions',
  description: 'Send each survey question as a separate interactive WhatsApp message',
  inputSchema: z.object({
    to: z.string(),
    surveyId: z.string(),
    questions: z.array(z.object({
      question: z.string(),
      options: z.array(z.string()),
      type: z.enum(['button', 'list', 'text']).optional(),
      text: z.string().optional(),
      sectionTitle: z.string().optional(),
      placeholder: z.string().optional(),
    })),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    questionsSent: z.number(),
    surveySessionId: z.string(),
  }),
  execute: async ({ inputData, mastra }) => {
    const { to, surveyId, questions } = inputData
    const surveySessionId = `${surveyId}_${Date.now()}`

    // Store survey session in Postgres for response tracking
    const storage = mastra?.getStorage()
    if (storage) {
      try {
        const workflowsStore = await storage.getStore('workflows')
        if (workflowsStore) {
          // Use the underlying db client for custom tables
          const pgStore = storage as any
          if (pgStore.db) {
            const result = await pgStore.db.any(
              `INSERT INTO survey_sessions (
                id,
                survey_id,
                customer_phone,
                current_question,
                total_questions,
                questions_data,
                status,
                created_at,
                updated_at
              )
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [
                surveySessionId,
                surveyId,
                normalizePhone(to),
                0,
                questions.length,
                JSON.stringify(questions),
                'active',
                new Date().toISOString(),
                new Date().toISOString(),
              ]
            )
            console.log("\n\nDB INSERT RESULT:", result);
          } 
        }
      } catch (err) {
        // Table might not exist yet — we'll handle this gracefully
        console.error('❌ FAILED TO SAVE SESSION:', err)
        throw err
      }
    }


    const firstQuestion = questions[0]

    const sent = await sendSurveyQuestion({
      to,
      session: {
        id: surveySessionId,
        current_question: 0,
        total_questions: questions.length,
      },
      question: firstQuestion,
    })


    const result =  {
      success: sent,
      questionsSent: sent ? 1 : 0,
      surveySessionId,
    };

    return result
  },
})

// ─── Workflow: Generate → Send ───────────────────────────────────────────────
export const surveyWorkflow = createWorkflow({
  id: 'survey-workflow',
  inputSchema: z.object({
    to: z.string(),
    surveyId: z.string(),
    topic: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    questionsSent: z.number(),
    surveySessionId: z.string(),
  }),
} as const)
  .map(async ({ inputData }) => inputData)
  .then(generateSurveyContent)
  .map(async ({ inputData, getInitData }): Promise<{
    to: string;
    surveyId: string;
    questions: Array<{
      question: string;
      options: string[];
      type?: 'button' | 'list' | 'text';
      text?: string;
      sectionTitle?: string;
      placeholder?: string;
    }>;
  }> => {
    const initData = getInitData<typeof surveyWorkflow>()
    return {
      to: initData.to,
      surveyId: initData.surveyId,
      questions: inputData.questions,
    }
  })
  .then(sendSurveyQuestions)

surveyWorkflow.commit()
