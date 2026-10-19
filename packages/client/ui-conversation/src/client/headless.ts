/** Conversation assembly and submission policy without browser components. */
import type {} from './index.ts'

export { UiConversation } from './conversation/assembly.ts'
export type { ConversationBinding } from './conversation/assembly.ts'
export { resolveSubmitMode, DEFAULT_BUSY_ENTER_BEHAVIOR } from './input/submission-policy.ts'
export type { BusyEnterBehavior } from './contract/composer-submission.ts'
