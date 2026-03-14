import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const CTF_PACKAGE = '0xaff30ff9a4b40845d8bdc91522a2b8e8e542ee41c0855f5cb21a652a00c45e96';
const ARENA_ID = '0xd7dd51e3c156a0c0152cad6bc94884db5302979e78f04d631a51ab107f9449e6';
const PLAYERS_TABLE_ID = '0xf3f63bf6a1d4bbf5ba9935eb8eead79d41db29f8c717b8395b74cea8fdb0418c';
const CLOCK = '0x6';
const COOLDOWN_MS = 600_000;
const SHIELD_THRESHOLD = 12;
const MY_ADDRESS = keypair.toSuiAddress();

async function rpc(method: string, params: unknown[]) {
  const res = await fetch('https://fullnode.testnet.sui.io:443', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  return json.result;
}

async function getMyPlayerState(): Promise<{ shield: number; last_action_ms: number } | null> {
  try {
    const result = await rpc('suix_getDynamicFieldObject', [
      PLAYERS_TABLE_ID,
      { type: 'address', value: MY_ADDRESS },
    ]);
    const fields = result?.data?.content?.fields?.value?.fields;
    if (!fields) return null;
    return {
      shield: Number(fields.shield),
      last_action_ms: Number(fields.last_action_ms),
    };
  } catch {
    return null;
  }
}

async function callArena(action: string, target?: string) {
  const tx = new Transaction();

  if (action === 'attack') {
    tx.moveCall({
      target: `${CTF_PACKAGE}::sabotage_arena::${action}`,
      arguments: [tx.object(ARENA_ID), tx.pure.address(target!), tx.object(CLOCK)],
    });
  } else if (action === 'claim_flag') {
    const [flag] = tx.moveCall({
      target: `${CTF_PACKAGE}::sabotage_arena::claim_flag`,
      arguments: [tx.object(ARENA_ID), tx.object(CLOCK)],
    });
    tx.transferObjects([flag], MY_ADDRESS);
  } else {
    tx.moveCall({
      target: `${CTF_PACKAGE}::sabotage_arena::${action}`,
      arguments: [tx.object(ARENA_ID), tx.object(CLOCK)],
    });
  }

  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const status = result.Transaction?.status;
  console.log(`  ✔ ${action}:`, status);
  if (!status?.success) throw new Error(`Transaction failed: ${JSON.stringify(status)}`);
  return result;
}

async function waitForCooldown(last_action_ms: number) {
  const now = Date.now();
  const readyAt = last_action_ms + COOLDOWN_MS + 2000;
  const waitMs = readyAt - now;
  if (waitMs > 0) {
    const mins = Math.ceil(waitMs / 60000);
    console.log(`  ⏳ Cooldown active — waiting ${mins} min (${Math.ceil(waitMs / 1000)}s)...`);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

(async () => {
  console.log(`\n🏟  Sabotage Arena — address: ${MY_ADDRESS}\n`);

  // Check arena is open
  const arena = await rpc('sui_getObject', [ARENA_ID, { showContent: true }]);
  const arenaFields = arena?.data?.content?.fields;
  const deadlineMs = Number(arenaFields?.deadline_ms);
  const now = Date.now();
  console.log(`Arena deadline: ${new Date(deadlineMs).toISOString()}`);
  console.log(`Arena open: ${now < deadlineMs}`);
  console.log(`Flags remaining: ${arenaFields?.flags_remaining}\n`);
  if (now >= deadlineMs) {
    console.error('❌ Arena is closed!');
    process.exit(1);
  }

  // Step 1: Register if needed
  console.log('📋 Registering...');
  try {
    await callArena('register');
    console.log('✅ Registered!\n');
  } catch (e: any) {
    if (e.message?.includes('abort code: 0') || e.message?.includes('abortCode":"0')) {
      console.log('✅ Already registered, continuing...\n');
    } else {
      throw e;
    }
  }

  await new Promise(r => setTimeout(r, 3000));

  // Step 2: Build until threshold
  let state;
  while (true) {
    state = await getMyPlayerState();

    if (!state) {
      console.log('Player state not indexed yet, waiting 5s...');
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    console.log(`🛡  Shield: ${state.shield}/${SHIELD_THRESHOLD}`);

    if (state.shield >= SHIELD_THRESHOLD) {
      console.log('\n✅ Shield threshold reached!\n');
      break;
    }

    await waitForCooldown(state.last_action_ms);

    try {
      console.log('🔨 Building shield...');
      await callArena('build');
    } catch (e: any) {
      console.warn('Build failed, retrying next cycle:', e.message?.slice(0, 120));
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  // Step 3: Claim flag
  console.log('🚩 Claiming flag...');
  await callArena('claim_flag');
  console.log('\n🎉 FLAG CAPTURED — sabotage_arena complete!\n');
})();