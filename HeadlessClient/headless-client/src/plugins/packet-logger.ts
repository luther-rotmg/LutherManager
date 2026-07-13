import { CreatePacket, CreateSuccessPacket, HelloPacket, LoadPacket, MapInfoPacket, NotificationPacket, QuestObjectIdPacket } from 'realmlib';
import { Client } from '../client';
import { PacketHook, Plugin } from './decorators';

/**
 * Logs selected protocol lifecycle, map, quest, and notification packets.
 */
@Plugin({
  name: 'PacketLogger',
  description: 'Logs selected lifecycle, map, quest, and notification packets.',
  author: 'realmlib',
  version: '1.0.0',
})
export class PacketLogger {
  @PacketHook()
  onHello(client: Client, p: HelloPacket): void {
    console.log(`[${client.alias}] HelloPacket: ${p}`);
  }

  @PacketHook()
  onLoad(client: Client, p: LoadPacket): void {
    console.log(`[${client.alias}] LoadPacket: ${p}`);
  }

  @PacketHook()
  onCreate(client: Client, p: CreatePacket): void {
    console.log(`[${client.alias}] CreatePacket: class=${p.classType} skin=${p.skinType} seasonal=${p.isChallenger}`);
  }

  @PacketHook()
  onCreateSuccess(client: Client, p: CreateSuccessPacket): void {
    console.log(`[${client.alias}] CreateSuccessPacket: ${p}`);
  }

  @PacketHook()
  onMapInfo(client: Client, p: MapInfoPacket): void {
    console.log(`[${client.alias}] MapInfoPacket: ${p}`);
  }

  @PacketHook()
  onQuestObjectId(client: Client, p: QuestObjectIdPacket): void {
    console.log(`[${client.alias}] QuestObjectId: ${p}`);
  }

  @PacketHook()
  onNotification(client: Client, p: NotificationPacket): void {
    console.log(`[${client.alias}] Notification: ${p}`);
  }
}
