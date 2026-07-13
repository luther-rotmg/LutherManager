import { TextPacket } from 'realmlib';
import { Client } from '../client';
import { Plugin, PacketHook } from './decorators';

/** Logs non-empty in-game chat and system TEXT packets. */
@Plugin({
  name: 'ChatLogger',
  description: 'Logs in-game chat messages.',
  author: 'realmlib',
  version: '1.0.0',
})
export class ChatLogger {
  @PacketHook()
  onText(client: Client, text: TextPacket): void {
    if (text.text) {
      // The real client uses 65535 stars for system/server messages.
      if (text.numStars !== 65535) {
        console.log(`[${client.alias}] ⭐️${text.numStars} <${text.name}> ${text.text}`);
      } else {
        console.log(`[${client.alias}] [${text.name}] ${text.text}`);
      }
    }
  }
}
