import { findLast } from 'lodash'

import {
    type ChatMessage,
    type ContextItem,
    type Message,
    type SerializedChatInteraction,
    type SerializedChatTranscript,
    errorToChatError,
    isCodyIgnoredFile,
    reformatBotMessageForChat,
    toRangeData,
} from '@sourcegraph/cody-shared'

import { createDisplayTextWithFileLinks } from '../../commands/utils/display-text'
import type { Repo } from '../../context/repo-fetcher'
import { getChatPanelTitle } from './chat-helpers'

export class SimpleChatModel {
    constructor(
        public modelID: string,
        private messages: ChatMessage[] = [],
        public readonly sessionID: string = new Date(Date.now()).toUTCString(),
        private customChatTitle?: string,
        private selectedRepos?: Repo[]
    ) {}

    public isEmpty(): boolean {
        return this.messages.length === 0
    }

    public setLastMessageContext(newContextUsed: ContextItem[]): void {
        const lastMessage = this.messages.at(-1)
        if (!lastMessage) {
            throw new Error('no last message')
        }
        if (lastMessage.speaker !== 'human') {
            throw new Error('Cannot set new context used for bot message')
        }
        lastMessage.contextFiles = newContextUsed.filter(c => !isCodyIgnoredFile(c.uri))
    }

    public addHumanMessage(message: Omit<Message, 'speaker'>): void {
        if (this.messages.at(-1)?.speaker === 'human') {
            throw new Error('Cannot add a user message after a user message')
        }
        this.messages.push({ ...message, speaker: 'human' })
    }

    public addBotMessage(message: Omit<Message, 'speaker'>, displayText?: string): void {
        const lastMessage = this.messages.at(-1)
        let error: any
        // If there is no text, it could be a placeholder message for an error
        if (lastMessage?.speaker === 'assistant') {
            if (lastMessage?.text) {
                throw new Error('Cannot add a bot message after a bot message')
            }
            error = this.messages.pop()?.error
        }
        this.messages.push({
            ...message,
            speaker: 'assistant',
            displayText,
            error,
        })
    }

    public addErrorAsBotMessage(error: Error): void {
        const lastMessage = this.messages.at(-1)
        // Remove the last assistant message if any
        const lastAssistantMessage: ChatMessage | undefined =
            lastMessage?.speaker === 'assistant' ? this.messages.pop() : undefined
        // Then add a new assistant message with error added
        this.messages.push({
            ...(lastAssistantMessage ?? {}),
            speaker: 'assistant',
            error: errorToChatError(error),
        })
    }

    public getLastHumanMessage(): ChatMessage | undefined {
        return findLast(this.messages, message => message.speaker === 'human')
    }

    public getLastSpeakerMessageIndex(speaker: 'human' | 'assistant'): number | undefined {
        return this.messages.findLastIndex(message => message.speaker === speaker)
    }

    /**
     * Removes all messages from the given index when it matches the expected speaker.
     *
     * expectedSpeaker must match the speaker of the message at the given index.
     * This helps ensuring the intented messages are being removed.
     */
    public removeMessagesFromIndex(index: number, expectedSpeaker: 'human' | 'assistant'): void {
        if (this.isEmpty()) {
            throw new Error('SimpleChatModel.removeMessagesFromIndex: not message to remove')
        }

        const speakerAtIndex = this.messages.at(index)?.speaker
        if (speakerAtIndex !== expectedSpeaker) {
            throw new Error(
                `SimpleChatModel.removeMessagesFromIndex: expected ${expectedSpeaker}, got ${speakerAtIndex}`
            )
        }

        // Removes everything from the index to the last element
        this.messages.splice(index)
    }

    public getMessages(): readonly ChatMessage[] {
        return this.messages
    }

    public getChatTitle(): string {
        if (this.customChatTitle) {
            return this.customChatTitle
        }
        const lastHumanMessage = this.getLastHumanMessage()
        const text = lastHumanMessage && getDisplayText(lastHumanMessage)
        if (text) {
            return getChatPanelTitle(text)
        }
        return 'New Chat'
    }

    public getCustomChatTitle(): string | undefined {
        return this.customChatTitle
    }

    public setCustomChatTitle(title: string): void {
        this.customChatTitle = title
    }

    public getSelectedRepos(): Repo[] | undefined {
        return this.selectedRepos ? this.selectedRepos.map(r => ({ ...r })) : undefined
    }

    public setSelectedRepos(repos: Repo[] | undefined): void {
        this.selectedRepos = repos ? repos.map(r => ({ ...r })) : undefined
    }

    /**
     * Serializes to the transcript JSON format.
     */
    public toSerializedChatTranscript(): SerializedChatTranscript {
        const interactions: SerializedChatInteraction[] = []
        for (let i = 0; i < this.messages.length; i += 2) {
            const humanMessage = this.messages[i]
            const assistantMessage = this.messages.at(i + 1)
            interactions.push(messageToSerializedChatInteraction(humanMessage, assistantMessage))
        }
        const result: SerializedChatTranscript = {
            id: this.sessionID,
            chatModel: this.modelID,
            chatTitle: this.getCustomChatTitle(),
            lastInteractionTimestamp: this.sessionID,
            interactions,
        }
        if (this.selectedRepos) {
            result.enhancedContext = {
                selectedRepos: this.selectedRepos.map(r => ({ ...r })),
            }
        }
        return result
    }
}

function messageToSerializedChatInteraction(
    humanMessage: ChatMessage,
    assistantMessage?: ChatMessage
): SerializedChatInteraction {
    if (humanMessage?.speaker !== 'human') {
        throw new Error('expected human message, got bot')
    }

    if (humanMessage.speaker !== 'human') {
        throw new Error(`expected human message to have speaker == 'human', got ${humanMessage.speaker}`)
    }
    if (assistantMessage && assistantMessage.speaker !== 'assistant') {
        throw new Error(
            `expected bot message to have speaker == 'assistant', got ${assistantMessage.speaker}`
        )
    }

    function toSerializedInteractionMessage(message: ChatMessage): ChatMessage {
        return { ...message, displayText: getDisplayText(message) }
    }
    return {
        humanMessage: toSerializedInteractionMessage(humanMessage),
        assistantMessage: assistantMessage ? toSerializedInteractionMessage(assistantMessage) : null,
    }
}

export function prepareChatMessage(message: ChatMessage): ChatMessage {
    return {
        ...message,
        displayText: getDisplayText(message),
        contextFiles: message.contextFiles?.map(item => ({
            ...item,
            // De-hydrate because vscode.Range serializes to `[start, end]` in JSON.
            range: toRangeData(item.range),
        })),
    }
}

function getDisplayText(message: ChatMessage): string | undefined {
    if (message.displayText) {
        return message.displayText
    }
    if (message.speaker === 'human' && message.text) {
        return createDisplayTextWithFileLinks(message.text, message.contextFiles ?? [])
    }
    if (message.speaker === 'assistant' && message.text) {
        return reformatBotMessageForChat(message.text, '')
    }
    return message.text
}
