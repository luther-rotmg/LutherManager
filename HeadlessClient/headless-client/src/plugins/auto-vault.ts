import { VaultContentPacket } from 'realmlib';
import { Client } from '../client';
import { ClientEvent } from '../events';
import { Plugin, EventHook } from './decorators';

/** Walks into the vault on reaching the nexus and reports the item count. */
@Plugin({
  name: 'AutoVault',
  description: 'Walks into the vault on reaching the nexus and logs its contents.',
  author: 'realmlib',
  version: '1.0.0',
})
export class AutoVault {
  @EventHook(ClientEvent.EnterNexus)
  onNexus(client: Client): void {
    client.enterVault();
  }

  @EventHook(ClientEvent.VaultContents)
  onVault(client: Client, vault: VaultContentPacket): void {
    if (!vault.lastVaultPacket) return;
    console.log(`[${client.alias}] AutoVault: ${client.getContainerItemCount('vault')} items in the vault`);
  }
}
