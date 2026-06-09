/**
 * WhatsApp Flow JSON Builder for Survey Flows
 *
 * Converts a simple survey definition (questions + options) into a valid
 * WhatsApp Flow JSON payload that can be uploaded to the Meta Flows API.
 *
 * Flow structure:
 *   INTRO  →  QUESTIONS  →  COMPLETE (terminal)
 *
 * The QUESTIONS screen submits via data_exchange to the server's
 * /webhook/meta-flow-data endpoint, which saves the responses and
 * navigates back to the COMPLETE terminal screen.
 *
 * Supported question types:
 *   "list"     → Dropdown selector       (best for 3-10 options)
 *   "button"   → RadioButtonsGroup       (best for 2-5 options)
 *   "text"     → TextInput (single-line)
 *   "textarea" → TextArea  (multi-line)
 *   "date"     → DatePicker
 */

export type QuestionType = 'list' | 'button' | 'text' | 'textarea' | 'date';

export interface MetaFlowQuestion {
  /** Unique identifier used as the form field name (no spaces, e.g. "q1" or "satisfaction") */
  id: string;
  /** The question text shown to the user */
  text: string;
  /**
   * Component type:
   * - "list"     → Dropdown
   * - "button"   → RadioButtonsGroup
   * - "text"     → TextInput
   * - "textarea" → TextArea
   * - "date"     → DatePicker
   */
  type: QuestionType;
  /** For list/button types: array of option strings */
  options?: string[];
  /** Whether the field is mandatory. Defaults to true */
  required?: boolean;
  /** Placeholder / helper text shown inside the component */
  placeholder?: string;
  /**
   * Section label for RadioButtonsGroup. If omitted, the question text is used.
   * RadioButtonsGroup requires a separate label attribute.
   */
  sectionTitle?: string;
}

