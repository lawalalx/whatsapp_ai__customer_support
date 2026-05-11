// webhook/handlers/chat.handler.ts

import { sendWhatsAppTyping } from '../whatsapp-client';
import { sendAgentReply } from '../utils/send-agent-reply';

export async function handleChatMessage({
  mastra,
  phone,
  text,
  contactName,
  messageId,
  sendMessage,
}: {
  mastra: any;
  phone: string;
  text: string;
  contactName?: string | null;
  messageId: string;
  sendMessage: (to: string, msg: string) => Promise<void>;
}) {
  try {
    console.log('Chat handler triggered for', phone, 'with text:', text);
    const agent = mastra.getAgent('engagementAgent');

    // Send a typing indicator and keep re-sending it periodically
    // while the agent is generating a response so the user sees activity.
    try {
      // initial ping
      await sendWhatsAppTyping({ to: phone, messageId }).catch(() => {});
      // keep-alive every 8s
      let intervalId: any = setInterval(() => {
        sendWhatsAppTyping({ to: phone, messageId }).catch(() => {});
      }, 8000);

      try {
        const messages: any[] = [];
        if (contactName) {
          messages.push({ role: 'system', content: `Customer name: ${contactName}. Address the customer by this name when appropriate.` });
        }
        messages.push({ role: 'user', content: text });

        const response = await agent.generate(messages, {
          memory: {
            thread: `thread_${phone}`,
            resource: phone,
          },
        });

        // stop typing pings once we have a response
        clearInterval(intervalId);

        const rawReply = response?.text?.trim() || "Sorry, I couldn't process that. Please try again.";
        console.log('Sending WhatsApp message to', phone, 'with raw reply:', rawReply);
        await sendAgentReply(phone, rawReply);
        return;
      } finally {
        clearInterval(intervalId);
      }
    } catch (e) {
      console.warn('Typing indicator failed; proceeding without it', e);
    }
    // Fallback: if typing pings fail, generate and send without typing indicator
    const messages: any[] = [];
    if (contactName) messages.push({ role: 'system', content: `Customer name: ${contactName}. Address the customer by this name when appropriate.` });
    messages.push({ role: 'user', content: text });

    const response = await agent.generate(messages, {
      memory: {
        thread: `thread_${phone}`,
        resource: phone,
      },
    });

    const rawReply = response?.text?.trim() || "Sorry, I couldn't process that. Please try again.";
    console.log('Sending WhatsApp message to', phone, 'with raw reply:', rawReply);
    await sendAgentReply(phone, rawReply);
  } catch (error) {
    console.error('❌ Chat handler error:', error);

    await sendMessage(
      phone,
      "👋 Thanks for reaching out. We're experiencing a delay right now. Please try again shortly."
    );
  }
}
