

import "dotenv/config";
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import swaggerUi from 'swagger-ui-express';
import express, { Application, Request, Response } from 'express';
import { MastraServer } from '@mastra/express';
import { mastra } from './mastra/index.js';

import { normalizePhone } from './utils/format_phone.js';
import { sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppReadReceipt } from './whatsapp-client.js';
import { lastOutboundType, setLastOutbound } from './utils/outboundTracker.js';
import escalationService from './services/escalation-service.js';
import chatHistoryService from './services/chat-history-service.js';
import { initDatabase } from './db-init.js';
// WhatsApp Webhook: Handle incoming messages
import { routeIncomingMessage } from './webhook/router.js';

// Meta WhatsApp Flow Surveys
import { buildSurveyFlowJson } from './meta-flow/flow-builder.js';
import * as metaSurveyService from './meta-flow/meta-survey.service.js';
import {
  createMetaFlow,
  uploadFlowJsonBuffer,
  publishFlow,
  deprecateFlow,
  deleteFlow,
  getFlow,
  sendFlowMessage,
} from './mastra/metaFlowApi.js';

// RAG / Knowledge Base
import kbUploadRoute from './mastra/core/rag/routes/upload.route.js';
import kbDocsRoute from './mastra/core/rag/routes/docs.route.js';
import { createKbDocsTable } from './mastra/core/rag/db.js';
import { initVectorIndex } from './mastra/core/rag/vector-store.js';
import { warmUpEmbeddingModel } from "./mastra/core/llm/provider.js";

const seenInboundMessageIds = new Map<string, number>();
const SEEN_INBOUND_TTL_MS = 10 * 60 * 1000;

function isDuplicateInboundMessage(messageId: string): boolean {
  const now = Date.now();

  for (const [id, timestamp] of seenInboundMessageIds) {
    if (now - timestamp > SEEN_INBOUND_TTL_MS) {
      seenInboundMessageIds.delete(id);
    }
  }

  if (seenInboundMessageIds.has(messageId)) {
    return true;
  }

  seenInboundMessageIds.set(messageId, now);
  return false;
}


const app: Application = express();

await warmUpEmbeddingModel().catch(console.error);


const args = process.argv;

const portIndex = args.indexOf("--port");

const PORT =
  portIndex !== -1 && args[portIndex + 1]
    ? Number(args[portIndex + 1])
    : Number(process.env.PORT || 3000);


const URL=  process.env.REMOTE_URL

app.use(express.json());

// Knowledge Base routes
app.use('/api/kb/upload', kbUploadRoute);
app.use('/api/kb/docs', kbDocsRoute);

// Agent chat test route
app.post('/api/agent/chat', async (req: Request, res: Response) => {
  try {
    const { phone, message, contactName } = req.body as { phone?: string; message?: string; contactName?: string };
    if (!message?.trim()) {
      return res.status(400).json({ success: false, error: '"message" is required' });
    }
    const threadPhone = phone?.trim() || 'test-user';
    const agent = mastra.getAgent('engagementAgent');
    const messages: any[] = [];
    const normalizedPhone = normalizePhone(threadPhone);

    messages.push({
      role: 'system',
      content: `Customer WhatsApp phone: ${normalizedPhone}. This is the customer's current WhatsApp number. You DO have access to this number. If the customer says "use the one you have", "use this number", or similar during escalation, treat this WhatsApp number as the provided contact number and only ask them to confirm whether it is the number linked to their FBNBank account. Do not say you do not have access to their phone number.`,
    });

    if (contactName) {
      messages.push({ role: 'system', content: `Customer name: ${contactName}. Address the customer by this name when appropriate.` });
    }

    messages.push({ role: 'user', content: message });
    const response = await agent.generate(messages, {
      memory: { thread: `thread_${threadPhone}`, resource: threadPhone },
    });

    // setLastOutbound(threadPhone, 'engagementAgent');

    return res.json({ success: true, reply: response?.text?.trim() ?? '' });
  } catch (err: any) {
    console.error('❌ /api/agent/chat error:', err);
    return res.status(500).json({ success: false, error: err?.message ?? 'Internal error' });
  }
});

console.log('DB URL from Express Server', process.env.DATABASE_URL);

