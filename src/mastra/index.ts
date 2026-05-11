import "dotenv/config";
import { Mastra } from "@mastra/core/mastra";
import { registerApiRoute } from "@mastra/core/server";
import { PinoLogger } from "@mastra/loggers";
import { sharedPgStore } from "./core/db/shared-pg-store";

// Workflows & Agents
import { surveyWorkflow } from "./workflows/survey-workflow";
import { surveyAgent } from "./agents/survey-agent";
import { engagementAgent } from "./agents/engagement-agent";

// Tools
import {
  escalateTool,
  sendWhatsAppMessageTool,
  sendWhatsAppSurveyTool,
  sendWhatsAppTemplateTool,
} from "./tools";

// Meta Flow APIs
import {
  createMetaFlow,
  uploadFlowJson,
  publishFlow,
} from "./metaFlowApi";

// WhatsApp client
import {
  sendWhatsAppMessage,
  markAsRead,
} from "../whatsapp-client";

/* -------------------------------------------------------------------------- */
/*                                CONFIG                                      */
/* -------------------------------------------------------------------------- */

const pgStorage = sharedPgStore;

/* -------------------------------------------------------------------------- */
/*                                HELPERS                                     */
/* -------------------------------------------------------------------------- */

const getDb = () => (pgStorage as any).db;

/* -------------------------------------------------------------------------- */
/*                              API ROUTES                                    */
/* -------------------------------------------------------------------------- */

const routes = [

  /* -------------------------- SEND SINGLE SURVEY -------------------------- */

  registerApiRoute("api/crm/send-survey", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json().catch(() => null);

      // Required fields
      if (!body?.to || !body?.surveyId || !body?.topic || !body?.mode) {
        return c.json({ error: "Missing required fields (to, surveyId, topic, mode)" }, 400);
      }

      const { to, surveyId, topic, mode, context } = body;

      // Only allow valid modes
      if (!['ai', 'manual', 'meta'].includes(mode)) {
        return c.json({ error: "Invalid mode. Must be one of: ai, manual, meta" }, 400);
      }

      try {
        if (mode === 'meta') {
          // Send Meta WhatsApp survey template (no workflow)
          // Use sendMetaTemplate helper
          const { sendMetaTemplate } = await import("./sendMetaTemplate");
          const metaResult = await sendMetaTemplate({ to, surveyId, topic });
          return c.json({ success: true, mode: 'meta', metaResult });
        }

        // For ai/manual, run the workflow
        const workflow = c.get("mastra").getWorkflow("surveyWorkflow");
        const run = await workflow.createRun();

        // Pass context if present (type-safe)
        const inputData = { to, surveyId, topic, ...(context ? { context } : {}), mode };
        const result = await run.start({ inputData });
        return c.json({ success: true, mode, result });
      } catch (error) {
        return c.json(
          { error: "Survey send failed", details: (error as Error).message },
          500
        );
      }
    },
  }),

  /* -------------------------- BULK SURVEY SEND ---------------------------- */
  registerApiRoute("api/crm/bulk-send-survey", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json().catch(() => null);

      if (!body?.customers || !Array.isArray(body.customers)) {
        return c.json({ error: "Invalid customers array" }, 400);
      }

      const workflow = c.get("mastra").getWorkflow("surveyWorkflow");

      const results = await Promise.all(
        body.customers.map(async (customer: any) => {
          // customer may be a string (phone) or an object { to, mode, context }
          const to = typeof customer === 'string' ? customer : customer?.to;
          const customerMode = (typeof customer === 'object' && customer?.mode) || body.mode;
          const customerContext = (typeof customer === 'object' && customer?.context) || body.context;

          if (!to) {
            return { to: null, success: false, error: 'Invalid input data: \n- to: Invalid input: expected string, received undefined' };
          }

          try {
            // Respect meta mode: send template directly
            const mode = customerMode || body.mode;
            if (mode === 'meta') {
              const { sendMetaTemplate } = await import("./sendMetaTemplate");
              const metaResult = await sendMetaTemplate({ to, surveyId: body.surveyId, topic: body.topic });
              return { to, success: true, mode: 'meta', metaResult };
            }

            // For ai/manual, start a workflow run
            const run = await workflow.createRun();
            const inputData: any = { to, surveyId: body.surveyId, topic: body.topic };
            if (customerContext) inputData.context = customerContext;
            if (mode) inputData.mode = mode;

            const result = await run.start({ inputData });
            return { to, success: true, result };
          } catch (error) {
            return {
              to,
              success: false,
              error: (error as Error).message,
            };
          }
        })
      );

      return c.json({ results });
    },
  }),

  /* -------------------------- META FLOW CREATION -------------------------- */
  registerApiRoute("api/crm/create-meta-flow", {
    method: "POST",
    handler: async (c) => {
      const body = await c.req.json().catch(() => null);

      try {
        const flowId = await createMetaFlow(body?.name || "survey_flow");

        await uploadFlowJson(flowId, "./survey.json");
        await publishFlow(flowId);

        return c.json({ success: true, flowId });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 500);
      }
    },
  }),

  /* -------------------------- GET SURVEY RESPONSES ------------------------ */
  registerApiRoute("api/crm/survey-responses", {
    method: "GET",
    handler: async (c) => {
      const surveyId = c.req.query("surveyId");

      try {
        const db = getDb();
        if (!db) throw new Error("DB not available");

        const query = surveyId
          ? {
              text: "SELECT * FROM survey_responses WHERE survey_id=$1 ORDER BY created_at DESC",
              values: [surveyId],
            }
          : {
              text: "SELECT * FROM survey_responses ORDER BY created_at DESC",
              values: [],
            };

        const rows = await db.any(query.text, query.values);
        return c.json({ responses: rows });

      } catch {
        return c.json({ responses: [] });
      }
    },
  }),

  /* -------------------------- META RESPONSES (STUB) ------------------------ */
  registerApiRoute("api/crm/meta-survey-responses", {
    method: "GET",
    handler: async () => {
      return new Response(
        JSON.stringify({
          responses: [],
          note: "Not implemented",
        }),
        { status: 200 }
      );
    },
  }),
];




/* -------------------------------------------------------------------------- */
/*                              MASTRA INSTANCE                               */
/* -------------------------------------------------------------------------- */

export const mastra = new Mastra({
  workflows: { surveyWorkflow },
  agents: { surveyAgent, engagementAgent },
  tools: {
    sendWhatsAppMessageTool,
    sendWhatsAppSurveyTool,
    sendWhatsAppTemplateTool,
    escalateTool,
  },
  storage: pgStorage,
  logger: new PinoLogger({
    name: "FBNBank-WhatsApp-Agent",
    level: "info",
  }),
  server: {
    apiRoutes: routes,
  },
});
