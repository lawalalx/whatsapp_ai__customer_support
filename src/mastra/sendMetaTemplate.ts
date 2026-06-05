import { sendWhatsAppTemplate } from '../whatsapp-client.js';
import { metaSurveyTemplates } from './metaSurveyTemplates.js';

/**
 * Sends a Meta WhatsApp survey template to a user.
 * @param {Object} params
 * @param {string} params.to - WhatsApp number
 * @param {string} params.surveyId - Survey template key
 * @param {string} [params.topic] - Topic for the survey
 * @returns {Promise<any>} WhatsApp API result
 */
export async function sendMetaTemplate({
  to,
  surveyId,
  topic,
}: {
  to: string;
  surveyId: string;
  topic?: string;
}) {
  const template =
    metaSurveyTemplates[
      surveyId as keyof typeof metaSurveyTemplates
    ];

  if (!template) {
    throw new Error('Meta template not found');
  }

  return sendWhatsAppTemplate({
    to,
    templateId: template.templateName,

    templateData: {
      body: [
        topic || 'Survey Feedback',
      ],
    },
  });
}