export interface MetaFlowSurveyDefinition {
  /** Unique identifier for this survey definition (saved in meta_flow_surveys.survey_id) */
  id?: string;
  /** Human-readable survey name (max 30 chars used as screen title) */
  name: string;
  /** Short description shown on the INTRO screen */
  description?: string;
  /** Questions to include in the survey */
  questions: MetaFlowQuestion[];
  /** Message shown on the COMPLETE terminal screen. Defaults to a generic thanks message */
  thankYouText?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncate(str: string, max: number): string {
  return str.length > max ? str.substring(0, max - 1) + '…' : str;
}

/** Build the component tree for one question */
function buildQuestionComponent(q: MetaFlowQuestion): any[] {
  const components: any[] = [];
  const required = q.required !== false;

  switch (q.type) {
    case 'list': {
      if (!q.options || q.options.length === 0) {
        throw new Error(`Question "${q.id}" has type "list" but no options array`);
      }
      components.push({
        type: 'Dropdown',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        'data-source': q.options.map((opt, i) => ({
          id: `${q.id}_opt_${i}`,
          title: truncate(opt, 30),
        })),
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'button': {
      if (!q.options || q.options.length === 0) {
        throw new Error(`Question "${q.id}" has type "button" but no options array`);
      }
      components.push({
        type: 'RadioButtonsGroup',
        name: q.id,
        label: truncate(q.sectionTitle || q.text, 30),
        required,
        'data-source': q.options.map((opt, i) => ({
          id: `${q.id}_opt_${i}`,
          title: truncate(opt, 30),
        })),
      });
      break;
    }

    case 'textarea': {
      components.push({
        type: 'TextArea',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'date': {
      components.push({
        type: 'DatePicker',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }

    case 'text':
    default: {
      components.push({
        type: 'TextInput',
        name: q.id,
        label: truncate(q.text, 80),
        required,
        'input-type': 'text',
        ...(q.placeholder ? { 'helper-text': truncate(q.placeholder, 80) } : {}),
      });
      break;
    }
  }

  return components;
}

// ─── Main Builder ─────────────────────────────────────────────────────────────

/**
 * Generates a WhatsApp Flow JSON object from a survey definition.
 *
 * @param def      Survey definition (name, description, questions, etc.)
 * @param dataEndpointUrl  Full HTTPS URL of your /webhook/meta-flow-data endpoint
 * @returns        Plain object ready for JSON.stringify and upload to Meta
 */


// interface FlowQuestion {
//   id: string;
//   text: string;
//   type: 'list' | 'button' | 'text' | 'textarea' | 'date';
//   options?: string[];
//   required?: boolean;
//   placeholder?: string;
// }

interface FlowParams {
  id?: string;
  name: string;
  description?: string;
  questions: FlowQuestion[];
  thankYouText?: string;
}


// export function buildSurveyFlowJson(params: FlowParams, endpointUrl: string): any {
//   const { name, description, questions, thankYouText } = params;

//   // 1. Map questions to WhatsApp Flow components
//   const questionComponents = questions.map((q) => {
//     switch (q.type) {
//       case 'list':
//         return {
//           type: 'Dropdown',
//           label: q.text,
//           name: q.id,
//           required: q.required !== false,
//           'data-source': (q.options || []).map((opt) => ({
//             id: opt,
//             title: opt,
//           })),
//         };
//       case 'button':
//         return {
//           type: 'RadioButtonsGroup',
//           label: q.text,
//           name: q.id,
//           required: q.required !== false,
//           'data-source': (q.options || []).map((opt) => ({
//             id: opt,
//             title: opt,
//           })),
//         };
//       case 'text':
//         return {
//           type: 'TextInput',
//           label: q.text,
//           name: q.id,
//           required: q.required !== false,
//           placeholder: q.placeholder,
//         };
//       case 'textarea':
//         return {
//           type: 'TextArea',
//           label: q.text,
//           name: q.id,
//           required: q.required !== false,
//           // placeholder: q.placeholder,
//         };
//       case 'date':
//         return {
//           type: 'DatePicker',
//           label: q.text,
//           name: q.id,
//           required: q.required !== false,
//         };
//       default:
//         return {
//           type: 'TextBody',
//           text: q.text,
//         };
//     }
//   });

//   // 2. Build the Flow JSON structure
//   return {
//     version: '7.0',
    
//     // REQUIRED for data_exchange flows
//     data_api_version: '3.0',

//     // data_channel_uri: endpointUrl,

//     // REQUIRED for navigation between screens
//     routing_model: {
//       INTRO: ['QUESTIONS'],
//       QUESTIONS: ['COMPLETE'],
//       COMPLETE: [],
//     },

//     screens: [
//       {
//         id: 'INTRO',
//         title: name,
//         layout: {
//           type: 'SingleColumnLayout',
//           children: [
//             { type: 'TextHeading', text: name },
//             { type: 'TextBody', text: description || 'Please complete this survey.' },
//             {
//               type: 'Footer',
//               label: 'Start Survey',
//               'on-click-action': {
//                 name: 'navigate',
//                 next: { type: 'screen', name: 'QUESTIONS' },
//               },
//             },
//           ],
//         },
//       },
//       {
//         id: 'QUESTIONS',
//         title: 'Questions',
//         terminal: false,
//         layout: {
//           type: 'SingleColumnLayout',
//           children: [
//             ...questionComponents,
//             {
//               type: 'Footer',
//               label: 'Submit',
//               'on-click-action': {
//                 name: 'data_exchange',
//                 payload: questions.reduce((acc, q) => {
//                   acc[q.id] = `\${form.${q.id}}`;
//                   return acc;
//                 }, {} as any),
//               },
//             },
//           ],
//         },
//       },
//       {
//         id: 'COMPLETE',
//         title: 'Done',
//         terminal: true,
//         layout: {
//           type: 'SingleColumnLayout',
//           children: [
//             { type: 'TextHeading', text: 'Thank You!' },
//             { type: 'TextBody', text: thankYouText || 'Your feedback has been received.' },
//             {
//               type: 'Footer',
//               label: 'Close',
//               'on-click-action': {
//                 name: 'complete',
//                 payload: {},
//               },
//             },
//           ],
//         },
//       },
//     ],
//   };
// }





export interface FlowCondition {
  dependsOn: string; // The ID of the previous question
  equals: string;    // The value that triggers this question to show
}

export interface MetaFlowQuestion {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  required?: boolean;
  placeholder?: string;
  sectionTitle?: string;
  showIf?: FlowCondition; // <-- ADD THIS
}

interface FlowQuestion {
  id: string;
  text: string;
  type: 'list' | 'button' | 'text' | 'textarea' | 'date';
  options?: string[];
  required?: boolean;
  placeholder?: string;
  showIf?: FlowCondition; // <-- ADD THIS
}



export function buildSurveyFlowJson(params: FlowParams, endpointUrl: string): any {
  const { name, description, questions, thankYouText } = params;

  // --- NEW: Helper to ensure Meta IDs don't contain spaces ---
  const sanitizeId = (str: string) => str.replace(/[^a-zA-Z0-9_]/g, '_');

  // 1. Map questions to WhatsApp Flow components
  const questionComponents = questions.map((q) => {
    let component: any;

    switch (q.type) {
      case 'list':
        component = {
          type: 'Dropdown',
          label: q.text,
          name: q.id,
          required: q.required !== false,
          'data-source': (q.options || []).map((opt) => ({
            id: sanitizeId(opt), // Sanitize ID here
            title: opt,          // Keep the display title pretty
          })),
        };
        break;
      case 'button':
        component = {
          type: 'RadioButtonsGroup',
          label: q.text,
          name: q.id,
          required: q.required !== false,
          'data-source': (q.options || []).map((opt) => ({
            id: sanitizeId(opt), // Sanitize ID here
            title: opt,          // Keep the display title pretty
          })),
        };
        break;
      case 'text':
        component = {
          type: 'TextInput',
          label: q.text,
          name: q.id,
          required: q.required !== false,
          'input-type': 'text', // Explicitly defining this as Meta sometimes demands it
          placeholder: q.placeholder,
        };
        break;
      case 'textarea':
        component = {
          type: 'TextArea',
          label: q.text,
          name: q.id,
          required: q.required !== false,
        };
        break;
      case 'date':
        component = {
          type: 'DatePicker',
          label: q.text,
          name: q.id,
          required: q.required !== false,
        };
        break;
      default:
        component = {
          type: 'TextBody',
          text: q.text,
        };
        break;
    }

    // --- DYNAMIC LOGIC INJECTION ---
    if (q.showIf && q.showIf.dependsOn && q.showIf.equals !== undefined) {
      // We must also sanitize the 'equals' string so it matches the sanitized option ID
      const sanitizedEquals = sanitizeId(q.showIf.equals);
      
      // Constructs: "${form.question_id == 'Target_Value'}"
      component.visible = `\${form.${q.showIf.dependsOn} == '${sanitizedEquals}'}`;
    }

    return component;
  });

  // 2. Build the Flow JSON structure
  return {
    version: '7.0',
    data_api_version: '3.0',
    routing_model: {
      INTRO: ['QUESTIONS'],
      QUESTIONS: ['COMPLETE'],
      COMPLETE: [],
    },
    screens: [
      {
        id: 'INTRO',
        title: name,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: name },
            { type: 'TextBody', text: description || 'Please complete this survey.' },
            {
              type: 'Footer',
              label: 'Start Survey',
              'on-click-action': {
                name: 'navigate',
                next: { type: 'screen', name: 'QUESTIONS' },
              },
            },
          ],
        },
      },
      {
        id: 'QUESTIONS',
        title: 'Questions',
        terminal: false,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...questionComponents,
            {
              type: 'Footer',
              label: 'Submit',
              'on-click-action': {
                name: 'data_exchange',
                payload: questions.reduce((acc, q) => {
                  acc[q.id] = `\${form.${q.id}}`;
                  return acc;
                }, {} as any),
              },
            },
          ],
        },
      },
      {
        id: 'COMPLETE',
        title: 'Done',
        terminal: true,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: 'Thank You!' },
            { type: 'TextBody', text: thankYouText || 'Your feedback has been received.' },
            {
              type: 'Footer',
              label: 'Close',
              'on-click-action': {
                name: 'complete',
                payload: {},
              },
            },
          ],
        },
      },
    ],
  };
}