// Serve Swagger UI at /docs
const swaggerDocument = {
  openapi: '3.0.0',
  info: {
    title: 'Senegal Survey and Whatsapp AI Agent API',
    version: '1.0.0',
    description: 'API docs for webhook and admin survey endpoints',
  },
  servers: [
    {
      url: URL,
      description: "The URL for viewing and testing the API locally or remotely depending on environment configuration",
    },
  ],
  tags: [
    { name: 'Webhook', description: 'WhatsApp webhook verification and inbound events' },
    { name: 'Admin - AI/Manual Survey', description: 'CRM-triggered survey and campaign endpoints modules' },
    { name: 'Admin - Meta Survey', description: 'Create and manage WhatsApp Flow surveys powered by the Meta Flows API. Submissions are saved directly to your database.' },
    { name: 'Admin - Escalation', description: 'Human handoff and escalation operations' },
    { name: 'Admin - Chat History', description: 'Thread and message history retrieval endpoints' },
    { name: 'Knowledge Base', description: 'Knowledge base document ingest and management' },
    { name: 'Agent', description: 'Agent testing endpoint' },
    { name: 'Health', description: 'Liveness endpoint' },
  ],
  components: {
    schemas: {
      MetaFlowQuestion: {
        type: 'object',
        description: 'A single survey question for a Meta WhatsApp Flow',
        required: ['id', 'text', 'type'],
        properties: {
          id: { type: 'string', description: 'Unique field name (snake_case, no spaces). Used as the form field key in submissions.', example: 'satisfaction' },
          text: { type: 'string', description: 'Question text shown to the user (max 80 chars).', example: 'How satisfied are you with our service?' },
          type: {
            type: 'string',
            description: `Component type:
  • **list**     → \`Dropdown\` — best for 3–10 choices (max 200 options, each max 30 chars)
  • **button**   → \`RadioButtonsGroup\` — best for 2–5 choices (each max 30 chars)
  • **text**     → \`TextInput\` — single-line free text
  • **textarea** → \`TextArea\` — multi-line free text
  • **date**     → \`DatePicker\``,
            enum: ['list', 'button', 'text', 'textarea', 'date'],
            example: 'list'
          },
          options: { type: 'array', items: { type: 'string' }, description: 'Required for type `list` and `button`.', example: ['Very Satisfied','Satisfied','Neutral','Dissatisfied','Very Dissatisfied'] },
          required: { type: 'boolean', description: 'Whether the field is mandatory. Defaults to `true`.', default: true },
          placeholder: { type: 'string', description: 'Helper text shown inside the input component (max 80 chars).' },
          sectionTitle: { type: 'string', description: 'Label for `RadioButtonsGroup` (max 30 chars). Falls back to `text` if omitted.' }
        }
      },
      MetaFlowSurveyDefinition: {
        type: 'object',
        required: ['name', 'questions'],
        properties: {
          name: { type: 'string', example: 'Post-Transaction Survey', description: 'Survey name (first 30 chars used as screen title).' },
          description: { type: 'string', description: 'Intro text on the opening screen.', example: 'Help us improve your banking experience.' },
          surveyId: { type: 'string', description: 'Internal survey ID saved in DB.', example: 'csat-q1-2026' },
          thankYouText: { type: 'string', description: 'Message on the terminal COMPLETE screen.', example: 'Thank you! Your feedback helps us serve you better.' },
          questions: { type: 'array', items: { $ref: '#/components/schemas/MetaFlowQuestion' }, minItems: 1 },
          autoPublish: { type: 'boolean', default: false, description: 'If true, publishes immediately after upload. **Irreversible** — published flows cannot be unpublished.' },
          dataEndpointUrl: { type: 'string', example: 'https://your-server.ngrok.io/webhook/meta-flow-data', description: 'HTTPS URL of your data endpoint. Defaults to `SERVER_URL + /webhook/meta-flow-data`.' }
        }
      },
      SurveyQuestion: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' } },
          type: { type: 'string', enum: ['button','list','text'] },
        },
        required: ['id','text','type']
      },
      SurveyTemplate: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          questions: { type: 'array', items: { $ref: '#/components/schemas/SurveyQuestion' } }
        },
        required: ['id','name','questions']
      }
    }
  },

  paths: {
  '/webhook/whatsapp': {
    post: {
      summary: 'Receive WhatsApp webhook events',
      tags: ['Webhook'],
      description: `
      Handles incoming events from the WhatsApp Business API, including:
      - User messages (text, button clicks)
      - Delivery and read status updates

      This endpoint acts as the entry point for all real-time customer interactions. 
      Incoming messages are parsed and routed to the appropriate AI agent (engagement or survey flow).

      Important:
      - Must respond with HTTP 200 quickly to avoid retries from Meta
      - Payload structure follows WhatsApp Cloud API format
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { type: 'object' }
          }
        }
      },
      responses: {
        '200': { description: 'Event received and processed successfully' },
        '500': { description: 'Webhook processing failed' }
      }
    }
  },

  '/api/crm/send-survey': {
    post: {
      summary: 'Send a survey to a single customer',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Triggers a Mastra workflow to send a survey via WhatsApp.

      **Supported modes** (required — choose one):

      | Mode | Description |
      |------|-------------|
      | \`ai\` | AI-generated questions dynamically created at runtime based on the topic and context |
      | \`manual\` | Uses predefined survey templates stored in the system |
      | \`meta\` | Uses approved WhatsApp Business message templates (outside the 24-hour window) |

      The workflow manages:
      - Question sequencing
      - User responses
      - Session tracking

      This endpoint is typically called by CRM systems.
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Customer phone number (E.164 format)' },
                surveyId: { type: 'string' },
                topic: { type: 'string' },
                mode: {
                  type: 'string',
                  enum: ['ai', 'manual', 'meta'],
                  description: '**ai** — AI-generated questions | **manual** — predefined template | **meta** — approved WhatsApp template'
                },
                context: { type: 'string', description: 'Optional AI context for personalization' },
                surveyIntroTemplateId: {
                  type: 'string',
                  description: 'Optional approved WhatsApp template id to use for the survey intro message. If not provided or send fails, system falls back to interactive intro.'
                }
              },
              required: ['to', 'surveyId', 'topic', 'mode']
            },
            examples: {
              ai_mode: {
                summary: 'AI mode — dynamic question generation',
                value: { to: '2348123456789', surveyId: 'sat-001', topic: 'Customer Satisfaction', mode: 'ai', context: 'Premium tier customer', surveyIntroTemplateId: 'survey_intro_v1' }
              },
              manual_mode: {
                summary: 'Manual mode — predefined template',
                value: { to: '2348123456789', surveyId: 'nps-template-001', topic: 'NPS Survey', mode: 'manual', surveyIntroTemplateId: 'survey_intro_v1' }
              },
              meta_mode: {
                summary: 'Meta mode — approved WhatsApp template',
                value: { to: '2348123456789', surveyId: 'meta-onboarding', topic: 'Onboarding Feedback', mode: 'meta' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Survey workflow successfully started' },
        '400': { description: 'Invalid request payload' },
        '500': { description: 'Failed to start workflow' }
      }
    }
  },

  '/api/crm/bulk-send-survey': {
    post: {
    summary: 'Send surveys to multiple customers',
    tags: ['Admin - AI/Manual Survey'],
    description: `
    Triggers survey workflows for multiple customers in a single request.

    Each phone number in the \`customers\` array represents a unique recipient. 
    A separate workflow execution is started per recipient, enabling parallel processing 
    and consistent delivery at scale.

    **Supported modes** (required — choose one):

    | Mode | Description |
    |------|-------------|
    | \`ai\` | AI-generated questions dynamically created at runtime based on the topic and context |
    | \`manual\` | Uses predefined survey templates stored in the system |
    | \`meta\` | Uses approved WhatsApp Business message templates (outside the 24-hour window) |

    Top-level fields (\`surveyId\`, \`topic\`, \`mode\`, \`context\`) are applied globally 
    to all recipients.

    Typical use cases:
    - Customer satisfaction campaigns
    - Product feedback collection
    - Large-scale outreach and engagement

    Note:
    - Phone numbers must be in E.164 format (without '+')
    - Personalization is applied uniformly unless extended in future versions
    `,
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              surveyId: { 
                type: 'string',
                description: 'Unique identifier for the survey'
              },
              topic: { 
                type: 'string',
                description: 'Survey topic used for AI generation or categorization'
              },
              mode: { 
                type: 'string', 
                enum: ['ai', 'manual', 'meta'],
                description: '**ai** — AI-generated questions | **manual** — predefined template | **meta** — approved WhatsApp template'
              },
              context: { 
                type: 'string',
                description: 'Optional context to guide AI or campaign messaging'
              },
              customers: {
                type: 'array',
                description: 'List of recipient phone numbers (E.164 format without +, e.g., 2348123456789)',
                items: {
                  type: 'string',
                  example: '2348123456789'
                }
              }
            },
            required: ['customers', 'mode']
          },
          examples: {
            bulk_ai_mode: {
              summary: 'Bulk — AI mode',
              value: {
                surveyId: 'customer-sat-001',
                topic: 'Customer Satisfaction',
                mode: 'ai',
                context: 'Premium users campaign',
                customers: ['2348123456789', '2348012345678']
              }
            },
            bulk_manual_mode: {
              summary: 'Bulk — Manual mode',
              value: {
                surveyId: 'nps-template-001',
                topic: 'NPS Survey',
                mode: 'manual',
                customers: ['2348123456789', '2348012345678']
              }
            },
            bulk_meta_mode: {
              summary: 'Bulk — Meta mode',
              value: {
                surveyId: 'meta-onboarding',
                topic: 'Onboarding Feedback',
                mode: 'meta',
                customers: ['2348123456789', '2348012345678']
              }
            }
          }
        }
      }
    },
    responses: {
      '200': { description: 'Bulk survey workflows triggered successfully' },
      '400': { description: 'Invalid request payload or missing required fields' },
      '500': { description: 'Failed to process bulk survey request' }
    }
  }
  },

  // ─── Admin - Meta Survey ──────────────────────────────────────────────────

  '/admin/meta-survey': {
    post: {
      summary: 'Create a Meta WhatsApp Flow survey',
      tags: ['Admin - Meta Survey'],
      description: `Creates a survey as a Meta WhatsApp Flow:

1. Generates valid Flow JSON from your questions
2. Creates the flow on the Meta Flows API
3. Uploads the Flow JSON
4. Optionally publishes it (\`autoPublish: true\`)
5. Saves the registration to your local DB

When a customer submits the form in WhatsApp, responses are POSTed to your \`/webhook/meta-flow-data\` endpoint and saved to \`meta_flow_responses\`.

---
### Question types

| type | WhatsApp component | Best for | Max options |
|------|-------------------|----------|-------------|
| \`list\` | Dropdown | 3–10 choices | 200 |
| \`button\` | RadioButtonsGroup | 2–5 choices | 5 |
| \`text\` | TextInput | Short free text | — |
| \`textarea\` | TextArea | Long free text | — |
| \`date\` | DatePicker | Date selection | — |

### Flow screen layout
\`\`\`
INTRO (navigate) → QUESTIONS (data_exchange) → COMPLETE (terminal)
\`\`\`

> **Publishing note:** Once published, a flow **cannot be unpublished** — only deprecated. Use \`autoPublish: false\` (default) to review in the Meta Flow Builder first.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/MetaFlowSurveyDefinition' },
            examples: {
              csat: {
                summary: 'CSAT Survey (3 questions, mixed types)',
                value: {
                  name: 'Post-Transaction Survey',
                  description: 'Help us improve your banking experience. Takes 1 minute.',
                  surveyId: 'csat-q1-2026',
                  thankYouText: 'Thank you! Your feedback helps us serve you better.',
                  autoPublish: false,
                  questions: [
                    { id: 'satisfaction', text: 'How satisfied are you with our service?', type: 'list', options: ['Very Satisfied','Satisfied','Neutral','Dissatisfied','Very Dissatisfied'], required: true },
                    { id: 'recommend', text: 'Would you recommend FBNBank to a friend?', type: 'button', options: ['Yes','No','Maybe'], required: true },
                    { id: 'improvement', text: 'What can we improve?', type: 'textarea', required: false, placeholder: 'Tell us what you think...' }
                  ]
                }
              },
              nps: {
                summary: 'NPS Survey',
                value: {
                  name: 'Net Promoter Score',
                  surveyId: 'nps-2026',
                  autoPublish: false,
                  questions: [
                    { id: 'nps_score', text: 'How likely are you to recommend us? (1–10)', type: 'list', options: ['1','2','3','4','5','6','7','8','9','10'], required: true },
                    { id: 'nps_reason', text: 'Main reason for your score?', type: 'textarea', required: false }
                  ]
                }
              }
            }
          }
        }
      },
      responses: {
        '201': {
          description: 'Flow created (and optionally published)',
          content: { 'application/json': { schema: { type: 'object', properties: {
            success: { type: 'boolean' },
            flowId: { type: 'string' },
            surveyId: { type: 'string', nullable: true },
            status: { type: 'string', enum: ['draft','published'] },
            dataEndpointUrl: { type: 'string' },
            uploadResult: { type: 'object' },
            publishResult: { type: 'object', nullable: true }
          }}}}
        },
        '400': { description: 'Validation error' },
        '500': { description: 'Meta API or server error' }
      }
    },
    get: {
      summary: 'List all registered Meta Flow surveys',
      tags: ['Admin - Meta Survey'],
      description: 'Returns all Meta WhatsApp Flow surveys registered in the local DB, ordered by creation date descending.',
      responses: {
        '200': { description: 'Array of survey records' }
      }
    }
  },

  '/admin/meta-survey/{flowId}': {
    get: {
      summary: 'Get a specific Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'Returns the local DB record plus live status from the Meta Flows API (includes validation errors and preview URL).',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Survey details' }, '404': { description: 'Not found' } }
    },
    delete: {
      summary: 'Delete a DRAFT Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'Hard-deletes the flow from Meta and removes the local DB survey record. Only works on **DRAFT** flows that were never published. For published flows use `/delete-published`.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Deleted' },
        '400': { description: 'Flow is published — use /delete-published' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/admin/meta-survey/{flowId}/publish': {
    post: {
      summary: 'Publish a Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: '⚠ **Irreversible.** Makes the flow live. Verify in the Meta Flow Builder before publishing. To stop sending, use `/deprecate`.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Published' }, '404': { description: 'Not found' } }
    }
  },

  '/admin/meta-survey/{flowId}/deprecate': {
    post: {
      summary: 'Deprecate a published Meta Flow',
      tags: ['Admin - Meta Survey'],
      description: 'Soft-disables a published flow. The flow can no longer be sent to customers. Existing response data is preserved.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'Deprecated' }, '404': { description: 'Not found' } }
    }
  },

  '/admin/meta-survey/{flowId}/delete-published': {
    delete: {
      summary: 'Delete a PUBLISHED Meta Flow survey',
      tags: ['Admin - Meta Survey'],
      description: 'For published/deprecated flows: deprecates on Meta (if needed) and removes the local survey record. Responses are preserved. Use `/delete-with-responses` to remove responses too.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Published flow removed from local registry' },
        '400': { description: 'Flow is not published/deprecated' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/admin/meta-survey/{flowId}/delete-with-responses': {
    delete: {
      summary: 'Delete a flow and all its saved responses',
      tags: ['Admin - Meta Survey'],
      description: 'Deletes the flow handling state and all local response records for the given flow. For DRAFT flows, it hard-deletes on Meta. For published/deprecated flows, it deprecates (if needed) then removes local records.',
      parameters: [{ name: 'flowId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Flow and responses deleted from local DB' },
        '404': { description: 'Not found' }
      }
    }
  },

  '/api/crm/meta-survey/send': {
    post: {
      summary: 'Send a Meta Flow survey to one or many customers',
      tags: ['Admin - Meta Survey'],
      description: `Sends an interactive WhatsApp Flow message with a CTA button that opens the survey inside WhatsApp.

You can send to a **single customer** or a **list of customers** in one request.

The **\`flowToken\`** can be any non-empty string (for example \`first-survey\`).
- If omitted, the server auto-generates one.
- If sending to multiple recipients, the server appends \`-1\`, \`-2\`, ... to keep each token unique for DB correlation.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['to','flowId'],
              properties: {
                to: {
                  oneOf: [
                    { type: 'string', example: '2349013360717' },
                    { type: 'array', items: { type: 'string' }, example: ['2349013360717', '2348012345678'], minItems: 1 }
                  ],
                  description: 'Recipient phone or list of recipient phones in E.164 without +.'
                },
                flowId: { type: 'string', example: '1234567890', description: 'Meta Flow ID returned by POST /admin/meta-survey' },
                flowToken: { type: 'string', example: 'first-survey', description: 'Optional base token. Can be any non-empty string. For bulk sends, server auto-suffixes per recipient for uniqueness.' },
                cta: { type: 'string', default: 'Take Survey', description: 'CTA button label (max 20 chars)' },
                headerText: { type: 'string', description: 'Message header (max 60 chars)' },
                bodyText: { type: 'string', description: 'Message body shown before the CTA button (max 1024 chars)' },
                footerText: { type: 'string', description: 'Message footer (max 60 chars)' },
                phoneNumberId: { type: 'string', description: 'Override WhatsApp Phone Number ID (defaults to env var)' }
              }
            },
            examples: {
              single: {
                summary: 'Single recipient',
                value: {
                  to: '2349013360717',
                  flowId: '1234567890',
                  flowToken: 'first-survey',
                  cta: 'Take Survey',
                  bodyText: 'Please help us improve by completing a 1-minute survey.',
                  headerText: 'Quick Survey'
                }
              },
              bulk: {
                summary: 'Bulk recipients',
                value: {
                  to: ['2349013360717', '2348012345678'],
                  flowId: '1234567890',
                  flowToken: 'june-csat',
                  cta: 'Take Survey',
                  bodyText: 'Please complete this 1-minute survey.'
                }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Message(s) sent (all or partial success)' },
        '400': { description: 'Validation error' },
        '500': { description: 'Send failed for all recipients' }
      }
    }
  },

  '/webhook/meta-flow-data': {
    post: {
      summary: 'Meta Flow Data Endpoint (submissions receiver)',
      tags: ['Webhook'],
      description: `**WhatsApp Flows Data Endpoint** — Meta calls this URL during flow execution.

Set this as the \`dataEndpointUrl\` when creating surveys (or set \`SERVER_URL\` env var).

### Actions

| action | trigger | server response |
|--------|---------|-----------------|
| \`INIT\` | User opens QUESTIONS screen | \`{ screen: "QUESTIONS", data: {} }\` |
| \`data_exchange\` | User taps **Submit Responses** | Saves to DB → \`{ screen: "COMPLETE", data: {} }\` |
| \`BACK\` | User navigates back (if refresh_on_back=true) | \`{ screen: current, data: {} }\` |

### Response saved on \`data_exchange\`
Form fields are saved immediately to \`meta_flow_responses\` with:
- \`flow_id\` — the Meta Flow ID
- \`flow_token\` — unique token from the send (correlates to your send record)
- \`responses\` — map of question IDs → submitted values
- \`source: "data_exchange"\`

> **Production note:** Meta encrypts the payload. Add decryption using \`FLOW_PRIVATE_KEY\` before going live.`,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                version: { type: 'string', example: '3.0' },
                action: { type: 'string', enum: ['INIT','data_exchange','BACK'] },
                screen: { type: 'string', example: 'QUESTIONS' },
                data: { type: 'object', description: 'For data_exchange: map of form field names to values', example: { satisfaction: 'Very Satisfied', recommend: 'Yes', improvement: 'Faster app' } },
                flow_token: { type: 'string', example: 'a3f7c1d2-0000-4abc-b789-0000deadbeef' },
                flow_id: { type: 'string', example: '1234567890' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Returns next screen instruction for the Flow client' },
        '500': { description: 'Server error' }
      }
    }
  },

  '/api/meta-survey/responses': {
    get: {
      summary: 'Query Meta Flow survey responses',
      tags: ['Admin - Meta Survey'],
      description: 'Returns survey responses saved from Meta WhatsApp Flow submissions (both `data_exchange` and `nfm_reply` sources).',
      parameters: [
        { name: 'flowId', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by Meta Flow ID' },
        { name: 'customerPhone', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by customer phone (E.164 without +)' },
        { name: 'surveyId', in: 'query', required: false, schema: { type: 'string' }, description: 'Filter by internal survey ID' },
        { name: 'source', in: 'query', required: false, schema: { type: 'string', enum: ['data_exchange','nfm_reply'] }, description: 'Filter by submission source' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Start date (ISO 8601)' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'End date (ISO 8601)' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', default: 50, maximum: 500 } },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', default: 0 } }
      ],
      responses: {
        '200': {
          description: 'Array of response records',
          content: { 'application/json': { schema: { type: 'object', properties: {
            count: { type: 'integer' },
            total: { type: 'integer', description: 'Total matching records' },
            responses: { type: 'array', items: { type: 'object', properties: {
              id: { type: 'string' },
              flow_id: { type: 'string' },
              flow_token: { type: 'string' },
              customer_phone: { type: 'string', nullable: true },
              survey_id: { type: 'string', nullable: true },
              responses: { type: 'object', description: 'Map of question IDs to submitted values', example: { satisfaction: 'Very Satisfied', recommend: 'Yes' } },
              source: { type: 'string', enum: ['data_exchange','nfm_reply'] },
              created_at: { type: 'string', format: 'date-time' }
            }}}
          }}}}
        }
      }
    }
  },

  '/api/crm/survey-responses': {
    get: {
      summary: 'Retrieve survey responses',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Fetches stored survey responses from the database.

      Supports optional filtering by:
      - **surveyId**: Filter responses belonging to a specific survey
      - **customerNumber**: Filter responses for a specific customer (phone number)
      - **surveySessionId**: Filter responses from a specific survey session
      - **surveyed**: \`true\` returns only responses where the session is completed; \`false\` returns responses from active or abandoned sessions

      Used for:
      - Analytics dashboards
      - Reporting
      - Data export
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'query',
          required: false,
          description: 'Filter by survey ID',
          schema: { type: 'string' }
        },
        {
          name: 'customerNumber',
          in: 'query',
          required: false,
          description: 'Filter by customer phone number (E.164 format without +, e.g. 2348123456789)',
          schema: { type: 'string', example: '2348123456789' }
        },
        {
          name: 'surveySessionId',
          in: 'query',
          required: false,
          description: 'Filter by a specific survey session ID',
          schema: { type: 'string' }
        },
        {
          name: 'surveyed',
          in: 'query',
          required: false,
          description: '`true` — only responses from completed sessions; `false` — responses from active or abandoned sessions',
          schema: { type: 'string', enum: ['true', 'false'] }
        }
      ],
      responses: {
        '200': { description: 'Survey responses retrieved successfully' }
      }
    }
  },

  '/api/crm/meta-survey-responses': {
    get: {
      summary: 'Meta survey responses (placeholder)',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Placeholder endpoint for retrieving responses from Meta-hosted survey flows.

      Currently returns stub data and can be extended for full Meta integration.
      `,
      responses: {
        '200': { description: 'Stub response returned' }
      }
    }
  },
  
  '/admin/survey': {
    post: {
      summary: 'Create and store a manual survey template',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Creates a reusable survey template and stores it locally as a JSON file.

      These templates are used in "manual" mode when sending surveys, allowing predefined
      question flows instead of AI-generated ones.

      Use cases:
      - Regulatory-compliant surveys
      - Fixed questionnaires (e.g., NPS, onboarding feedback)

      The template must follow the SurveyTemplate schema.
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SurveyTemplate' }
          }
        }
      },
      responses: {
        '201': { description: 'Survey template created successfully' },
        '400': { description: 'Validation failed (invalid structure)' }
      }
    }
  },

  '/admin/survey/{surveyId}/participants': {
    get: {
      summary: 'Get survey participants',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Returns a list of unique customer phone numbers who have participated in a given survey.

      Data is retrieved from stored survey responses in the database.
      Useful for:
      - Analytics
      - Retargeting campaigns
      - Follow-up engagement
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
        ,
        {
          name: 'status',
          in: 'query',
          required: false,
          description: "Filter sessions by status. One of: active, completed, abandoned",
          schema: { type: 'string', enum: ['active','completed','abandoned'] }
        }
      ],
      responses: {
        '200': {
          description: 'Sessions with participant phone lists',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  surveyId: { type: 'string' },
                  sessions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        sessionId: { type: 'string' },
                        phones: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/admin/survey/{surveyId}/file': {
    delete: {
      summary: 'Delete survey template file',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Deletes a locally stored survey template JSON file from the data directory.

      This does NOT delete survey responses stored in the database.
      Only removes the template definition used for manual survey mode.
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Survey template file deleted successfully' },
        '404': { description: 'Survey file not found' }
      }
    }
  },

  '/admin/survey/{surveyId}': {
    delete: {
      summary: 'Delete survey (data + sessions)',
      tags: ['Admin - AI/Manual Survey'],
      description: `
      Deletes all data associated with a survey, including:
      - Survey responses
      - Survey sessions (progress tracking)
      - Associated template file (if it exists)

      This is a destructive operation and should be used with caution.
      Typically used for:
      - Data cleanup
      - Retesting environments
      `,
      parameters: [
        {
          name: 'surveyId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Survey data deleted successfully' },
        '500': { description: 'Failed to delete survey data' }
      }
    }
  },

  '/admin/escalations': {
    get: {
      summary: 'Get escalations',
      tags: ['Admin - Escalation'],
      description: `
      Returns a list of escalations (human handoff / tickets) from the database.

      Useful for:
      - Monitoring pending tickets
      - Tracking completed tickets
      - Analyzing escalation trends
      `,
      parameters: [
        {
          name: 'status',
          in: 'query',
          required: false,
          description: "Filter escalations by status. One of: pending, completed",
          schema: { type: 'string', enum: ['pending','completed'] }
        }
      ],
      responses: {
        '200': {
          description: 'List of escalations',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    ticket_id: { type: 'string' },
                    message: { type: 'string' },
                    category: { type: 'string', enum: ['complaint','enquiry','request'] },
                    ticket_status: { type: 'string', enum: ['pending','completed'] },
                    customer_phone: { type: 'string' },
                    human_agent_active: { type: 'boolean' },
                    handoff_phone: { type: 'string', nullable: true },
                    human_engaged_at: { type: 'string', format: 'date-time', nullable: true },
                    created_at: { type: 'string', format: 'date-time' },
                    updated_at: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/admin/escalation/{ticketId}/resolve': {
    post: {
      summary: 'Resolve escalation',
      tags: ['Admin - Escalation'],
      description: `
      Marks an escalation (human handoff / ticket) as completed in the database.

      Useful for:
      - Closing completed tickets
      - Updating ticket status
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],

      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ticketStatus: {
                  type: 'string',
                  enum: ['pending', 'completed'],
                  example: 'completed',
                  description: 'Status to set (default: completed)'
                },
                to: {
                  type: 'string',
                  example: '+2348012345678',
                  description: 'Customer phone number for notification'
                },
                message: {
                  type: 'string',
                  example: 'Your issue has been resolved successfully.',
                  description: 'Optional message to send to customer'
                }
              }
            }
          }
        }
      },

      responses: {
        '200': { description: 'Escalation resolved successfully' },
        '400': { description: 'Invalid request' },
        '404': { description: 'Escalation not found. Probably deleted' },
        '500': { description: 'Failed to resolve escalation' }
      }
    }
  },

  '/admin/escalation/{ticketId}/message': {
    post: {
      summary: 'Send human agent message',
      tags: ['Admin - Escalation'],
      description: `
      Sends a WhatsApp message to the customer for an active escalation.

      Useful for:
      - Letting a human agent claim and continue a conversation after AI handoff
      - Replying from a backend or supervisor console using the ticket created during escalation

      The first human message automatically marks the ticket as human-owned,
      so the bot stops replying only after a human agent has actually engaged.
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['message'],
              properties: {
                message: {
                  type: 'string',
                  example: 'Hello, this is Ada from FBNBank support. I am now handling your request.',
                  description: 'Message that the human agent wants to send to the customer'
                },
                to: {
                  type: 'string',
                  example: '+221770000000',
                  description: 'Optional override for the customer phone number; defaults to the number stored on the ticket'
                }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Human agent message sent successfully' },
        '400': { description: 'Invalid request payload' },
        '404': { description: 'Escalation not found' },
        '409': { description: 'Escalation is no longer active' },
        '502': { description: 'WhatsApp delivery failed' },
        '500': { description: 'Failed to send human agent message' }
      }
    }
  },
  '/admin/escalation/message': {
    post: {
      summary: 'Send spontaneous human message(s)',
      tags: ['Admin - Escalation'],
      description: `
      Sends a spontaneous human-originated WhatsApp message without requiring a ticket or thread id.

      Useful for:
      - Proactive outreach from support operations
      - Sending one-off updates to multiple customers directly

      This endpoint accepts a list of customer numbers and sends the same message to each number.
      `,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['message', 'to'],
              properties: {
                message: {
                  type: 'string',
                  example: 'Hello, this is FBNBank support with an important update.',
                  description: 'Message content to send to all recipients'
                },
                to: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string' },
                  example: ['+221770000000', '+2349013360717'],
                  description: 'List of customer phone numbers'
                }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Message sent to at least one recipient' },
        '400': { description: 'Invalid request payload' },
        '502': { description: 'Message delivery failed for all recipients' },
        '500': { description: 'Failed to send spontaneous human agent message' }
      }
    }
  },
  '/admin/escalation/{ticketId}/messages': {
    get: {
      summary: 'Get escalation messages',
      tags: ['Admin - Escalation'],
      description: `
      Returns inbound and outbound messages linked to an escalation ticket.

      Useful for:
      - Letting backend human-support consoles fetch customer replies during handoff
      - Auditing the human-agent conversation trail for a ticket
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        },
        {
          name: 'direction',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['inbound', 'outbound'] },
          description: 'Optional direction filter'
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          description: 'Maximum number of messages to return'
        }
      ],
      responses: {
        '200': { description: 'Escalation messages retrieved successfully' },
        '400': { description: 'Invalid request query parameters' },
        '404': { description: 'Escalation not found' },
        '500': { description: 'Failed to fetch escalation messages' }
      }
    }
  },
  '/admin/escalation/{ticketId}/release': {
    post: {
      summary: 'Release human handoff',
      tags: ['Admin - Escalation'],
      description: `
      Returns control of a pending escalation back to the AI without closing the ticket.

      Useful for:
      - Handing the conversation back to the bot when the human agent is done for now
      - Avoiding clashes when a human agent cannot continue immediately
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Human handoff released successfully' },
        '404': { description: 'Escalation not found' },
        '409': { description: 'Escalation is already completed' },
        '500': { description: 'Failed to release human handoff' }
      }
    }
  },
  '/admin/chat-history/messages': {
    get: {
      summary: 'Get detailed chat history',
      tags: ['Admin - Chat History'],
      description: `
      Returns detailed chat history records across Customer, AI, and Human roles.

      Filters supported:
      - threadId (phone/thread)
      - role (AI, Human, Customer)
      - escalationId
      - from/to datetime range
      - limit/offset pagination
      `,
      parameters: [
        { name: 'threadId', in: 'query', required: false, schema: { type: 'string' }, description: 'Phone/thread id to filter by' },
        { name: 'role', in: 'query', required: false, schema: { type: 'string', enum: ['AI', 'Human', 'Customer'] }, description: 'Message role filter' },
        { name: 'escalationId', in: 'query', required: false, schema: { type: 'string' }, description: 'Escalation ticket id filter' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records from this timestamp' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records up to this timestamp' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, description: 'Maximum number of messages to return' },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Pagination offset' }
      ],
      responses: {
        '200': { description: 'Detailed chat history fetched successfully' },
        '400': { description: 'Invalid query parameters' },
        '500': { description: 'Failed to fetch chat history messages' }
      }
    }
  },
  '/admin/chat-history/threads': {
    get: {
      summary: 'Get chat history threads summary',
      tags: ['Admin - Chat History'],
      description: `
      Returns thread-level chat history summary with role counts and timestamps.

      Useful for dashboards, inbox views, and selecting active customer conversations.
      Supports the same filters as detailed history.
      `,
      parameters: [
        { name: 'threadId', in: 'query', required: false, schema: { type: 'string' }, description: 'Phone/thread id to filter by' },
        { name: 'role', in: 'query', required: false, schema: { type: 'string', enum: ['AI', 'Human', 'Customer'] }, description: 'Filter threads having this role in range' },
        { name: 'escalationId', in: 'query', required: false, schema: { type: 'string' }, description: 'Escalation ticket id filter' },
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records from this timestamp' },
        { name: 'to', in: 'query', required: false, schema: { type: 'string', format: 'date-time' }, description: 'Include records up to this timestamp' },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, description: 'Maximum number of thread summaries to return' },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Pagination offset' }
      ],
      responses: {
        '200': { description: 'Thread summaries fetched successfully' },
        '400': { description: 'Invalid query parameters' },
        '500': { description: 'Failed to fetch chat history threads' }
      }
    }
  },
  '/admin/escalation/{ticketId}': {
    delete: {
      summary: 'Delete escalation',
      tags: ['Admin - Escalation'],
      description: `
      Deletes an escalation (human handoff / ticket) from the database.

      Useful for:
      - Removing completed tickets
      - Cleaning up old escalations
      `,
      parameters: [
        {
          name: 'ticketId',
          in: 'path',
          required: true,
          schema: { type: 'string' }
        }
      ],
      responses: {
        '200': { description: 'Escalation deleted successfully' },
        '404': { description: 'The escalation with this ID is not found. Probably deleted' },
        '500': { description: 'Failed to delete escalation' }
      }
    }
  },


  '/api/agent/chat': {
    post: {
      summary: 'Chat with the Engagement Agent (testing)',
      description: 'Send a message to the FBNBank Senegal engagement agent and receive a reply. Uses thread-based memory keyed on `phone`.',
      tags: ['Agent'],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['message'],
              properties: {
                message: { type: 'string', description: 'The customer message to send to the agent', example: 'Bonjour' },
                phone: { type: 'string', description: 'Phone number used as the memory thread key (optional, defaults to "test-user")', example: '+221770000000' },
                contactName: { type: 'string', description: 'Optional customer display name', example: 'Amadou' },
              }
            }
          }
        }
      },
      responses: {
        '200': {
          description: 'Agent reply',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  success: { type: 'boolean' },
                  reply: { type: 'string' }
                }
              }
            }
          }
        },
        '400': { description: 'Missing message field' },
        '500': { description: 'Agent error' }
      }
    }
  },

  '/api/kb/upload': {
    post: {
      summary: 'Upload document(s) to knowledge base',
      tags: ['Knowledge Base'],
      description: 'Uploads one or more files (PDF, TXT, CSV, DOCX, DOC, XLSX, XLS) or raw text to the knowledge base. Each document is chunked, embedded, and stored in the vector index.',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              properties: {
                files: { type: 'array', items: { type: 'string', format: 'binary' }, description: 'PDF, TXT, CSV, DOCX, DOC, XLSX, or XLS files' },
                text: { type: 'string', description: 'Raw text to ingest directly' },
                title: { type: 'string', description: 'Optional document title' }
              }
            }
          }
        }
      },
      responses: {
        '200': { description: 'Documents ingested successfully' },
        '400': { description: 'No file or text provided' },
        '500': { description: 'Ingestion failed' }
      }
    }
  },

  '/api/kb/docs': {
    get: {
      summary: 'List all knowledge base documents',
      tags: ['Knowledge Base'],
      description: 'Returns metadata for all documents currently in the knowledge base index.',
      responses: {
        '200': {
          description: 'List of document metadata',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  docs: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        doc_id: { type: 'string' },
                        title: { type: 'string' },
                        original_name: { type: 'string' },
                        size: { type: 'integer' },
                        uploaded_at: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  },

  '/api/kb/docs/{docId}': {
    get: {
      summary: 'Get knowledge base document by ID',
      tags: ['Knowledge Base'],
      parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Document metadata' },
        '404': { description: 'Document not found' }
      }
    },
    delete: {
      summary: 'Delete a document from the knowledge base',
      tags: ['Knowledge Base'],
      description: 'Removes the document vectors, the uploaded file, and the metadata record.',
      parameters: [{ name: 'docId', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Document deleted successfully' },
        '404': { description: 'Document not found' },
        '500': { description: 'Deletion failed' }
      }
    }
  },

  '/': {
    get: {
      summary: 'Health check',
      description: 'Returns a simple liveness confirmation that the server is up and running.',
      tags: ['Health'],
      responses: {
        '200': {
          description: 'Server is running',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string', example: 'I am alive!' }
                }
              }
            }
          }
        }
      }
    }
  }

}
}





