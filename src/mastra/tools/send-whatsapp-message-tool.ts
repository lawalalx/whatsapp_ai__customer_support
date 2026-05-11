import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { sendWhatsAppMessage } from '../../whatsapp-client'

export const sendWhatsAppMessageTool = createTool({
  id: 'send-whatsapp-message',
  name: 'Send WhatsApp Message',
  description: 'Sends a text message to a user via WhatsApp.',
  inputSchema: z.object({
    to: z.string().describe('The recipient\'s WhatsApp number.'),
    message: z.string().describe('The text message to send.'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('Whether the message was sent successfully.'),
  }),
  execute: async ({ input }) => {
    const success = await sendWhatsAppMessage(input)
    return { success }
  },
})
