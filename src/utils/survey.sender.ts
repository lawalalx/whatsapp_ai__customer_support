// import { SendSurveyQuestionParams } from "../flow.types.js"
// import { sendWhatsAppList, sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppTemplate, sendWhatsAppTyping } from "../whatsapp-client.js"
// import { setLastOutbound } from './outboundTracker.js'



// export async function sendSurveyQuestion({
//   to,
//   session,
//   question,
// }: SendSurveyQuestionParams) {

//     if (!session) {
//         console.error("❌ Missing session in sendSurveyQuestion")
//         return false
//     }

//     const index = session.current_question;
//     const total = session.total_questions;

//     // const headerText =
//     //     index === 0 ? `📊 FBNBank Survey\n💡 Type exit anytime to stop the survey.` : undefined;


//     const welcomeGreeting = `📊 *Dear Value Customer,*\n\nWelcome to the *FBNBank Customer Survey*.\n\nPlease help us fill out this quick survey. Your feedback is incredibly important to us and helps us improve our services for you! 🌟\n\n⏱️ *Time:* Less than 2 minutes\n🛑 _Type *EXIT* at any time to stop._`;
//     const headerText = index === 0 ? "FBNBank Survey" : undefined;

//     const footerText = `Question ${index + 1} of ${total}`;

//     const qText = question.text ?? question.question;
//     if (!qText) return false;

//     // If this is the first question of a proactively-started session, use
//     // a pre-approved WhatsApp template to avoid the 24-hour re-engagement block.
//     const proactiveTemplate = process.env.WHATSAPP_PROACTIVE_TEMPLATE;
//     const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
//     if ((session?.current_question === 0 || session?.current_question === undefined) && proactiveTemplate) {
//         console.log('Using proactive template for first question:', proactiveTemplate);
//         // Pass the question text as a body parameter to the template
//         return sendWhatsAppTemplate({
//             to,
//             templateName: proactiveTemplate,
//             languageCode: templateLang,
//             components: [
//                 {
//                     type: 'body',
//                     parameters: [{ type: 'text', text: `${qText}\n\n${footerText}` }],
//                 },
//             ],
//         });
//     }

//     // Prefer interactive when options are present. Use explicit `type` when provided,
//     // otherwise infer: up to 3 options => buttons, more => list.
//     const opts = question.options ?? [];
//     const hasOptions = Array.isArray(opts) && opts.length > 0;

//     if (hasOptions) {
//             // historical behavior: treat >2 options as a list (sectionList) rather than buttons
//         const useButtons = question.type === 'button' || (question.type === undefined && opts.length <= 2);
//         const useList = question.type === 'list' || (question.type === undefined && opts.length > 2);

//         // mark outbound
//         setLastOutbound(to, 'survey_question');

//         // send typing indicator before survey message
//         try { sendWhatsAppTyping({ to, messageId: `${session.id}_q${index + 1}` }).catch(() => {}); } catch (e) {}

//         if (useButtons) {
//             return sendWhatsAppSurvey({
//                 to,
//                 question: qText,
//                 options: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
//                 headerText,
//                 footerText,
//             });
//         }

//         if (useList) {
//             return sendWhatsAppList({
//                 to,
//                 headerText,
//                 bodyText: qText,
//                 footerText,
//                 buttonText: 'Select',
//                 sections: [
//                     {
//                         title: question.sectionTitle || 'Options',
//                         rows: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
//                     },
//                 ],
//             });
//         }
//     }

//     // TEXT (FIXED)
//     // mark outbound
//     setLastOutbound(to, 'survey_question');
//     try { sendWhatsAppTyping({ to, messageId: `${session.id}_q${index + 1}` }).catch(() => {}); } catch (e) {}
//     return sendWhatsAppMessage({
//         to,
//         message: `${qText}\n\n${footerText}\n(Reply with your answer)`,
//     });
// }




