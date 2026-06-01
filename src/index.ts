

import "dotenv/config";
import fs from 'fs/promises';
import path from 'path';
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


const URL=  process.env.LOCAL_URL

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
    { name: 'CRM', description: 'CRM-triggered survey and campaign endpoints' },
    { name: 'Admin - Survey', description: 'Survey template and survey dataset management' },
    { name: 'Admin - Escalation', description: 'Human handoff and escalation operations' },
    { name: 'Admin - Chat History', description: 'Thread and message history retrieval endpoints' },
    { name: 'Knowledge Base', description: 'Knowledge base document ingest and management' },
    { name: 'Agent', description: 'Agent testing endpoint' },
    { name: 'Health', description: 'Liveness endpoint' },
  ],
  components: {
    schemas: {
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
      tags: ['CRM'],
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
                context: { type: 'string', description: 'Optional AI context for personalization' }
              },
              required: ['to', 'surveyId', 'topic', 'mode']
            },
            examples: {
              ai_mode: {
                summary: 'AI mode — dynamic question generation',
                value: { to: '2348123456789', surveyId: 'sat-001', topic: 'Customer Satisfaction', mode: 'ai', context: 'Premium tier customer' }
              },
              manual_mode: {
                summary: 'Manual mode — predefined template',
                value: { to: '2348123456789', surveyId: 'nps-template-001', topic: 'NPS Survey', mode: 'manual' }
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
    tags: ['CRM'],
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

  '/api/crm/create-meta-flow': {
    post: {
      summary: 'Create and publish Meta (WhatsApp) flow',
      tags: ['CRM'],
      description: `
        Creates and publishes a WhatsApp interactive flow using Meta APIs.

        Used for structured, pre-approved conversational flows outside the 24-hour messaging window.

        Typically required for:
        - Compliance messaging
        - Proactive outreach
      `,
      responses: {
        '200': { description: 'Meta flow created and published' },
        '500': { description: 'Flow creation failed' }
      }
    }
  },

  '/api/crm/survey-responses': {
    get: {
      summary: 'Retrieve survey responses',
      tags: ['CRM'],
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
      tags: ['CRM'],
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
      tags: ['Admin - Survey'],
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
      tags: ['Admin - Survey'],
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
      tags: ['Admin - Survey'],
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
      tags: ['Admin - Survey'],
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
