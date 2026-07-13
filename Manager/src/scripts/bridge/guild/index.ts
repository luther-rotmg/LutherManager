import { guild } from '@hive/sdk';
import type { GuildInviteEvent, GuildResultEvent, GuildHandler } from '@hive/sdk';
import type { BridgeDeps } from '../BridgeDeps.js';
import { Logger } from '../../../util/Logger.js';

function sendGuildPacket(
  deps: BridgeDeps,
  packetName: string,
  data: Record<string, unknown>,
): boolean {
  const c = deps.clientRef.current;
  if (!c?.connected) return false;
  try {
    const pkt = deps.proxy.packetFactory.createByName(packetName);
    Object.assign(pkt.data, data);
    pkt.modified = true;
    c.sendToServer(pkt);
    return true;
  } catch (err) {
    Logger.warn('Guild', `${packetName} send failed: ${(err as Error).message}`);
    return false;
  }
}

export function install(deps: BridgeDeps): void {
  const invitedHandlers = new Set<GuildHandler<GuildInviteEvent>>();
  const resultHandlers  = new Set<GuildHandler<GuildResultEvent>>();

  deps.proxy.hookPacket('INVITEDTOGUILD', (_client, packet) => {
    if (!packet.isDefined || invitedHandlers.size === 0) return;
    const d = packet.data as { name?: string; guildName?: string };
    const event: GuildInviteEvent = {
      inviterName: String(d.name ?? ''),
      guildName:   String(d.guildName ?? ''),
    };
    for (const h of invitedHandlers) {
      try { h(event); } catch (err) {
        Logger.error('Guild', 'onInvited handler threw', err as Error);
      }
    }
  });

  deps.proxy.hookPacket('GUILDRESULT', (_client, packet) => {
    if (!packet.isDefined || resultHandlers.size === 0) return;
    const d = packet.data as { success?: boolean; lineBuilderJSON?: string };
    const event: GuildResultEvent = {
      success: Boolean(d.success),
      message: String(d.lineBuilderJSON ?? ''),
    };
    for (const h of resultHandlers) {
      try { h(event); } catch (err) {
        Logger.error('Guild', 'onResult handler threw', err as Error);
      }
    }
  });

  guild.invite = (name: string): void => {
    sendGuildPacket(deps, 'GUILDINVITE', { name: String(name) });
  };

  guild.remove = (name: string): void => {
    sendGuildPacket(deps, 'GUILDREMOVE', { name: String(name) });
  };

  guild.leave = (): void => {
    const c = deps.clientRef.current;
    if (!c?.connected) return;
    const myName = c.playerData.name;
    if (!myName) {
      Logger.warn('Guild', 'leave: character name not yet known');
      return;
    }
    sendGuildPacket(deps, 'GUILDREMOVE', { name: myName });
  };

  guild.join = (guildName: string): void => {
    sendGuildPacket(deps, 'JOINGUILD', { guildName: String(guildName) });
  };

  guild.setRank = (name: string, rank: number): void => {
    sendGuildPacket(deps, 'CHANGEGUILDRANK', {
      name:      String(name),
      guildRank: Math.trunc(Number(rank)),
    });
  };

  guild.onInvited = (handler: GuildHandler<GuildInviteEvent>): (() => void) => {
    invitedHandlers.add(handler);
    return () => { invitedHandlers.delete(handler); };
  };

  guild.onResult = (handler: GuildHandler<GuildResultEvent>): (() => void) => {
    resultHandlers.add(handler);
    return () => { resultHandlers.delete(handler); };
  };
}
