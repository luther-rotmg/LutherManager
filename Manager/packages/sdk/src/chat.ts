import type { ChatChannel, ChatHandler, ChatOutgoingBlockMode, Unsubscribe } from './types/chat';

const noopUnsub: Unsubscribe = () => {};

/**
 * Chat listen/send API. Stub implementations; Hive host patches these at runtime.
 */
export const chat = {
    onMessage(handler: ChatHandler): Unsubscribe {
        void handler;
        return noopUnsub;
    },

    onMessageFrom(playerName: string, handler: ChatHandler): Unsubscribe {
        void playerName;
        void handler;
        return noopUnsub;
    },

    onMessageContaining(match: string | RegExp, handler: ChatHandler): Unsubscribe {
        void match;
        void handler;
        return noopUnsub;
    },

    onChannelMessage(channel: ChatChannel, handler: ChatHandler): Unsubscribe {
        void channel;
        void handler;
        return noopUnsub;
    },

    onWhisper(handler: ChatHandler): Unsubscribe {
        void handler;
        return noopUnsub;
    },

    onSystemMessage(handler: ChatHandler): Unsubscribe {
        void handler;
        return noopUnsub;
    },

    send(message: string, channel?: ChatChannel): void {
        void message;
        void channel;
    },

    /**
     * Show a local-only chat notification in the game client.
     * Nothing reaches the server or other players — useful for plugin /
     * script alerts. `sender` becomes the fake name shown next to the
     * message (defaults to `'Hive'`).
     */
    notify(message: string, sender?: string): void {
        void message;
        void sender;
    },

    say(message: string): void {
        void message;
    },

    yell(message: string): void {
        void message;
    },

    tell(playerName: string, message: string): void {
        void playerName;
        void message;
    },

    party(message: string): void {
        void message;
    },

    guild(message: string): void {
        void message;
    },

    /**
     * Stop matching lines typed in the game client from reaching the server (drops outgoing `PLAYERTEXT`).
     * `Hive.chat.onMessage` and other listeners still see the line. Patterns are compared
     * **case-insensitive** after trim. Does not apply to `chat.say` / `tell` etc. (those bypass the client queue).
     *
     * @param mode  `'equals'` — full wire text (trimmed) equals any `pattern`; `'contains'` — wire text includes any `pattern`.
     * @param patterns  One or more substrings / full lines; **OR** semantics (any match blocks).
     * @returns  Unsubscribe — removes this rule set only.
     */
    blockOutgoing(mode: ChatOutgoingBlockMode, ...patterns: string[]): Unsubscribe {
        void mode;
        void patterns;
        return noopUnsub;
    },
};
