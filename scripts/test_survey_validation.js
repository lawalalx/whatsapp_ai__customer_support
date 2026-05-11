// scripts/test_survey_validation.js

function normalizeQuestions(questions) {
  if (typeof questions === 'string') {
    try { return JSON.parse(questions) } catch (e) { return questions }
  }
  return questions
}

async function testScenario({session, message, description}){
  console.log('\n---', description, '---')
  const sendLog = []
  const sendMessage = async (to, msg) => { sendLog.push({type:'sendMessage', to, msg}); console.log('sendMessage ->', msg) }
  const sendQuestion = async (to, question, session) => { sendLog.push({type:'sendQuestion', to, question}); console.log('sendQuestion ->', question.question || JSON.stringify(question)) }

  const currentIndex = session.current_question
  let questions = normalizeQuestions(session.questions_data)
  const currentQuestion = Array.isArray(questions) ? questions[currentIndex] : undefined

  const buttonReply = message?.interactive?.button_reply
  const listReply = message?.interactive?.list_reply
  const textBody = typeof message?.text?.body === 'string' ? message.text.body : ''
  const rawAnswer = buttonReply?.title || listReply?.title || buttonReply?.id || listReply?.id || textBody

  if (!rawAnswer) {
    console.log('No answer provided')
    return
  }

  let responseTextToSave = rawAnswer
  let responseIdToSave = message.id

  if ((currentQuestion?.type === 'button' || currentQuestion?.type === 'list') && currentQuestion?.options?.length) {
    const validOptions = currentQuestion.options.map(opt => String(opt).toLowerCase().trim())
    const replyId = buttonReply?.id || listReply?.id
    if (replyId && typeof replyId === 'string' && replyId.includes(session.id)) {
      const m = replyId.match(/_opt(\d+)$/)
      if (m) {
        const idx = parseInt(m[1],10)-1
        if (currentQuestion.options[idx]) {
          responseTextToSave = currentQuestion.options[idx]
          responseIdToSave = replyId
        }
      }
    } else {
      const normalizedAnswer = String(rawAnswer || '').toLowerCase().trim()
      console.log('validOptions:', validOptions, 'normalizedAnswer:', normalizedAnswer)
      if (!validOptions.includes(normalizedAnswer)) {
        console.log('Invalid option provided -> will resend question')
        await sendMessage(session.customer_phone, '🙂 Please select from the available options above.')
        await sendQuestion(session.customer_phone, currentQuestion, session)
        return
      }
      const matchedIndex = validOptions.indexOf(normalizedAnswer)
      if (matchedIndex >= 0) responseTextToSave = currentQuestion.options[matchedIndex]
    }
  }

  console.log('Accepted response:', responseTextToSave)
}

(async () => {
  const session = {
    id: 'sess_123',
    customer_phone: '+221600000000',
    current_question: 0,
    questions_data: [
      { type: 'button', question: 'How satisfied?', options: ['Very satisfied','Satisfied','Neutral','Dissatisfied'] }
    ]
  }

  await testScenario({
    session,
    message: { text: { body: 'fdsfdsf' } },
    description: 'Typed invalid text during button question'
  })

  await testScenario({
    session,
    message: { text: { body: 'satisfied' } },
    description: 'Typed valid text (case-insensitive match) during button question'
  })

  await testScenario({
    session: {...session, questions_data: JSON.stringify(session.questions_data) },
    message: { text: { body: 'neutral' } },
    description: 'questions_data as JSON string, valid answer'
  })

  await testScenario({
    session,
    message: { interactive: { button_reply: { id: 'sess_123_q1_opt2', title: 'Satisfied' } } },
    description: 'Interactive button reply'
  })

})()
