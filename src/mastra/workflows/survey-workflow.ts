import "dotenv/config";

import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { surveyTemplates } from '../../surveyTemplates.js'
import { normalizePhone } from "../../utils/format_phone.js";
import { sendSurveyIntro } from "../../utils/survey.sender.js";

async function loadManualSurveyQuestions(surveyId?: string) {
  if (!surveyId) return null;

  try {
    const fs = await import('fs/promises');
    const p = `${process.cwd()}/data/${surveyId}.json`;

    console.log('\n\nAttempting to load manual survey questions from:', p);
    
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.questions)) {
      return parsed.questions.map((q: any) => ({
        question: q.text,
        options: q.options || [],
        type: q.type,
        text: q.text,
        sectionTitle: q.sectionTitle,
        placeholder: q.placeholder,
      }));
    }
  } catch (e) {
    // ignore and fallback to built-in templates
  }

  const demo = surveyTemplates.find(s => s.id === surveyId);
  if (!demo) return null;

  return demo.questions.map(q => ({
    question: q.text,
    options: q.options || [],
    type: q.type,
    text: q.text,
    sectionTitle: q.sectionTitle,
    placeholder: q.placeholder,
  }));
}

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
      const manualQuestions = await loadManualSurveyQuestions(inputData.surveyId);
      if (manualQuestions) {
        return { questions: manualQuestions }
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
    let response;
    try {
      response = await agent.generate(
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTransientConnectionError = /ECONNRESET|Cannot connect to API/i.test(message);
      if (isTransientConnectionError) {
        const manualQuestions = await loadManualSurveyQuestions(inputData.surveyId);
        if (manualQuestions) {
          console.warn(`AI survey generation failed for ${inputData.surveyId}; falling back to local template.`, error);
          return { questions: manualQuestions };
        }
      }
      throw error;
    }

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
    surveyIntroTemplateId: z.string().optional(),
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
    const { to, surveyId, questions, surveyIntroTemplateId } = inputData
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
                -1,
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


    const sent = await sendSurveyIntro({
      to,
      phoneNumberId: undefined,
      surveyIntroTemplateId,
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
    context: z.string().optional(),
    surveyIntroTemplateId: z.string().optional(),
    mode: z.enum(['ai', 'manual']).optional(),
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
    surveyIntroTemplateId?: string;
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
      surveyIntroTemplateId: initData.surveyIntroTemplateId,
      questions: inputData.questions,
    }
  })
  .then(sendSurveyQuestions)

surveyWorkflow.commit()