app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "I am alive!" });
});



app.use('/api-docs', (swaggerUi.serve as any), (swaggerUi.setup(swaggerDocument) as any));


// WhatsApp Webhook: Verification
app.get('/webhook/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(challenge);
    } else {
      return res.sendStatus(403);
    }
  }
  return res.sendStatus(400);
});



app.post('/webhook/whatsapp', async (req: Request, res: Response) => {
  const body = req.body;

  try {
    if (!body.object) {
      return res.sendStatus(404);
    }

    // Handle message status events (delivery/read) if present
    const statuses = body?.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (statuses && Array.isArray(statuses) && statuses.length > 0) {
      console.log('📣 Received message statuses:', JSON.stringify(statuses, null, 2));
      // Could update DB with delivery/read receipts here
      return res.sendStatus(200);
    }

    const changeValue = body?.entry?.[0]?.changes?.[0]?.value;
    const message = changeValue?.messages?.[0];
    // Try to extract the contact/profile name from the Meta webhook payload
    const contacts = changeValue?.contacts;
    const phoneNumberId: string | undefined = changeValue?.metadata?.phone_number_id || undefined;
    const contactName = Array.isArray(contacts) && contacts.length > 0
      ? (contacts[0]?.profile?.name || contacts[0]?.name || contacts[0]?.pushname || null)
      : null;

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const messageId: string = message.id || '';

    if (messageId && isDuplicateInboundMessage(messageId)) {
      console.log(`↩️ Skipping duplicate inbound message ${messageId}`);
      return res.sendStatus(200);
    }

    console.log(`📩 Incoming message from ${from}`);
    console.log(JSON.stringify(message, null, 2));

    // Mark the incoming message as read immediately (turns grey ticks blue)
    if (messageId) {
      sendWhatsAppReadReceipt({ messageId, phoneNumberId }).catch(() => {});
    }

    //  Get DB + mastra
    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      throw new Error('DB not initialized');
    }

    //  Call your router (THIS is the key line)
    await routeIncomingMessage({
      db,
      mastra,
      message,
      phone: from,
      contactName,
      messageId,
      phoneNumberId,
      lastOutboundType,

      sendMessage: async (to: string, msg: string) => {
        // mark last outbound as chat
        setLastOutbound(String(to), 'chat');
        await sendWhatsAppMessage({ to, message: msg, phoneNumberId });

        try {
          const threadId = normalizePhone(String(to));
          const pendingEscalation = await escalationService.getLatestActiveEscalationByPhone(db, threadId);
          await chatHistoryService.logChatMessage({
            db,
            threadId,
            role: 'AI',
            messageText: msg,
            escalationId: pendingEscalation?.ticket_id || null,
          });
        } catch (err) {
          console.error('Failed to log outbound AI chat message', err);
        }
      },

      sendQuestion: async (to: string, question: any, session: any) => {
        // mark last outbound as survey question
        setLastOutbound(String(to), 'survey_question');

        // Handle text-only question
        if (!question.options || question.options.length === 0) {
          await sendWhatsAppMessage({
            to,
            message: question.question || question.text || "Please provide your response:",
            phoneNumberId,
          });
          return;
        }

        // Handle interactive (buttons)
        await sendWhatsAppSurvey({
          to,
          surveyId: session.survey_id,
          question: question.question,
          options: question.options,
          phoneNumberId,
        });
      },
    });

    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return res.sendStatus(500);
  }
});