import { SendSurveyQuestionParams } from "../flow.types.js"
import { sendWhatsAppList, sendWhatsAppMessage, sendWhatsAppSurvey, sendWhatsAppTemplate, sendWhatsAppTyping } from "../whatsapp-client.js"
import { setLastOutbound } from './outboundTracker.js'

export async function sendSurveyQuestion({
  to,
  session,
  question,
  phoneNumberId,
}: SendSurveyQuestionParams) {

  if (!session) {
    console.error("❌ Missing session in sendSurveyQuestion")
    return false
  }

  const index = session.current_question;
  const total = session.total_questions;
        
  const footerText = `Question ${index + 1} of ${total}`;

  let qText = question.text ?? question.question;
  if (!qText) return false;

  // 1. Define the welcome greeting separately
  const welcomeGreeting = `📊 *Dear Valued Customer,*\n\nWelcome to the *FBNBank Customer Survey*.\n\nPlease help us fill out this quick survey. Your feedback is incredibly important to us and helps us improve our services for you! 🌟\n\n⏱️ *Time:* Less than 2 minutes\n🛑 _Type *EXIT* at any time to stop._\n\n`;

  // 2. Keep the technical header text clean, markdown-free, and brief
  const headerText = index === 0 ? "FBNBank Survey" : undefined;

  // If this is the first question of a proactively-started session, use
  // a pre-approved WhatsApp template to avoid the 24-hour re-engagement block.
  const proactiveTemplate = process.env.WHATSAPP_PROACTIVE_TEMPLATE;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';
  
  if ((session?.current_question === 0 || session?.current_question === undefined) && proactiveTemplate) {
    console.log('Using proactive template for first question:', proactiveTemplate);
    
    // For templates, prepend the greeting text nicely into the body parameter
    const fullTemplateBody = index === 0 ? `${welcomeGreeting}${qText}` : qText;

    return sendWhatsAppTemplate({
      to,
      templateName: proactiveTemplate,
      languageCode: templateLang,
      phoneNumberId,
      components: [
        {
          type: 'body',
          parameters: [{ type: 'text', text: `${fullTemplateBody}\n\n${footerText}` }],
        },
      ],
    });
  }

  // Prefer interactive when options are present.
  const opts = question.options ?? [];
  const hasOptions = Array.isArray(opts) && opts.length > 0;

  if (hasOptions) {
    const useButtons = question.type === 'button' || (question.type === undefined && opts.length <= 2);
    const useList = question.type === 'list' || (question.type === undefined && opts.length > 2);

    // Mark outbound
    setLastOutbound(to, 'survey_question');

    if (useButtons) {
      // For buttons: if index is 0, append the welcome greeting directly to the question text
      const finalQuestionText = index === 0 ? `${welcomeGreeting}${qText}` : qText;

      return sendWhatsAppSurvey({
        to,
        question: finalQuestionText,
        options: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
        headerText,
        footerText,
        phoneNumberId,
      });
    }

    if (useList) {
      // For Lists: Append greeting text into the bodyText param where markdown is completely valid
      const finalBodyText = index === 0 ? `${welcomeGreeting}${qText}` : qText;

      return sendWhatsAppList({
        to,
        headerText, // Will now safely be "FBNBank Survey" or undefined
        bodyText: finalBodyText, 
        footerText,
        buttonText: 'Select',
        phoneNumberId,
        sections: [
          {
            title: question.sectionTitle || 'Options',
            rows: opts.map((opt, i) => ({ id: `${session.id}_q${index + 1}_opt${i + 1}`, title: opt })),
          },
        ],
      });
    }
  }

  // TEXT FALLBACK (FIXED)
  setLastOutbound(to, 'survey_question');
  
  const finalText = index === 0 ? `${welcomeGreeting}${qText}` : qText;
  
  return sendWhatsAppMessage({
    to,
    message: `${finalText}\n\n${footerText}\n(Reply with your answer)`,
    phoneNumberId,
  });
}
