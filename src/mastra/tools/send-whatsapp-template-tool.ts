import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sendWhatsAppTemplate } from '../../whatsapp-client'

export const sendWhatsAppTemplateTool = createTool({
  id: 'send-whatsapp-template',
  name: 'Send WhatsApp Template',
  description: 'Sends a pre-approved WhatsApp template message to a customer. Use this for proactive outreach outside the 24-hour customer service window.',
  inputSchema: z.object({
    to: z.string().describe("The recipient's WhatsApp number."),
    templateName: z.string().describe('The name of the approved template (e.g. survey_invitation_scale).'),
    languageCode: z.string().describe('The language code of the template (e.g. en_US, fr).'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the template message was sent successfully.'),
  }),
  execute: async ({ input }) => {
    const success = await sendWhatsAppTemplate({
      to: input.to,
      templateName: input.templateName,
      languageCode: input.languageCode,
    })
    return { success }
  },
})