// ---------------- Admin endpoints ----------------
// GET participants for a survey
// Returns an array of objects { sessionId, phones: [customer_phone, ...] }
// Each survey can have multiple sessions (re-sends); we group responses by session_id
app.get('/admin/survey/:surveyId/participants', async (req: Request, res: Response) => {
  const surveyId = req.params.surveyId;
  const status = (req.query?.status as string) || undefined;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    // Validate status if provided
    const allowed = ['active','completed','abandoned'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(',')}` });
    }

    // Group by session_id and collect distinct phones for each session
    let rows: any[] = [];
    if (status) {
      rows = await db.any(
        `SELECT r.session_id, array_agg(DISTINCT r.customer_phone) AS phones
         FROM survey_responses r
         JOIN survey_sessions s ON r.session_id = s.id
         WHERE r.survey_id = $1 AND s.status = $2
         GROUP BY r.session_id
         ORDER BY MAX(r.created_at) DESC`,
        [surveyId, status]
      );
    } else {
      rows = await db.any(
        `SELECT r.session_id, array_agg(DISTINCT r.customer_phone) AS phones
         FROM survey_responses r
         JOIN survey_sessions s ON r.session_id = s.id
         WHERE r.survey_id = $1
         GROUP BY r.session_id
         ORDER BY MAX(r.created_at) DESC`,
        [surveyId]
      );
    }

    const sessions = Array.isArray(rows)
      ? rows.map((r: any) => ({ sessionId: r.session_id, phones: r.phones || [] }))
      : [];

    return res.json({ surveyId, sessions });
  } catch (e) {
    console.error('Failed to fetch participants', e);
    return res.status(500).json({ error: 'failed' });
  }
});



// POST create/save a manual survey JSON into data/<surveyId>.json
const SurveyQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  options: z.array(z.string()).optional(),
  type: z.enum(['button', 'list', 'text']),
  sectionTitle: z.string().optional(),
  placeholder: z.string().optional(),
});

const SurveyTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  questions: z.array(SurveyQuestionSchema),
});

app.post('/admin/survey', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    const parse = SurveyTemplateSchema.safeParse(body);
    if (!parse.success) {
      return res.status(400).json({ error: 'validation_failed', details: parse.error.format() });
    }

    const tpl = parse.data;
    const outDir = path.join(process.cwd(), 'data');
    try { await fs.mkdir(outDir, { recursive: true }); } catch (e) {}
    const filePath = path.join(outDir, `${tpl.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(tpl, null, 2), 'utf-8');

    return res.status(201).json({ success: true, file: `data/${tpl.id}.json` });
  } catch (e) {
    console.error('Failed to create survey template', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// DELETE manual survey file from data/<surveyId>.json
app.delete('/admin/survey/:surveyId/file', async (req: Request, res: Response) => {
  const surveyId = req.params.surveyId;
  try {
    const filePath = path.join(process.cwd(), 'data', `${surveyId}.json`);
    try {
      await fs.unlink(filePath);
      return res.json({ success: true, file: `data/${surveyId}.json`, deleted: true });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return res.status(404).json({ error: 'not_found', message: 'file not found' });
      }
      throw err;
    }
  } catch (e) {
    console.error('Failed to delete survey file', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// DELETE survey data from DB (responses + sessions) and remove manual file if present
app.delete('/admin/survey/:surveyId', async (req: Request, res: Response) => {
  const surveyId = req.params.surveyId;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    // Delete responses and sessions for this survey
    try {
      await db.query('BEGIN');
      await db.query('DELETE FROM survey_responses WHERE survey_id = $1', [surveyId]);
      await db.query('DELETE FROM survey_sessions WHERE survey_id = $1', [surveyId]);
      await db.query('COMMIT');
    } catch (e) {
      try { await db.query('ROLLBACK'); } catch (_) {}
      throw e;
    }

    // Also attempt to remove a manual file if present
    const filePath = path.join(process.cwd(), 'data', `${surveyId}.json`);
    let fileDeleted = false;
    try {
      await fs.unlink(filePath);
      fileDeleted = true;
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    return res.json({ success: true, surveyId, fileDeleted });
  } catch (e) {
    console.error('Failed to delete survey data', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// ---------------- Escalation endpoints ----------------
// GET /admin/escalations?status=pending|completed
app.get('/admin/escalations', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || undefined;
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const allowed = ['pending', 'completed'];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Allowed: ${allowed.join(',')}` });
    }

    const rows = await escalationService.getEscalations(db, status);
    return res.json({ escalations: rows });
  } catch (e) {
    console.error('Failed to fetch escalations', e);
    return res.status(500).json({ error: 'failed' });
  }
});


app.post('/admin/escalation/:ticketId/message', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const parse = z.object({
      message: z.string().trim().min(1),
      to: z.string().trim().optional(),
    }).safeParse(req.body || {});

    if (!parse.success) {
      return res.status(400).json({ error: 'validation_failed', details: parse.error.format() });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const result = await escalationService.sendHumanAgentMessage({
      db,
      ticketId,
      message: parse.data.message,
      to: parse.data.to,
      sendMessage: async (to: string, message: string) => sendWhatsAppMessage({ to, message }),
    });

    if (!result.sent) {
      return res.status(502).json({
        error: 'Failed to deliver human agent message to WhatsApp',
        ticketId,
        to: result.to,
      });
    }

    try {
      await chatHistoryService.logChatMessage({
        db,
        threadId: result.to,
        role: 'Human',
        messageText: parse.data.message,
        escalationId: ticketId,
      });
    } catch (error) {
      console.error('Failed to log outbound human chat message', error);
    }

    return res.status(200).json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    if (err.message === 'message is required' || err.message === 'customer_phone (to) is required') {
      return res.status(400).json({ error: err.message });
    }

    if (err.message === 'not_found') {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    if (err.message === 'ticket_not_active') {
      return res.status(409).json({ error: 'Only pending escalations can receive human agent messages' });
    }

    console.error('Failed to send human agent message', err);
    return res.status(500).json({ error: 'Failed to send human agent message' });
  }
});

app.post('/admin/escalation/message', async (req: Request, res: Response) => {
  try {
    const parse = z.object({
      message: z.string().trim().min(1),
      to: z.array(z.string().trim().min(1)).min(1),
    }).safeParse(req.body || {});

    if (!parse.success) {
      return res.status(400).json({ error: 'validation_failed', details: parse.error.format() });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const recipients = Array.from(new Set(parse.data.to.map((n) => normalizePhone(n)).filter(Boolean)));
    if (recipients.length === 0) {
      return res.status(400).json({ error: 'to must contain at least one valid phone number' });
    }

    const results = await Promise.all(
      recipients.map(async (to) => {
        const sent = await sendWhatsAppMessage({ to, message: parse.data.message });

        if (sent) {
          try {
            await chatHistoryService.logChatMessage({
              db,
              threadId: to,
              role: 'Human',
              messageText: parse.data.message,
              escalationId: null,
            });
          } catch (error) {
            console.error('Failed to log spontaneous outbound human chat message', error);
          }
        }

        return { to, sent };
      })
    );

    const sentCount = results.filter((r) => r.sent).length;
    const failedCount = results.length - sentCount;

    if (sentCount === 0) {
      return res.status(502).json({
        error: 'Failed to deliver message to all recipients',
        summary: { total: results.length, sentCount, failedCount },
        results,
      });
    }

    return res.status(200).json({
      success: true,
      summary: { total: results.length, sentCount, failedCount },
      results,
    });
  } catch (err) {
    console.error('Failed to send spontaneous human agent message', err);
    return res.status(500).json({ error: 'Failed to send spontaneous human agent message' });
  }
});

app.get('/admin/chat-history/messages', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : undefined;
    const role = typeof req.query.role === 'string' ? req.query.role.trim() as 'AI' | 'Human' | 'Customer' : undefined;
    const escalationId = typeof req.query.escalationId === 'string' ? req.query.escalationId.trim() : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const offset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

    if (role && !['AI', 'Human', 'Customer'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }

    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    }

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    const messages = await chatHistoryService.getChatHistory(db, {
      threadId,
      role,
      escalationId,
      from,
      to,
      limit,
      offset,
    });

    return res.status(200).json({
      filters: {
        threadId: threadId || null,
        role: role || null,
        escalationId: escalationId || null,
        from: from || null,
        to: to || null,
        limit,
        offset,
      },
      count: messages.length,
      messages,
    });
  } catch (e: any) {
    if (e.message === 'Invalid role') {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }
    console.error('Failed to fetch chat history messages', e);
    return res.status(500).json({ error: 'Failed to fetch chat history messages' });
  }
});

app.get('/admin/chat-history/threads', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const threadId = typeof req.query.threadId === 'string' ? req.query.threadId.trim() : undefined;
    const role = typeof req.query.role === 'string' ? req.query.role.trim() as 'AI' | 'Human' | 'Customer' : undefined;
    const escalationId = typeof req.query.escalationId === 'string' ? req.query.escalationId.trim() : undefined;
    const from = typeof req.query.from === 'string' ? req.query.from.trim() : undefined;
    const to = typeof req.query.to === 'string' ? req.query.to.trim() : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
    const offset = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

    if (role && !['AI', 'Human', 'Customer'].includes(role)) {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }

    if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 500' });
    }

    if (!Number.isFinite(offset) || offset < 0) {
      return res.status(400).json({ error: 'offset must be a non-negative integer' });
    }

    const threads = await chatHistoryService.getChatHistoryThreads(db, {
      threadId,
      role,
      escalationId,
      from,
      to,
      limit,
      offset,
    });

    return res.status(200).json({
      filters: {
        threadId: threadId || null,
        role: role || null,
        escalationId: escalationId || null,
        from: from || null,
        to: to || null,
        limit,
        offset,
      },
      count: threads.length,
      threads,
    });
  } catch (e: any) {
    if (e.message === 'Invalid role') {
      return res.status(400).json({ error: 'role must be one of: AI, Human, Customer' });
    }
    console.error('Failed to fetch chat history threads', e);
    return res.status(500).json({ error: 'Failed to fetch chat history threads' });
  }
});

app.post('/admin/escalation/:ticketId/release', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const ticket = await escalationService.getEscalationByTicketId(db, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    if (ticket.ticket_status !== 'pending') {
      return res.status(409).json({ error: 'Only pending escalations can be released back to the bot' });
    }

    const updated = await escalationService.setHumanAgentActive(db, ticketId, false);
    if (!updated) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    return res.status(200).json({
      success: true,
      ticketId,
      ticketStatus: updated.ticket_status,
      humanAgentActive: updated.human_agent_active,
    });
  } catch (e) {
    console.error('Failed to release human handoff', e);
    return res.status(500).json({ error: 'Failed to release human handoff' });
  }
});

app.get('/admin/escalation/:ticketId/messages', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;
    const directionRaw = req.query.direction;
    const limitRaw = req.query.limit;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const direction = typeof directionRaw === 'string' ? directionRaw.trim().toLowerCase() : undefined;
    if (direction && !['inbound', 'outbound'].includes(direction)) {
      return res.status(400).json({ error: 'direction must be one of: inbound, outbound' });
    }

    const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : 50;
    if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 200' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    const ticket = await escalationService.getEscalationByTicketId(db, ticketId);
    if (!ticket) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    const messages = await escalationService.getEscalationMessages(
      db,
      ticketId,
      direction as 'inbound' | 'outbound' | undefined,
      limit
    );

    return res.status(200).json({
      ticketId,
      count: messages.length,
      messages,
    });
  } catch (e) {
    console.error('Failed to fetch escalation messages', e);
    return res.status(500).json({ error: 'Failed to fetch escalation messages' });
  }
});


// body: { ticketId?: string, ticketStatus?: 'pending'|'completed', to?: string, message?: string }
app.post('/admin/escalation/:ticketId/resolve', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    const { ticketStatus, to, message } = req.body || {};

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    try {
      const result = await escalationService.notifyAndMaybeUpdate({
        db,
        ticketId,
        ticketStatus: ticketStatus || 'completed',
        to,
        message,
        sendMessage: async (t: string, m: string) =>
          sendWhatsAppMessage({ to: t, message: m }),
      });

      return res.status(200).json({
        success: true,
        ticketId,
        status: ticketStatus || 'completed',
        ...result,
      });

    } catch (err: any) {
      if (err.message === 'Invalid ticketStatus') {
        return res.status(400).json({
          error: 'Invalid ticketStatus. Allowed values: pending, completed',
        });
      }

      if (err.message === 'customer_phone (to) is required') {
        return res.status(400).json({
          error: 'customer_phone (to) is required or not found for ticketId',
        });
      }

      if (err.message === 'not_found') {
        return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
      }

      console.error('Failed to resolve escalation', err);
      return res.status(500).json({ error: 'Failed to resolve escalation' });
    }

  } catch (e) {
    console.error('Failed to resolve escalation', e);
    return res.status(500).json({ error: 'Failed to resolve escalation' });
  }
});

// ─── Admin - Meta Survey Routes ──────────────────────────────────────────────

app.post('/admin/meta-survey', async (req: Request, res: Response) => {
  try {
    const { name, description, surveyId, thankYouText, questions, autoPublish, dataEndpointUrl } = req.body || {};

    if (!name || !Array.isArray(questions) || questions.length === 0) {
      return res.status(400).json({ error: 'name and questions (non-empty array) are required' });
    }

    const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
    const endpointUrl = dataEndpointUrl || `${serverUrl}/webhook/meta-flow-data`;

    if (!endpointUrl.startsWith('https://')) {
      return res.status(400).json({
        error: 'dataEndpointUrl must be a valid HTTPS URL. Set the SERVER_URL env var or pass dataEndpointUrl in the body.',
      });
    }

    for (const q of questions) {
      if (!q.id || !q.text || !q.type) {
        return res.status(400).json({ error: `Each question must have id, text, and type. Invalid: ${JSON.stringify(q)}` });
      }
      if (['list', 'button'].includes(q.type) && (!Array.isArray(q.options) || q.options.length === 0)) {
        return res.status(400).json({ error: `Question "${q.id}" of type "${q.type}" must have a non-empty options array` });
      }
    }

    const flowJson = buildSurveyFlowJson({ id: surveyId, name, description, questions, thankYouText }, endpointUrl);
    const flowJsonBuffer = Buffer.from(JSON.stringify(flowJson, null, 2));

    const flowId = await createMetaFlow(name, ['SURVEY']);
    const uploadResult = await uploadFlowJsonBuffer(flowId, flowJsonBuffer);

    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) throw new Error('DB not initialized');

    await metaSurveyService.upsertMetaFlowSurvey(db, {
      flowId, flowName: name, surveyId: surveyId || null,
      questionsData: questions, status: 'draft', dataEndpointUrl: endpointUrl,
    });

    let publishResult: any = null;
    if (autoPublish) {
      publishResult = await publishFlow(flowId);
      await metaSurveyService.markFlowPublished(db, flowId);
    }

    return res.status(201).json({
      success: true, flowId, surveyId: surveyId || null,
      status: autoPublish ? 'published' : 'draft',
      dataEndpointUrl: endpointUrl, uploadResult, publishResult,
    });
  } catch (e: any) {
    console.error('POST /admin/meta-survey failed', e);
    return res.status(500).json({ error: e.message || 'Failed to create meta survey' });
  }
});

app.get('/admin/meta-survey', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const surveys = await metaSurveyService.listMetaFlowSurveys(db);
    return res.status(200).json({ count: surveys.length, surveys });
  } catch (e: any) {
    console.error('GET /admin/meta-survey failed', e);
    return res.status(500).json({ error: e.message || 'Failed to list meta surveys' });
  }
});

app.get('/admin/meta-survey/:flowId', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });
    let meta: any = null;
    try { meta = await getFlow(flowId); } catch (_) { /* non-fatal */ }
    return res.status(200).json({ local, meta });
  } catch (e: any) {
    console.error(`GET /admin/meta-survey/${flowId} failed`, e);
    return res.status(500).json({ error: e.message || 'Failed to get meta survey' });
  }
});

app.post('/admin/meta-survey/:flowId/publish', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });
    const result = await publishFlow(flowId);
    await metaSurveyService.markFlowPublished(db, flowId);
    return res.status(200).json({ success: true, flowId, result });
  } catch (e: any) {
    console.error(`POST /admin/meta-survey/${flowId}/publish failed`, e);
    return res.status(500).json({ error: e.message || 'Publish failed' });
  }
});

app.post('/admin/meta-survey/:flowId/deprecate', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const result = await deprecateFlow(flowId);
    await metaSurveyService.markFlowDeprecated(db, flowId);
    return res.status(200).json({ success: true, flowId, result });
  } catch (e: any) {
    console.error(`POST /admin/meta-survey/${flowId}/deprecate failed`, e);
    return res.status(500).json({ error: e.message || 'Deprecate failed' });
  }
});

app.delete('/admin/meta-survey/:flowId', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });
    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });
    if (local.status === 'published') {
      return res.status(400).json({ error: 'Published flows cannot be hard-deleted. Use DELETE /admin/meta-survey/:flowId/delete-published instead.' });
    }
    await deleteFlow(flowId);
    await metaSurveyService.deleteMetaFlowSurveyRecord(db, flowId);
    return res.status(200).json({ success: true, flowId, deleted: true });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId} failed`, e);
    return res.status(500).json({ error: e.message || 'Delete failed' });
  }
});

app.delete('/admin/meta-survey/:flowId/delete-published', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });

    if (!['published', 'deprecated'].includes(local.status)) {
      return res.status(400).json({ error: 'Only published/deprecated flows can use this endpoint. Use DELETE /admin/meta-survey/:flowId for draft flows.' });
    }

    if (local.status === 'published') {
      await deprecateFlow(flowId);
      await metaSurveyService.markFlowDeprecated(db, flowId);
    }

    await metaSurveyService.deleteMetaFlowSurveyRecord(db, flowId);
    return res.status(200).json({ success: true, flowId, deletedSurvey: true, responsesDeleted: false });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId}/delete-published failed`, e);
    return res.status(500).json({ error: e.message || 'Delete published flow failed' });
  }
});

app.delete('/admin/meta-survey/:flowId/delete-with-responses', async (req: Request, res: Response) => {
  const { flowId } = req.params;
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const local = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flowId);
    if (!local) return res.status(404).json({ error: 'Survey not found in local database' });

    if (local.status === 'draft') {
      await deleteFlow(flowId);
    } else if (local.status === 'published') {
      await deprecateFlow(flowId);
      await metaSurveyService.markFlowDeprecated(db, flowId);
    }

    const totalResponses = await metaSurveyService.countMetaFlowResponses(db, { flowId });
    await metaSurveyService.deleteMetaFlowResponsesByFlowId(db, flowId);
    await metaSurveyService.deleteMetaFlowSurveyRecord(db, flowId);

    return res.status(200).json({
      success: true,
      flowId,
      deletedSurvey: true,
      responsesDeleted: totalResponses,
    });
  } catch (e: any) {
    console.error(`DELETE /admin/meta-survey/${flowId}/delete-with-responses failed`, e);
    return res.status(500).json({ error: e.message || 'Delete flow and responses failed' });
  }
});

app.post('/api/crm/meta-survey/send', async (req: Request, res: Response) => {
  try {
    const { to, flowId, flowToken, cta, headerText, bodyText, footerText, phoneNumberId } = req.body || {};
    if (!to || !flowId) {
      return res.status(400).json({ error: 'to and flowId are required' });
    }

    const recipients = (Array.isArray(to) ? to : [to])
      .map((phone: any) => normalizePhone(String(phone || '')))
      .filter(Boolean);

    if (recipients.length === 0) {
      return res.status(400).json({ error: 'at least one valid recipient is required in to' });
    }

    const baseFlowToken = typeof flowToken === 'string' && flowToken.trim().length > 0
      ? flowToken.trim()
      : `flow-${Date.now()}-${randomUUID().slice(0, 8)}`;

    if (baseFlowToken.length > 120) {
      return res.status(400).json({ error: 'flowToken must be 120 characters or fewer' });
    }

    const settled = await Promise.allSettled(recipients.map((phone, i) => {
      const tokenForRecipient = recipients.length === 1
        ? baseFlowToken
        : `${baseFlowToken}-${i + 1}`;

      return sendFlowMessage({
        to: phone,
        flowId,
        flowToken: tokenForRecipient,
        cta: cta || 'Take Survey',
        headerText,
        bodyText,
        footerText,
        phoneNumberId,
      }).then((result) => ({ to: phone, flowToken: tokenForRecipient, result }));
    }));

    const results = settled.map((entry, idx) => {
      const phone = recipients[idx];
      const tokenForRecipient = recipients.length === 1 ? baseFlowToken : `${baseFlowToken}-${idx + 1}`;
      if (entry.status === 'fulfilled') {
        return { success: true, to: phone, flowToken: tokenForRecipient, result: entry.value.result };
      }
      const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      return { success: false, to: phone, flowToken: tokenForRecipient, error: message };
    });

    const sent = results.filter((r) => r.success).length;
    const failed = results.length - sent;

    if (sent === 0) {
      return res.status(500).json({
        success: false,
        error: 'Failed to send flow message to all recipients',
        flowId,
        sent,
        failed,
        results,
      });
    }

    return res.status(200).json({
      success: true,
      partial: failed > 0,
      flowId,
      baseFlowToken,
      sent,
      failed,
      results,
    });
  } catch (e: any) {
    console.error('POST /api/crm/meta-survey/send failed', e);
    return res.status(500).json({ error: e.message || 'Failed to send flow message' });
  }
});

// POST /webhook/meta-flow-data — WhatsApp Flow Data Endpoint
// Meta calls this during flow execution for INIT and data_exchange actions.
app.post('/webhook/meta-flow-data', async (req: Request, res: Response) => {
  try {
    // Production: Meta encrypts the request. Decrypt using FLOW_PRIVATE_KEY before reading body.
    const body = req.body || {};
    const { version = '3.0', action, screen, data, flow_token, flow_id } = body;

    console.log('[meta-flow-data] action=%s screen=%s token=%s', action, screen, flow_token);

    if (action === 'INIT' || action === 'BACK') {
      return res.status(200).json({ version, screen: screen || 'QUESTIONS', data: {} });
    }

    if (action === 'data_exchange') {
      const storage = mastra.getStorage() as any;
      const db = storage?.db;

      if (db && flow_id && flow_token && data && typeof data === 'object') {
        let surveyId: string | undefined;
        try {
          const rec = await metaSurveyService.getMetaFlowSurveyByFlowId(db, flow_id);
          surveyId = rec?.survey_id ?? undefined;
        } catch (_) { /* non-fatal */ }

        await metaSurveyService.saveMetaFlowResponse(db, {
          flowId: flow_id,
          flowToken: flow_token,
          surveyId,
          responses: data as Record<string, any>,
          source: 'data_exchange',
        });
        console.log('[meta-flow-data] Saved response flow=%s token=%s', flow_id, flow_token);
      }

      return res.status(200).json({ version, screen: 'COMPLETE', data: {} });
    }

    return res.status(200).json({ version, screen: screen || 'INTRO', data: {} });
  } catch (e: any) {
    console.error('POST /webhook/meta-flow-data failed', e);
    return res.status(200).json({ version: '3.0', screen: 'COMPLETE', data: {} });
  }
});

app.get('/api/meta-survey/responses', async (req: Request, res: Response) => {
  try {
    const storage = mastra.getStorage() as any;
    const db = storage?.db;
    if (!db) return res.status(500).json({ error: 'DB not initialized' });

    const { flowId, customerPhone, surveyId, source, from, to } = req.query as Record<string, string>;
    const limit = req.query.limit ? Math.min(Number.parseInt(req.query.limit as string, 10), 500) : 50;
    const offset = req.query.offset ? Number.parseInt(req.query.offset as string, 10) : 0;

    if (!Number.isFinite(limit) || limit < 1) return res.status(400).json({ error: 'limit must be a positive integer (max 500)' });
    if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: 'offset must be a non-negative integer' });

    const [responses, total] = await Promise.all([
      metaSurveyService.queryMetaFlowResponses(db, { flowId, customerPhone, surveyId, source, from, to, limit, offset }),
      metaSurveyService.countMetaFlowResponses(db, { flowId, customerPhone, surveyId }),
    ]);

    return res.status(200).json({ count: responses.length, total, limit, offset, responses });
  } catch (e: any) {
    console.error('GET /api/meta-survey/responses failed', e);
    return res.status(500).json({ error: e.message || 'Failed to query responses' });
  }
});

// delete /admin/escalation/:ticketId - could be added to remove escalations if needed, but not implemented here for safety
app.delete('/admin/escalation/:ticketId', async (req: Request, res: Response) => {
  try {
    const rawTicketId = req.params.ticketId;
    const ticketId = Array.isArray(rawTicketId) ? rawTicketId[0] : rawTicketId;

    if (!ticketId) {
      return res.status(400).json({ error: 'ticketId is required' });
    }

    const storage = mastra.getStorage() as any;
    const db = storage?.db;

    if (!db) {
      return res.status(500).json({ error: 'DB not initialized' });
    }

    // Optional safety: only allow deleting resolved tickets
    const existing = await db.query(
      'SELECT ticket_id, ticket_status FROM escalations WHERE ticket_id = $1',
      [ticketId]
    );

    if (!existing.rows.length) {
      return res.status(404).json({ error: 'The escalation with this ID is not found. Probably deleted' });
    }

    const escalation = existing.rows[0];

    if (escalation.ticket_status !== 'completed') {
      return res.status(400).json({
        error: 'Only completed escalations can be deleted',
      });
    }

    // 🧨 Actual delete
    await db.query('DELETE FROM escalations WHERE ticket_id = $1', [ticketId]);

    return res.status(200).json({
      success: true,
      ticketId,
      deleted: true,
    });

  } catch (e) {
    console.error('Failed to delete escalation', e);
    return res.status(500).json({ error: 'Failed to delete escalation' });
  }
});




await initDatabase().catch(console.error);
await createKbDocsTable().catch(console.error);
await initVectorIndex().catch(console.error);

async function startServer() {
  try {
    const server = new MastraServer({ app: app as any, mastra });
    await server.init();

    // const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    app.listen(PORT, () => {
      console.log(`Server is listening at ${PORT} and running at ${URL}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

startServer();
